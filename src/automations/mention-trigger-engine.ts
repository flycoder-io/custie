import type { App } from '@slack/bolt';
import type { MentionTrigger } from './config';
import { runAutomation } from './runner';
import { displayNameFor, ensureUsersCached } from '../store/user-cache';

export interface MentionTriggerEngineOpts {
  ownerUserId?: string;
  // Resolve the bot's own user ID — used to skip mentions of the bot itself.
  // Returning undefined means "don't filter self-mentions".
  getBotUserId?: () => Promise<string | undefined>;
}

export interface MentionEventInput {
  client: App['client'];
  channelId: string;
  ts: string;
  threadTs?: string;
  text: string;
  senderId?: string;
}

export class MentionTriggerEngine {
  private triggers: MentionTrigger[] = [];
  private dedupSeen = new Set<string>(); // `${name}:${channelId}:${threadTs}`
  private opts: MentionTriggerEngineOpts;

  constructor(opts: MentionTriggerEngineOpts = {}) {
    this.opts = opts;
  }

  load(triggers: MentionTrigger[]): void {
    this.triggers = triggers;
  }

  // Resolves a configured 'user' field to a concrete Slack user ID.
  // Returns undefined when the alias can't be resolved.
  private resolveTargetUser(t: MentionTrigger): string | undefined {
    if (t.user === 'owner') return this.opts.ownerUserId;
    return t.user;
  }

  // Returns the list of triggers that match this event. (Plural — different
  // configs can react to the same event, e.g. one for owner, one for a teammate.)
  matchAll(event: MentionEventInput): MentionTrigger[] {
    const isThreadReply = !!event.threadTs && event.threadTs !== event.ts;
    const matched: MentionTrigger[] = [];

    for (const t of this.triggers) {
      if (!t.enabled) continue;

      const targetUser = this.resolveTargetUser(t);
      if (!targetUser) continue;
      if (!event.text.includes(`<@${targetUser}>`)) continue;

      const includeThreads = t.include_thread_replies ?? true;
      if (isThreadReply && !includeThreads) continue;

      if (t.source_channels?.length) {
        if (!t.source_channels.includes(event.channelId)) continue;
      }

      // Dedup — prevent firing twice on the same thread.
      if (t.dedup_per_thread !== false) {
        const dedupKey = `${t.name}:${event.channelId}:${event.threadTs ?? event.ts}`;
        if (this.dedupSeen.has(dedupKey)) continue;
        this.dedupSeen.add(dedupKey);
      }

      matched.push(t);
    }

    return matched;
  }
}

// Fire a single mention trigger: react, fetch thread, send to runAutomation.
export async function fireMentionTrigger(
  trigger: MentionTrigger,
  event: MentionEventInput,
  config: {
    botName: string;
    maxTurns: number;
    claudeConfigDir?: string;
    claudeCwd: string;
  },
): Promise<void> {
  const { client, channelId, ts, threadTs } = event;

  // Best-effort reaction. Slack collapses duplicate emoji reactions, so it's
  // safe even if multiple triggers configure the same emoji.
  if (trigger.react_with) {
    try {
      await client.reactions.add({
        channel: channelId,
        timestamp: ts,
        name: trigger.react_with,
      });
    } catch (err) {
      console.warn(`[mention-trigger:${trigger.name}] reaction failed:`, err);
    }
  }

  // Fetch the thread (parent + replies). For top-level mentions with no replies
  // yet, this returns just the parent message.
  const parentTs = threadTs ?? ts;
  let messages: Array<{ user?: string; bot_id?: string; text?: string; ts?: string }> = [];
  try {
    const res = await client.conversations.replies({
      channel: channelId,
      ts: parentTs,
      limit: 100,
    });
    messages = (res.messages ?? []).map((m) => ({
      user: m.user,
      bot_id: m.bot_id,
      text: m.text,
      ts: m.ts,
    }));
  } catch (err) {
    console.warn(`[mention-trigger:${trigger.name}] fetch thread failed:`, err);
    return;
  }

  // Resolve user IDs to display names (no-op if users:read scope is missing).
  const userIds = [...new Set(messages.map((m) => m.user).filter(Boolean))] as string[];
  await ensureUsersCached(client, userIds);

  // Resolve channel info for the source channel.
  let channelLabel = channelId;
  try {
    const info = await client.conversations.info({ channel: channelId });
    if (info.channel?.name) channelLabel = `#${info.channel.name}`;
  } catch {
    // Keep channelId as label
  }

  // Format thread for the prompt.
  const formatted = messages
    .map((m) => {
      const author = m.user ? displayNameFor(m.user) : m.bot_id ?? 'unknown';
      const time = m.ts
        ? new Date(parseFloat(m.ts) * 1000).toLocaleString('en-AU', {
            timeZone: 'Australia/Sydney',
          })
        : '?';
      return `[${time}] ${author}: ${m.text ?? ''}`;
    })
    .join('\n');

  const promptBody =
    `Source channel: ${channelLabel}\n` +
    `Triggered by: ${event.senderId ? displayNameFor(event.senderId) : 'unknown'}\n` +
    `Thread (${messages.length} message${messages.length === 1 ? '' : 's'}):\n` +
    `\n${formatted}\n\n` +
    `---\n\n${trigger.prompt}`;

  await runAutomation({
    name: trigger.name,
    prompt: promptBody,
    channel: trigger.target_channel,
    cwd: config.claudeCwd,
    botName: config.botName,
    maxTurns: config.maxTurns,
    claudeConfigDir: config.claudeConfigDir,
    slackClient: client,
  });
}
