import type { App } from '@slack/bolt';
import { askClaude } from '../claude/agent';
import { toSlackMarkdown, splitMessage } from '../slack/formatters';
import { markdownToBlocks, blockToFallbackText } from '../slack/blocks';
import { resolveChannelId } from '../store/channel-cache';

export interface RunAutomationOpts {
  name: string;
  prompt: string;
  channel: string;
  cwd: string;
  botName: string;
  maxTurns: number;
  claudeConfigDir?: string;
  slackClient: App['client'];
  threadTs?: string;
  silent?: boolean;
}

export async function runAutomation(opts: RunAutomationOpts): Promise<void> {
  const { name, prompt, channel, cwd, botName, maxTurns, claudeConfigDir, slackClient, threadTs, silent } = opts;

  // Prefix lets Claude detect it's running as a scheduled automation (vs an
  // interactive Slack message). system.capabilities.md teaches it that in this
  // mode, its response IS the message — don't try to post via Slack tools.
  const automationPrefix = `[automation: schedule=${name}${silent ? ', silent=true' : ''}]\n\n`;

  try {
    const channelId = await resolveChannelId(slackClient, channel);
    const response = await askClaude(automationPrefix + prompt, cwd, botName, maxTurns, claudeConfigDir);

    // In silent mode, Claude handles posting via custie slack post in the prompt
    if (silent) return;

    const blocks = markdownToBlocks(response.text);
    const messages = blocks.length > 0
      ? blocks.map((b) => ({ blocks: [b], text: blockToFallbackText(b) }))
      : splitMessage(toSlackMarkdown(response.text)).map((text) => ({ text }));

    for (const m of messages) {
      await slackClient.chat.postMessage({
        channel: channelId,
        text: m.text,
        ...('blocks' in m ? { blocks: m.blocks } : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    }
  } catch (err) {
    console.error(`[automation] Error running automation:`, err);
  }
}
