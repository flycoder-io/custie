const SLACK_MAX_LENGTH = 2900; // Stay under Slack's 3000-char section block limit

// Convert markdown to Slack mrkdwn
export function toSlackMarkdown(text: string): string {
  let result = text;

  // Convert fenced code blocks: ```lang\n...\n``` → ```\n...\n```
  // (Slack doesn't support language hints)
  result = result.replace(/```\w*\n/g, '```\n');

  // Convert inline code (backticks are the same in both formats — no change needed)

  // Convert bold: **text** → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Convert italic: _text_ is the same in Slack, but *text* (single) in markdown is italic.
  // Since we just converted **bold** → *bold*, single asterisks from original markdown
  // would have been _italic_ in standard markdown — Slack uses _italic_ too, so no change.

  // Convert links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Convert headings: ### text → *text*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  return result;
}

// Split a message if it exceeds Slack's limit
export function splitMessage(text: string): string[] {
  if (text.length <= SLACK_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', SLACK_MAX_LENGTH);
    if (splitAt < SLACK_MAX_LENGTH / 2) {
      // If no good newline, split at a space
      splitAt = remaining.lastIndexOf(' ', SLACK_MAX_LENGTH);
    }
    if (splitAt < SLACK_MAX_LENGTH / 2) {
      // Last resort: hard split
      splitAt = SLACK_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
