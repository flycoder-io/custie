import Database from 'better-sqlite3';

export interface Session {
  channelId: string;
  threadTs: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export class SessionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (channel_id, thread_ts)
      )
    `);
  }

  getSession(channelId: string, threadTs: string): Session | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE channel_id = ? AND thread_ts = ?')
      .get(channelId, threadTs) as
      | {
          channel_id: string;
          thread_ts: string;
          session_id: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) return undefined;

    return {
      channelId: row.channel_id,
      threadTs: row.thread_ts,
      sessionId: row.session_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveSession(channelId: string, threadTs: string, sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (channel_id, thread_ts, session_id)
         VALUES (?, ?, ?)
         ON CONFLICT (channel_id, thread_ts)
         DO UPDATE SET session_id = excluded.session_id, updated_at = datetime('now')`,
      )
      .run(channelId, threadTs, sessionId);
  }

  deleteSession(channelId: string, threadTs: string): void {
    this.db
      .prepare('DELETE FROM sessions WHERE channel_id = ? AND thread_ts = ?')
      .run(channelId, threadTs);
  }

  close(): void {
    this.db.close();
  }
}
