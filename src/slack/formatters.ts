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

  // Convert bullet lists: `- ` / `+ ` / `* ` at start of line → `• `
  // (Slack mrkdwn has no native list syntax — the dash renders as a literal dash.)
  // Preserve leading indentation so nested items still look indented.
  result = result.replace(/^(\s*)[-+] (?=\S)/gm, '$1• ');
  result = result.replace(/^(\s*)\* (?=\S)/gm, '$1• ');

  // Slack mrkdwn requires ASCII word boundaries around bold/italic markers.
  // CJK characters and full-width punctuation aren't recognised, so e.g. `*危機感*：`
  // renders with literal asterisks. Insert a thin gap so Slack picks up the boundary.
  // We use the BOUNDARY chars Slack accepts: whitespace + ASCII punct .,;:!?-()[]{}'"`
  result = ensureSlackBoundaries(result);

  return result;
}

const SLACK_BOUNDARY = `\\s.,;:!?\\-()\\[\\]{}'"\`*_~`;

// A bold span: *X* or *X...X* where the inner edges are non-whitespace and contain no *.
const BOLD_SPAN = String.raw`\*(?:\S|\S[^*\n]*?\S)\*`;
const ITALIC_SPAN = String.raw`_(?:\S|\S[^_\n]*?\S)_`;

function ensureSlackBoundaries(text: string): string {
  let result = text;
  for (const span of [BOLD_SPAN, ITALIC_SPAN]) {
    // Add a space after the closing marker if followed by a non-boundary char (e.g. CJK punct).
    const trailing = new RegExp(`(${span})(?=[^${SLACK_BOUNDARY}])`, 'g');
    result = result.replace(trailing, '$1 ');
    // Add a space before the opening marker if preceded by a non-boundary char.
    const leading = new RegExp(`(?<=[^${SLACK_BOUNDARY}])(${span})`, 'g');
    result = result.replace(leading, ' $1');
  }
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
