import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import cron from 'node-cron';
import { paths } from '../paths';

export const DEFAULT_TIMEZONE = 'Australia/Sydney';

export interface ScheduleAutomation {
  name: string;
  enabled: boolean;
  cron: string;
  prompt: string;
  channel: string;
  timezone?: string;
  cwd?: string;
  catchup?: boolean;
  silent?: boolean;
  created_by?: string;
  created_at?: string;
}

export interface TriggerAutomation {
  name: string;
  enabled: boolean;
  patterns: string[];
  channels: string[];
  require_mention: boolean;
  cooldown: number;
  prompt: string;
  created_by?: string;
  created_at?: string;
}

// Fires when a specific user is @-mentioned. Unlike TriggerAutomation
// (text-pattern matching, top-level only), this fires on the *event of being
// tagged*, in any channel, in threads too — and posts to a separate channel.
// Use case: surface mentions of yourself to your private summary channel so
// you don't have to track many channels manually.
export interface MentionTrigger {
  name: string;
  enabled: boolean;
  // Whose mention triggers this. 'owner' resolves to OWNER_USER_ID env var.
  // Otherwise a literal Slack user ID like 'U027C1PSVEJ'.
  user: string;
  // Channel where the summary is posted (channel ID preferred to skip resolution).
  target_channel: string;
  // Optional emoji to add as a reaction on the source message (no leading colon).
  react_with?: string;
  // Whether to fire on thread-reply mentions too. Default: true.
  include_thread_replies?: boolean;
  // Dedup per (channel, thread) so one thread → one summary. Default: true.
  dedup_per_thread?: boolean;
  // Restrict to certain source channels. Empty/undefined = listen everywhere.
  source_channels?: string[];
  prompt: string;
  created_by?: string;
  created_at?: string;
}

export interface AutomationsConfig {
  schedules: ScheduleAutomation[];
  triggers: TriggerAutomation[];
  mention_triggers: MentionTrigger[];
}

const EMPTY_CONFIG: AutomationsConfig = { schedules: [], triggers: [], mention_triggers: [] };

export function loadAutomations(): AutomationsConfig {
  const filePath = paths.AUTOMATIONS_FILE;
  if (!existsSync(filePath)) return { ...EMPTY_CONFIG };

  const raw = readFileSync(filePath, 'utf-8');
  if (!raw.trim()) return { ...EMPTY_CONFIG };

  const parsed = yaml.load(raw) as Partial<AutomationsConfig> | null;
  return {
    schedules: parsed?.schedules ?? [],
    triggers: parsed?.triggers ?? [],
    mention_triggers: parsed?.mention_triggers ?? [],
  };
}

export function saveAutomations(config: AutomationsConfig): void {
  const filePath = paths.AUTOMATIONS_FILE;
  const content = yaml.dump(config, { lineWidth: 120, noRefs: true });
  writeFileSync(filePath, content, 'utf-8');
}

export function validateSchedule(s: ScheduleAutomation): string[] {
  const errors: string[] = [];
  if (!s.name) errors.push('name is required');
  if (!s.cron) errors.push('cron expression is required');
  else if (!cron.validate(s.cron)) errors.push(`invalid cron expression: ${s.cron}`);
  if (!s.prompt) errors.push('prompt is required');
  if (!s.channel) errors.push('channel is required');
  return errors;
}

export function validateTrigger(t: TriggerAutomation): string[] {
  const errors: string[] = [];
  if (!t.name) errors.push('name is required');
  if (!t.patterns?.length) errors.push('at least one pattern is required');
  if (!t.channels?.length) errors.push('at least one channel is required');
  if (!t.prompt) errors.push('prompt is required');
  if (t.cooldown < 0) errors.push('cooldown must be >= 0');
  return errors;
}

export function validateMentionTrigger(t: MentionTrigger): string[] {
  const errors: string[] = [];
  if (!t.name) errors.push('name is required');
  if (!t.user) errors.push('user is required (Slack user ID or "owner")');
  if (!t.target_channel) errors.push('target_channel is required');
  if (!t.prompt) errors.push('prompt is required');
  return errors;
}
