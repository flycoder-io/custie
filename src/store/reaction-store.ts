import Database from 'better-sqlite3';

export interface PendingReaction {
  channelId: string;
  messageTs: string;
  name: string;
}

// Tracks reactions Custie has added but not yet removed. We persist these so
// that an unclean shutdown (deploy, crash, restart) doesn't leave a permanent
// "still thinking" indicator on a message the bot has already stopped working
// on. On startup, anything still in this table gets removed from Slack.
export class ReactionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_reactions (
        channel_id TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        name TEXT NOT NULL,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (channel_id, message_ts, name)
      )
    `);
  }

  markPending(channelId: string, messageTs: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO pending_reactions (channel_id, message_ts, name)
         VALUES (?, ?, ?)
         ON CONFLICT (channel_id, message_ts, name) DO NOTHING`,
      )
      .run(channelId, messageTs, name);
  }

  clearPending(channelId: string, messageTs: string, name: string): void {
    this.db
      .prepare(
        'DELETE FROM pending_reactions WHERE channel_id = ? AND message_ts = ? AND name = ?',
      )
      .run(channelId, messageTs, name);
  }

  listAll(): PendingReaction[] {
    const rows = this.db
      .prepare('SELECT channel_id, message_ts, name FROM pending_reactions')
      .all() as Array<{ channel_id: string; message_ts: string; name: string }>;
    return rows.map((r) => ({
      channelId: r.channel_id,
      messageTs: r.message_ts,
      name: r.name,
    }));
  }

  close(): void {
    this.db.close();
  }
}
