import type { DatabaseAdapter } from '@/db';

const migrations = new WeakMap<DatabaseAdapter, Promise<void>>();

/** Keep legacy names confined to this upgrade; rows and execution fences retain their identity. */
export function migrateMonitorStorage(db: DatabaseAdapter): Promise<void> {
  const existing = migrations.get(db);
  if (existing) return existing;
  const migration = migrate(db).catch((error) => { migrations.delete(db); throw error; });
  migrations.set(db, migration);
  return migration;
}

async function migrate(db: DatabaseAdapter): Promise<void> {
  const tables = ['accounts', 'snapshots', 'findings', 'repairs', 'runs'];
  const legacyTables = tables.map((table) => `watchdog_${table}`);
  const currentTables = tables.map((table) => `monitor_${table}`);
  const schema = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results;
  const names = new Set(schema.map((row) => row.name));
  const legacyCount = legacyTables.filter((table) => names.has(table)).length;
  const currentCount = currentTables.filter((table) => names.has(table)).length;
  if ((legacyCount && legacyCount !== tables.length) || (currentCount && currentCount !== tables.length)
    || (legacyCount && currentCount)) {
    throw new Error('Monitor storage upgrade found partial or conflicting tables. Restore a consistent database backup before starting the app; no records were changed.');
  }

  const statements = legacyCount ? tables.map((table) => db.prepare(`ALTER TABLE watchdog_${table} RENAME TO monitor_${table}`)) : [];
  if (legacyCount) {
    for (const index of ['idx_watchdog_findings_account', 'idx_watchdog_repairs_finding', 'idx_watchdog_runs_account']) {
      statements.push(db.prepare(`DROP INDEX IF EXISTS ${index}`));
    }
    // Only exact application-generated errors change. CRM values, evidence and human notes are immutable here.
    const errors = [
      'Watchdog requires persistent local SQLite storage. Enable CONTROL_TOWER_PERSISTENCE_ENABLED.',
      'Watchdog repairs are limited to nonempty, trimmed company and job title values.',
      'Watchdog currently requires the self-hosted SQLite runtime. Cloudflare D1 execution is not supported.',
      'Watchdog worker lease expired or was replaced. No further CRM write may start.',
      'Watchdog was disabled or automatic repairs were turned off during this tick.',
      'Watchdog checkpoint lost its worker lease. The page was not advanced.',
      'Watchdog source does not match the saved provider and account.',
      'Watchdog record does not match the connected provider and object scope.',
      'Watchdog tick failed.',
    ];
    for (const error of errors) {
      const replacement = error.replace('Watchdog', 'Monitor');
      statements.push(
        db.prepare('UPDATE monitor_findings SET repair_error = ? WHERE repair_error = ?').bind(replacement, error),
        db.prepare('UPDATE monitor_repairs SET error = ? WHERE error = ?').bind(replacement, error),
        db.prepare("UPDATE monitor_runs SET payload_json = json_set(payload_json, '$.error', ?) WHERE json_valid(payload_json) AND json_extract(payload_json, '$.error') = ?").bind(replacement, error),
      );
    }
  }

  if (names.has('slack_notification_events')) {
    statements.push(db.prepare(`UPDATE slack_notification_events SET
      path = '/app/monitor' || substr(path, length('/app/watchdog') + 1),
      title = CASE title
        WHEN 'Watchdog finding needs review' THEN 'CRM Monitor finding needs review'
        WHEN 'Watchdog finding resolved' THEN 'CRM Monitor finding resolved'
        WHEN 'Watchdog repair verified' THEN 'CRM Monitor repair verified'
        WHEN 'Watchdog repair needs verification' THEN 'CRM Monitor repair needs verification'
        WHEN 'Watchdog check failed' THEN 'CRM Monitor check failed'
        WHEN 'Watchdog connection needs attention' THEN 'CRM Monitor connection needs attention'
        ELSE title END
      WHERE state = 'pending' AND provider IN ('hubspot', 'salesforce')
        AND (path = '/app/watchdog' OR path LIKE '/app/watchdog?%')`));
  }
  if (statements.length) await db.batch(statements);
}
