import Database from 'better-sqlite3';

export interface XeroConnection {
  id: string;
  refreshToken: string;
  tenantId: string | null;
  tenantName: string | null;
  scopes: string;
  createdAt: string;
  updatedAt: string;
}

interface XeroConnectionRow {
  id: string;
  refresh_token: string;
  tenant_id: string | null;
  tenant_name: string | null;
  scopes: string;
  created_at: string;
  updated_at: string;
}

function rowToConnection(row: XeroConnectionRow): XeroConnection {
  return {
    id: row.id,
    refreshToken: row.refresh_token,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    scopes: row.scopes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class XeroTokenStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS xero_connection (
        id TEXT PRIMARY KEY,
        refresh_token TEXT NOT NULL,
        tenant_id TEXT,
        tenant_name TEXT,
        scopes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  getConnection(id: string = 'default'): XeroConnection | undefined {
    const row = this.db
      .prepare('SELECT * FROM xero_connection WHERE id = ?')
      .get(id) as XeroConnectionRow | undefined;
    return row ? rowToConnection(row) : undefined;
  }

  saveConnection(params: {
    id?: string;
    refreshToken: string;
    tenantId: string | null;
    tenantName: string | null;
    scopes: string;
  }): void {
    const id = params.id ?? 'default';
    this.db
      .prepare(
        `INSERT INTO xero_connection (id, refresh_token, tenant_id, tenant_name, scopes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           refresh_token = excluded.refresh_token,
           tenant_id = excluded.tenant_id,
           tenant_name = excluded.tenant_name,
           scopes = excluded.scopes,
           updated_at = datetime('now')`,
      )
      .run(id, params.refreshToken, params.tenantId, params.tenantName, params.scopes);
  }

  updateRefreshToken(id: string, refreshToken: string): void {
    this.db
      .prepare(
        `UPDATE xero_connection
         SET refresh_token = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(refreshToken, id);
  }

  deleteConnection(id: string = 'default'): void {
    this.db.prepare('DELETE FROM xero_connection WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }
}
