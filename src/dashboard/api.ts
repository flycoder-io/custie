import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { paths } from '../paths';
import { getProfile } from '../profile';
import { loadChannels } from '../channels';
import { loadAutomations } from '../automations/config';
import { listProfiles, isServiceRunning } from '../commands/profiles';
import { listMemberChannels, lookupById } from '../store/channel-cache';
import { SessionStore } from '../store/session-store';

/**
 * The global default model. Mirrors config.ts: `sonnet` unless CUSTIE_MODEL
 * overrides it. Channels/schedules without their own `model:` run on this.
 */
function defaultModelName(): string {
  return process.env['CUSTIE_MODEL']?.trim() || 'sonnet';
}

/** Turn a stored `channel` value (ID or `#name`) into a `#name` label. */
function channelLabel(channel: string): string {
  if (channel.startsWith('C')) {
    const row = lookupById(channel);
    return row ? `#${row.name}` : channel;
  }
  return channel.startsWith('#') ? channel : `#${channel}`;
}

/** Read the last `limit` lines of a log file, or an empty array if absent. */
function tailFile(file: string, limit: number): string[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf-8').split('\n');
  // Drop a trailing empty line from the final newline.
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-limit);
}

/**
 * Read-only JSON API for the dashboard (Phase 1). Every route reflects the
 * active `--profile` since `paths` and `getProfile()` are profile-aware.
 */
export function createApiRouter(): Hono {
  const api = new Hono();

  // The profile this dashboard instance is bound to — surfaced so the SPA can
  // show "you are viewing profile X" without guessing.
  api.get('/profile', (c) => c.json({ profile: getProfile() }));

  // All channels the bot is a member of (from the local channel cache), merged
  // with their channels.yml overrides. Channels without an override run on the
  // global defaults (CLAUDE_CWD / CUSTIE_MODEL / global access) and are flagged
  // `configured: false`. A channels.yml entry that isn't a current member (rare)
  // is still listed so nothing silently disappears.
  api.get('/channels', (c) => {
    const { channels: configured } = loadChannels();
    const members = listMemberChannels();
    const seen = new Set<string>();

    const list = members.map((m) => {
      seen.add(m.id);
      const entry = configured[m.id];
      return {
        id: m.id,
        name: m.name,
        purpose: m.purpose ?? undefined,
        member: true,
        configured: !!entry,
        cwd: entry?.cwd,
        model: entry?.model,
        access: entry?.access,
      };
    });

    // Configured channels the cache doesn't know about (e.g. cache not yet
    // refreshed, or bot removed but config left behind).
    for (const [id, entry] of Object.entries(configured)) {
      if (seen.has(id)) continue;
      list.push({
        id,
        name: entry.name ?? id,
        purpose: undefined,
        member: false,
        configured: true,
        cwd: entry.cwd,
        model: entry.model,
        access: entry.access,
      });
    }

    list.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ channels: list, defaultModel: defaultModelName() });
  });

  api.get('/automations', (c) => {
    const auto = loadAutomations();
    const defaultModel = defaultModelName();
    return c.json({
      ...auto,
      defaultModel,
      schedules: auto.schedules.map((s) => ({
        ...s,
        channelLabel: channelLabel(s.channel),
      })),
    });
  });

  api.get('/profiles', (c) => {
    const active = getProfile();
    const list = listProfiles().map((name) => ({
      name,
      active: name === active,
      running: isServiceRunning(name),
    }));
    return c.json({ profiles: list });
  });

  api.get('/sessions', (c) => {
    if (!existsSync(paths.DB_FILE)) return c.json({ sessions: [] });
    const store = new SessionStore(paths.DB_FILE);
    try {
      return c.json({ sessions: store.listSessions() });
    } finally {
      store.close();
    }
  });

  api.get('/logs', (c) => {
    const errors = c.req.query('error') === 'true' || c.req.query('error') === '1';
    const limit = Math.min(Number(c.req.query('limit')) || 200, 2000);
    const filename = errors ? 'custie-error.log' : 'custie.log';
    const file = join(paths.LOG_DIR, filename);
    const exists = existsSync(file);
    return c.json({
      file,
      exists,
      size: exists ? statSync(file).size : 0,
      lines: tailFile(file, limit),
    });
  });

  return api;
}
