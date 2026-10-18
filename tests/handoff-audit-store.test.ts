import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { incidentDatabase, ingestObservation, type IncidentCoverage } from '../lib/crm-incidents';
import { createHandoffAudit, getHandoffAccounts, getHandoffAudit, getHandoffAuditOverview, readHandoffMonitorEvidence, reconcileHandoffAudit } from '../lib/handoff-audit-store';
import type { DestinationEvidence, HandoffManifest, SourceRow } from '../lib/handoff-audit';

const directory = mkdtempSync(join(tmpdir(), 'handoff-store-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'audit.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
const now = '2026-10-16T12:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
const fetchSpy = vi.fn(() => Promise.reject(new Error('Network is forbidden in audit tests.')));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal('fetch', fetchSpy); fetchSpy.mockClear(); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

function row(id = '1001', overrides: Partial<SourceRow> = {}): SourceRow {
  return { rowId: `row-${id}`, sourceId: id, label: `Synthetic ${id}`, observedAt: now, sourceUpdatedAt: at(-20),
    eligibleAt: at(-20), properties: { permission: 'yes' }, destinationIds: [], exclusionReason: null, failure: null, ...overrides };
}
function manifest(name: string, rows = [row()]): HandoffManifest {
  return { version: 1, name, sourceAccount: 'fixture-hubspot', destinationAccount: 'salesforce_fixture', capturedAt: now,
    policy: { syncDeadlineMinutes: 10, routingDeadlineMinutes: 5, evidenceMaxAgeMinutes: 60,
      destinationMatchField: 'hubspot_id', eligibilityRules: [{ field: 'permission', operator: 'equals', values: ['yes'] }],
      routingRules: [{ field: 'owner_id', operator: 'not_empty', values: [] }] }, rows };
}
function evidence(overrides: Partial<DestinationEvidence> = {}): DestinationEvidence {
  return { accountId: 'salesforce_fixture', observedAt: now, completeThrough: now, coverage: 'complete', limitations: [], records: [], ...overrides };
}
const lead = (id = '00Q000000000001', source = '1001', owner = ''): DestinationEvidence['records'][number] => ({
  objectType: 'Lead', id, observedAt: now, sourceUpdatedAt: at(-10), firstObservedAt: at(-10), properties: { hubspot_id: source, owner_id: owner },
});

async function seedMonitor(overrides: Partial<IncidentCoverage> = {}, state: Partial<{ phase: string; cursor: string | null; watermark: string | null; window_end: string | null }> = {}) {
  const db = await incidentDatabase();
  await db.prepare('CREATE TABLE IF NOT EXISTS monitor_accounts(account_id TEXT PRIMARY KEY,phase TEXT,cursor TEXT,watermark TEXT,window_end TEXT)').run();
  for (const account of ['fixture-hubspot', 'salesforce_fixture', 'salesforce_other']) {
    await db.prepare('INSERT OR REPLACE INTO monitor_accounts(account_id,phase,cursor,watermark,window_end) VALUES(?,?,?,?,?)')
      .bind(account, state.phase ?? 'changes', state.cursor ?? null, state.watermark === undefined ? now : state.watermark, state.window_end ?? null).run();
  }
  const coverage: IncidentCoverage = { status: 'healthy', phase: 'changes', lastCheckedAt: now, baselineStartedAt: at(-60),
    lastSuccessAt: now, staleAfterSeconds: 900, lastChangedAt: now, scanned: 0, error: null, objectTypes: ['Lead', 'Contact'],
    capabilities: ['Lead', 'Contact'].map((objectType) => ({ objectType: objectType as 'Lead' | 'Contact', status: 'available', fields: ['hubspot_id', 'owner_id'], missingFields: [], detail: 'Synthetic coverage' })),
    limitations: [], ...overrides };
  await db.prepare('INSERT OR REPLACE INTO crm_incident_coverage(account_id,payload_json) VALUES(?,?)').bind('salesforce_fixture', JSON.stringify(coverage)).run();
}

async function cacheRecord(id = '00Q000000000001', account = 'salesforce_fixture', minute = -10) {
  await ingestObservation(account, { provider: 'salesforce', objectType: 'Lead', id, updatedAt: at(minute), properties: { hubspot_id: '1001', owner_id: '' } },
    { phase: 'baseline', observedAt: at(minute) });
}

describe('local handoff audit store', () => {
  it('imports explicitly named accounts without credentials, saves every cohort row, and keeps a durable report history', async () => {
    const source = manifest('Synthetic cohort', [row(), row('1002', { properties: { permission: 'no' }, exclusionReason: 'No permission' }),
      row('1003', { eligibleAt: at(-2) }), row('1004', { failure: { message: 'Validation rejected the record', occurredAt: at(-1), evidenceRef: 'synthetic-log:4' } })]);
    const saved = await createHandoffAudit({ requestId: 'snapshot-cohort', manifest: source, evidence: evidence({ records: [lead()] }) }, now);
    expect(saved.mode).toBe('snapshot');
    expect(saved.manifest).toEqual(source);
    expect(saved.report.rows.map((result) => result.status)).toEqual(['present', 'excluded', 'awaiting_sync', 'failed']);
    expect(saved.report.rows[0].routing).toBe('unrouted');
    expect(saved.evidence.limitations.join(' ')).toContain('not a verified live CRM connection');
    const countsBefore = await (await incidentDatabase()).prepare('SELECT COUNT(*) AS count FROM handoff_audit_reports').first();
    expect((await getHandoffAudit(saved.id))?.report).toEqual(saved.report);
    expect((await getHandoffAuditOverview(saved.id)).selected?.id).toBe(saved.id);
    expect(await (await incidentDatabase()).prepare('SELECT COUNT(*) AS count FROM handoff_audit_reports').first()).toEqual(countsBefore);
  });

  it('makes create idempotent, rejects collisions, and never overwrites the immutable manifest', async () => {
    const source = manifest('Idempotency');
    const input = { requestId: 'same-create-request', manifest: source, evidence: evidence() };
    const [first, duplicate] = await Promise.all([createHandoffAudit(input, now), createHandoffAudit(input, now)]);
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.history).toHaveLength(1);
    await expect(createHandoffAudit({ ...input, manifest: { ...source, name: 'Changed' } }, now)).rejects.toMatchObject({ status: 409 });
    source.rows[0].label = 'Mutation of caller object';
    expect((await getHandoffAudit(first.id))!.manifest.rows[0].label).toBe('Synthetic 1001');
  });

  it('reconciles delayed arrival using new evidence and leaves the original cohort and previous report untouched', async () => {
    const source = manifest('Delayed arrival', [row('1001', { eligibleAt: at(-2) })]);
    const saved = await createHandoffAudit({ requestId: 'delay-cohort', manifest: source, evidence: evidence() }, now);
    expect(saved.report.rows[0].status).toBe('awaiting_sync');
    const advanced = at(8);
    const arrived = evidence({ observedAt: advanced, completeThrough: advanced, records: [{ ...lead(), observedAt: advanced, sourceUpdatedAt: advanced, firstObservedAt: advanced }] });
    const next = await reconcileHandoffAudit(saved.id, arrived, advanced);
    expect(next.report.rows[0]).toMatchObject({ status: 'present', routing: 'awaiting_routing' });
    expect(next.manifest).toEqual(saved.manifest);
    expect(next.history).toHaveLength(2);
    const db = await incidentDatabase();
    const first = await db.prepare('SELECT report_json FROM handoff_audit_reports WHERE id=?').bind(saved.reportId).first<{ report_json: string }>();
    expect(JSON.parse(first!.report_json)).toEqual(saved.report);
    const oldClock = next.evidence.observedAt;
    const stale = await reconcileHandoffAudit(saved.id, undefined, at(100));
    expect(stale.evidence.observedAt).toBe(oldClock);
    expect(stale.report.evidenceSummary.fresh).toBe(false);
  });

  it('rejects snapshot account mismatch and bounds source cohorts', async () => {
    await expect(createHandoffAudit({ requestId: 'wrong-account', manifest: manifest('Wrong account'), evidence: evidence({ accountId: 'salesforce_other' }) }, now)).rejects.toThrow('different account');
    await expect(createHandoffAudit({ requestId: 'too-many-rows', manifest: manifest('Too many', Array.from({ length: 5001 }, (_, index) => row(String(index)))), evidence: evidence() }, now)).rejects.toThrow();
  });

  it('rejects older snapshots and regressing record clocks after arrival without superseding the saved report', async () => {
    const source = manifest('Chronology');
    const saved = await createHandoffAudit({ requestId: 'chronology-create', manifest: source, evidence: evidence() }, now);
    const arrived = evidence({ observedAt: at(5), completeThrough: at(5), records: [{ ...lead(), observedAt: at(5), sourceUpdatedAt: at(5), firstObservedAt: at(5) }] });
    const latest = await reconcileHandoffAudit(saved.id, arrived, at(5));
    expect(latest.report.rows[0].status).toBe('present');
    await expect(reconcileHandoffAudit(saved.id, evidence(), at(6))).rejects.toThrow('predates');
    const backwards = { ...arrived, observedAt: at(6), completeThrough: at(6), records: [{ ...arrived.records[0], observedAt: at(4) }] };
    await expect(reconcileHandoffAudit(saved.id, backwards, at(6))).rejects.toThrow('backward');
    await expect(reconcileHandoffAudit(saved.id, { ...backwards, records: [{ ...arrived.records[0], observedAt: at(6), sourceUpdatedAt: at(4) }] }, at(6))).rejects.toThrow('backward');
    await expect(reconcileHandoffAudit(saved.id, { ...backwards, records: [{ ...arrived.records[0], observedAt: at(6), firstObservedAt: at(6) }] }, at(6))).rejects.toThrow('reset the routing deadline');
    expect((await getHandoffAudit(saved.id))?.reportId).toBe(latest.reportId);
    expect((await getHandoffAudit(saved.id))?.history).toHaveLength(2);
    const partial = await reconcileHandoffAudit(saved.id, { ...arrived, observedAt: at(6), completeThrough: null, coverage: 'incomplete' }, at(6));
    expect(partial.report.evidenceSummary.coverage).toBe('incomplete');
  });

  it('does not let concurrent reconciliations overwrite a report advanced by another request', async () => {
    const saved = await createHandoffAudit({ requestId: 'concurrent-reconcile', manifest: manifest('Concurrent'), evidence: evidence() }, now);
    const results = await Promise.allSettled([
      reconcileHandoffAudit(saved.id, evidence({ observedAt: at(1), completeThrough: at(1) }), at(1)),
      reconcileHandoffAudit(saved.id, evidence({ observedAt: at(2), completeThrough: at(2) }), at(2)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect((await getHandoffAudit(saved.id))?.history).toHaveLength(2);
  });

  it('retains arrival proof and record clocks through incomplete and complete omissions, then accepts a newer reappearance', async () => {
    const arrived = evidence({ records: [lead()] });
    const saved = await createHandoffAudit({ requestId: 'retained-arrival', manifest: manifest('Retained arrival'), evidence: arrived }, now);
    expect(saved.report.rows[0]).toMatchObject({ status: 'present', routing: 'unrouted' });
    const incomplete = await reconcileHandoffAudit(saved.id, evidence({ observedAt: at(1), completeThrough: null, coverage: 'incomplete' }), at(1));
    expect(incomplete.report.rows[0]).toMatchObject({ status: 'unknown', evidence: { lastObservedStatus: 'present', destinationObservedAt: now } });
    expect(incomplete.report.rows[0].reasons.join(' ')).toContain('cannot establish that the handoff never arrived');
    await expect(reconcileHandoffAudit(saved.id, evidence({ observedAt: at(2), completeThrough: at(-1) }), at(2))).rejects.toThrow('predates');
    const omitted = await reconcileHandoffAudit(saved.id, evidence({ observedAt: at(2), completeThrough: at(2) }), at(2));
    expect(omitted.report.counts).toMatchObject({ missing: 0, unknown: 1 });
    expect(omitted.report.rows[0].destinationIds).toContainEqual({ objectType: 'Lead', id: '00Q000000000001' });
    const returned = { ...lead(), observedAt: at(3), sourceUpdatedAt: at(3), firstObservedAt: at(-10), properties: { hubspot_id: '1001', owner_id: 'sales-queue' } };
    await expect(reconcileHandoffAudit(saved.id, evidence({ observedAt: at(3), completeThrough: at(3), records: [{ ...returned, observedAt: at(-1) }] }), at(3))).rejects.toThrow('backward');
    await expect(reconcileHandoffAudit(saved.id, evidence({ observedAt: at(3), completeThrough: at(3), records: [{ ...returned, firstObservedAt: at(-5) }] }), at(3))).rejects.toThrow('reset the routing deadline');
    const reappeared = await reconcileHandoffAudit(saved.id, evidence({ observedAt: at(3), completeThrough: at(3), records: [returned] }), at(3));
    expect(reappeared.report.rows[0]).toMatchObject({ status: 'present', routing: 'routed' });
    expect(reappeared.manifest).toEqual(saved.manifest);
    expect(reappeared.history).toHaveLength(4);
  });

  it('rejects contradictory property values at the same observed or provider timestamp, including across omissions', async () => {
    const saved = await createHandoffAudit({ requestId: 'same-time-properties', manifest: manifest('Same time'), evidence: evidence({ records: [lead()] }) }, now);
    await reconcileHandoffAudit(saved.id, evidence({ observedAt: at(1), completeThrough: null, coverage: 'incomplete' }), at(1));
    const changed = { ...lead(), properties: { hubspot_id: '1001', owner_id: 'different-owner' } };
    await expect(reconcileHandoffAudit(saved.id, evidence({ observedAt: at(2), completeThrough: at(2), records: [changed] }), at(2))).rejects.toThrow('same timestamp');
    await expect(reconcileHandoffAudit(saved.id, evidence({ observedAt: at(2), completeThrough: at(2), records: [{ ...changed, observedAt: at(2) }] }), at(2))).rejects.toThrow('same timestamp');
    expect((await getHandoffAudit(saved.id))!.history).toHaveLength(2);
  });

  it('keeps invalid future evidence in history without letting it block a coherent correction', async () => {
    const invalidRecords = [
      { ...lead(), observedAt: at(1440) },
      { ...lead(), firstObservedAt: at(1440) },
      { ...lead(), sourceUpdatedAt: at(1440) },
      { ...lead(), id: '00Q000000000001BAD' },
    ];
    for (const [index, invalid] of invalidRecords.entries()) {
      const saved = await createHandoffAudit({ requestId: `invalid-clock-${index}`, manifest: manifest('Invalid clock correction'), evidence: evidence({ records: [invalid] }) }, now);
      expect(saved.report.rows[0].status).toBe('unknown');
      const corrected = await reconcileHandoffAudit(saved.id, evidence({ observedAt: at(1), completeThrough: at(1), records: [{ ...lead(), observedAt: at(1) }] }), at(1));
      expect(corrected.report.rows[0]).toMatchObject({ status: 'present', routing: 'unrouted' });
      expect(corrected.history).toHaveLength(2);
      const db = await incidentDatabase();
      const original = await db.prepare('SELECT evidence_json FROM handoff_audit_reports WHERE id=?').bind(saved.reportId).first<{ evidence_json: string }>();
      expect(JSON.parse(original!.evidence_json).records[0]).toEqual(invalid);
    }
    const futureEnvelope = await createHandoffAudit({ requestId: 'invalid-envelope-clock', manifest: manifest('Envelope correction'),
      evidence: evidence({ observedAt: at(1440), completeThrough: at(1440), records: [lead()] }) }, now);
    const correctedEnvelope = await reconcileHandoffAudit(futureEnvelope.id, evidence({ observedAt: at(1), completeThrough: at(1), records: [lead()] }), at(1));
    expect(correctedEnvelope.report.rows[0].status).toBe('present');

    const trusted = await createHandoffAudit({ requestId: 'trusted-then-invalid', manifest: manifest('Preserved trusted envelope'),
      evidence: evidence({ coverage: 'incomplete', completeThrough: null }) }, now);
    await reconcileHandoffAudit(trusted.id, evidence({ observedAt: at(1440), completeThrough: null, coverage: 'incomplete' }), at(1));
    await expect(reconcileHandoffAudit(trusted.id, evidence({ observedAt: at(-1), completeThrough: null, coverage: 'incomplete' }), at(2))).rejects.toThrow('predates');
    const repaired = await reconcileHandoffAudit(trusted.id, evidence({ observedAt: at(2), completeThrough: at(2), records: [lead()] }), at(2));
    expect(repaired.report.rows[0].status).toBe('present');
  });

  it('reads only saved scoped cache records and preserves record clocks independently from fresh account coverage', async () => {
    await seedMonitor();
    await cacheRecord();
    await cacheRecord('00Q000000000002', 'salesforce_other');
    expect(await getHandoffAccounts()).toContainEqual({ scope: 'salesforce_fixture', provider: 'salesforce', accountId: 'fixture' });
    const snapshot = await readHandoffMonitorEvidence(manifest('Monitor'));
    expect(snapshot.coverage).toBe('complete');
    expect(snapshot.completeThrough).toBe(now);
    expect(snapshot.records.map((record) => record.id)).toEqual(['00Q000000000001']);
    expect(snapshot.records[0].observedAt).toBe(at(-10));
    expect(snapshot.observedAt).toBe(now);
    expect(snapshot.limitations.join(' ')).toContain('Converted or deleted leads');
    const saved = await createHandoffAudit({ requestId: 'monitor-create', manifest: manifest('Monitor') }, now);
    expect(saved.mode).toBe('monitor');
    await expect(reconcileHandoffAudit(saved.id, evidence(), now)).rejects.toThrow('only reconcile saved');
    await expect(createHandoffAudit({ requestId: 'missing-saved', manifest: { ...manifest('Missing source'), sourceAccount: 'not-saved' } }, now)).rejects.toThrow('saved HubSpot');
  });

  it('refuses completeness for stale coverage, unfinished windows, missing watermark or unavailable matching capability', async () => {
    await seedMonitor({ lastCheckedAt: at(-60), lastSuccessAt: at(-60) });
    expect((await readHandoffMonitorEvidence(manifest('Stale'))).coverage).toBe('incomplete');
    await seedMonitor({}, { cursor: 'unfinished-page' });
    expect((await readHandoffMonitorEvidence(manifest('Cursor'))).completeThrough).toBeNull();
    await seedMonitor({}, { window_end: now });
    expect((await readHandoffMonitorEvidence(manifest('Window'))).coverage).toBe('incomplete');
    await seedMonitor({}, { watermark: null });
    expect((await readHandoffMonitorEvidence(manifest('Watermark'))).coverage).toBe('incomplete');
    await seedMonitor({ capabilities: [{ objectType: 'Lead', status: 'available', fields: ['owner_id'], missingFields: [], detail: 'Synthetic limited field set' }] });
    expect((await readHandoffMonitorEvidence(manifest('Capability'))).limitations.join(' ')).toContain('source-ID match field');
  });

  it('detects cache truncation rather than treating omitted records as missing', async () => {
    await seedMonitor();
    const db = await incidentDatabase();
    const fixture = { provider: 'salesforce', objectType: 'Contact', updatedAt: now, properties: { hubspot_id: 'bulk', owner_id: '' } };
    await db.batch(Array.from({ length: 10_001 }, (_, index) => {
      const id = `003${String(index).padStart(12, '0')}`;
      return db.prepare('INSERT OR REPLACE INTO crm_observed_records(account_id,record_key,object_type,record_id,provider_updated_at,observed_at,first_seen_at,payload_json) VALUES(?,?,?,?,?,?,?,?)')
        .bind('salesforce_fixture', `Contact:${id}`, 'Contact', id, now, now, now, JSON.stringify({ ...fixture, id }));
    }));
    const result = await readHandoffMonitorEvidence(manifest('Large cache'));
    expect(result.records).toHaveLength(10_000);
    expect(result.coverage).toBe('incomplete');
    expect(result.limitations.join(' ')).toContain('truncated');
    await db.prepare("DELETE FROM crm_observed_records WHERE account_id='salesforce_fixture' AND object_type='Contact'").run();
  });

  it('links only associated incidents in the correct account and does not alter CRM cache or notification queues', async () => {
    await seedMonitor();
    const db = await incidentDatabase();
    for (const [id, scope, key] of [['related-source', 'fixture-hubspot', '1001'], ['related-destination', 'salesforce_fixture', 'Lead:00Q000000000001'], ['unrelated-scope', 'salesforce_other', 'Lead:00Q000000000001']]) {
      await db.prepare("INSERT INTO crm_incidents(id,account_id,fingerprint,kind,object_type,field,title,severity,status,first_seen_at,last_seen_at,policy_version,evidence_json) VALUES(?,?,?,'expectation','Lead','owner_id','Synthetic routing incident','warning','open',?,?,1,'{}')")
        .bind(id, scope, id, now, now).run();
      await db.prepare('INSERT INTO crm_incident_records(incident_id,record_key) VALUES(?,?)').bind(id, key).run();
    }
    const before = await db.prepare('SELECT * FROM crm_observed_records ORDER BY account_id,record_key').all();
    const outboxBefore = await db.prepare('SELECT * FROM operation_notification_outbox ORDER BY event_key').all();
    const saved = await createHandoffAudit({ requestId: 'linked-incidents', manifest: manifest('Related'), evidence: evidence({ records: [lead()] }) }, now);
    expect(saved.relatedIncidents.map((incident) => incident.id).sort()).toEqual(['related-destination', 'related-source']);
    expect(saved.relatedIncidents.every((incident) => incident.href.includes(`account=${incident.accountId}`))).toBe(true);
    await getHandoffAuditOverview(saved.id);
    await reconcileHandoffAudit(saved.id, undefined, at(1));
    expect(await db.prepare('SELECT * FROM crm_observed_records ORDER BY account_id,record_key').all()).toEqual(before);
    expect(await db.prepare('SELECT * FROM operation_notification_outbox ORDER BY event_key').all()).toEqual(outboxBefore);
  });
});
