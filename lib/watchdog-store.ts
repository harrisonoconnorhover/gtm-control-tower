import { getDatabase, type DatabaseAdapter } from '@/db';
import { WATCHDOG_DEFAULT_CONFIG, type WatchdogConfig, type WatchdogFinding, type WatchdogRun } from './watchdog-types';
import { validWatchdogEmail, type WatchdogIssue, type WatchdogSnapshot } from './watchdog-rules';

export type WatchdogAccount = {
  account_id: string; config_json: string; phase: 'baseline' | 'changes'; cursor: string | null;
  baseline_started_at: string | null; last_baseline_at: string | null; watermark: string | null;
  window_end: string | null; last_checked_at: string | null; next_check_at: string | null;
  lease_id: string | null; lease_expires_at: string | null;
};
type FindingRow = {
  id: string; account_id: string; contact_id: string; rule: WatchdogFinding['rule'];
  status: WatchdogFinding['status']; assignee: string; note: string; first_seen_at: string;
  last_seen_at: string; resolved_at: string | null; occurrences: number; evidence_json: string;
  repair_error: string | null;
};
let schemaPromise: Promise<void> | null = null;
const leasePredicate = 'EXISTS (SELECT 1 FROM watchdog_accounts WHERE account_id = ? AND lease_id = ? AND lease_expires_at > ?)';

export async function watchdogDatabase(): Promise<DatabaseAdapter> {
  const db = await getDatabase();
  if (db.kind !== 'sqlite') throw new Error('Watchdog currently requires the self-hosted SQLite runtime. Cloudflare D1 execution is not supported.');
  schemaPromise ??= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS watchdog_accounts (
      account_id TEXT PRIMARY KEY, config_json TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'baseline',
      cursor TEXT, baseline_started_at TEXT, last_baseline_at TEXT, watermark TEXT, window_end TEXT,
      last_checked_at TEXT, next_check_at TEXT, lease_id TEXT, lease_expires_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS watchdog_snapshots (
      account_id TEXT NOT NULL, contact_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(account_id, contact_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS watchdog_findings (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, contact_id TEXT NOT NULL, rule TEXT NOT NULL,
      status TEXT NOT NULL, assignee TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, resolved_at TEXT,
      occurrences INTEGER NOT NULL DEFAULT 1, evidence_json TEXT NOT NULL, repair_error TEXT, auto_eligible INTEGER NOT NULL DEFAULT 0,
      UNIQUE(account_id, contact_id, rule)
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_watchdog_findings_account ON watchdog_findings(account_id, status, last_seen_at)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS watchdog_repairs (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, finding_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      lease_id TEXT NOT NULL, state TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, error TEXT
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_watchdog_repairs_finding ON watchdog_repairs(account_id, finding_id, state)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS watchdog_runs (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, started_at TEXT NOT NULL, payload_json TEXT NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_watchdog_runs_account ON watchdog_runs(account_id, started_at)'),
  ]).then(() => undefined).catch((error) => { schemaPromise = null; throw error; });
  await schemaPromise;
  return db;
}

export async function getWatchdogAccount(accountId: string): Promise<WatchdogAccount> {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(accountId)) throw new Error('Invalid HubSpot account identity.');
  const db = await watchdogDatabase();
  await db.prepare('INSERT INTO watchdog_accounts (account_id, config_json) VALUES (?, ?) ON CONFLICT(account_id) DO NOTHING')
    .bind(accountId, JSON.stringify(WATCHDOG_DEFAULT_CONFIG)).run();
  return (await db.prepare('SELECT * FROM watchdog_accounts WHERE account_id = ?').bind(accountId).first<WatchdogAccount>())!;
}

export async function setWatchdogConfig(accountId: string, config: WatchdogConfig): Promise<void> {
  await getWatchdogAccount(accountId);
  const db = await watchdogDatabase();
  await db.prepare('UPDATE watchdog_accounts SET config_json = ?, next_check_at = NULL WHERE account_id = ?').bind(JSON.stringify(config), accountId).run();
}

/** A fixed four-minute lease exceeds the bounded provider budget. No work continues after its fence expires. */
export async function claimWatchdogTick(accountId: string, force: boolean): Promise<WatchdogAccount | null> {
  const initial = await getWatchdogAccount(accountId);
  const config = JSON.parse(initial.config_json) as WatchdogConfig;
  const now = new Date().toISOString();
  if (!config.enabled || (!force && initial.next_check_at && initial.next_check_at > now)) return null;
  const db = await watchdogDatabase();
  const leaseId = crypto.randomUUID();
  const row = await db.prepare(`UPDATE watchdog_accounts SET lease_id = ?, lease_expires_at = ?
    WHERE account_id = ? AND config_json = ? AND (lease_id IS NULL OR lease_expires_at <= ?)
    AND (? = 1 OR next_check_at IS NULL OR next_check_at <= ?) RETURNING *`)
    .bind(leaseId, new Date(Date.now() + 240_000).toISOString(), accountId, initial.config_json, now, force ? 1 : 0, now)
    .first<WatchdogAccount>();
  if (!row) return null;
  // Interrupted sending attempts are never candidates for another automatic PATCH.
  await db.batch([
    db.prepare(`UPDATE watchdog_findings SET status = 'unknown', repair_error = 'A previous repair was interrupted. Verify HubSpot manually; it will not be replayed.'
      WHERE account_id = ? AND id IN (SELECT finding_id FROM watchdog_repairs WHERE account_id = ? AND state = 'sending')`)
      .bind(accountId, accountId),
    db.prepare(`UPDATE watchdog_repairs SET state = 'unknown', finished_at = ?, error = 'Worker interrupted; remote outcome unknown.'
      WHERE account_id = ? AND state = 'sending'`).bind(now, accountId),
  ]);
  const interrupted = await db.prepare('SELECT payload_json FROM watchdog_runs WHERE account_id = ? ORDER BY started_at DESC LIMIT 1').bind(accountId).first<{ payload_json: string }>();
  if (interrupted) {
    const run = JSON.parse(interrupted.payload_json) as WatchdogRun;
    if (run.status === 'running') await saveWatchdogRun({ ...run, status: 'failed', finishedAt: now, error: 'Previous worker stopped before completing its page. The saved page will be retried; uncertain repairs are held for review.' }, leaseId);
  }
  return row;
}

export async function assertWatchdogLease(accountId: string, leaseId: string, repairs = false): Promise<WatchdogAccount> {
  const db = await watchdogDatabase();
  const row = await db.prepare(`SELECT * FROM watchdog_accounts WHERE account_id = ? AND lease_id = ? AND lease_expires_at > ?`)
    .bind(accountId, leaseId, new Date(Date.now() + 15_000).toISOString()).first<WatchdogAccount>();
  if (!row) throw new Error('Watchdog worker lease expired or was replaced. No further CRM write may start.');
  const config = JSON.parse(row.config_json) as WatchdogConfig;
  if (!config.enabled || (repairs && !config.automaticRepairs)) throw new Error('Watchdog was disabled or automatic repairs were turned off during this tick.');
  return row;
}

export async function checkpointWatchdog(account: WatchdogAccount, leaseId: string): Promise<void> {
  const db = await watchdogDatabase();
  const saved = await db.prepare(`UPDATE watchdog_accounts SET phase = ?, cursor = ?, baseline_started_at = ?, last_baseline_at = ?,
    watermark = ?, window_end = ?, last_checked_at = ?, next_check_at = ?
    WHERE account_id = ? AND lease_id = ? AND lease_expires_at > ? RETURNING account_id`)
    .bind(account.phase, account.cursor, account.baseline_started_at, account.last_baseline_at,
      account.watermark, account.window_end, account.last_checked_at, account.next_check_at,
      account.account_id, leaseId, new Date().toISOString()).first();
  if (!saved) throw new Error('Watchdog checkpoint lost its worker lease. The page was not advanced.');
}

export async function releaseWatchdogTick(accountId: string, leaseId: string): Promise<void> {
  const db = await watchdogDatabase();
  await db.prepare('UPDATE watchdog_accounts SET lease_id = NULL, lease_expires_at = NULL WHERE account_id = ? AND lease_id = ?').bind(accountId, leaseId).run();
}

export async function getWatchdogSnapshot(accountId: string, contactId: string): Promise<WatchdogSnapshot | null> {
  const db = await watchdogDatabase();
  const row = await db.prepare('SELECT payload_json FROM watchdog_snapshots WHERE account_id = ? AND contact_id = ?').bind(accountId, contactId).first<{ payload_json: string }>();
  return row ? JSON.parse(row.payload_json) as WatchdogSnapshot : null;
}

export async function saveWatchdogObservation(accountId: string, leaseId: string, snapshot: WatchdogSnapshot, label: string, issues: WatchdogIssue[], assignee: string): Promise<{ findings: WatchdogFinding[]; opened: number }> {
  const db = await watchdogDatabase();
  const now = new Date().toISOString();
  const previous = await getContactFindings(accountId, snapshot.contact.id);
  const statements = issues.map((issue) => db.prepare(`INSERT INTO watchdog_findings
    (id, account_id, contact_id, rule, status, assignee, first_seen_at, last_seen_at, evidence_json, auto_eligible)
    SELECT ?, ?, ?, ?, 'open', ?, ?, ?, ?, ? WHERE ${leasePredicate}
    ON CONFLICT(account_id, contact_id, rule) DO UPDATE SET
      status = CASE WHEN watchdog_findings.status IN ('fixed', 'resolved') THEN 'open' ELSE watchdog_findings.status END,
      occurrences = watchdog_findings.occurrences + CASE WHEN watchdog_findings.status IN ('fixed', 'resolved') THEN 1 ELSE 0 END,
      last_seen_at = excluded.last_seen_at, resolved_at = NULL, evidence_json = excluded.evidence_json, auto_eligible = excluded.auto_eligible`)
    .bind(crypto.randomUUID(), accountId, snapshot.contact.id, issue.rule, assignee, now, now,
      JSON.stringify({ ...issue, contactLabel: label }),
      issue.rule === 'text_whitespace' && Object.values(issue.after).every(Boolean) && validWatchdogEmail(snapshot.contact.properties.email ?? '') ? 1 : 0,
      accountId, leaseId, now));
  for (const finding of previous) {
    if (!issues.some((issue) => issue.rule === finding.rule) && ['open', 'in_progress'].includes(finding.status)) {
      statements.push(db.prepare(`UPDATE watchdog_findings SET status = 'resolved', resolved_at = ?, repair_error = NULL
        WHERE id = ? AND status IN ('open', 'in_progress') AND ${leasePredicate}`).bind(now, finding.id, accountId, leaseId, now));
    }
  }
  statements.push(db.prepare(`INSERT INTO watchdog_snapshots (account_id, contact_id, payload_json)
    SELECT ?, ?, ? WHERE ${leasePredicate}
    ON CONFLICT(account_id, contact_id) DO UPDATE SET payload_json = excluded.payload_json`)
    .bind(accountId, snapshot.contact.id, JSON.stringify(snapshot), accountId, leaseId, now));
  await db.batch(statements);
  await assertWatchdogLease(accountId, leaseId);
  return {
    findings: await getContactFindings(accountId, snapshot.contact.id),
    opened: issues.filter((issue) => !previous.some((finding) => finding.rule === issue.rule && !['resolved', 'fixed'].includes(finding.status))).length,
  };
}

export async function getContactFindings(accountId: string, contactId: string): Promise<WatchdogFinding[]> {
  const db = await watchdogDatabase();
  const rows = await db.prepare('SELECT * FROM watchdog_findings WHERE account_id = ? AND contact_id = ?').bind(accountId, contactId).all<FindingRow>();
  return rows.results.map(hydrateFinding);
}

export async function getPendingWatchdogRepairs(accountId: string, limit = 5): Promise<{ finding: WatchdogFinding; snapshot: WatchdogSnapshot }[]> {
  const db = await watchdogDatabase();
  const rows = await db.prepare(`SELECT f.*, s.payload_json AS snapshot_json FROM watchdog_findings f
    JOIN watchdog_snapshots s ON s.account_id = f.account_id AND s.contact_id = f.contact_id
    WHERE f.account_id = ? AND f.rule = 'text_whitespace' AND f.status = 'open' AND f.auto_eligible = 1
    AND NOT EXISTS (SELECT 1 FROM watchdog_repairs r WHERE r.account_id = f.account_id AND r.finding_id = f.id AND r.state IN ('sending', 'unknown'))
    ORDER BY f.last_seen_at ASC, f.id ASC LIMIT ?`).bind(accountId, Math.min(5, Math.max(1, limit)))
    .all<FindingRow & { snapshot_json: string }>();
  return rows.results.map((row) => ({ finding: hydrateFinding(row), snapshot: JSON.parse(row.snapshot_json) as WatchdogSnapshot }));
}

export async function claimWatchdogRepair(accountId: string, leaseId: string, finding: WatchdogFinding): Promise<string | null> {
  const db = await watchdogDatabase();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const row = await db.prepare(`INSERT INTO watchdog_repairs
    (id, account_id, finding_id, contact_id, lease_id, state, before_json, after_json, started_at)
    SELECT ?, ?, ?, ?, ?, 'sending', ?, ?, ? WHERE ${leasePredicate}
    AND EXISTS (SELECT 1 FROM watchdog_findings WHERE id = ? AND account_id = ? AND status = 'open')
    AND NOT EXISTS (SELECT 1 FROM watchdog_repairs WHERE account_id = ? AND finding_id = ? AND state IN ('sending', 'unknown')) RETURNING id`)
    .bind(id, accountId, finding.id, finding.contactId, leaseId, JSON.stringify(finding.before), JSON.stringify(finding.after), now,
      accountId, leaseId, new Date(Date.now() + 15_000).toISOString(), finding.id, accountId, accountId, finding.id).first<{ id: string }>();
  if (!row) return null;
  await db.prepare(`UPDATE watchdog_findings SET status = 'unknown', repair_error = 'Repair dispatched; waiting for verified readback.'
    WHERE id = ? AND account_id = ? AND ${leasePredicate}`).bind(finding.id, accountId, accountId, leaseId, now).run();
  return row.id;
}

export async function finishWatchdogRepair(accountId: string, leaseId: string, repairId: string, findingId: string, state: 'verified' | 'unknown', error: string | null): Promise<void> {
  const db = await watchdogDatabase();
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE watchdog_repairs SET state = ?, finished_at = ?, error = ? WHERE id = ? AND account_id = ? AND lease_id = ? AND state = 'sending' AND ${leasePredicate}`)
      .bind(state, now, error, repairId, accountId, leaseId, accountId, leaseId, now),
    db.prepare(`UPDATE watchdog_findings SET status = ?, resolved_at = ?, repair_error = ? WHERE id = ? AND account_id = ? AND ${leasePredicate}
      AND EXISTS (SELECT 1 FROM watchdog_repairs WHERE id = ? AND state = ?)`)
      .bind(state === 'verified' ? 'fixed' : 'unknown', state === 'verified' ? now : null, error, findingId, accountId, accountId, leaseId, now, repairId, state),
  ]);
}

export async function setWatchdogFindingError(accountId: string, leaseId: string, findingId: string, error: string): Promise<void> {
  const db = await watchdogDatabase();
  await db.prepare(`UPDATE watchdog_findings SET repair_error = ?, auto_eligible = 0 WHERE id = ? AND account_id = ? AND ${leasePredicate}`)
    .bind(error, findingId, accountId, accountId, leaseId, new Date().toISOString()).run();
}

export async function updateWatchdogTriage(accountId: string, input: { id: string; status: 'open' | 'in_progress' | 'resolved'; assignee: string; note: string }): Promise<void> {
  const db = await watchdogDatabase();
  const row = await db.prepare(`UPDATE watchdog_findings SET status = ?, assignee = ?, note = ?, resolved_at = ?
    WHERE id = ? AND account_id = ? AND NOT EXISTS (SELECT 1 FROM watchdog_repairs WHERE finding_id = ? AND state = 'sending') RETURNING id`)
    .bind(input.status, input.assignee, input.note, input.status === 'resolved' ? new Date().toISOString() : null, input.id, accountId, input.id).first();
  if (!row) throw new Error('Finding was not found in this account or has a repair in flight.');
}

export async function saveWatchdogRun(run: WatchdogRun, leaseId: string): Promise<void> {
  const db = await watchdogDatabase();
  await db.prepare(`INSERT INTO watchdog_runs (id, account_id, started_at, payload_json)
    SELECT ?, ?, ?, ? WHERE ${leasePredicate}
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`)
    .bind(run.id, run.accountId, run.startedAt, JSON.stringify(run), run.accountId, leaseId, new Date().toISOString()).run();
}

export async function readWatchdogReport(accountId: string): Promise<{ findings: WatchdogFinding[]; runs: WatchdogRun[]; counts: { status: WatchdogFinding['status']; count: number }[] }> {
  const db = await watchdogDatabase();
  const [findings, runs, counts] = await Promise.all([
    db.prepare(`SELECT * FROM watchdog_findings WHERE account_id = ? ORDER BY
      CASE status WHEN 'unknown' THEN 0 WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END, last_seen_at DESC LIMIT 100`).bind(accountId).all<FindingRow>(),
    db.prepare('SELECT payload_json FROM watchdog_runs WHERE account_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 25').bind(accountId).all<{ payload_json: string }>(),
    db.prepare('SELECT status, COUNT(*) AS count FROM watchdog_findings WHERE account_id = ? GROUP BY status').bind(accountId).all<{ status: WatchdogFinding['status']; count: number }>(),
  ]);
  return { findings: findings.results.map(hydrateFinding), runs: runs.results.map((row) => JSON.parse(row.payload_json) as WatchdogRun), counts: counts.results };
}

function hydrateFinding(row: FindingRow): WatchdogFinding {
  return {
    ...JSON.parse(row.evidence_json), id: row.id, accountId: row.account_id, contactId: row.contact_id,
    rule: row.rule, status: row.status, assignee: row.assignee, note: row.note,
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, resolvedAt: row.resolved_at,
    occurrences: row.occurrences, repairError: row.repair_error,
  } as WatchdogFinding;
}
