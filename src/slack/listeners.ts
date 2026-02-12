import type { App } from '@slack/bolt';
import type { Config } from '../config.js';
import type { SessionStore } from '../store/session-store.js';
import { askClaude } from '../claude/agent.js';
import { MessageQueue } from '../queue/message-queue.js';
import { toSlackMarkdown, splitMessage } from './formatters.js';

const REJECT_MESSAGE = "Sorry, I'm a personal assistant and only respond to my owner. :bow:";

export function registerListeners(app: App, store: SessionStore, config: Config): void {
  const { claudeCwd, allowedUserIds } = config;
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
      const response = await askClaude(prompt, claudeCwd, sessionId);
      store.saveSession(channelId, sessionKey, response.sessionId);

      const formatted = toSlackMarkdown(response.text);
      const chunks = splitMessage(formatted);

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

    if (allowedUserIds.size > 0 && !allowedUserIds.has(event.user)) {
      await say({ text: REJECT_MESSAGE, thread_ts: threadTs });
      return;
    }

    const userId = await ensureBotUserId(client);
    const prompt = event.text.replace(new RegExp(`<@${userId}>`, 'g'), '').trim();
    if (!prompt) return;

    queue.enqueue(threadKey, async () => {
      const session = store.getSession(channelId, threadTs);
      await handleMessage(client, say, channelId, threadTs, prompt, session?.sessionId, threadTs);
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
    if (event.text.includes(`<@${userId}>`)) return;

    const prompt = event.text.trim();
    if (!prompt) return;

    queue.enqueue(threadKey, async () => {
      await handleMessage(client, say, channelId, threadTs, prompt, session.sessionId, threadTs);
    });
  });
}
