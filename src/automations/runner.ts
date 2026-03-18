import type { App } from '@slack/bolt';
import { askClaude } from '../claude/agent';
import { toSlackMarkdown, splitMessage } from '../slack/formatters';

const channelIdCache = new Map<string, string>();

async function resolveChannelId(client: App['client'], channel: string): Promise<string> {
  // Already a channel ID
  if (!channel.startsWith('#')) return channel;

  const name = channel.slice(1);
  const cached = channelIdCache.get(name);
  if (cached) return cached;

  let cursor: string | undefined;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      limit: 200,
      cursor,
    });
    for (const ch of res.channels ?? []) {
      if (ch.name === name && ch.id) {
        channelIdCache.set(name, ch.id);
        return ch.id;
      }
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  throw new Error(`Channel not found: ${channel}`);
}

export interface RunAutomationOpts {
  prompt: string;
  channel: string;
  cwd: string;
  botName: string;
  maxTurns: number;
  claudeConfigDir?: string;
  slackClient: App['client'];
  threadTs?: string;
}

export async function runAutomation(opts: RunAutomationOpts): Promise<void> {
  const { prompt, channel, cwd, botName, maxTurns, claudeConfigDir, slackClient, threadTs } = opts;

  try {
    const channelId = await resolveChannelId(slackClient, channel);
    const response = await askClaude(prompt, cwd, botName, maxTurns, claudeConfigDir);

    const formatted = toSlackMarkdown(response.text);
    const chunks = splitMessage(formatted);

    for (const chunk of chunks) {
      await slackClient.chat.postMessage({
        channel: channelId,
        text: chunk,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    }
  } catch (err) {
    console.error(`[automation] Error running automation:`, err);
  }
}
