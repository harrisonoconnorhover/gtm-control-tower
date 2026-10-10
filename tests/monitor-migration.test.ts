import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseAdapter } from '../db';

const directory = mkdtempSync(join(tmpdir(), 'gtm-monitor-upgrade-'));
let db: DatabaseAdapter;
let databasePath: string;
const timestamp = '2026-10-10T12:00:00.000Z';
const oldError = 'Watchdog worker lease expired or was replaced. No further CRM write may start.';
const evidence = JSON.stringify({ rule: 'text_whitespace', before: { company: ' Watchdog Services ' }, after: { company: 'Watchdog Services' }, contactLabel: 'Watchdog Services', provider: 'hubspot', objectType: 'Contact' });

beforeEach(async () => {
  vi.resetModules();
  databasePath = join(directory, `${crypto.randomUUID()}.db`);
  vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', databasePath);
  vi.stubEnv('CONTROL_TOWER_SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/T_FIXTURE/B_FIXTURE/fixture-secret');
  vi.stubEnv('CONTROL_TOWER_APP_URL', 'https://tower.example.test');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
  db = await (await import('../db')).getDatabase();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function legacyFixture() {
  await db.batch([
    db.prepare(`CREATE TABLE watchdog_accounts (
      account_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'baseline',
      cursor TEXT, baseline_started_at TEXT, last_baseline_at TEXT, watermark TEXT, window_end TEXT,
      last_checked_at TEXT, next_check_at TEXT, lease_id TEXT, lease_expires_at TEXT
    )`),
    db.prepare('CREATE TABLE watchdog_snapshots (account_id TEXT NOT NULL, contact_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(account_id, contact_id))'),
    db.prepare(`CREATE TABLE watchdog_findings (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, contact_id TEXT NOT NULL, rule TEXT NOT NULL,
      status TEXT NOT NULL, assignee TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, resolved_at TEXT, occurrences INTEGER NOT NULL DEFAULT 1,
      evidence_json TEXT NOT NULL, repair_error TEXT, auto_eligible INTEGER NOT NULL DEFAULT 0,
      UNIQUE(account_id, contact_id, rule)
    )`),
    db.prepare(`CREATE TABLE watchdog_repairs (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, finding_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      lease_id TEXT NOT NULL, state TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, error TEXT
    )`),
    db.prepare('CREATE TABLE watchdog_runs (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, started_at TEXT NOT NULL, payload_json TEXT NOT NULL)'),
    db.prepare('CREATE INDEX idx_watchdog_findings_account ON watchdog_findings(account_id, status, last_seen_at)'),
    db.prepare('CREATE INDEX idx_watchdog_repairs_finding ON watchdog_repairs(account_id, finding_id, state)'),
    db.prepare('CREATE INDEX idx_watchdog_runs_account ON watchdog_runs(account_id, started_at)'),
    db.prepare(`CREATE TABLE slack_notification_events (
      event_key TEXT PRIMARY KEY, provider TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
      path TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', delivery_id TEXT, created_at TEXT NOT NULL, finished_at TEXT
    )`),
    db.prepare(`INSERT INTO watchdog_accounts VALUES (?, ?, 'changes', 'cursor-42', ?, ?, ?, ?, ?, ?, 'lease-kept', ?)`)
      .bind('fixture-account', JSON.stringify({ enabled: true, automaticRepairs: true, intervalSeconds: 600, defaultAssignee: 'RevOps' }), timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, '2099-01-01T00:00:00.000Z'),
  ]);
  for (const state of ['unknown', 'sending', 'eligible']) {
    await db.batch([
      db.prepare(`INSERT INTO watchdog_findings (id, account_id, contact_id, rule, status, assignee, note, first_seen_at, last_seen_at, occurrences, evidence_json, repair_error, auto_eligible)
        VALUES (?, 'fixture-account', ?, 'text_whitespace', 'open', 'RevOps', 'Watchdog Services is the account name', ?, ?, 3, ?, ?, 1)`)
        .bind(`finding-${state}`, state, timestamp, timestamp, evidence, state === 'unknown' ? oldError : null),
      db.prepare('INSERT INTO watchdog_snapshots VALUES (?, ?, ?)').bind('fixture-account', state, JSON.stringify({ contact: { id: state, properties: { email: 'fixture@example.test', company: ' Watchdog Services ' } } })),
    ]);
    if (state !== 'eligible') await db.prepare('INSERT INTO watchdog_repairs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(`repair-${state}`, 'fixture-account', `finding-${state}`, state, 'lease-kept', state, JSON.stringify({ company: ' Watchdog Services ' }), JSON.stringify({ company: 'Watchdog Services' }), timestamp, null, state === 'unknown' ? oldError : null).run();
  }
  await db.prepare('INSERT INTO watchdog_runs VALUES (?, ?, ?, ?)').bind('run-kept', 'fixture-account', timestamp, JSON.stringify({ id: 'run-kept', accountId: 'fixture-account', status: 'failed', error: oldError, evidence: 'Watchdog Services' })).run();
  for (const state of ['pending', 'sending', 'unknown', 'delivered']) {
    await db.prepare('INSERT INTO slack_notification_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(`finding:fixture:${state}`, 'hubspot', 'Watchdog finding needs review', 'Review the saved evidence.', `/app/watchdog?provider=hubspot&finding=${state}`, state, `delivery-${state}`, timestamp, null).run();
  }
}

describe('Monitor storage upgrade', () => {
  it('upgrades before Slack delivery, retaining repair holds, cursors, deduplication and historical evidence', async () => {
    await legacyFixture();
    const originalAccount = await db.prepare('SELECT * FROM watchdog_accounts').first();
    const originalSnapshots = await db.prepare('SELECT * FROM watchdog_snapshots ORDER BY contact_id').all();
    const slack = await import('../lib/slack-notifications');
    expect(await slack.getSlackNotificationStatus()).toMatchObject({ pending: 1, sending: 1, unknown: 1, delivered: 1 });
    expect(await db.prepare('SELECT * FROM monitor_accounts').first()).toEqual(originalAccount);
    expect(await db.prepare('SELECT * FROM monitor_snapshots ORDER BY contact_id').all()).toEqual(originalSnapshots);
    expect((await db.prepare('SELECT id, state, lease_id FROM monitor_repairs ORDER BY id').all()).results).toEqual([
      { id: 'repair-sending', state: 'sending', lease_id: 'lease-kept' },
      { id: 'repair-unknown', state: 'unknown', lease_id: 'lease-kept' },
    ]);
    expect(await db.prepare("SELECT evidence_json, note, repair_error FROM monitor_findings WHERE id = 'finding-unknown'").first()).toEqual({
      evidence_json: evidence, note: 'Watchdog Services is the account name', repair_error: oldError.replace('Watchdog', 'Monitor'),
    });
    const run = await db.prepare('SELECT payload_json FROM monitor_runs').first<{ payload_json: string }>();
    expect(JSON.parse(run!.payload_json)).toMatchObject({ id: 'run-kept', error: oldError.replace('Watchdog', 'Monitor'), evidence: 'Watchdog Services' });
    const pending = await db.prepare("SELECT * FROM slack_notification_events WHERE state = 'pending'").first();
    expect(pending).toMatchObject({ event_key: 'finding:fixture:pending', title: 'CRM Monitor finding needs review', path: '/app/monitor?provider=hubspot&finding=pending', state: 'pending', delivery_id: 'delivery-pending' });
    for (const state of ['sending', 'unknown', 'delivered']) {
      expect(await db.prepare('SELECT title, path, state, delivery_id FROM slack_notification_events WHERE event_key = ?').bind(`finding:fixture:${state}`).first()).toEqual({
        title: 'Watchdog finding needs review', path: `/app/watchdog?provider=hubspot&finding=${state}`, state, delivery_id: `delivery-${state}`,
      });
    }
    const monitor = await import('../lib/monitor-store');
    expect((await monitor.getPendingMonitorRepairs('fixture-account')).map((row) => row.finding.id)).toEqual(['finding-eligible']);
    const schema = (await db.prepare('SELECT name, type FROM sqlite_master WHERE sql IS NOT NULL').all<{ name: string; type: string }>()).results;
    expect(schema.some((row) => row.name.includes('watchdog'))).toBe(false);
    expect(schema.filter((row) => row.name.startsWith('idx_monitor_'))).toHaveLength(3);
    await expect(db.prepare('INSERT INTO monitor_findings SELECT * FROM monitor_findings LIMIT 1').run()).rejects.toThrow('UNIQUE');
    await slack.enqueueSlackNotification({ key: 'finding:fixture:pending', provider: 'hubspot', title: 'Changed', summary: 'Duplicate', path: '/app/work' });
    expect(await db.prepare("SELECT * FROM slack_notification_events WHERE state = 'pending'").first()).toEqual(pending);
    expect(fetch).not.toHaveBeenCalled();
    const fetcher = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetcher);
    expect(await slack.deliverSlackNotifications()).toMatchObject({ delivered: 2, unknown: 2, pending: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(request[1].body)).toContain('/app/monitor?provider=hubspot');
    expect(String(request[1].body)).not.toContain('Watchdog');
    expect(String(request[1].body)).not.toContain('/app/watchdog');
    // A new module lifetime represents an app restart, not merely a cached promise.
    vi.resetModules();
    const restarted = await import('../lib/monitor-store');
    expect(await restarted.getMonitorAccount('fixture-account')).toEqual(originalAccount);
    expect((await restarted.getPendingMonitorRepairs('fixture-account')).map((row) => row.finding.id)).toEqual(['finding-eligible']);
  });

  it('allows fresh concurrent initialization and repeat startup without an upgrade', async () => {
    const monitor = await import('../lib/monitor-store');
    const slack = await import('../lib/slack-notifications');
    await Promise.all([monitor.monitorDatabase(), slack.getSlackNotificationStatus()]);
    expect((await monitor.getMonitorAccount('fresh')).account_id).toBe('fresh');
    vi.resetModules();
    expect((await (await import('../lib/monitor-store')).getMonitorAccount('fresh')).account_id).toBe('fresh');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['partial', 'conflicting'] as const)('rejects %s tables without modifying either data set', async (state) => {
    await legacyFixture();
    if (state === 'partial') await db.prepare('DROP TABLE watchdog_runs').run();
    else await db.prepare('CREATE TABLE monitor_accounts (id TEXT PRIMARY KEY)').run();
    const original = await db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    const migration = await import('../lib/monitor-migration');
    await expect(migration.migrateMonitorStorage(db)).rejects.toThrow('partial or conflicting tables');
    expect(await db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()).toEqual(original);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM watchdog_repairs').first()).toEqual({ count: 2 });
  });

  it('rolls back all table renames if an accompanying pending-notification update fails, then can retry', async () => {
    await legacyFixture();
    await db.prepare("CREATE TRIGGER fixture_stop_upgrade BEFORE UPDATE ON slack_notification_events BEGIN SELECT RAISE(ABORT, 'fixture rejects update'); END").run();
    const { migrateMonitorStorage } = await import('../lib/monitor-migration');
    await expect(migrateMonitorStorage(db)).rejects.toThrow('fixture rejects update');
    expect(await db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'monitor_%'").first()).toEqual({ count: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM watchdog_repairs').first()).toEqual({ count: 2 });
    await db.prepare('DROP TRIGGER fixture_stop_upgrade').run();
    await migrateMonitorStorage(db);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM monitor_repairs').first()).toEqual({ count: 2 });
  });
});
