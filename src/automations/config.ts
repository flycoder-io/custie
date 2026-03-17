import cron from 'node-cron';

export interface ScheduleAutomation {
  name: string;
  enabled: boolean;
  cron: string;
  prompt: string;
  channel: string;
  cwd?: string;
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
