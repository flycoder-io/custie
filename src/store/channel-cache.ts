import Database from 'better-sqlite3';
import type { WebClient } from '@slack/web-api';
import { paths } from '../paths';

interface ChannelRow {
  id: string;
  name: string;
  is_member: number;
  purpose: string | null;
  updated_at: string;
}

let db: Database.Database | undefined;

function getDb(): Database.Database {
  if (db) return db;
  db = new Database(paths.DB_FILE);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_member INTEGER NOT NULL DEFAULT 0,
      purpose TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name);
  `);
  // Add purpose column for older databases (idempotent best-effort)
  try {
    db.exec('ALTER TABLE channels ADD COLUMN purpose TEXT');
  } catch {
    // Column already exists
  }
  return db;
}

export function lookupByName(name: string): ChannelRow | undefined {
  return getDb()
    .prepare('SELECT * FROM channels WHERE name = ?')
    .get(name) as ChannelRow | undefined;
}

export function lookupById(id: string): ChannelRow | undefined {
  return getDb().prepare('SELECT * FROM channels WHERE id = ?').get(id) as
    | ChannelRow
    | undefined;
}

export function listMemberChannels(): ChannelRow[] {
  return getDb()
    .prepare('SELECT * FROM channels WHERE is_member = 1 ORDER BY name')
    .all() as ChannelRow[];
}

export async function refreshCache(client: WebClient): Promise<void> {
  // Paginate `conversations.list` and upsert all channels in one transaction.
  const all: Array<{
    id?: string;
    name?: string;
    is_member?: boolean;
    purpose?: { value?: string };
  }> = [];
  let cursor: string | undefined;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    if (res.channels) all.push(...res.channels);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const upsert = getDb().prepare(
    `INSERT INTO channels (id, name, is_member, purpose, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (id)
     DO UPDATE SET name = excluded.name, is_member = excluded.is_member,
                   purpose = excluded.purpose, updated_at = datetime('now')`,
  );

  const seenIds = new Set<string>();
  const tx = getDb().transaction(() => {
    for (const ch of all) {
      if (!ch.id || !ch.name) continue;
      seenIds.add(ch.id);
      upsert.run(ch.id, ch.name, ch.is_member ? 1 : 0, ch.purpose?.value ?? null);
    }
    // Delete channels that disappeared (renamed/archived/bot removed)
    const existing = getDb().prepare('SELECT id FROM channels').all() as { id: string }[];
    const del = getDb().prepare('DELETE FROM channels WHERE id = ?');
    for (const row of existing) if (!seenIds.has(row.id)) del.run(row.id);
  });
  tx();
}

// Resolve a name (with or without #) or ID to a channel ID, hitting the cache
// first and only falling back to the Slack API on miss.
export async function resolveChannelId(
  client: WebClient,
  nameOrId: string,
): Promise<string> {
  if (nameOrId.startsWith('C')) return nameOrId;
  const name = nameOrId.replace(/^#/, '');

  const cached = lookupByName(name);
  if (cached) return cached.id;

  // Cache miss → refresh once, then retry
  await refreshCache(client);
  const fresh = lookupByName(name);
  if (!fresh) throw new Error(`Channel not found: ${nameOrId}`);
  return fresh.id;
}
