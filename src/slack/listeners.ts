import type { App } from '@slack/bolt';
import type { Config } from '../config';
import type { SessionStore } from '../store/session-store';
import type { TriggerEngine } from '../automations/triggers';
import {
  type MentionTriggerEngine,
  fireMentionTrigger,
} from '../automations/mention-trigger-engine';
import { askClaude } from '../claude/agent';
import { runAutomation } from '../automations/runner';
import { resolveCwd } from '../channels';
import { MessageQueue } from '../queue/message-queue';
import { toSlackMarkdown, splitMessage } from './formatters';
import { markdownToBlocks, blockToFallbackText } from './blocks';
import { downloadSlackFiles, buildFilesPromptSection, type SlackFile } from './file-downloader';
import { extractButtons, buildActionsBlock, BUTTON_ACTION_ID_PREFIX } from './buttons';
import { listSkills } from '../claude/skills';
import {
  parseCommand,
  buildSkillsMessage,
  buildHelpMessage,
  buildSkillPrompt,
  SKILL_SELECT_ACTION_ID,
} from './commands';

const REJECT_MESSAGES = [
  "Sorry, I'm a personal assistant and only respond to my owner. :bow:",
  "I appreciate the interest, but I'm exclusively dedicated to my owner. :lock:",
  "Flattered you'd ask, but I'm a one-person bot. :robot_face:",
  "I'm on a strict guest list, and you're not on it — yet! :clipboard:",
  'My owner keeps me on a short leash. Nothing personal! :dog:',
];

function getRejectMessage(): string {
  return REJECT_MESSAGES[Math.floor(Math.random() * REJECT_MESSAGES.length)]!;
}
const debug = process.env['DEBUG'] === 'true';

// Emoji added to the triggering message while Claude is working. A reaction is
// silent — unlike a posted message, it doesn't mark the channel unread or
// notify thread participants. This is a custom workspace emoji (assets/
// claude-spark.gif); if it's ever removed, reactions.add fails and is caught
// silently, so no reaction is shown but the response still posts.
const THINKING_REACTION = 'claude-spark';

const nameCache = new Map<string, string>();

async function resolveUser(client: App['client'], userId: string): Promise<string> {
  const cached = nameCache.get(userId);
  if (cached) return cached;
  try {
    const res = await client.users.info({ user: userId });
    const name = res.user?.real_name || res.user?.name || userId;
    nameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

const USER_MENTION_PATTERN = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/g;

async function renderMentions(client: App['client'], text: string): Promise<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(USER_MENTION_PATTERN)) ids.add(match[1]!);
  if (ids.size === 0) return text;
  const resolved = await Promise.all(
    [...ids].map(async (id) => [id, await resolveUser(client, id)] as const),
  );
  const nameById = new Map(resolved);
  return text.replace(USER_MENTION_PATTERN, (_, uid) => `@${nameById.get(uid) ?? uid}`);
}

async function resolveChannel(client: App['client'], channelId: string): Promise<string> {
  const cached = nameCache.get(channelId);
  if (cached) return cached;
  try {
    const res = await client.conversations.info({ channel: channelId });
    const name = res.channel?.name || channelId;
    nameCache.set(channelId, name);
    return name;
  } catch {
    return channelId;
  }
}

const SUBTEAM_MENTION_PATTERN = /<!subteam\^(S[A-Z0-9]+)(?:\|[^>]*)?>/g;
const SESSION_ID_PATTERN = /claude\s+--resume\s+([0-9a-f-]{36})/;

async function extractSessionFromParent(
  client: App['client'],
  channelId: string,
  threadTs: string,
): Promise<string | undefined> {
  try {
    const res = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 1,
      inclusive: true,
    });
    const parentText = res.messages?.[0]?.text ?? '';
    const match = parentText.match(SESSION_ID_PATTERN);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function getThreadParticipants(
  client: App['client'],
  channelId: string,
  threadTs: string,
): Promise<Set<string>> {
  const participants = new Set<string>();
  try {
    const res = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 200,
    });
    for (const msg of res.messages ?? []) {
      if (msg.user) participants.add(msg.user);
    }
  } catch {
    // ignore
  }
  return participants;
}

async function fetchThreadContext(
  client: App['client'],
  channelId: string,
  threadTs: string,
  botUserId: string,
): Promise<string> {
  try {
    const res = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 50,
      inclusive: true,
    });
    const messages = res.messages ?? [];
    if (messages.length <= 1) {
      // Only the current message — just include the parent
      const parent = messages[0];
      if (parent?.text) {
        const author = parent.user
          ? await resolveUser(client, parent.user)
          : parent.bot_id
            ? 'bot'
            : 'unknown';
        const text = await renderMentions(client, parent.text);
        return `[thread context — parent message by ${author}]\n${text}\n[end thread context]\n\n`;
      }
      return '';
    }

    // Exclude the last message (the current user prompt) and build context
    const prior = messages.slice(0, -1);
    const lines: string[] = [];
    for (const msg of prior) {
      const author = msg.user
        ? msg.user === botUserId
          ? 'you (bot)'
          : await resolveUser(client, msg.user)
        : msg.bot_id
          ? 'you (bot)'
          : 'unknown';
      const text = await renderMentions(client, msg.text ?? '');
      lines.push(`${author}: ${text}`);
    }
    return `[thread context — previous messages in this thread]\n${lines.join('\n')}\n[end thread context]\n\n`;
  } catch {
    return '';
  }
}

// Cache: subteam ID → Set of member user IDs (refreshed every 10 minutes)
const groupMemberCache = new Map<string, { members: Set<string>; fetchedAt: number }>();
const GROUP_CACHE_TTL = 10 * 60 * 1000;

async function isOwnerInSubteam(
  client: App['client'],
  subteamId: string,
  ownerUserId: string,
): Promise<boolean> {
  const cached = groupMemberCache.get(subteamId);
  if (cached && Date.now() - cached.fetchedAt < GROUP_CACHE_TTL) {
    return cached.members.has(ownerUserId);
  }
  try {
    const res = await client.usergroups.users.list({ usergroup: subteamId });
    const members = new Set(res.users ?? []);
    groupMemberCache.set(subteamId, { members, fetchedAt: Date.now() });
    return members.has(ownerUserId);
  } catch {
    return false;
  }
}

export function registerListeners(
  app: App,
  store: SessionStore,
  config: Config,
  triggerEngine?: TriggerEngine,
  mentionTriggerEngine?: MentionTriggerEngine,
): void {
  const {
    claudeCwd,
    claudeConfigDir,
    botName,
    allowedUserIds,
    maxTurns,
    ownerUserId,
    slackBotToken,
    autoRespondChannelIds,
  } = config;
  const queue = new MessageQueue();
  let botUserId: string | undefined;

  async function ensureBotUserId(client: App['client']): Promise<string> {
    if (botUserId) return botUserId;
    const auth = await client.auth.test();
    botUserId = auth.user_id as string;
    return botUserId;
  }

  async function handleMessage(
    client: App['client'],
    say: (msg: { text: string; thread_ts?: string }) => Promise<unknown>,
    channelId: string,
    sessionKey: string,
    prompt: string,
    senderId?: string,
    sessionId?: string,
    threadTs?: string,
    reactTs?: string,
  ): Promise<void> {
    // Signal work-in-progress with a reaction on the triggering message
    // instead of posting a "_Thinking ..._" message.
    let reacted = false;
    if (reactTs) {
      try {
        await client.reactions.add({
          channel: channelId,
          timestamp: reactTs,
          name: THINKING_REACTION,
        });
        reacted = true;
      } catch (err) {
        if (debug) console.log('[listener] Failed to add thinking reaction:', err);
      }
    }
    const clearReaction = async (): Promise<void> => {
      if (!reacted || !reactTs) return;
      reacted = false;
      try {
        await client.reactions.remove({
          channel: channelId,
          timestamp: reactTs,
          name: THINKING_REACTION,
        });
      } catch (err) {
        if (debug) console.log('[listener] Failed to remove thinking reaction:', err);
      }
    };

    try {
      // Build context-enriched prompt so Claude knows where and who
      const [channelName, senderName] = await Promise.all([
        resolveChannel(client, channelId),
        senderId ? resolveUser(client, senderId) : Promise.resolve('unknown'),
      ]);
      const contextPrefix =
        `[context: channel=#${channelName} (${channelId}), sender=${senderName}` +
        (threadTs ? `, thread=${threadTs}` : '') +
        ']\n\n';
      const enrichedPrompt = contextPrefix + prompt;

      // Interactive messages have no explicit cwd, so this resolves to
      // channels[channelId].cwd ?? CLAUDE_CWD.
      const cwd = resolveCwd(undefined, channelId, claudeCwd);

      const response = await askClaude(
        enrichedPrompt,
        cwd,
        botName,
        maxTurns,
        claudeConfigDir,
        sessionId,
      );
      if (response.isError) {
        if (response.isTransientError) {
          // Network / 5xx failure — the session file is not poisoned, so keep
          // the existing sessionId so the next message can --resume and pick
          // up the full thread context.
          if (debug) console.log('[handle] transient error, keeping session for resume');
        } else {
          // The CLI persists the failed turn into the session file, so any
          // future --resume on this session would replay the bad turn and fail
          // again. Drop the session so the next message starts fresh.
          store.deleteSession(channelId, sessionKey);
        }
      } else {
        store.saveSession(channelId, sessionKey, response.sessionId);
      }

      const { cleanedText, buttons } = extractButtons(response.text);
      const actionsBlock = buttons ? buildActionsBlock(buttons) : null;

      const rtBlocks = markdownToBlocks(cleanedText);
      const messages: Array<{ text: string; blocks?: unknown[] }> =
        rtBlocks.length > 0
          ? rtBlocks.map((b) => ({ blocks: [b] as unknown[], text: blockToFallbackText(b) }))
          : splitMessage(toSlackMarkdown(cleanedText)).map((text) => ({ text }));

      if (actionsBlock) {
        const last = messages[messages.length - 1]!;
        if (last.blocks) {
          last.blocks.push(actionsBlock);
        } else {
          // Plain-text branch — promote to blocks so the actions block has somewhere to attach.
          last.blocks = [
            { type: 'section', text: { type: 'mrkdwn', text: last.text || ' ' } },
            actionsBlock,
          ];
        }
      }

      if (debug) {
        console.log(
          `[response] length=${response.text.length} messages=${messages.length} buttons=${buttons?.length ?? 0}`,
        );
      }

      // Remove the in-progress reaction, then post the response chunks.
      await clearReaction();
      for (const m of messages) {
        await say({
          text: m.text,
          ...(m.blocks ? { blocks: m.blocks as never } : {}),
          ...(threadTs ? { thread_ts: threadTs } : {}),
        } as never);
      }
    } catch (err) {
      console.error('[listener] Error handling message:', err);
      await clearReaction();
      await say({
        text: 'Sorry, something went wrong. Please try again.',
        ...(threadTs ? { thread_ts: threadTs } : {}),
      } as never);
    }
  }

  app.event('app_mention', async ({ event, client, say }) => {
    const threadTs = event.thread_ts ?? event.ts;
    const channelId = event.channel;
    const threadKey = `${channelId}:${threadTs}`;

    if (!event.user) return;
    if (allowedUserIds.size > 0 && !allowedUserIds.has(event.user)) {
      await say({ text: getRejectMessage(), thread_ts: threadTs });
      return;
    }

    const userId = await ensureBotUserId(client);
    const basePrompt = event.text.replace(new RegExp(`<@${userId}>`, 'g'), '').trim();
    const downloaded = await downloadSlackFiles(
      'files' in event ? (event.files as SlackFile[] | undefined) : undefined,
      slackBotToken,
    );
    const prompt = basePrompt + buildFilesPromptSection(downloaded);
    if (!prompt) return;

    if (debug) {
      const [userName, channelName] = await Promise.all([
        resolveUser(client, event.user),
        resolveChannel(client, channelId),
      ]);
      console.log(
        `[mention] user=${userName} channel=#${channelName} thread=${threadTs} prompt="${prompt}"`,
      );
    }

    queue.enqueue(threadKey, async () => {
      let sessionId = store.getSession(channelId, threadTs)?.sessionId;
      if (!sessionId) {
        sessionId = await extractSessionFromParent(client, channelId, threadTs);
        if (debug && sessionId) {
          console.log(`[mention] resuming session from parent message: ${sessionId}`);
        }
      }
      // When no existing session, include thread history so Claude has context
      let enrichedPrompt = prompt;
      if (!sessionId && event.thread_ts) {
        const userId = await ensureBotUserId(client);
        const threadContext = await fetchThreadContext(client, channelId, threadTs, userId);
        enrichedPrompt = threadContext + prompt;
      }
      await handleMessage(
        client,
        say,
        channelId,
        threadTs,
        enrichedPrompt,
        event.user,
        sessionId,
        threadTs,
        event.ts,
      );
    });
  });

  app.event('message', async ({ event, client, say }) => {
    if (!('text' in event) || !event.text) return;
    if ('bot_id' in event && event.bot_id) return;
    if ('subtype' in event && event.subtype) return;

    // Check event-driven triggers — only for top-level messages (not thread replies)
    const isThreadReply = 'thread_ts' in event && event.thread_ts;
    if (triggerEngine && !isThreadReply) {
      const matched = triggerEngine.match(event.text, event.channel);
      if (matched) {
        triggerEngine.recordFired(matched.name);
        runAutomation({
          name: matched.name,
          prompt: `Context: A user said "${event.text}" in this channel.\n\n${matched.prompt}`,
          channel: event.channel,
          cwd: resolveCwd(undefined, event.channel, config.claudeCwd),
          botName: config.botName,
          maxTurns: config.maxTurns,
          claudeConfigDir: config.claudeConfigDir,
          slackClient: client,
          threadTs: event.ts,
          silent: true,
        }).catch((err) => console.error('[trigger] Error:', err));
      }
    }

    // React with eyes emoji when someone mentions the owner (directly or via group)
    if (ownerUserId) {
      let ownerMentioned = event.text.includes(`<@${ownerUserId}>`);

      if (!ownerMentioned) {
        const subteamIds = [...event.text.matchAll(SUBTEAM_MENTION_PATTERN)].map((m) => m[1]!);
        for (const subteamId of subteamIds) {
          if (await isOwnerInSubteam(client, subteamId, ownerUserId)) {
            ownerMentioned = true;
            break;
          }
        }
      }

      if (ownerMentioned) {
        try {
          await client.reactions.add({
            channel: event.channel,
            timestamp: event.ts,
            name: 'eyes',
          });
        } catch (err) {
          if (debug) console.log('[owner-mention] Failed to add eyes reaction:', err);
        }
      }
    }

    // Mention triggers — config-driven. Fires when a configured user is tagged
    // in any channel; runs Claude with the trigger's prompt and posts to its
    // target_channel. Different from pattern triggers (text match) above.
    if (mentionTriggerEngine) {
      const senderId = ('user' in event ? event.user : undefined) as string | undefined;
      const matched = mentionTriggerEngine.matchAll({
        client,
        channelId: event.channel,
        ts: event.ts,
        threadTs: 'thread_ts' in event ? (event.thread_ts as string | undefined) : undefined,
        text: event.text,
        senderId,
      });
      for (const trigger of matched) {
        fireMentionTrigger(
          trigger,
          {
            client,
            channelId: event.channel,
            ts: event.ts,
            threadTs: 'thread_ts' in event ? (event.thread_ts as string | undefined) : undefined,
            text: event.text,
            senderId,
          },
          {
            botName: config.botName,
            maxTurns: config.maxTurns,
            claudeConfigDir: config.claudeConfigDir,
            claudeCwd: config.claudeCwd,
          },
        ).catch((err) => console.error(`[mention-trigger:${trigger.name}] Error:`, err));
      }
    }

    const senderId = ('user' in event ? event.user : undefined) as string | undefined;
    if (allowedUserIds.size > 0 && (!senderId || !allowedUserIds.has(senderId))) return;

    const channelId = event.channel;
    const channelType = ('channel_type' in event ? event.channel_type : undefined) as
      | string
      | undefined;
    const isDM = channelType === 'im';
    const isAutoRespondChannel = autoRespondChannelIds.has(channelId);

    // Outside DMs, Slack also fires `app_mention` for messages that @ the bot.
    // Skip here so app_mention is the sole handler — otherwise we double-process.
    if (!isDM) {
      const botId = await ensureBotUserId(client);
      if (event.text.includes(`<@${botId}>`)) return;
    }

    // DMs and auto-respond channels: every message starts or continues a session.
    // DMs reply at channel root; auto-respond channels thread under the user's
    // message (matching app_mention) so we don't spam the channel with root posts.
    if (isDM || isAutoRespondChannel) {
      const eventThreadTs = ('thread_ts' in event ? event.thread_ts : undefined) as
        | string
        | undefined;
      const threadTs = isAutoRespondChannel ? (eventThreadTs ?? event.ts) : eventThreadTs;
      const sessionKey = threadTs ?? channelId;
      const threadKey = `${channelId}:${sessionKey}`;

      const downloaded = await downloadSlackFiles(
        'files' in event ? (event.files as SlackFile[] | undefined) : undefined,
        slackBotToken,
      );
      const prompt = event.text.trim() + buildFilesPromptSection(downloaded);
      if (!prompt) return;

      if (debug) {
        const userName = senderId ? await resolveUser(client, senderId) : 'unknown';
        console.log(`[dm] user=${userName} thread=${sessionKey} prompt="${prompt}"`);
      }

      queue.enqueue(threadKey, async () => {
        const session = store.getSession(channelId, sessionKey);
        await handleMessage(
          client,
          say,
          channelId,
          sessionKey,
          prompt,
          senderId,
          session?.sessionId,
          threadTs,
          event.ts,
        );
      });
      return;
    }

    // Channels: require @mention to start interacting (handled by app_mention handler).
    // Once a session exists for a thread, allow mention-less replies if the thread
    // only involves the sender and the bot (a private 1-on-1 thread).
    const threadTs = ('thread_ts' in event ? event.thread_ts : undefined) as string | undefined;
    if (!threadTs || !senderId) return;

    const downloaded = await downloadSlackFiles(
      'files' in event ? (event.files as SlackFile[] | undefined) : undefined,
      slackBotToken,
    );
    const prompt = event.text.trim() + buildFilesPromptSection(downloaded);
    if (!prompt) return;

    const threadKey = `${channelId}:${threadTs}`;
    queue.enqueue(threadKey, async () => {
      // Check session inside the queue so a follow-up sent while the prior
      // mention is still processing waits for that mention's session save
      // before checking, instead of being silently dropped.
      const existingSession = store.getSession(channelId, threadTs);
      if (!existingSession) return;

      const botId = await ensureBotUserId(client);
      const participants = await getThreadParticipants(client, channelId, threadTs);
      const humans = new Set([...participants].filter((id) => id !== botId));
      if (humans.size !== 1 || !humans.has(senderId)) return;

      if (debug) {
        const userName = await resolveUser(client, senderId);
        console.log(`[thread-followup] user=${userName} thread=${threadTs} prompt="${prompt}"`);
      }

      await handleMessage(
        client,
        say,
        channelId,
        threadTs,
        prompt,
        senderId,
        existingSession.sessionId,
        threadTs,
        event.ts,
      );
    });
  });

  // Quick-reply button clicks. Strip the actions block from the original
  // message, leave a "✓ Selected: X" context line, then feed the choice
  // back into the same Claude session as if the user had typed it.
  app.action(new RegExp(`^${BUTTON_ACTION_ID_PREFIX}`), async ({ body, ack, client }) => {
    await ack();

    if (body.type !== 'block_actions') return;
    const action = body.actions?.[0];
    if (!action || action.type !== 'button') return;

    const userId = body.user?.id;
    if (allowedUserIds.size > 0 && (!userId || !allowedUserIds.has(userId))) return;

    const channelId = body.channel?.id;
    const message = body.message as
      | {
          ts: string;
          thread_ts?: string;
          blocks?: Array<{ type: string; block_id?: string }>;
          text?: string;
        }
      | undefined;
    if (!channelId || !message) return;

    const choice = (action.value ?? action.text?.text ?? '').trim();
    if (!choice) return;

    const threadTs = message.thread_ts;
    const sessionKey = threadTs ?? channelId;
    const threadKey = `${channelId}:${sessionKey}`;

    // Rebuild message blocks without the actions block, and append a
    // context block showing the selection so the thread reads naturally.
    const remainingBlocks = (message.blocks ?? []).filter(
      (b) => !(b.type === 'actions' && b.block_id?.startsWith('custie_buttons')),
    );
    const selectedBlock = {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `✓ Selected: *${choice}*` }],
    };
    try {
      await client.chat.update({
        channel: channelId,
        ts: message.ts,
        text: message.text ?? choice,
        blocks: [...remainingBlocks, selectedBlock] as never,
      });
    } catch (err) {
      if (debug) console.log('[button] failed to strip actions block:', err);
    }

    const sayInThread = async (msg: { text: string; thread_ts?: string }) => {
      await client.chat.postMessage({ channel: channelId, ...msg });
    };

    queue.enqueue(threadKey, async () => {
      const session = store.getSession(channelId, sessionKey);
      if (debug) {
        console.log(
          `[button] user=${userId} channel=${channelId} thread=${threadTs ?? '(root)'} choice="${choice}" resume=${session?.sessionId ?? 'none'}`,
        );
      }
      await handleMessage(
        client,
        sayInThread,
        channelId,
        sessionKey,
        choice,
        userId,
        session?.sessionId,
        threadTs,
        message.ts,
      );
    });
  });

  // `/custie` slash command. `skills` opens a searchable skill picker; any
  // other (or empty) subcommand shows help. Both replies are ephemeral so the
  // channel stays clean — the skill conversation itself is posted publicly.
  app.command('/custie', async ({ command, ack, respond }) => {
    await ack();

    if (allowedUserIds.size > 0 && !allowedUserIds.has(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: getRejectMessage() });
      return;
    }

    const { sub } = parseCommand(command.text);

    if (sub === 'skills') {
      const cwd = resolveCwd(undefined, command.channel_id, claudeCwd);
      const skills = listSkills(claudeConfigDir, cwd);
      if (skills.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: 'No skills found for this channel.',
        });
        return;
      }
      const msg = buildSkillsMessage(skills);
      await respond({
        response_type: 'ephemeral',
        text: msg.text,
        blocks: msg.blocks as never,
      });
      return;
    }

    const help = buildHelpMessage(botName);
    await respond({
      response_type: 'ephemeral',
      text: help.text,
      blocks: help.blocks as never,
    });
  });

  // Skill picked from the `/custie skills` dropdown. Collapse the ephemeral
  // picker, anchor a public thread, and engage the chosen skill inside it.
  app.action(SKILL_SELECT_ACTION_ID, async ({ body, ack, client, respond }) => {
    await ack();

    if (body.type !== 'block_actions') return;
    const action = body.actions?.[0];
    if (!action || action.type !== 'static_select') return;

    const userId = body.user?.id;
    if (allowedUserIds.size > 0 && (!userId || !allowedUserIds.has(userId))) return;

    const channelId = body.channel?.id;
    const skillName = action.selected_option?.value?.trim();
    if (!channelId || !skillName) return;

    // Collapse the picker so it can't be reused.
    try {
      await respond({
        response_type: 'ephemeral',
        replace_original: true,
        text: `🛠️ Starting *${skillName}*…`,
      });
    } catch (err) {
      if (debug) console.log('[skill-select] failed to collapse picker:', err);
    }

    // Anchor a thread with an intro message; the skill conversation runs inside it.
    const intro = (await client.chat.postMessage({
      channel: channelId,
      text: `🛠️ <@${userId}> started the *${skillName}* skill.`,
    })) as { ts: string };

    const sayInThread = async (msg: { text: string; thread_ts?: string }) => {
      await client.chat.postMessage({ channel: channelId, ...msg });
    };

    const threadKey = `${channelId}:${intro.ts}`;
    queue.enqueue(threadKey, async () => {
      if (debug) {
        console.log(`[skill-select] user=${userId} channel=${channelId} skill="${skillName}"`);
      }
      await handleMessage(
        client,
        sayInThread,
        channelId,
        intro.ts,
        buildSkillPrompt(skillName),
        userId,
        undefined,
        intro.ts,
        intro.ts,
      );
    });
  });
}
