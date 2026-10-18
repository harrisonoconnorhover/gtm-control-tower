import type { DatabaseAdapter, PreparedQuery } from '@/db';
import { getIncidentCoverage, incidentDatabase } from './crm-incidents';
import { monitorAccountIdentity, type MonitorContact, type MonitorProvider } from './monitor-types';
import {
  parseDestinationEvidence, parseHandoffManifest, reconcileHandoff,
  type DestinationEvidence, type HandoffManifest, type HandoffReport,
} from './handoff-audit';

export const HANDOFF_BODY_LIMIT = 5 * 1024 * 1024;
const CACHE_RECORD_LIMIT = 10_000;
const SNAPSHOT_NOTE = 'Imported evidence is a supplied snapshot, not a verified live CRM connection. Its completeness and timestamps are assertions from the file.';
const CACHE_NOTE = 'Monitor polling cannot prove deletion or reconstruct intermediate changes. Converted or deleted leads may remain in the cache; presence is a recorded observation, not proof of current existence.';

export class HandoffAuditError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export type HandoffSavedAccount = { scope: string; provider: MonitorProvider; accountId: string };
export type HandoffAuditSummary = {
  id: string; name: string; createdAt: string; sourceAccount: string; destinationAccount: string; mode: 'monitor' | 'snapshot';
};
export type HandoffRelatedIncident = {
  id: string; accountId: string; title: string; status: string; kind: string; recordKeys: string[]; href: string;
};
export type HandoffAuditDetail = HandoffAuditSummary & {
  manifest: HandoffManifest; evidence: DestinationEvidence; report: HandoffReport; reportId: string;
  history: { id: string; evaluatedAt: string }[]; relatedIncidents: HandoffRelatedIncident[];
};
export type HandoffAuditOverview = { accounts: HandoffSavedAccount[]; audits: HandoffAuditSummary[]; selected: HandoffAuditDetail | null };
type AuditRow = {
  id: string; request_id: string; request_hash: string; name: string; created_at: string;
  source_account: string; destination_account: string; mode: 'monitor' | 'snapshot'; manifest_json: string;
};
type ReportRow = { id: string; evaluated_at: string; evidence_json: string; report_json: string };
type CacheRow = { object_type: 'Lead' | 'Contact'; record_id: string; provider_updated_at: string; observed_at: string; first_seen_at: string; payload_json: string };
type AccountRow = { phase: string; cursor: string | null; watermark: string | null; window_end: string | null };
type RecordClock = {
  observedAt: string; sourceUpdatedAt: string | null; firstObservedAt: string | null;
  observedProperties: Record<string, string>; sourceProperties: Record<string, string>;
};
type ArrivalProof = {
  observedAt: string; sourceUpdatedAt: string | null; firstObservedAt: string | null;
  destinationIds: HandoffReport['rows'][number]['destinationIds']; routing: HandoffReport['rows'][number]['routing'];
};
type RetainedEvidence = { records: Map<string, RecordClock>; arrivals: Map<string, ArrivalProof>; observedAt: string | null; completeThrough: string | null };
let schema: Promise<void> | null = null;

/** Only audit tables are written. No monitor runner, provider, incident detector, or notification dispatcher is called. */
async function auditDatabase(): Promise<DatabaseAdapter> {
  const db = await incidentDatabase();
  schema ??= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS handoff_audits (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      name TEXT NOT NULL, created_at TEXT NOT NULL, source_account TEXT NOT NULL,
      destination_account TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('monitor','snapshot')), manifest_json TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS handoff_audit_reports (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      audit_id TEXT NOT NULL REFERENCES handoff_audits(id), evaluated_at TEXT NOT NULL,
      evidence_json TEXT NOT NULL, report_json TEXT NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_handoff_reports_audit ON handoff_audit_reports(audit_id, sequence DESC)'),
    db.prepare('CREATE TABLE IF NOT EXISTS handoff_audit_record_clocks(audit_id TEXT NOT NULL,record_key TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(audit_id,record_key))'),
    db.prepare('CREATE TABLE IF NOT EXISTS handoff_audit_arrivals(audit_id TEXT NOT NULL,row_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(audit_id,row_id))'),
    db.prepare('CREATE TABLE IF NOT EXISTS handoff_audit_retention_state(audit_id TEXT PRIMARY KEY)'),
    db.prepare('CREATE TABLE IF NOT EXISTS handoff_audit_coverage_clocks(audit_id TEXT PRIMARY KEY,complete_through TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS handoff_audit_envelope_clocks(audit_id TEXT PRIMARY KEY,observed_at TEXT)'),
  ]).then(() => undefined).catch((error) => { schema = null; throw error; });
  await schema;
  return db;
}

/** Do not call incidentAccounts here: its monitorDatabase initializer can migrate notification state. */
export async function getHandoffAccounts(): Promise<HandoffSavedAccount[]> {
  const db = await incidentDatabase();
  const table = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='monitor_accounts'").first();
  if (!table) return [];
  const rows = (await db.prepare('SELECT account_id FROM monitor_accounts ORDER BY account_id LIMIT 100').all<{ account_id: string }>()).results;
  return rows.map(({ account_id: scope }) => ({ scope, ...monitorAccountIdentity(scope) }));
}

async function assertMonitorAccounts(manifest: HandoffManifest) {
  const accounts = await getHandoffAccounts();
  if (!accounts.some((account) => account.scope === manifest.sourceAccount && account.provider === 'hubspot')
    || !accounts.some((account) => account.scope === manifest.destinationAccount && account.provider === 'salesforce')) {
    throw new HandoffAuditError('Monitor mode requires explicitly selected saved HubSpot and Salesforce account scopes. Import a snapshot to inspect evidence without saved accounts.');
  }
}

function validDate(value: string | null): value is string { return value !== null && Number.isFinite(Date.parse(value)); }

export async function readHandoffMonitorEvidence(manifest: HandoffManifest): Promise<DestinationEvidence> {
  await assertMonitorAccounts(manifest);
  const db = await incidentDatabase();
  const [coverage, state, cached] = await Promise.all([
    getIncidentCoverage(manifest.destinationAccount),
    db.prepare('SELECT phase,cursor,watermark,window_end FROM monitor_accounts WHERE account_id=?')
      .bind(manifest.destinationAccount).first<AccountRow>(),
    db.prepare("SELECT object_type,record_id,provider_updated_at,observed_at,first_seen_at,payload_json FROM crm_observed_records WHERE account_id=? AND object_type IN ('Lead','Contact') ORDER BY record_key LIMIT ?")
      .bind(manifest.destinationAccount, CACHE_RECORD_LIMIT + 1).all<CacheRow>(),
  ]);
  const limitations = [...coverage.limitations, CACHE_NOTE];
  let complete = coverage.status === 'healthy' && coverage.phase === 'changes' && state?.phase === 'changes';
  if (!complete) limitations.push(`Destination monitor coverage is ${coverage.status}; a completed healthy baseline and changes phase are required to infer absence.`);
  if (!state || !validDate(state.watermark) || state.cursor !== null || state.window_end !== null) {
    complete = false;
    limitations.push('The monitor has no completed watermark or still has an unfinished page/window; absence cannot be inferred.');
  }
  for (const objectType of ['Lead', 'Contact'] as const) {
    const capability = coverage.capabilities?.find((item) => item.objectType === objectType);
    if (!coverage.objectTypes.includes(objectType) || capability?.status !== 'available') {
      complete = false;
      limitations.push(`${objectType} coverage is not confirmed available; matching may miss records of this type.`);
    }
    if (manifest.policy.destinationMatchField && !capability?.fields.includes(manifest.policy.destinationMatchField)) {
      complete = false;
      limitations.push(`${objectType} does not confirm the configured source-ID match field ${manifest.policy.destinationMatchField}.`);
    }
  }
  if (cached.results.length > CACHE_RECORD_LIMIT) {
    complete = false;
    limitations.push(`Destination cache exceeds the ${CACHE_RECORD_LIMIT.toLocaleString('en-US')}-record audit bound; this view is truncated and cannot prove missing records.`);
  }
  const records: DestinationEvidence['records'] = [];
  for (const row of cached.results.slice(0, CACHE_RECORD_LIMIT)) {
    try {
      const record = JSON.parse(row.payload_json) as MonitorContact;
      if (record.provider !== 'salesforce' || record.id !== row.record_id || record.objectType !== row.object_type
        || !validDate(row.observed_at) || !validDate(row.provider_updated_at) || !validDate(row.first_seen_at)
        || !record.properties || typeof record.properties !== 'object') throw new Error('Invalid cached record');
      if (record.coverage?.length) {
        complete = false;
        limitations.push(`Record ${row.object_type}:${row.record_id} has saved field coverage gaps.`);
      }
      records.push({ objectType: row.object_type, id: row.record_id, observedAt: row.observed_at,
        sourceUpdatedAt: row.provider_updated_at, firstObservedAt: row.first_seen_at, properties: record.properties });
    } catch {
      complete = false;
      limitations.push(`Record ${row.object_type}:${row.record_id} has invalid cached evidence and was not evaluated.`);
    }
  }
  // Account-level freshness is separate from every cached record's observation clock. Never substitute retrieval time.
  const observedAt = validDate(coverage.lastSuccessAt) ? coverage.lastSuccessAt : '1970-01-01T00:00:00.000Z';
  if (!validDate(coverage.lastSuccessAt)) { complete = false; limitations.push('No successful destination observation timestamp is recorded.'); }
  return { accountId: manifest.destinationAccount, observedAt, completeThrough: complete && state ? state.watermark : null,
    coverage: complete ? 'complete' : 'incomplete', limitations: [...new Set(limitations)].slice(0, 100), records };
}

function snapshotEvidence(value: unknown, destinationAccount: string): DestinationEvidence {
  const evidence = parseDestinationEvidence(value);
  if (evidence.accountId !== destinationAccount) throw new HandoffAuditError('Destination evidence belongs to a different account scope.');
  return { ...evidence, limitations: [...new Set([...evidence.limitations, SNAPSHOT_NOTE])] };
}

function recordKey(record: DestinationEvidence['records'][number]) {
  // 15-character IDs preserve case; the last three characters on an 18-character ID are its checksum.
  return `${record.objectType}:${record.id.length === 18 ? record.id.slice(0, 15) : record.id}`;
}

function assertSnapshotChronology(next: DestinationEvidence, retained: RetainedEvidence) {
  const before = (left: string | null, right: string | null) => left !== null && right !== null && Date.parse(left) < Date.parse(right);
  if (before(next.observedAt, retained.observedAt) || before(next.completeThrough, retained.completeThrough)) {
    throw new HandoffAuditError('Replacement evidence predates the latest saved snapshot. Import older evidence as a separate audit to preserve the latest known handoff state.');
  }
  for (const record of next.records) {
    const old = retained.records.get(recordKey(record));
    if (!old) continue;
    if (before(record.observedAt, old.observedAt) || before(record.sourceUpdatedAt, old.sourceUpdatedAt)) {
      throw new HandoffAuditError(`Replacement evidence moves the recorded observation or source timestamp backward for ${record.objectType}:${record.id}.`);
    }
    if (old.firstObservedAt !== null && (record.firstObservedAt === null || before(old.firstObservedAt, record.firstObservedAt))) {
      throw new HandoffAuditError(`Keep the earliest known firstObservedAt for ${record.objectType}:${record.id}; replacing it would reset the routing deadline.`);
    }
    const contradicts = (properties: Record<string, string>) => Object.entries(record.properties)
      .some(([field, value]) => Object.hasOwn(properties, field) && properties[field] !== value);
    if ((Date.parse(record.observedAt) === Date.parse(old.observedAt) && contradicts(old.observedProperties))
      || (record.sourceUpdatedAt !== null && old.sourceUpdatedAt !== null
        && Date.parse(record.sourceUpdatedAt) === Date.parse(old.sourceUpdatedAt) && contradicts(old.sourceProperties))) {
      throw new HandoffAuditError(`Replacement evidence contradicts saved property values at the same timestamp for ${record.objectType}:${record.id}. Supply ordered observations instead of choosing an arbitrary value.`);
    }
  }
}

function retainEvidence(retained: RetainedEvidence, evidence: DestinationEvidence, report: HandoffReport) {
  // Invalid evidence remains visible in immutable reports, but must not become an authoritative clock that blocks correction.
  const coherentEnvelope = Date.parse(evidence.observedAt) <= Date.parse(report.evaluatedAt)
    && (evidence.completeThrough === null || Date.parse(evidence.completeThrough) <= Date.parse(evidence.observedAt));
  if (!coherentEnvelope) return;
  if (retained.observedAt === null || Date.parse(evidence.observedAt) > Date.parse(retained.observedAt)) retained.observedAt = evidence.observedAt;
  if (evidence.completeThrough !== null && (retained.completeThrough === null || Date.parse(evidence.completeThrough) > Date.parse(retained.completeThrough))) {
    retained.completeThrough = evidence.completeThrough;
  }
  for (const [index, record] of evidence.records.entries()) {
    if (report.evidenceSummary.recordAccounting[index]?.issues.length !== 0) continue;
    const key = recordKey(record);
    const old = retained.records.get(key);
    const laterObservation = !old || Date.parse(record.observedAt) > Date.parse(old.observedAt);
    const laterSource = record.sourceUpdatedAt !== null && (!old?.sourceUpdatedAt || Date.parse(record.sourceUpdatedAt) > Date.parse(old.sourceUpdatedAt));
    retained.records.set(key, {
      observedAt: laterObservation ? record.observedAt : old.observedAt,
      sourceUpdatedAt: laterSource ? record.sourceUpdatedAt : old?.sourceUpdatedAt ?? null,
      firstObservedAt: !old?.firstObservedAt || (record.firstObservedAt !== null && Date.parse(record.firstObservedAt) < Date.parse(old.firstObservedAt)) ? record.firstObservedAt : old.firstObservedAt,
      observedProperties: laterObservation ? record.properties : { ...record.properties, ...old.observedProperties },
      sourceProperties: laterSource ? record.properties : { ...record.properties, ...old?.sourceProperties },
    });
  }
  for (const row of report.rows) {
    if (row.evidence.lastObservedStatus !== 'present' || !row.evidence.destinationObservedAt) continue;
    const old = retained.arrivals.get(row.rowId);
    if (old && Date.parse(old.observedAt) >= Date.parse(row.evidence.destinationObservedAt)) continue;
    retained.arrivals.set(row.rowId, { observedAt: row.evidence.destinationObservedAt,
      sourceUpdatedAt: row.evidence.destinationSourceUpdatedAt, firstObservedAt: row.evidence.firstObservedAt,
      destinationIds: row.destinationIds, routing: row.evidence.lastObservedRouting ?? 'unknown' });
  }
}

async function readRetainedEvidence(db: DatabaseAdapter, id: string, next: DestinationEvidence): Promise<RetainedEvidence> {
  const initialized = !!await db.prepare('SELECT audit_id FROM handoff_audit_retention_state WHERE audit_id=?').bind(id).first();
  const retained: RetainedEvidence = { records: new Map(), arrivals: new Map(), observedAt: null, completeThrough: null };
  if (!initialized) {
    // Existing local audits made before the ledger was introduced are backfilled only during a POST.
    const history = (await db.prepare('SELECT evidence_json,report_json FROM handoff_audit_reports WHERE audit_id=? ORDER BY sequence').bind(id).all<ReportRow>()).results;
    for (const item of history) retainEvidence(retained, JSON.parse(item.evidence_json), JSON.parse(item.report_json));
    return retained;
  }
  const [records, arrivals, coverageClock, envelopeClock] = await Promise.all([
    db.prepare('SELECT record_key,payload_json FROM handoff_audit_record_clocks WHERE audit_id=? AND record_key IN (SELECT value FROM json_each(?))')
      .bind(id, JSON.stringify([...new Set(next.records.map(recordKey))])).all<{ record_key: string; payload_json: string }>(),
    db.prepare('SELECT row_id,payload_json FROM handoff_audit_arrivals WHERE audit_id=?').bind(id).all<{ row_id: string; payload_json: string }>(),
    db.prepare('SELECT complete_through FROM handoff_audit_coverage_clocks WHERE audit_id=?').bind(id).first<{ complete_through: string | null }>(),
    db.prepare('SELECT observed_at FROM handoff_audit_envelope_clocks WHERE audit_id=?').bind(id).first<{ observed_at: string | null }>(),
  ]);
  records.results.forEach((row) => retained.records.set(row.record_key, JSON.parse(row.payload_json)));
  arrivals.results.forEach((row) => retained.arrivals.set(row.row_id, JSON.parse(row.payload_json)));
  const coverage = coverageClock ?? await db.prepare(`SELECT json_extract(evidence_json,'$.completeThrough') AS complete_through FROM handoff_audit_reports
    WHERE audit_id=? AND json_extract(evidence_json,'$.completeThrough') IS NOT NULL
    AND julianday(json_extract(evidence_json,'$.observedAt'))<=julianday(evaluated_at)
    AND julianday(json_extract(evidence_json,'$.completeThrough'))<=julianday(json_extract(evidence_json,'$.observedAt'))
    ORDER BY julianday(json_extract(evidence_json,'$.completeThrough')) DESC LIMIT 1`).bind(id).first<{ complete_through: string | null }>();
  retained.completeThrough = coverage?.complete_through ?? null;
  const envelope = envelopeClock ?? await db.prepare(`SELECT json_extract(evidence_json,'$.observedAt') AS observed_at FROM handoff_audit_reports
    WHERE audit_id=? AND julianday(json_extract(evidence_json,'$.observedAt'))<=julianday(evaluated_at)
    AND (json_extract(evidence_json,'$.completeThrough') IS NULL OR julianday(json_extract(evidence_json,'$.completeThrough'))<=julianday(json_extract(evidence_json,'$.observedAt')))
    ORDER BY julianday(json_extract(evidence_json,'$.observedAt')) DESC LIMIT 1`).bind(id).first<{ observed_at: string | null }>();
  retained.observedAt = envelope?.observed_at ?? null;
  return retained;
}

function applyArrivalHistory(report: HandoffReport, retained: RetainedEvidence) {
  for (const row of report.rows) {
    const old = retained.arrivals.get(row.rowId);
    if (!old || row.evidence.destinationObservedAt !== null || row.status === 'excluded') continue;
    row.status = 'unknown'; row.routing = 'unknown';
    row.evidence.lastObservedStatus = 'present'; row.evidence.lastObservedRouting = old.routing;
    row.evidence.destinationObservedAt = old.observedAt;
    row.evidence.destinationSourceUpdatedAt = old.sourceUpdatedAt;
    row.evidence.firstObservedAt = old.firstObservedAt;
    for (const id of old.destinationIds) if (!row.destinationIds.some((item) => item.id === id.id && item.objectType === id.objectType)) row.destinationIds.push(id);
    row.reasons.push(`A previous arrival was observed at ${old.observedAt}. The latest snapshot has no uniquely matched current observation; absence or ambiguity may reflect deletion, conversion, or coverage changes. This cannot establish that the handoff never arrived.`);
  }
  for (const status of Object.keys(report.counts) as Array<keyof HandoffReport['counts']>) report.counts[status] = 0;
  for (const status of Object.keys(report.routingCounts) as Array<keyof HandoffReport['routingCounts']>) report.routingCounts[status] = 0;
  report.rows.forEach((row) => { report.counts[row.status]++; report.routingCounts[row.routing]++; });
}

function retentionStatements(db: DatabaseAdapter, id: string, reportId: string, retained: RetainedEvidence): PreparedQuery[] {
  const guard = 'EXISTS(SELECT 1 FROM handoff_audit_reports WHERE id=? AND audit_id=?)';
  return [
    ...[...retained.records].map(([key, value]) => db.prepare(`INSERT INTO handoff_audit_record_clocks(audit_id,record_key,payload_json) SELECT ?,?,? WHERE ${guard} ON CONFLICT(audit_id,record_key) DO UPDATE SET payload_json=excluded.payload_json`)
      .bind(id, key, JSON.stringify(value), reportId, id)),
    ...[...retained.arrivals].map(([key, value]) => db.prepare(`INSERT INTO handoff_audit_arrivals(audit_id,row_id,payload_json) SELECT ?,?,? WHERE ${guard} ON CONFLICT(audit_id,row_id) DO UPDATE SET payload_json=excluded.payload_json`)
      .bind(id, key, JSON.stringify(value), reportId, id)),
    db.prepare(`INSERT INTO handoff_audit_retention_state(audit_id) SELECT ? WHERE ${guard} ON CONFLICT DO NOTHING`).bind(id, reportId, id),
    db.prepare(`INSERT INTO handoff_audit_coverage_clocks(audit_id,complete_through) SELECT ?,? WHERE ${guard} ON CONFLICT(audit_id) DO UPDATE SET complete_through=excluded.complete_through`)
      .bind(id, retained.completeThrough, reportId, id),
    db.prepare(`INSERT INTO handoff_audit_envelope_clocks(audit_id,observed_at) SELECT ?,? WHERE ${guard} ON CONFLICT(audit_id) DO UPDATE SET observed_at=excluded.observed_at`)
      .bind(id, retained.observedAt, reportId, id),
  ];
}

function summary(row: AuditRow): HandoffAuditSummary {
  return { id: row.id, name: row.name, createdAt: row.created_at, sourceAccount: row.source_account,
    destinationAccount: row.destination_account, mode: row.mode };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

async function requestHash(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function checkRequestId(value: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{8,200}$/.test(value)) throw new HandoffAuditError('Use a stable requestId containing 8–200 letters, digits, periods, underscores, colons, or hyphens.');
}

export async function createHandoffAudit(input: { requestId: string; manifest: unknown; evidence?: unknown }, now = new Date().toISOString()): Promise<HandoffAuditDetail> {
  checkRequestId(input.requestId);
  const manifest = parseHandoffManifest(input.manifest);
  const mode = input.evidence === undefined ? 'monitor' : 'snapshot';
  const supplied = mode === 'snapshot' ? snapshotEvidence(input.evidence, manifest.destinationAccount) : null;
  const hash = await requestHash({ manifest, mode, evidence: supplied });
  const db = await auditDatabase();
  const previous = await db.prepare('SELECT * FROM handoff_audits WHERE request_id=?').bind(input.requestId).first<AuditRow>();
  if (previous) {
    if (previous.request_hash !== hash) throw new HandoffAuditError('This requestId was already used with different input. Use a new requestId for a new immutable cohort.', 409);
    return (await getHandoffAudit(previous.id))!;
  }
  const evidence = supplied ?? await readHandoffMonitorEvidence(manifest);
  const report = reconcileHandoff(manifest, evidence, now);
  const id = crypto.randomUUID();
  const reportId = crypto.randomUUID();
  const retained: RetainedEvidence = { records: new Map(), arrivals: new Map(), observedAt: null, completeThrough: null };
  retainEvidence(retained, evidence, report);
  await db.batch([
    db.prepare('INSERT INTO handoff_audits(id,request_id,request_hash,name,created_at,source_account,destination_account,mode,manifest_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING')
      .bind(id, input.requestId, hash, manifest.name, now, manifest.sourceAccount, manifest.destinationAccount, mode, JSON.stringify(manifest)),
    db.prepare('INSERT INTO handoff_audit_reports(id,audit_id,evaluated_at,evidence_json,report_json) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM handoff_audits WHERE id=?)')
      .bind(reportId, id, now, JSON.stringify(evidence), JSON.stringify(report), id),
    ...retentionStatements(db, id, reportId, retained),
  ]);
  const saved = (await db.prepare('SELECT * FROM handoff_audits WHERE request_id=?').bind(input.requestId).first<AuditRow>())!;
  if (saved.request_hash !== hash) throw new HandoffAuditError('This requestId was concurrently used with different input.', 409);
  return (await getHandoffAudit(saved.id))!;
}

export async function reconcileHandoffAudit(id: string, suppliedEvidence?: unknown, now = new Date().toISOString()): Promise<HandoffAuditDetail> {
  const existing = await getHandoffAudit(id);
  if (!existing) throw new HandoffAuditError('Handoff audit not found.', 404);
  if (existing.mode === 'monitor' && suppliedEvidence !== undefined) throw new HandoffAuditError('Monitor audits only reconcile saved monitor evidence. Create a separate snapshot audit for imported evidence.');
  const evidence = existing.mode === 'monitor' ? await readHandoffMonitorEvidence(existing.manifest)
    : suppliedEvidence === undefined ? existing.evidence : snapshotEvidence(suppliedEvidence, existing.destinationAccount);
  const db = await auditDatabase();
  const retained = await readRetainedEvidence(db, id, evidence);
  if (existing.mode === 'snapshot' && suppliedEvidence !== undefined) assertSnapshotChronology(evidence, retained);
  const report = reconcileHandoff(existing.manifest, evidence, now);
  applyArrivalHistory(report, retained);
  retainEvidence(retained, evidence, report);
  const reportId = crypto.randomUUID();
  // A competing reconciliation must not append older evidence after another process has advanced this audit.
  await db.batch([db.prepare(`INSERT INTO handoff_audit_reports(id,audit_id,evaluated_at,evidence_json,report_json)
    SELECT ?,?,?,?,? WHERE (SELECT id FROM handoff_audit_reports WHERE audit_id=? ORDER BY sequence DESC LIMIT 1)=?`)
    .bind(reportId, id, now, JSON.stringify(evidence), JSON.stringify(report), id, existing.reportId),
  ...retentionStatements(db, id, reportId, retained)]);
  if (!await db.prepare('SELECT id FROM handoff_audit_reports WHERE id=?').bind(reportId).first()) {
    throw new HandoffAuditError('Another reconciliation saved newer evidence. Reload the audit before retrying.', 409);
  }
  return (await getHandoffAudit(id))!;
}

async function relatedIncidents(db: DatabaseAdapter, manifest: HandoffManifest, report: HandoffReport): Promise<HandoffRelatedIncident[]> {
  const sourceKeys = [...new Set(manifest.rows.flatMap((row) => row.sourceId ? [row.sourceId] : []))];
  const destinationKeys = [...new Set(report.rows.flatMap((row) => row.destinationIds.flatMap((record) => [
    `${record.objectType}:${record.id}`, ...(record.id.length === 18 ? [`${record.objectType}:${record.id.slice(0, 15)}`] : []),
  ])))];
  const rows = (await db.prepare(`SELECT i.id,i.account_id,i.title,i.status,i.kind,r.record_key
    FROM crm_incidents i JOIN crm_incident_records r ON r.incident_id=i.id
    WHERE (i.account_id=? AND r.record_key IN (SELECT value FROM json_each(?)))
       OR (i.account_id=? AND r.record_key IN (SELECT value FROM json_each(?)))
    ORDER BY i.last_seen_at DESC,i.id,r.record_key LIMIT 500`)
    .bind(manifest.sourceAccount, JSON.stringify(sourceKeys), manifest.destinationAccount, JSON.stringify(destinationKeys))
    .all<{ id: string; account_id: string; title: string; status: string; kind: string; record_key: string }>()).results;
  const grouped = new Map<string, HandoffRelatedIncident>();
  for (const row of rows) {
    if (!grouped.has(row.id) && grouped.size >= 50) continue;
    const provider = monitorAccountIdentity(row.account_id).provider;
    const current = grouped.get(row.id) ?? { id: row.id, accountId: row.account_id, title: row.title, status: row.status,
      kind: row.kind, recordKeys: [], href: `/app/incidents?provider=${provider}&account=${encodeURIComponent(row.account_id)}&incident=${encodeURIComponent(row.id)}` };
    current.recordKeys.push(row.record_key);
    grouped.set(row.id, current);
  }
  return [...grouped.values()];
}

export async function getHandoffAudit(id: string): Promise<HandoffAuditDetail | null> {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new HandoffAuditError('Use a valid handoff audit ID.');
  const db = await auditDatabase();
  const row = await db.prepare('SELECT * FROM handoff_audits WHERE id=?').bind(id).first<AuditRow>();
  if (!row) return null;
  const latest = await db.prepare('SELECT id,evaluated_at,evidence_json,report_json FROM handoff_audit_reports WHERE audit_id=? ORDER BY sequence DESC LIMIT 1').bind(id).first<ReportRow>();
  if (!latest) throw new HandoffAuditError('The saved audit has no report snapshot.', 503);
  const history = (await db.prepare('SELECT id,evaluated_at FROM handoff_audit_reports WHERE audit_id=? ORDER BY sequence DESC LIMIT 50')
    .bind(id).all<{ id: string; evaluated_at: string }>()).results.map((item) => ({ id: item.id, evaluatedAt: item.evaluated_at }));
  const manifest = JSON.parse(row.manifest_json) as HandoffManifest;
  const report = JSON.parse(latest.report_json) as HandoffReport;
  return { ...summary(row), manifest, evidence: JSON.parse(latest.evidence_json) as DestinationEvidence, report,
    reportId: latest.id, history, relatedIncidents: await relatedIncidents(db, manifest, report) };
}

export async function getHandoffAuditOverview(id?: string | null): Promise<HandoffAuditOverview> {
  const db = await auditDatabase();
  const [accounts, saved] = await Promise.all([
    getHandoffAccounts(), db.prepare('SELECT * FROM handoff_audits ORDER BY created_at DESC,id DESC LIMIT 100').all<AuditRow>(),
  ]);
  const selectedId = id ?? saved.results[0]?.id;
  const selected = selectedId ? await getHandoffAudit(selectedId) : null;
  if (id && !selected) throw new HandoffAuditError('Handoff audit not found.', 404);
  return { accounts, audits: saved.results.map(summary), selected };
}
