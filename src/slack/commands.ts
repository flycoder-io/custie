// Helpers for the `/custie` slash command: parsing the subcommand and building
// the Block Kit payloads for the skill picker and help message. Registration
// of the handlers lives in `listeners.ts`, alongside the button action handler,
// so it can reuse the shared message-handling pipeline.

import type { Skill } from '../claude/skills';

export const SKILL_SELECT_ACTION_ID = 'custie_skill_select';
export const SKILL_SELECT_BLOCK_ID = 'custie_skill_select_block';

// Slack static_select option `text` and `description` cap at 75 chars.
const MAX_OPTION_TEXT = 74;
const MAX_OPTION_DESC = 74;
// Slack caps a static_select at 100 options.
const MAX_OPTIONS = 100;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export interface ParsedCommand {
  sub: string;
  rest: string;
}

/** Split slash-command text into a lowercased subcommand and the remainder. */
export function parseCommand(text: string | undefined): ParsedCommand {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { sub: '', rest: '' };
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return { sub: trimmed.toLowerCase(), rest: '' };
  return {
    sub: trimmed.slice(0, spaceIdx).toLowerCase(),
    rest: trimmed.slice(spaceIdx + 1).trim(),
  };
}

export interface SlackMessageContent {
  text: string;
  blocks: unknown[];
}

/** Build the skill-picker message: a header plus a searchable select menu. */
export function buildSkillsMessage(skills: Skill[]): SlackMessageContent {
  const options = skills.slice(0, MAX_OPTIONS).map((skill) => ({
    text: { type: 'plain_text', text: truncate(skill.name, MAX_OPTION_TEXT) },
    value: skill.name,
    ...(skill.description
      ? {
          description: {
            type: 'plain_text',
            text: truncate(skill.description, MAX_OPTION_DESC),
          },
        }
      : {}),
  }));

  return {
    text: `${skills.length} skills available`,
    blocks: [
      {
        type: 'section',
        block_id: SKILL_SELECT_BLOCK_ID,
        text: {
          type: 'mrkdwn',
          text: `*Skills* — ${skills.length} available. Pick one to get started:`,
        },
        accessory: {
          type: 'static_select',
          action_id: SKILL_SELECT_ACTION_ID,
          placeholder: { type: 'plain_text', text: 'Search skills…' },
          options,
        },
      },
    ],
  };
}

/** Build the `/custie help` message. */
export function buildHelpMessage(botName: string): SlackMessageContent {
  const text = [
    `*${botName}* — Claude, inside your Slack.`,
    '',
    '• *Chat* — @-mention me in a channel, or send me a DM. I keep context per thread.',
    '• `/custie skills` — browse the available skills and start one.',
    '• `/custie help` — show this message.',
  ].join('\n');
  return {
    text: `${botName} help`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

/** The prompt fed to Claude when a skill is picked from the dropdown. */
export function buildSkillPrompt(skillName: string): string {
  return (
    `I'd like to use the \`${skillName}\` skill. ` +
    'Please start it now and ask me for whatever you need to proceed.'
  );
}
