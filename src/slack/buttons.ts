// Quick-reply buttons. Claude emits `[BUTTONS: A | B | C]` on its own line at the
// end of a message; we strip the marker and append a Block Kit `actions` block.

export type ButtonOption = string;

export interface ButtonElement {
  type: 'button';
  action_id: string;
  text: { type: 'plain_text'; text: string };
  value: string;
}

export interface ActionsBlock {
  type: 'actions';
  block_id: string;
  elements: ButtonElement[];
}

export const BUTTON_ACTION_ID_PREFIX = 'custie_button_';
export const BUTTONS_BLOCK_ID = 'custie_buttons';

// Retry button shown after a request fails twice. The action_id carries a short
// id that maps back to the original request so it can be re-run on click.
export const RETRY_ACTION_ID_PREFIX = 'custie_retry_';
export const RETRY_BLOCK_ID = 'custie_retry';

// Match the marker on its own line, anywhere in the message — not just at the
// end. Two tolerated shapes:
//   1. Properly closed: `[BUTTONS: ...]` followed by newline or end of input.
//   2. Truncated: `[BUTTONS: ...` running straight into end of input with no
//      closing `]` (model output got cut off mid-marker).
const BUTTONS_PATTERN = /(?:^|\n)[ \t]*\[BUTTONS:\s*([^\]\n]+?)(?:\][ \t]*(?=\n|$)|$)/i;

// Slack plain_text button labels cap at 75 chars. Keep some margin.
const MAX_LABEL_LENGTH = 70;
// Slack caps an actions block at 25 elements.
const MAX_BUTTONS = 5;

export function extractButtons(text: string): { cleanedText: string; buttons: ButtonOption[] | null } {
  const match = text.match(BUTTONS_PATTERN);
  if (!match) return { cleanedText: text, buttons: null };

  const raw = match[1] ?? '';
  const buttons = raw
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, MAX_BUTTONS)
    .map((s) => (s.length > MAX_LABEL_LENGTH ? s.slice(0, MAX_LABEL_LENGTH - 1) + '…' : s));

  if (buttons.length === 0) return { cleanedText: text, buttons: null };

  const cleanedText = text.replace(BUTTONS_PATTERN, '').trim();
  return { cleanedText, buttons };
}

export function buildActionsBlock(buttons: ButtonOption[]): ActionsBlock {
  return {
    type: 'actions',
    block_id: BUTTONS_BLOCK_ID,
    elements: buttons.map((label, i) => ({
      type: 'button',
      action_id: `${BUTTON_ACTION_ID_PREFIX}${i}`,
      text: { type: 'plain_text', text: label },
      value: label,
    })),
  };
}

export function buildRetryBlock(retryId: string, label = '🔄 重新整理'): ActionsBlock {
  return {
    type: 'actions',
    block_id: RETRY_BLOCK_ID,
    elements: [
      {
        type: 'button',
        action_id: `${RETRY_ACTION_ID_PREFIX}${retryId}`,
        text: { type: 'plain_text', text: label },
        value: retryId,
      },
    ],
  };
}
