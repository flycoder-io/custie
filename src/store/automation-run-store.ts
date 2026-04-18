import Database from 'better-sqlite3';

export type RunStatus = 'ok' | 'error';

export interface AutomationRun {
  name: string;
  lastRunAt: Date;
  lastStatus: RunStatus | null;
}

export class AutomationRunStore {
  private db: Database.Database;
  private ownsDb: boolean;

  constructor(dbOrPath: string | Database.Database) {
    if (typeof dbOrPath === 'string') {
      this.db = new Database(dbOrPath);
      this.db.pragma('journal_mode = WAL');
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_runs (
        name TEXT PRIMARY KEY,
        last_run_at TEXT NOT NULL,
        last_status TEXT
      )
    `);
  }

  getLastRun(name: string): AutomationRun | undefined {
    const row = this.db
      .prepare('SELECT name, last_run_at, last_status FROM automation_runs WHERE name = ?')
      .get(name) as { name: string; last_run_at: string; last_status: string | null } | undefined;

    if (!row) return undefined;

    return {
      name: row.name,
      lastRunAt: new Date(row.last_run_at),
      lastStatus: (row.last_status as RunStatus | null) ?? null,
    };
  }

  recordRun(name: string, status: RunStatus, when: Date = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO automation_runs (name, last_run_at, last_status)
         VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, last_status = excluded.last_status`,
      )
      .run(name, when.toISOString(), status);
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
