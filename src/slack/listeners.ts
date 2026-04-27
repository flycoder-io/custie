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
import { MessageQueue } from '../queue/message-queue';
import { toSlackMarkdown, splitMessage } from './formatters';
import { markdownToBlocks, blockToFallbackText } from './blocks';

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
        return `[thread context — parent message by ${author}]\n${parent.text}\n[end thread context]\n\n`;
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
      lines.push(`${author}: ${msg.text ?? ''}`);
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
  const { claudeCwd, claudeConfigDir, botName, allowedUserIds, maxTurns, ownerUserId } = config;
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
  ): Promise<void> {
    // Post a typing placeholder
    const typingMsg = (await client.chat.postMessage({
      channel: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: '_Thinking ..._',
    })) as { ts: string };

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

      const response = await askClaude(
        enrichedPrompt,
        claudeCwd,
        botName,
        maxTurns,
        claudeConfigDir,
        sessionId,
      );
      store.saveSession(channelId, sessionKey, response.sessionId);

      const blocks = markdownToBlocks(response.text);
      const messages = blocks.length > 0
        ? blocks.map((b) => ({ blocks: [b], text: blockToFallbackText(b) }))
        : splitMessage(toSlackMarkdown(response.text)).map((text) => ({ text }));

      if (debug) {
        console.log(
          `[response] length=${response.text.length} messages=${messages.length}`,
        );
      }

      // Update the typing message with the first chunk
      const first = messages[0]!;
      await client.chat.update({
        channel: channelId,
        ts: typingMsg.ts,
        text: first.text,
        ...('blocks' in first ? { blocks: first.blocks } : {}),
      });

      // Post remaining chunks as new messages
      for (let i = 1; i < messages.length; i++) {
        const m = messages[i]!;
        await say({
          text: m.text,
          ...('blocks' in m ? { blocks: m.blocks } : {}),
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      }
    } catch (err) {
      console.error('[listener] Error handling message:', err);
      await client.chat.update({
        channel: channelId,
        ts: typingMsg.ts,
        text: 'Sorry, something went wrong. Please try again.',
      });
    } finally {
      // no-op
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
    const prompt = event.text.replace(new RegExp(`<@${userId}>`, 'g'), '').trim();
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
      await handleMessage(client, say, channelId, threadTs, enrichedPrompt, event.user, sessionId, threadTs);
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
          cwd: config.claudeCwd,
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
        ).catch((err) =>
          console.error(`[mention-trigger:${trigger.name}] Error:`, err),
        );
      }
    }

    const senderId = ('user' in event ? event.user : undefined) as string | undefined;
    if (allowedUserIds.size > 0 && (!senderId || !allowedUserIds.has(senderId))) return;

    const channelId = event.channel;
    const channelType = ('channel_type' in event ? event.channel_type : undefined) as
      | string
      | undefined;
    const isDM = channelType === 'im';

    // DMs: every message starts or continues a session (keyed by channel)
    if (isDM) {
      const threadTs = ('thread_ts' in event ? event.thread_ts : undefined) as string | undefined;
      const sessionKey = threadTs ?? channelId;
      const threadKey = `${channelId}:${sessionKey}`;

      const prompt = event.text.trim();
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
        );
      });
      return;
    }

    // Channels: require @mention to start interacting (handled by app_mention handler).
    // Once a session exists for a thread, allow mention-less replies if the thread
    // only involves the sender and the bot (a private 1-on-1 thread).
    const threadTs = ('thread_ts' in event ? event.thread_ts : undefined) as string | undefined;
    if (!threadTs || !senderId) return;

    const existingSession = store.getSession(channelId, threadTs);
    if (!existingSession) return;

    const botId = await ensureBotUserId(client);
    const participants = await getThreadParticipants(client, channelId, threadTs);
    const humans = new Set([...participants].filter((id) => id !== botId));
    if (humans.size !== 1 || !humans.has(senderId)) return;

    const prompt = event.text.trim();
    if (!prompt) return;

    if (debug) {
      const userName = await resolveUser(client, senderId);
      console.log(`[thread-followup] user=${userName} thread=${threadTs} prompt="${prompt}"`);
    }

    const threadKey = `${channelId}:${threadTs}`;
    queue.enqueue(threadKey, async () => {
      await handleMessage(
        client,
        say,
        channelId,
        threadTs,
        prompt,
        senderId,
        existingSession.sessionId,
        threadTs,
      );
    });
  });
}
