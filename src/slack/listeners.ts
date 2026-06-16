import type { App } from '@slack/bolt';
import type { Config } from '../config';
import type { SessionStore } from '../store/session-store';
import type { ReactionStore } from '../store/reaction-store';
import type { TriggerEngine } from '../automations/triggers';
import {
  type MentionTriggerEngine,
  fireMentionTrigger,
} from '../automations/mention-trigger-engine';
import { askClaude, type ClaudeResponse } from '../claude/agent';
import { runAutomation } from '../automations/runner';
import { resolveCwd, isChannelAccessAllowed } from '../channels';
import { MessageQueue } from '../queue/message-queue';
import { toSlackMarkdown, splitMessage } from './formatters';
import { markdownToBlocks, blockToFallbackText } from './blocks';
import { downloadSlackFiles, buildFilesPromptSection, type SlackFile } from './file-downloader';
import {
  extractButtons,
  buildActionsBlock,
  buildRetryBlock,
  BUTTON_ACTION_ID_PREFIX,
  RETRY_ACTION_ID_PREFIX,
  RETRY_BLOCK_ID,
} from './buttons';
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

// Delay before the automatic single retry after a transient failure.
const RETRY_DELAY_MS = 1500;
// Cap on stored retry contexts to keep the in-memory map bounded.
const MAX_RETRY_CONTEXTS = 50;

// Everything needed to re-run a failed request when the user taps the retry
// button. Stored in-memory and looked up by a short id embedded in the button.
interface RetryContext {
  channelId: string;
  sessionKey: string;
  prompt: string;
  senderId?: string;
  threadTs?: string;
  reactTs?: string;
}

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

// Cache: channel ID → Set of member user IDs (refreshed every 10 minutes).
// Stored with limit=3 — enough to tell "exactly 2 members" from "3+", which is
// all we need for the auto-respond check. Invalidated live via
// member_joined_channel / member_left_channel events when the app is
// subscribed to them; otherwise the TTL bounds staleness.
const channelMemberCache = new Map<string, { members: Set<string>; fetchedAt: number }>();
const CHANNEL_MEMBER_CACHE_TTL = 10 * 60 * 1000;

async function getChannelMembers(
  client: App['client'],
  channelId: string,
): Promise<Set<string>> {
  const cached = channelMemberCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < CHANNEL_MEMBER_CACHE_TTL) {
    return cached.members;
  }
  try {
    const res = await client.conversations.members({ channel: channelId, limit: 3 });
    const members = new Set(res.members ?? []);
    channelMemberCache.set(channelId, { members, fetchedAt: Date.now() });
    return members;
  } catch {
    return new Set();
  }
}

async function isOneOnOneChannel(
  client: App['client'],
  channelId: string,
  senderId: string,
  botId: string,
): Promise<boolean> {
  const members = await getChannelMembers(client, channelId);
  return members.size === 2 && members.has(botId) && members.has(senderId);
}

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

export interface ListenerHandles {
  // Wait for in-flight Claude subprocesses to finish posting their response
  // before the process exits, up to `timeoutMs`. Resolves to true if drained,
  // false on timeout.
  drain(timeoutMs: number): Promise<boolean>;
  pendingCount(): number;
}

export function registerListeners(
  app: App,
  store: SessionStore,
  reactionStore: ReactionStore,
  config: Config,
  triggerEngine?: TriggerEngine,
  mentionTriggerEngine?: MentionTriggerEngine,
): ListenerHandles {
  const {
    claudeCwd,
    claudeConfigDir,
    botName,
    allowedUserIds,
    model,
    maxBudgetUsd,
    ownerUserId,
    slackBotToken,
    autoRespondChannelIds,
  } = config;
  const queue = new MessageQueue();
  let botUserId: string | undefined;

  // Access gate. The global ALLOWED_USER_IDS list applies everywhere; an empty
  // list means open to everyone. `channels.yml` `access` rules widen that list
  // per channel (whole-channel `open`, or a per-channel user allow-list).
  const isAccessAllowed = (
    userId: string | undefined,
    channelId: string | undefined,
  ): boolean => {
    if (allowedUserIds.size === 0) return true;
    if (userId && allowedUserIds.has(userId)) return true;
    return isChannelAccessAllowed(channelId, userId);
  };

  // Pending retry contexts, keyed by a short id embedded in the retry button.
  // In-memory only: a server restart drops them and the button then reports the
  // request expired. Capped to avoid unbounded growth.
  const retryContexts = new Map<string, RetryContext>();
  let retryCounter = 0;
  const registerRetry = (ctx: RetryContext): string => {
    const id = String(++retryCounter);
    retryContexts.set(id, ctx);
    // Map preserves insertion order, so the first key is the oldest entry.
    while (retryContexts.size > MAX_RETRY_CONTEXTS) {
      const oldest = retryContexts.keys().next().value;
      if (oldest === undefined) break;
      retryContexts.delete(oldest);
    }
    return id;
  };

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
        // Persist so startup recovery can clear this if we crash/restart
        // before clearReaction runs.
        reactionStore.markPending(channelId, reactTs, THINKING_REACTION);
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
      // Always drop the pending row, even on remove failure — the reaction is
      // either gone or we've given up on it; either way, no point retrying on
      // every future startup.
      reactionStore.clearPending(channelId, reactTs, THINKING_REACTION);
    };

    // Posted when a request fails even after the automatic retry. Offers a
    // button that re-runs the same request on demand.
    const offerRetry = async (): Promise<void> => {
      await clearReaction();
      const retryId = registerRetry({ channelId, sessionKey, prompt, senderId, threadTs, reactTs });
      const text = '抱歉，連續試了兩次都出錯 😣 點下面的按鈕讓我再試一次。';
      await say({
        text,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text } },
          buildRetryBlock(retryId),
        ],
        ...(threadTs ? { thread_ts: threadTs } : {}),
      } as never);
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

      // Run the attempt, retrying once on a transient failure (a thrown error,
      // or a transient API error like a 5xx / network blip). If both attempts
      // fail, surface a retry button instead of a raw error.
      let response: ClaudeResponse | null = null;
      try {
        response = await askClaude(enrichedPrompt, cwd, botName, { model, maxBudgetUsd }, claudeConfigDir, sessionId);
      } catch (err) {
        if (debug) console.log('[handle] attempt 1 failed:', err);
      }

      // Context too long — progressively shed context and retry fresh.
      if (response?.isContextTooLong) {
        store.deleteSession(channelId, sessionKey);

        const tryAskFresh = async (p: string): Promise<ClaudeResponse | null> => {
          try {
            return await askClaude(p, cwd, botName, { model, maxBudgetUsd }, claudeConfigDir);
          } catch {
            return null;
          }
        };

        // Step 1: if we had a session (prompt has no thread context), add it for continuity.
        if (sessionId && threadTs) {
          const uid = await ensureBotUserId(client);
          const ctx = await fetchThreadContext(client, channelId, threadTs, uid);
          if (ctx) response = await tryAskFresh(ctx + enrichedPrompt);
        }

        // Step 2: strip thread context from prompt and retry bare.
        if (!response || response.isContextTooLong) {
          const bare = enrichedPrompt.replace(
            /\[thread context[^\]]*\][\s\S]*?\[end thread context\]\n*/g,
            '',
          );
          response = await tryAskFresh(bare);
        }

        // All retries exhausted — conversation is too long to continue.
        if (!response || response.isContextTooLong) {
          await clearReaction();
          await say({
            text: '這個對話太長了，沒辦法繼續處理 :pensive: 請另開一個新的 thread，我可以繼續幫你。',
            ...(threadTs ? { thread_ts: threadTs } : {}),
          });
          return;
        }
      }

      const isTransientFailure = (r: ClaudeResponse | null): boolean =>
        !r || (r.isError === true && r.isTransientError === true);

      if (isTransientFailure(response)) {
        if (debug) console.log('[handle] transient failure — retrying once');
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        try {
          response = await askClaude(enrichedPrompt, cwd, botName, { model, maxBudgetUsd }, claudeConfigDir, sessionId);
        } catch (err) {
          if (debug) console.log('[handle] retry attempt failed:', err);
          response = null;
        }
      }

      if (isTransientFailure(response)) {
        // Still failing after the retry. Transient errors don't poison the
        // session file, so keep it intact (the retry button will --resume) and
        // let the user retry on demand.
        await offerRetry();
        return;
      }

      const resolved: ClaudeResponse = response!;
      if (resolved.isError) {
        // Non-transient (timeout, or a 4xx baked into the session file): the CLI
        // persisted the failed turn, so any future --resume would replay the bad
        // turn and fail again. Drop the session so the next message starts fresh.
        store.deleteSession(channelId, sessionKey);
      } else {
        store.saveSession(channelId, sessionKey, resolved.sessionId);
      }

      const { cleanedText, buttons } = extractButtons(resolved.text);
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
          `[response] length=${resolved.text.length} messages=${messages.length} buttons=${buttons?.length ?? 0}`,
        );
      }

      // Remove the in-progress reaction, then post the response chunks.
      await clearReaction();
      for (const m of messages) {
        // Slack rejects chat.postMessage with no_text when `text` is empty,
        // even if `blocks` carries the visible payload. Happens when Claude
        // returns only a `[BUTTONS:...]` marker (cleanedText becomes '')
        // or only whitespace. Skip chunks with no content; otherwise pad
        // `text` to at least one char.
        const trimmed = m.text.trim();
        if (!trimmed && !m.blocks) {
          if (debug) console.log('[listener] skipping empty response chunk');
          continue;
        }
        await say({
          text: trimmed || ' ',
          ...(m.blocks ? { blocks: m.blocks as never } : {}),
          ...(threadTs ? { thread_ts: threadTs } : {}),
        } as never);
      }
    } catch (err) {
      console.error('[listener] Error handling message:', err);
      try {
        await offerRetry();
      } catch (postErr) {
        console.error('[listener] Failed to post retry message:', postErr);
      }
    }
  }

  app.event('app_mention', async ({ event, client, say }) => {
    const threadTs = event.thread_ts ?? event.ts;
    const channelId = event.channel;
    const threadKey = `${channelId}:${threadTs}`;

    if (!event.user) return;
    if (!isAccessAllowed(event.user, channelId)) {
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
    if ('bot_id' in event && event.bot_id) return;
    // Drop edits/deletes/etc., but let `file_share` through — a bare image (or
    // image + caption) posted without an @mention arrives as a `file_share`
    // message, and we want auto-respond/DM/1-on-1 channels to handle it.
    const subtype = 'subtype' in event ? event.subtype : undefined;
    if (subtype && subtype !== 'file_share') return;

    const text = 'text' in event && typeof event.text === 'string' ? event.text : '';
    const hasFiles =
      'files' in event && Array.isArray(event.files) && event.files.length > 0;
    if (!text && !hasFiles) return;

    // Check event-driven triggers — only for top-level messages with text
    // (triggers match on text patterns, so files-only messages don't trigger).
    const isThreadReply = 'thread_ts' in event && event.thread_ts;
    if (triggerEngine && !isThreadReply && text) {
      const matched = triggerEngine.match(text, event.channel);
      if (matched) {
        triggerEngine.recordFired(matched.name);
        runAutomation({
          name: matched.name,
          prompt: `Context: A user said "${text}" in this channel.\n\n${matched.prompt}`,
          channel: event.channel,
          cwd: resolveCwd(undefined, event.channel, config.claudeCwd),
          botName: config.botName,
          model: config.model,
          maxBudgetUsd: config.maxBudgetUsd,
          claudeConfigDir: config.claudeConfigDir,
          slackClient: client,
          threadTs: event.ts,
          silent: true,
        }).catch((err) => console.error('[trigger] Error:', err));
      }
    }

    // React with eyes emoji when someone mentions the owner (directly or via group)
    if (ownerUserId && text) {
      let ownerMentioned = text.includes(`<@${ownerUserId}>`);

      if (!ownerMentioned) {
        const subteamIds = [...text.matchAll(SUBTEAM_MENTION_PATTERN)].map((m) => m[1]!);
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
    if (mentionTriggerEngine && text) {
      const senderId = ('user' in event ? event.user : undefined) as string | undefined;
      const matched = mentionTriggerEngine.matchAll({
        client,
        channelId: event.channel,
        ts: event.ts,
        threadTs: 'thread_ts' in event ? (event.thread_ts as string | undefined) : undefined,
        text,
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
            text,
            senderId,
          },
          {
            botName: config.botName,
            model: config.model,
            maxBudgetUsd: config.maxBudgetUsd,
            claudeConfigDir: config.claudeConfigDir,
            claudeCwd: config.claudeCwd,
          },
        ).catch((err) => console.error(`[mention-trigger:${trigger.name}] Error:`, err));
      }
    }

    const senderId = ('user' in event ? event.user : undefined) as string | undefined;
    if (!isAccessAllowed(senderId, event.channel)) return;

    const channelId = event.channel;
    const channelType = ('channel_type' in event ? event.channel_type : undefined) as
      | string
      | undefined;
    const isDM = channelType === 'im';

    // Outside DMs, Slack also fires `app_mention` for messages that @ the bot.
    // Skip here so app_mention is the sole handler — otherwise we double-process.
    let botId: string | undefined;
    if (!isDM) {
      botId = await ensureBotUserId(client);
      if (text.includes(`<@${botId}>`)) return;
    }

    // Auto-respond when the channel is in the configured allow-list, OR when
    // the channel has exactly two members (the bot + this sender) — i.e. a
    // private 1-on-1 channel that behaves like a DM.
    const isAutoRespondChannel =
      autoRespondChannelIds.has(channelId) ||
      (!isDM && !!senderId && !!botId &&
        (await isOneOnOneChannel(client, channelId, senderId, botId)));

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
      const prompt = text.trim() + buildFilesPromptSection(downloaded);
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
    const prompt = text.trim() + buildFilesPromptSection(downloaded);
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

  // Invalidate the channel membership cache the moment Slack tells us
  // someone joined or left, so 1-on-1 auto-respond flips off as soon as a
  // third person enters the channel (and on as soon as it becomes 1-on-1).
  // If the app isn't subscribed to these events the handlers never fire and
  // the cache TTL is the upper bound on staleness.
  app.event('member_joined_channel', async ({ event }) => {
    channelMemberCache.delete(event.channel);
  });
  app.event('member_left_channel', async ({ event }) => {
    channelMemberCache.delete(event.channel);
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
    const channelId = body.channel?.id;
    if (!isAccessAllowed(userId, channelId)) return;

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

  // Retry button clicks (shown after two consecutive failures). Look up the
  // stored request and re-run it, resuming the session if one still exists.
  app.action(new RegExp(`^${RETRY_ACTION_ID_PREFIX}`), async ({ body, ack, client }) => {
    await ack();

    if (body.type !== 'block_actions') return;
    const action = body.actions?.[0];
    if (!action || action.type !== 'button') return;

    const userId = body.user?.id;
    const channelId = body.channel?.id;
    if (!isAccessAllowed(userId, channelId)) return;

    const message = body.message as
      | {
          ts: string;
          thread_ts?: string;
          blocks?: Array<{ type: string; block_id?: string }>;
          text?: string;
        }
      | undefined;
    if (!channelId || !message) return;

    const retryId = (action.value ?? '').trim();
    const ctx = retryId ? retryContexts.get(retryId) : undefined;

    // Strip the retry button from the original message; we replace it with a
    // status line below.
    const remainingBlocks = (message.blocks ?? []).filter(
      (b) => !(b.type === 'actions' && b.block_id?.startsWith(RETRY_BLOCK_ID)),
    );

    if (!ctx) {
      // Context gone — server restarted, or the button was already used. Expire
      // it so it can't be tapped again.
      try {
        await client.chat.update({
          channel: channelId,
          ts: message.ts,
          text: message.text ?? '重試已逾時',
          blocks: [
            ...remainingBlocks,
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: '⌛ 這個重試已逾時，請直接重新傳一次訊息。' }],
            },
          ] as never,
        });
      } catch (err) {
        if (debug) console.log('[retry] failed to expire button:', err);
      }
      return;
    }

    retryContexts.delete(retryId);

    try {
      await client.chat.update({
        channel: channelId,
        ts: message.ts,
        text: message.text ?? '重試中…',
        blocks: [
          ...remainingBlocks,
          { type: 'context', elements: [{ type: 'mrkdwn', text: '🔄 重試中…' }] },
        ] as never,
      });
    } catch (err) {
      if (debug) console.log('[retry] failed to update message:', err);
    }

    const sayInThread = async (msg: { text: string; thread_ts?: string }) => {
      await client.chat.postMessage({ channel: channelId, ...msg });
    };

    const threadKey = `${channelId}:${ctx.sessionKey}`;
    queue.enqueue(threadKey, async () => {
      const session = store.getSession(channelId, ctx.sessionKey);
      if (debug) {
        console.log(
          `[retry] user=${userId} channel=${channelId} thread=${ctx.threadTs ?? '(root)'} resume=${session?.sessionId ?? 'none'}`,
        );
      }
      await handleMessage(
        client,
        sayInThread,
        channelId,
        ctx.sessionKey,
        ctx.prompt,
        ctx.senderId,
        session?.sessionId,
        ctx.threadTs,
        ctx.reactTs,
      );
    });
  });

  // `/custie` slash command. `skills` opens a searchable skill picker; any
  // other (or empty) subcommand shows help. Both replies are ephemeral so the
  // channel stays clean — the skill conversation itself is posted publicly.
  app.command('/custie', async ({ command, ack, respond }) => {
    await ack();

    if (!isAccessAllowed(command.user_id, command.channel_id)) {
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
    const channelId = body.channel?.id;
    if (!isAccessAllowed(userId, channelId)) return;

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

  // "Fork thread" message shortcut. Summarises the current session (or Slack
  // thread messages as fallback) and opens a new root-level thread in the same
  // channel with the summary as context.
  app.shortcut('custie_fork', async ({ shortcut, ack, client }) => {
    await ack();

    if (shortcut.type !== 'message_action') return;

    const userId = shortcut.user.id;
    const channelId = shortcut.channel.id;
    if (!isAccessAllowed(userId, channelId)) return;

    // Resolve thread root: if the shortcut was invoked on a reply, thread_ts
    // is the root; if invoked on the root itself, fall back to message ts.
    const messageTs = shortcut.message.ts;
    const threadTs = (shortcut.message as { thread_ts?: string }).thread_ts ?? messageTs;

    const session = store.getSession(channelId, threadTs);
    const cwd = resolveCwd(undefined, channelId, claudeCwd);

    const FORK_PROMPT =
      'Please summarise this conversation concisely for a forked thread. Include:\n' +
      '- Key topics and context\n' +
      '- Decisions or conclusions reached\n' +
      '- Open questions / next steps\n\n' +
      'Keep it brief — this will be the opening message of the new thread.';

    // Primary path: resume existing Claude session to generate the summary.
    let summaryResponse: ClaudeResponse | null = null;
    if (session?.sessionId) {
      try {
        summaryResponse = await askClaude(
          FORK_PROMPT,
          cwd,
          botName,
          { model, maxBudgetUsd },
          claudeConfigDir,
          session.sessionId,
        );
        if (summaryResponse.isError) summaryResponse = null;
      } catch {
        summaryResponse = null;
      }
    }

    // Fallback: compile Slack thread messages and summarise from scratch.
    if (!summaryResponse) {
      const botId = await ensureBotUserId(client);
      const threadContext = await fetchThreadContext(client, channelId, threadTs, botId);
      if (!threadContext) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: '找不到這個 thread 的對話內容，無法 fork。',
        });
        return;
      }
      try {
        summaryResponse = await askClaude(
          threadContext + '\n\n' + FORK_PROMPT,
          cwd,
          botName,
          { model, maxBudgetUsd },
          claudeConfigDir,
        );
        if (summaryResponse.isError) summaryResponse = null;
      } catch {
        summaryResponse = null;
      }
    }

    if (!summaryResponse) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: '摘要產生失敗，請稍後再試。',
      });
      return;
    }

    // Post summary as a new root-level message (no thread_ts = new thread root).
    const rtBlocks = markdownToBlocks(summaryResponse.text);
    const newMsg = rtBlocks.length > 0
      ? await client.chat.postMessage({
          channel: channelId,
          text: blockToFallbackText(rtBlocks[0]!),
          blocks: rtBlocks as never,
        })
      : await client.chat.postMessage({
          channel: channelId,
          text: toSlackMarkdown(summaryResponse.text),
        });

    const newTs = (newMsg as { ts: string }).ts;
    const newTsForLink = newTs.replace('.', '');
    const authInfo = await client.auth.test();
    const workspaceUrl = (authInfo.url as string).replace(/\/$/, '');
    const permalink = `${workspaceUrl}/archives/${channelId}/p${newTsForLink}`;

    // Notify the original thread.
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `🍴 Forked → <${permalink}>`,
    });
  });

  return {
    drain: (timeoutMs) => queue.drain(timeoutMs),
    pendingCount: () => queue.pendingCount(),
  };
}
