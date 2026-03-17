import Database from 'better-sqlite3';
import type { ScheduleAutomation, TriggerAutomation } from '../automations/config';

interface ScheduleRow {
  name: string;
  enabled: number;
  cron: string;
  prompt: string;
  channel: string;
  cwd: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface TriggerRow {
  name: string;
  enabled: number;
  patterns: string;
  channels: string;
  require_mention: number;
  cooldown: number;
  prompt: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSchedule(row: ScheduleRow): ScheduleAutomation {
  return {
    name: row.name,
    enabled: row.enabled === 1,
    cron: row.cron,
    prompt: row.prompt,
    channel: row.channel,
    cwd: row.cwd ?? undefined,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
  };
}

function rowToTrigger(row: TriggerRow): TriggerAutomation {
  return {
    name: row.name,
    enabled: row.enabled === 1,
    patterns: JSON.parse(row.patterns) as string[],
    channels: JSON.parse(row.channels) as string[],
    require_mention: row.require_mention === 1,
    cooldown: row.cooldown,
    prompt: row.prompt,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
  };
}

export class AutomationStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        name TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        cron TEXT NOT NULL,
        prompt TEXT NOT NULL,
        channel TEXT NOT NULL,
        cwd TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        name TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        patterns TEXT NOT NULL,
        channels TEXT NOT NULL DEFAULT '["*"]',
        require_mention INTEGER NOT NULL DEFAULT 0,
        cooldown INTEGER NOT NULL DEFAULT 300,
        prompt TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  getSchedules(): ScheduleAutomation[] {
    const rows = this.db.prepare('SELECT * FROM schedules').all() as ScheduleRow[];
    return rows.map(rowToSchedule);
  }

  getTriggers(): TriggerAutomation[] {
    const rows = this.db.prepare('SELECT * FROM triggers').all() as TriggerRow[];
    return rows.map(rowToTrigger);
  }

  getSchedule(name: string): ScheduleAutomation | undefined {
    const row = this.db.prepare('SELECT * FROM schedules WHERE name = ?').get(name) as
      | ScheduleRow
      | undefined;
    return row ? rowToSchedule(row) : undefined;
  }

  getTrigger(name: string): TriggerAutomation | undefined {
    const row = this.db.prepare('SELECT * FROM triggers WHERE name = ?').get(name) as
      | TriggerRow
      | undefined;
    return row ? rowToTrigger(row) : undefined;
  }

  addSchedule(s: ScheduleAutomation): void {
    this.db
      .prepare(
        `INSERT INTO schedules (name, enabled, cron, prompt, channel, cwd, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.name,
        s.enabled ? 1 : 0,
        s.cron,
        s.prompt,
        s.channel,
        s.cwd ?? null,
        s.created_by ?? null,
      );
  }

  addTrigger(t: TriggerAutomation): void {
    this.db
      .prepare(
        `INSERT INTO triggers (name, enabled, patterns, channels, require_mention, cooldown, prompt, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.name,
        t.enabled ? 1 : 0,
        JSON.stringify(t.patterns),
        JSON.stringify(t.channels),
        t.require_mention ? 1 : 0,
        t.cooldown,
        t.prompt,
        t.created_by ?? null,
      );
  }

  removeSchedule(name: string): boolean {
    const result = this.db.prepare('DELETE FROM schedules WHERE name = ?').run(name);
    return result.changes > 0;
  }

  removeTrigger(name: string): boolean {
    const result = this.db.prepare('DELETE FROM triggers WHERE name = ?').run(name);
    return result.changes > 0;
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const val = enabled ? 1 : 0;
    const r1 = this.db
      .prepare("UPDATE schedules SET enabled = ?, updated_at = datetime('now') WHERE name = ?")
      .run(val, name);
    if (r1.changes > 0) return true;
    const r2 = this.db
      .prepare("UPDATE triggers SET enabled = ?, updated_at = datetime('now') WHERE name = ?")
      .run(val, name);
    return r2.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
