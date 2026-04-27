import Database from 'better-sqlite3';
import type { WebClient } from '@slack/web-api';
import { paths } from '../paths';

interface UserRow {
  id: string;
  name: string;
  real_name: string | null;
  display_name: string | null;
  is_bot: number;
  deleted: number;
  updated_at: string;
}

let db: Database.Database | undefined;

function getDb(): Database.Database {
  if (db) return db;
  db = new Database(paths.DB_FILE);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      real_name TEXT,
      display_name TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);
  `);
  return db;
}

export function lookupUserById(id: string): UserRow | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function lookupUserByName(name: string): UserRow | undefined {
  return getDb()
    .prepare('SELECT * FROM users WHERE name = ? OR real_name = ? OR display_name = ?')
    .get(name, name, name) as UserRow | undefined;
}

export function listActiveUsers(): UserRow[] {
  return getDb()
    .prepare("SELECT * FROM users WHERE deleted = 0 AND is_bot = 0 AND id != 'USLACKBOT' ORDER BY real_name")
    .all() as UserRow[];
}

// Best display label for a user — prefers real_name, falls back to display_name, name, then id.
export function displayNameFor(id: string): string {
  const row = lookupUserById(id);
  if (!row) return id;
  return row.real_name || row.display_name || row.name || id;
}

export async function refreshUserCache(client: WebClient): Promise<void> {
  const all: Array<{
    id?: string;
    name?: string;
    real_name?: string;
    profile?: { display_name?: string };
    is_bot?: boolean;
    deleted?: boolean;
  }> = [];
  let cursor: string | undefined;
  do {
    const res = await client.users.list({ limit: 200, cursor });
    if (res.members) all.push(...res.members);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const upsert = getDb().prepare(
    `INSERT INTO users (id, name, real_name, display_name, is_bot, deleted, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (id)
     DO UPDATE SET name = excluded.name, real_name = excluded.real_name,
                   display_name = excluded.display_name, is_bot = excluded.is_bot,
                   deleted = excluded.deleted, updated_at = datetime('now')`,
  );

  const tx = getDb().transaction(() => {
    for (const u of all) {
      if (!u.id || !u.name) continue;
      upsert.run(
        u.id,
        u.name,
        u.real_name ?? null,
        u.profile?.display_name || null,
        u.is_bot ? 1 : 0,
        u.deleted ? 1 : 0,
      );
    }
  });
  tx();
}

export async function resolveUserId(
  client: WebClient,
  nameOrId: string,
): Promise<string> {
  if (nameOrId.startsWith('U')) return nameOrId;
  const name = nameOrId.replace(/^@/, '');

  const cached = lookupUserByName(name);
  if (cached) return cached.id;

  await refreshUserCache(client);
  const fresh = lookupUserByName(name);
  if (!fresh) throw new Error(`User not found: ${nameOrId}`);
  return fresh.id;
}

// Look up multiple users from cache; refresh once if any are missing.
// Refresh failures (e.g. missing `users:read` scope) are swallowed — callers
// fall back to displaying raw IDs via `displayNameFor`.
export async function ensureUsersCached(
  client: WebClient,
  ids: Iterable<string>,
): Promise<void> {
  const idSet = new Set(ids);
  if (idSet.size === 0) return;
  const present = new Set(
    (
      getDb()
        .prepare(
          `SELECT id FROM users WHERE id IN (${[...idSet].map(() => '?').join(',')})`,
        )
        .all(...idSet) as { id: string }[]
    ).map((r) => r.id),
  );
  const missing = [...idSet].filter((id) => !present.has(id));
  if (missing.length === 0) return;
  try {
    await refreshUserCache(client);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[user-cache] refresh failed (${msg}); falling back to raw IDs`);
  }
}
