import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { paths } from '../paths';
import { getProfile } from '../profile';
import { loadChannels } from '../channels';
import { loadAutomations } from '../automations/config';
import { listProfiles, isServiceRunning } from '../commands/profiles';
import { SessionStore } from '../store/session-store';

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

  api.get('/channels', (c) => {
    const { channels } = loadChannels();
    const list = Object.entries(channels).map(([id, entry]) => ({ id, ...entry }));
    return c.json({ channels: list });
  });

  api.get('/automations', (c) => {
    return c.json(loadAutomations());
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
