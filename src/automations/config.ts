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

export interface AutomationsConfig {
  schedules: ScheduleAutomation[];
  triggers: TriggerAutomation[];
}

const EMPTY_CONFIG: AutomationsConfig = { schedules: [], triggers: [] };

export function loadAutomations(): AutomationsConfig {
  const filePath = paths.AUTOMATIONS_FILE;
  if (!existsSync(filePath)) return { ...EMPTY_CONFIG };

  const raw = readFileSync(filePath, 'utf-8');
  if (!raw.trim()) return { ...EMPTY_CONFIG };

  const parsed = yaml.load(raw) as Partial<AutomationsConfig> | null;
  return {
    schedules: parsed?.schedules ?? [],
    triggers: parsed?.triggers ?? [],
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
