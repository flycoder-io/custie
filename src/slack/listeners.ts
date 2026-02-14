import type { App } from '@slack/bolt';
import type { Config } from '../config';
import type { SessionStore } from '../store/session-store';
import { askClaude } from '../claude/agent';
import { MessageQueue } from '../queue/message-queue';
import { toSlackMarkdown, splitMessage } from './formatters';

const REJECT_MESSAGES = [
  "Sorry, I'm a personal assistant and only respond to my owner. :bow:",
  "I appreciate the interest, but I'm exclusively dedicated to my owner. :lock:",
  "Flattered you'd ask, but I'm a one-person bot. :robot_face:",
  "I'm on a strict guest list, and you're not on it — yet! :clipboard:",
  "My owner keeps me on a short leash. Nothing personal! :dog:",
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

export function registerListeners(app: App, store: SessionStore, config: Config): void {
  const { claudeCwd, claudeConfigDir, botName, allowedUserIds, maxTurns } = config;
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
      const response = await askClaude(prompt, claudeCwd, botName, maxTurns, claudeConfigDir, sessionId);
      store.saveSession(channelId, sessionKey, response.sessionId);

      const formatted = toSlackMarkdown(response.text);
      const chunks = splitMessage(formatted);

      if (debug) {
        console.log(`[response] length=${response.text.length} chunks=${chunks.length} chunkSizes=[${chunks.map((c) => c.length).join(',')}]`);
      }

      // Update the typing message with the first chunk
      await client.chat.update({
        channel: channelId,
        ts: typingMsg.ts,
        text: chunks[0],
      });

      // Post remaining chunks as new messages
      for (let i = 1; i < chunks.length; i++) {
        await say({ text: chunks[i], ...(threadTs ? { thread_ts: threadTs } : {}) });
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
      console.log(`[mention] user=${userName} channel=#${channelName} thread=${threadTs} prompt="${prompt}"`);
    }

    queue.enqueue(threadKey, async () => {
      let sessionId = store.getSession(channelId, threadTs)?.sessionId;
      if (!sessionId) {
        sessionId = await extractSessionFromParent(client, channelId, threadTs);
        if (debug && sessionId) {
          console.log(`[mention] resuming session from parent message: ${sessionId}`);
        }
      }
      await handleMessage(client, say, channelId, threadTs, prompt, sessionId, threadTs);
    });
  });

  app.event('message', async ({ event, client, say }) => {
    if (!('text' in event) || !event.text) return;
    if ('bot_id' in event && event.bot_id) return;
    if ('subtype' in event && event.subtype) return;

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
        await handleMessage(client, say, channelId, sessionKey, prompt, session?.sessionId, threadTs);
      });
      return;
    }

    // Channels: only respond in threads with an active session
    if (!('thread_ts' in event) || !event.thread_ts) return;

    const threadTs = event.thread_ts;
    const threadKey = `${channelId}:${threadTs}`;

    const session = store.getSession(channelId, threadTs);
    if (!session) return;

    const userId = await ensureBotUserId(client);
    // Skip if message mentions the bot (handled by app_mention)
    if (event.text.includes(`<@${userId}>`)) return;
    // Skip if message mentions another user — they're talking to someone else
    if (/<@U[A-Z0-9]+>/.test(event.text)) return;

    const prompt = event.text.trim();
    if (!prompt) return;

    if (debug) {
      const [userName, channelName] = await Promise.all([
        senderId ? resolveUser(client, senderId) : Promise.resolve('unknown'),
        resolveChannel(client, channelId),
      ]);
      console.log(`[thread] user=${userName} channel=#${channelName} thread=${threadTs} prompt="${prompt}"`);
    }

    queue.enqueue(threadKey, async () => {
      await handleMessage(client, say, channelId, threadTs, prompt, session.sessionId, threadTs);
    });
  });
}
