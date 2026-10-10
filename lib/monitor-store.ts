import { getDatabase, type DatabaseAdapter } from '@/db';
import { MONITOR_DEFAULT_CONFIG, monitorAccountIdentity, monitorRecordKey, type MonitorConfig, type MonitorFinding, type MonitorRun } from './monitor-types';
import { validMonitorEmail, type MonitorIssue, type MonitorSnapshot } from './monitor-rules';
import { notifyAssignment, notifyMonitorFailure, notifyMonitorObservation, notifyMonitorRepair } from './operation-notifications';
import { migrateMonitorStorage } from './monitor-migration';

export type MonitorAccount = {
  account_id: string; config_json: string; phase: 'baseline' | 'changes'; cursor: string | null;
  baseline_started_at: string | null; last_baseline_at: string | null; watermark: string | null;
  window_end: string | null; last_checked_at: string | null; next_check_at: string | null;
  lease_id: string | null; lease_expires_at: string | null;
};
type FindingRow = {
  id: string; account_id: string; contact_id: string; rule: MonitorFinding['rule'];
  status: MonitorFinding['status']; assignee: string; note: string; first_seen_at: string;
  last_seen_at: string; resolved_at: string | null; occurrences: number; evidence_json: string;
  repair_error: string | null;
};
let schemaPromise: Promise<void> | null = null;
const leasePredicate = 'EXISTS (SELECT 1 FROM monitor_accounts WHERE account_id = ? AND lease_id = ? AND lease_expires_at > ?)';

export async function monitorDatabase(): Promise<DatabaseAdapter> {
  const db = await getDatabase();
  if (db.kind !== 'sqlite') throw new Error('Monitor currently requires the self-hosted SQLite runtime. Cloudflare D1 execution is not supported.');
  schemaPromise ??= migrateMonitorStorage(db).then(() => db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS monitor_accounts (
      account_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'baseline',
      cursor TEXT, baseline_started_at TEXT, last_baseline_at TEXT, watermark TEXT, window_end TEXT,
      last_checked_at TEXT, next_check_at TEXT, lease_id TEXT, lease_expires_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS monitor_snapshots (
      account_id TEXT NOT NULL, contact_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(account_id, contact_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS monitor_findings (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, contact_id TEXT NOT NULL, rule TEXT NOT NULL,
      status TEXT NOT NULL, assignee TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, resolved_at TEXT,
      occurrences INTEGER NOT NULL DEFAULT 1, evidence_json TEXT NOT NULL, repair_error TEXT, auto_eligible INTEGER NOT NULL DEFAULT 0,
      UNIQUE(account_id, contact_id, rule)
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_monitor_findings_account ON monitor_findings(account_id, status, last_seen_at)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS monitor_repairs (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, finding_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      lease_id TEXT NOT NULL, state TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, error TEXT
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_monitor_repairs_finding ON monitor_repairs(account_id, finding_id, state)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS monitor_runs (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, started_at TEXT NOT NULL, payload_json TEXT NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_monitor_runs_account ON monitor_runs(account_id, started_at)'),
  ])).then(() => undefined).catch((error) => { schemaPromise = null; throw error; });
  await schemaPromise;
  return db;
}

export async function getMonitorAccount(accountId: string): Promise<MonitorAccount> {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(accountId)) throw new Error('Invalid CRM account identity.');
  const db = await monitorDatabase();
  await db.prepare('INSERT INTO monitor_accounts (account_id, config_json) VALUES (?, ?) ON CONFLICT(account_id) DO NOTHING')
    .bind(accountId, JSON.stringify(MONITOR_DEFAULT_CONFIG)).run();
  return (await db.prepare('SELECT * FROM monitor_accounts WHERE account_id = ?').bind(accountId).first<MonitorAccount>())!;
}

export async function setMonitorConfig(accountId: string, config: MonitorConfig): Promise<void> {
  await getMonitorAccount(accountId);
  const db = await monitorDatabase();
  await db.prepare('UPDATE monitor_accounts SET config_json = ?, next_check_at = NULL WHERE account_id = ?').bind(JSON.stringify(config), accountId).run();
}

/** A fixed four-minute lease exceeds the bounded provider budget. No work continues after its fence expires. */
export async function claimMonitorTick(accountId: string, force: boolean): Promise<MonitorAccount | null> {
  const initial = await getMonitorAccount(accountId);
  const config = JSON.parse(initial.config_json) as MonitorConfig;
  const now = new Date().toISOString();
  if (!config.enabled || (!force && initial.next_check_at && initial.next_check_at > now)) return null;
  const db = await monitorDatabase();
  const leaseId = crypto.randomUUID();
  const row = await db.prepare(`UPDATE monitor_accounts SET lease_id = ?, lease_expires_at = ?
    WHERE account_id = ? AND config_json = ? AND (lease_id IS NULL OR lease_expires_at <= ?)
    AND (? = 1 OR next_check_at IS NULL OR next_check_at <= ?) RETURNING *`)
    .bind(leaseId, new Date(Date.now() + 240_000).toISOString(), accountId, initial.config_json, now, force ? 1 : 0, now)
    .first<MonitorAccount>();
  if (!row) return null;
  // Interrupted sending attempts are never candidates for another automatic PATCH.
  const interruptedRepairs = await db.prepare("SELECT id, finding_id FROM monitor_repairs WHERE account_id = ? AND state = 'sending'")
    .bind(accountId).all<{ id: string; finding_id: string }>();
  await db.batch([
    db.prepare(`UPDATE monitor_findings SET status = 'unknown', repair_error = 'A previous repair was interrupted. Verify the CRM manually; it will not be replayed.'
      WHERE account_id = ? AND id IN (SELECT finding_id FROM monitor_repairs WHERE account_id = ? AND state = 'sending')`)
      .bind(accountId, accountId),
    db.prepare(`UPDATE monitor_repairs SET state = 'unknown', finished_at = ?, error = 'Worker interrupted; remote outcome unknown.'
      WHERE account_id = ? AND state = 'sending'`).bind(now, accountId),
  ]);
  for (const repair of interruptedRepairs.results) await notifyMonitorRepair(accountId, repair.finding_id, repair.id, 'unknown');
  const interrupted = await db.prepare('SELECT payload_json FROM monitor_runs WHERE account_id = ? ORDER BY started_at DESC LIMIT 1').bind(accountId).first<{ payload_json: string }>();
  if (interrupted) {
    const run = JSON.parse(interrupted.payload_json) as MonitorRun;
    if (run.status === 'running') await saveMonitorRun({ ...run, status: 'failed', finishedAt: now, error: 'Previous worker stopped before completing its page. The saved page will be retried; uncertain repairs are held for review.' }, leaseId);
  }
  return row;
}

export async function assertMonitorLease(accountId: string, leaseId: string, repairs = false): Promise<MonitorAccount> {
  const db = await monitorDatabase();
  const row = await db.prepare(`SELECT * FROM monitor_accounts WHERE account_id = ? AND lease_id = ? AND lease_expires_at > ?`)
    .bind(accountId, leaseId, new Date(Date.now() + 15_000).toISOString()).first<MonitorAccount>();
  if (!row) throw new Error('Monitor worker lease expired or was replaced. No further CRM write may start.');
  const config = JSON.parse(row.config_json) as MonitorConfig;
  if (!config.enabled || (repairs && !config.automaticRepairs)) throw new Error('Monitor was disabled or automatic repairs were turned off during this tick.');
  return row;
}

export async function checkpointMonitor(account: MonitorAccount, leaseId: string): Promise<void> {
  const db = await monitorDatabase();
  const saved = await db.prepare(`UPDATE monitor_accounts SET phase = ?, cursor = ?, baseline_started_at = ?, last_baseline_at = ?,
    watermark = ?, window_end = ?, last_checked_at = ?, next_check_at = ?
    WHERE account_id = ? AND lease_id = ? AND lease_expires_at > ? RETURNING account_id`)
    .bind(account.phase, account.cursor, account.baseline_started_at, account.last_baseline_at,
      account.watermark, account.window_end, account.last_checked_at, account.next_check_at,
      account.account_id, leaseId, new Date().toISOString()).first();
  if (!saved) throw new Error('Monitor checkpoint lost its worker lease. The page was not advanced.');
}

export async function releaseMonitorTick(accountId: string, leaseId: string): Promise<void> {
  const db = await monitorDatabase();
  await db.prepare('UPDATE monitor_accounts SET lease_id = NULL, lease_expires_at = NULL WHERE account_id = ? AND lease_id = ?').bind(accountId, leaseId).run();
}

export async function getMonitorSnapshot(accountId: string, contactId: string): Promise<MonitorSnapshot | null> {
  const db = await monitorDatabase();
  const row = await db.prepare('SELECT payload_json FROM monitor_snapshots WHERE account_id = ? AND contact_id = ?').bind(accountId, contactId).first<{ payload_json: string }>();
  return row ? JSON.parse(row.payload_json) as MonitorSnapshot : null;
}

export async function saveMonitorObservation(accountId: string, leaseId: string, snapshot: MonitorSnapshot, label: string, issues: MonitorIssue[], assignee: string): Promise<{ findings: MonitorFinding[]; opened: number }> {
  const db = await monitorDatabase();
  const now = new Date().toISOString();
  const previous = await getContactFindings(accountId, monitorRecordKey(snapshot.contact));
  const statements = issues.map((issue) => db.prepare(`INSERT INTO monitor_findings
    (id, account_id, contact_id, rule, status, assignee, first_seen_at, last_seen_at, evidence_json, auto_eligible)
    SELECT ?, ?, ?, ?, 'open', ?, ?, ?, ?, ? WHERE ${leasePredicate}
    ON CONFLICT(account_id, contact_id, rule) DO UPDATE SET
      status = CASE WHEN monitor_findings.status IN ('fixed', 'resolved') THEN 'open' ELSE monitor_findings.status END,
      occurrences = monitor_findings.occurrences + CASE WHEN monitor_findings.status IN ('fixed', 'resolved') THEN 1 ELSE 0 END,
      last_seen_at = excluded.last_seen_at, resolved_at = NULL, evidence_json = excluded.evidence_json, auto_eligible = excluded.auto_eligible`)
    .bind(crypto.randomUUID(), accountId, monitorRecordKey(snapshot.contact), issue.rule, assignee, now, now,
      JSON.stringify({ ...issue, contactLabel: label, provider: snapshot.contact.provider ?? 'hubspot', objectType: snapshot.contact.objectType ?? 'Contact' }),
      issue.rule === 'text_whitespace' && Object.values(issue.after).every(Boolean) && validMonitorEmail(snapshot.contact.properties.email ?? '') ? 1 : 0,
      accountId, leaseId, now));
  for (const finding of previous) {
    if (!issues.some((issue) => issue.rule === finding.rule) && ['open', 'in_progress'].includes(finding.status)) {
      statements.push(db.prepare(`UPDATE monitor_findings SET status = 'resolved', resolved_at = ?, repair_error = NULL
        WHERE id = ? AND status IN ('open', 'in_progress') AND ${leasePredicate}`).bind(now, finding.id, accountId, leaseId, now));
    }
  }
  statements.push(db.prepare(`INSERT INTO monitor_snapshots (account_id, contact_id, payload_json)
    SELECT ?, ?, ? WHERE ${leasePredicate}
    ON CONFLICT(account_id, contact_id) DO UPDATE SET payload_json = excluded.payload_json`)
    .bind(accountId, monitorRecordKey(snapshot.contact), JSON.stringify(snapshot), accountId, leaseId, now));
  await db.batch(statements);
  await assertMonitorLease(accountId, leaseId);
  const findings = await getContactFindings(accountId, monitorRecordKey(snapshot.contact));
  await notifyMonitorObservation(previous, findings);
  return {
    findings,
    opened: issues.filter((issue) => !previous.some((finding) => finding.rule === issue.rule && !['resolved', 'fixed'].includes(finding.status))).length,
  };
}

export async function getContactFindings(accountId: string, contactId: string): Promise<MonitorFinding[]> {
  const db = await monitorDatabase();
  const rows = await db.prepare('SELECT * FROM monitor_findings WHERE account_id = ? AND contact_id = ?').bind(accountId, contactId).all<FindingRow>();
  return rows.results.map(hydrateFinding);
}

export async function getPendingMonitorRepairs(accountId: string, limit = 5): Promise<{ finding: MonitorFinding; snapshot: MonitorSnapshot }[]> {
  const db = await monitorDatabase();
  const rows = await db.prepare(`SELECT f.*, s.payload_json AS snapshot_json FROM monitor_findings f
    JOIN monitor_snapshots s ON s.account_id = f.account_id AND s.contact_id = f.contact_id
    WHERE f.account_id = ? AND f.rule = 'text_whitespace' AND f.status = 'open' AND f.auto_eligible = 1
    AND NOT EXISTS (SELECT 1 FROM monitor_repairs r WHERE r.account_id = f.account_id AND r.finding_id = f.id AND r.state IN ('sending', 'unknown'))
    ORDER BY f.last_seen_at ASC, f.id ASC LIMIT ?`).bind(accountId, Math.min(5, Math.max(1, limit)))
    .all<FindingRow & { snapshot_json: string }>();
  return rows.results.map((row) => ({ finding: hydrateFinding(row), snapshot: JSON.parse(row.snapshot_json) as MonitorSnapshot }));
}

export async function claimMonitorRepair(accountId: string, leaseId: string, finding: MonitorFinding): Promise<string | null> {
  const db = await monitorDatabase();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const row = await db.prepare(`INSERT INTO monitor_repairs
    (id, account_id, finding_id, contact_id, lease_id, state, before_json, after_json, started_at)
    SELECT ?, ?, ?, ?, ?, 'sending', ?, ?, ? WHERE ${leasePredicate}
    AND EXISTS (SELECT 1 FROM monitor_findings WHERE id = ? AND account_id = ? AND status = 'open')
    AND NOT EXISTS (SELECT 1 FROM monitor_repairs WHERE account_id = ? AND finding_id = ? AND state IN ('sending', 'unknown')) RETURNING id`)
    .bind(id, accountId, finding.id, finding.provider === 'salesforce' ? `${finding.objectType}:${finding.contactId}` : finding.contactId, leaseId, JSON.stringify(finding.before), JSON.stringify(finding.after), now,
      accountId, leaseId, new Date(Date.now() + 15_000).toISOString(), finding.id, accountId, accountId, finding.id).first<{ id: string }>();
  if (!row) return null;
  await db.prepare(`UPDATE monitor_findings SET status = 'unknown', repair_error = 'Repair dispatched; waiting for verified readback.'
    WHERE id = ? AND account_id = ? AND ${leasePredicate}`).bind(finding.id, accountId, accountId, leaseId, now).run();
  return row.id;
}

export async function finishMonitorRepair(accountId: string, leaseId: string, repairId: string, findingId: string, state: 'verified' | 'unknown', error: string | null): Promise<void> {
  const db = await monitorDatabase();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE monitor_repairs SET state = ?, finished_at = ?, error = ? WHERE id = ? AND account_id = ? AND lease_id = ? AND state = 'sending' AND ${leasePredicate}`)
      .bind(state, now, error, repairId, accountId, leaseId, accountId, leaseId, now),
    db.prepare(`UPDATE monitor_findings SET status = ?, resolved_at = ?, repair_error = ? WHERE id = ? AND account_id = ? AND ${leasePredicate}
      AND EXISTS (SELECT 1 FROM monitor_repairs WHERE id = ? AND state = ?)`)
      .bind(state === 'verified' ? 'fixed' : 'unknown', state === 'verified' ? now : null, error, findingId, accountId, accountId, leaseId, now, repairId, state),
  ]);
  const saved = await db.prepare('SELECT state FROM monitor_repairs WHERE id = ? AND account_id = ?').bind(repairId, accountId).first<{ state: string }>();
  if (saved?.state === state) await notifyMonitorRepair(accountId, findingId, repairId, state);
}

export async function setMonitorFindingError(accountId: string, leaseId: string, findingId: string, error: string): Promise<void> {
  const db = await monitorDatabase();
  await db.prepare(`UPDATE monitor_findings SET repair_error = ?, auto_eligible = 0 WHERE id = ? AND account_id = ? AND ${leasePredicate}`)
    .bind(error, findingId, accountId, accountId, leaseId, new Date().toISOString()).run();
}

export async function updateMonitorTriage(accountId: string, input: { id: string; status: 'open' | 'in_progress' | 'resolved'; assignee: string; note: string }): Promise<void> {
  const db = await monitorDatabase();
  const row = await db.prepare(`UPDATE monitor_findings SET status = ?, assignee = ?, note = ?, resolved_at = ?
    WHERE id = ? AND account_id = ? AND (status != ? OR assignee != ? OR note != ?)
    AND NOT EXISTS (SELECT 1 FROM monitor_repairs WHERE finding_id = ? AND state = 'sending') RETURNING id`)
    .bind(input.status, input.assignee, input.note, input.status === 'resolved' ? new Date().toISOString() : null, input.id, accountId, input.status, input.assignee, input.note, input.id).first();
  if (!row) {
    const saved = await db.prepare('SELECT status, assignee, note FROM monitor_findings WHERE id = ? AND account_id = ?')
      .bind(input.id, accountId).first<{ status: string; assignee: string; note: string }>();
    if (saved?.status === input.status && saved.assignee === input.assignee && saved.note === input.note) return;
    throw new Error('Finding was not found in this account or has a repair in flight.');
  }
  const { provider } = monitorAccountIdentity(accountId);
  await notifyAssignment(provider, `/app/monitor?provider=${provider}&finding=${encodeURIComponent(input.id)}`, Boolean(input.assignee));
}

export async function saveMonitorRun(run: MonitorRun, leaseId: string): Promise<void> {
  const db = await monitorDatabase();
  await db.prepare(`INSERT INTO monitor_runs (id, account_id, started_at, payload_json)
    SELECT ?, ?, ?, ? WHERE ${leasePredicate}
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`)
    .bind(run.id, run.accountId, run.startedAt, JSON.stringify(run), run.accountId, leaseId, new Date().toISOString()).run();
  if (run.status === 'failed') {
    const saved = await db.prepare('SELECT payload_json FROM monitor_runs WHERE id = ?').bind(run.id).first<{ payload_json: string }>();
    const completed = await db.prepare("SELECT id FROM monitor_runs WHERE account_id = ? AND json_extract(payload_json, '$.status') = 'completed' ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .bind(run.accountId).first<{ id: string }>();
    if (saved?.payload_json === JSON.stringify(run)) await notifyMonitorFailure(run, completed?.id ?? 'initial');
  }
}

export async function readMonitorReport(accountId: string): Promise<{ findings: MonitorFinding[]; runs: MonitorRun[]; counts: { status: MonitorFinding['status']; count: number }[] }> {
  const db = await monitorDatabase();
  const [findings, runs, counts] = await Promise.all([
    db.prepare(`SELECT * FROM monitor_findings WHERE account_id = ? ORDER BY
      CASE status WHEN 'unknown' THEN 0 WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END, last_seen_at DESC LIMIT 100`).bind(accountId).all<FindingRow>(),
    db.prepare('SELECT payload_json FROM monitor_runs WHERE account_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 25').bind(accountId).all<{ payload_json: string }>(),
    db.prepare('SELECT status, COUNT(*) AS count FROM monitor_findings WHERE account_id = ? GROUP BY status').bind(accountId).all<{ status: MonitorFinding['status']; count: number }>(),
  ]);
  return { findings: findings.results.map(hydrateFinding), runs: runs.results.map((row) => { const run = JSON.parse(row.payload_json) as MonitorRun; return { ...run, accountId: monitorAccountIdentity(run.accountId).accountId }; }), counts: counts.results };
}

function hydrateFinding(row: FindingRow): MonitorFinding {
  return {
    provider: 'hubspot', objectType: 'Contact', ...JSON.parse(row.evidence_json), id: row.id, accountId: monitorAccountIdentity(row.account_id).accountId, contactId: row.contact_id.replace(/^(Lead|Contact):/, ''),
    rule: row.rule, status: row.status, assignee: row.assignee, note: row.note,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, resolvedAt: row.resolved_at,
    occurrences: row.occurrences, repairError: row.repair_error,
  } as MonitorFinding;
}
