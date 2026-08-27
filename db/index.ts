type BetterSqliteDatabase = InstanceType<typeof import('better-sqlite3')>;

export type PreparedQuery = {
  bind: (...values: unknown[]) => PreparedQuery;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<unknown>;
};

export type DatabaseAdapter = {
  prepare: (sql: string) => PreparedQuery;
  batch: (statements: PreparedQuery[]) => Promise<unknown>;
};

let databasePromise: Promise<DatabaseAdapter> | null = null;
let schemaPromise: Promise<void> | null = null;

export async function getDatabase(): Promise<DatabaseAdapter> {
  databasePromise ??= resolveDatabase();
  return databasePromise;
}

async function resolveDatabase(): Promise<DatabaseAdapter> {
  try {
    const cloudflareModule = 'cloudflare:workers';
    const workers = await import(/* @vite-ignore */ cloudflareModule) as unknown as { env?: { DB?: D1Database } };
    if (workers.env?.DB) return workers.env.DB as unknown as DatabaseAdapter;
  } catch {
    // Plain Node does not implement the cloudflare: URL scheme; use a file below.
  }

  const sqliteModule = 'better-sqlite3';
  const [sqlitePackage, { mkdirSync }, path] = await Promise.all([
    import(/* @vite-ignore */ sqliteModule) as Promise<unknown>,
    import('node:fs'),
    import('node:path'),
  ]);
  const BetterSqlite3 = (sqlitePackage as { default: new (filename: string) => BetterSqliteDatabase }).default;
  const databasePath = process.env.CONTROL_TOWER_SQLITE_PATH
    ?? path.resolve(process.cwd(), '.runtime/sqlite/gtm-control-tower.db');
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new BetterSqlite3(databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');

  class LocalPreparedQuery implements PreparedQuery {
    private values: unknown[] = [];

    constructor(private readonly sql: string) {}

    bind(...values: unknown[]) {
      this.values = values;
      return this;
    }

    async first<T>() {
      return (database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
    }

    async all<T>() {
      return { results: database.prepare(this.sql).all(...this.values) as T[] };
    }

    async run() {
      return database.prepare(this.sql).run(...this.values);
    }

    runSync() {
      return database.prepare(this.sql).run(...this.values);
    }
  }

  return {
    prepare: (sql) => new LocalPreparedQuery(sql),
    batch: async (statements) => {
      database.transaction(() => {
        for (const statement of statements) (statement as LocalPreparedQuery).runSync();
      })();
    },
  };
}

export async function ensureWorkspaceSchema(): Promise<void> {
  if (schemaPromise) return schemaPromise;
  schemaPromise = getDatabase().then((db) => db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL DEFAULT 'My GTM workspace',
      revision INTEGER NOT NULL DEFAULT 0,
      source_type TEXT NOT NULL DEFAULT 'csv',
      destination_type TEXT NOT NULL DEFAULT 'csv',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS workspace_state_chunks (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, revision, chunk_index)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS mapping_presets (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mapping_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS connector_runs (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      connector_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      undo_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_connector_runs_workspace_created
      ON connector_runs(workspace_id, created_at)`),
    db.prepare('PRAGMA optimize'),
  ])).then(() => undefined).catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}
