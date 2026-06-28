// Typed fetch helpers for the read-only dashboard API (Phase 1).

export interface ChannelRow {
  id: string;
  name: string;
  purpose?: string;
  member: boolean;
  configured: boolean;
  cwd?: string;
  access?: unknown;
  model?: string;
}

export interface Schedule {
  name: string;
  enabled: boolean;
  cron: string;
  channel: string;
  channelLabel: string;
  timezone?: string;
  model?: string;
}

export interface Trigger {
  name: string;
  enabled: boolean;
  patterns: string[];
  channels: string[];
  cooldown: number;
}

export interface MentionTrigger {
  name: string;
  enabled: boolean;
  user: string;
  target_channel: string;
}

export interface ProfileRow {
  name: string;
  active: boolean;
  running: boolean;
}

export interface SessionRow {
  channelId: string;
  threadTs: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  profile: () => get<{ profile: string }>('/profile'),
  channels: () => get<{ channels: ChannelRow[] }>('/channels'),
  automations: () =>
    get<{
      schedules: Schedule[];
      triggers: Trigger[];
      mention_triggers: MentionTrigger[];
      defaultModel: string;
    }>('/automations'),
  profiles: () => get<{ profiles: ProfileRow[] }>('/profiles'),
  sessions: () => get<{ sessions: SessionRow[] }>('/sessions'),
  logs: (error: boolean) =>
    get<{ file: string; exists: boolean; size: number; lines: string[] }>(
      `/logs?limit=400&error=${error}`,
    ),
};
