import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import yaml from 'js-yaml';
import { paths } from './paths';
import type {
  ScheduleAutomation,
  TriggerAutomation,
  MentionTrigger,
} from './automations/config';

// Automation entries nested under a channel block omit the fields the parent
// block supplies (channel / cwd / channels / target_channel). They are
// otherwise identical to their top-level counterparts.
export type NestedSchedule = Omit<ScheduleAutomation, 'channel'> & { channel?: string };
export type NestedTrigger = Omit<TriggerAutomation, 'channels'> & { channels?: string[] };
export type NestedMentionTrigger = Omit<MentionTrigger, 'target_channel'> & {
  target_channel?: string;
};

export interface ChannelAutomations {
  schedules?: NestedSchedule[];
  triggers?: NestedTrigger[];
  mention_triggers?: NestedMentionTrigger[];
}

/**
 * Per-channel access widening, layered on top of the global ALLOWED_USER_IDS
 * list. `'open'` (also `'*'` / `'all'`) opens the channel to everyone; an array
 * allows the listed Slack user IDs. Absent = no widening (global list applies).
 */
export type ChannelAccess = 'open' | '*' | 'all' | string[];

export interface ChannelEntry {
  name?: string;
  cwd: string;
  access?: ChannelAccess;
  /**
   * Per-channel Claude model (`--model` value, e.g. `opus` / `haiku` / `sonnet`).
   * Lets complex coding channels use a stronger model while leaving casual
   * channels on a cheaper one. Absent = fall back to the global CUSTIE_MODEL.
   */
  model?: string;
  automations?: ChannelAutomations;
}

export interface ChannelsConfig {
  channels: Record<string, ChannelEntry>;
}

/** Expand a leading `~` and resolve relative paths to absolute paths. */
export function expandPath(p: string): string {
  let expanded = p;
  if (expanded === '~') {
    expanded = homedir();
  } else if (expanded.startsWith('~/')) {
    expanded = resolve(homedir(), expanded.slice(2));
  }
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Load and parse `channels.yml`. Each channel's `cwd` is expanded (`~` and
 * relative paths). Missing/empty file yields an empty registry.
 */
export function loadChannels(): ChannelsConfig {
  const filePath = paths.CHANNELS_FILE;
  if (!existsSync(filePath)) return { channels: {} };

  const raw = readFileSync(filePath, 'utf-8');
  if (!raw.trim()) return { channels: {} };

  const parsed = yaml.load(raw) as Partial<ChannelsConfig> | null;
  const channels: Record<string, ChannelEntry> = {};
  for (const [id, entry] of Object.entries(parsed?.channels ?? {})) {
    if (!entry) continue;
    channels[id] = { ...entry, cwd: entry.cwd ? expandPath(entry.cwd) : entry.cwd };
  }
  return { channels };
}

/** Write `channels.yml`, mirroring `saveAutomations()`. */
export function saveChannels(config: ChannelsConfig): void {
  const filePath = paths.CHANNELS_FILE;
  const content = yaml.dump(config, { lineWidth: 120, noRefs: true });
  writeFileSync(filePath, content, 'utf-8');
}

// In-memory channel registry backing resolveChannelCwd(). Refreshed by the
// file watcher in initAutomations() so the resolver stays current.
let registry: Record<string, ChannelEntry> = {};

/** Reload the in-memory channel registry from `channels.yml`. */
export function refreshChannelRegistry(): void {
  registry = loadChannels().channels;
}

/** The current in-memory channel registry. */
export function getChannelRegistry(): Record<string, ChannelEntry> {
  return registry;
}

/**
 * Resolve the channel-scoped working directory for a Slack channel ID.
 * Returns `undefined` when the channel has no entry (callers fall back to
 * `CLAUDE_CWD`). A configured `cwd` that points at a missing directory logs a
 * warning and also returns `undefined`.
 */
export function resolveChannelCwd(channelId: string | undefined): string | undefined {
  if (!channelId) return undefined;
  const entry = registry[channelId];
  if (!entry?.cwd) return undefined;

  if (!existsSync(entry.cwd) || !statSync(entry.cwd).isDirectory()) {
    console.warn(
      `[channels] ${channelId}: cwd "${entry.cwd}" does not exist — falling back to CLAUDE_CWD`,
    );
    return undefined;
  }
  return entry.cwd;
}

/**
 * Whether `channels.yml` grants `userId` access to `channelId` beyond the
 * global ALLOWED_USER_IDS list. An `access: open` channel admits everyone; an
 * `access` array admits the listed user IDs. Returns false when the channel has
 * no `access` rule, so callers fall back to the global allow-list.
 */
export function isChannelAccessAllowed(
  channelId: string | undefined,
  userId: string | undefined,
): boolean {
  if (!channelId) return false;
  const access = registry[channelId]?.access;
  if (!access) return false;
  if (typeof access === 'string') {
    return access === 'open' || access === '*' || access === 'all';
  }
  return !!userId && access.includes(userId);
}

/**
 * Resolve the effective cwd for a Claude spawn, applying the precedence:
 *   explicit automation cwd > channels[channelId].cwd > fallback (CLAUDE_CWD).
 */
export function resolveCwd(
  explicitCwd: string | undefined,
  channelId: string | undefined,
  fallback: string,
): string {
  if (explicitCwd) return explicitCwd;
  return resolveChannelCwd(channelId) ?? fallback;
}

/** The per-channel model override, or undefined when the channel has none. */
export function resolveChannelModel(channelId: string | undefined): string | undefined {
  if (!channelId) return undefined;
  return registry[channelId]?.model?.trim() || undefined;
}

/**
 * Resolve the effective model for a Claude spawn, mirroring resolveCwd:
 *   explicit (per-automation) model > channels[channelId].model > fallback (CUSTIE_MODEL).
 */
export function resolveModel(
  explicitModel: string | undefined,
  channelId: string | undefined,
  fallback: string,
): string {
  if (explicitModel?.trim()) return explicitModel.trim();
  return resolveChannelModel(channelId) ?? fallback;
}
