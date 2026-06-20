import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import cron from 'node-cron';
import { paths } from '../paths';
import { loadChannels, expandPath } from '../channels';

export const DEFAULT_TIMEZONE = 'Australia/Sydney';

export interface ScheduleAutomation {
  name: string;
  enabled: boolean;
  cron: string;
  prompt: string;
  channel: string;
  timezone?: string;
  cwd?: string;
  /**
   * Per-automation Claude model (`--model`, e.g. `opus` / `haiku`). Lets heavy
   * automations use a stronger model and routine polling/digests use a cheaper
   * one. Absent = fall back to the global CUSTIE_MODEL.
   */
  model?: string;
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
  /** Per-automation Claude model override; absent = global CUSTIE_MODEL. */
  model?: string;
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
  /** Per-automation Claude model override; absent = global CUSTIE_MODEL. */
  model?: string;
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

// Validation options. When an automation is nested under a channel block, the
// parent supplies `channel` / `channels` / `target_channel`, so those fields
// are not required in the YAML.
export interface ValidateOpts {
  nested?: boolean;
}

export function validateSchedule(s: ScheduleAutomation, opts: ValidateOpts = {}): string[] {
  const errors: string[] = [];
  if (!s.name) errors.push('name is required');
  if (!s.cron) errors.push('cron expression is required');
  else if (!cron.validate(s.cron)) errors.push(`invalid cron expression: ${s.cron}`);
  if (!s.prompt) errors.push('prompt is required');
  if (!opts.nested && !s.channel) errors.push('channel is required');
  return errors;
}

export function validateTrigger(t: TriggerAutomation, opts: ValidateOpts = {}): string[] {
  const errors: string[] = [];
  if (!t.name) errors.push('name is required');
  if (!t.patterns?.length) errors.push('at least one pattern is required');
  if (!opts.nested && !t.channels?.length) errors.push('at least one channel is required');
  if (!t.prompt) errors.push('prompt is required');
  if (t.cooldown < 0) errors.push('cooldown must be >= 0');
  return errors;
}

export function validateMentionTrigger(t: MentionTrigger, opts: ValidateOpts = {}): string[] {
  const errors: string[] = [];
  if (!t.name) errors.push('name is required');
  if (!t.user) errors.push('user is required (Slack user ID or "owner")');
  if (!opts.nested && !t.target_channel) errors.push('target_channel is required');
  if (!t.prompt) errors.push('prompt is required');
  return errors;
}

/**
 * Effective automation list: `automations.yml` merged with every channel
 * block's automations. Nested entries inherit `channel`/`cwd` from their block
 * (an explicit `cwd` still wins); nested trigger `channels` and mention-trigger
 * `target_channel` default to the block ID. Duplicate names are skipped with a
 * warning so the first definition wins.
 */
export function loadEffectiveAutomations(): AutomationsConfig {
  const base = loadAutomations();
  const merged: AutomationsConfig = {
    schedules: [...base.schedules],
    triggers: [...base.triggers],
    mention_triggers: [...base.mention_triggers],
  };

  const seen = new Set<string>([
    ...base.schedules.map((s) => s.name),
    ...base.triggers.map((t) => t.name),
    ...base.mention_triggers.map((m) => m.name),
  ]);

  const claim = (name: string, kind: string): boolean => {
    if (!name) return true;
    if (seen.has(name)) {
      console.warn(`[automations] Duplicate ${kind} name "${name}" — skipping channel-scoped copy`);
      return false;
    }
    seen.add(name);
    return true;
  };

  const { channels } = loadChannels();
  for (const [channelId, entry] of Object.entries(channels)) {
    const blockCwd = entry.cwd;
    const a = entry.automations;
    if (!a) continue;

    for (const s of a.schedules ?? []) {
      if (!claim(s.name, 'schedule')) continue;
      merged.schedules.push({
        ...s,
        channel: s.channel ?? channelId,
        cwd: s.cwd ? expandPath(s.cwd) : blockCwd,
      });
    }

    for (const t of a.triggers ?? []) {
      if (!claim(t.name, 'trigger')) continue;
      merged.triggers.push({
        ...t,
        channels: t.channels?.length ? t.channels : [channelId],
      });
    }

    for (const m of a.mention_triggers ?? []) {
      if (!claim(m.name, 'mention-trigger')) continue;
      merged.mention_triggers.push({
        ...m,
        target_channel: m.target_channel ?? channelId,
      });
    }
  }

  return merged;
}
