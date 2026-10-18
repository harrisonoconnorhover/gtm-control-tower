import { describe, expect, it } from 'vitest';
import { createHandoffExample } from '../lib/handoff-audit-example';
import { parseDestinationEvidence, parseHandoffManifest, reconcileHandoff, type DestinationEvidence, type HandoffManifest } from '../lib/handoff-audit';

const now = '2026-10-16T12:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
function fixture() {
  const { manifest, evidence } = createHandoffExample(now);
  manifest.rows = [manifest.rows[0]];
  evidence.records = [evidence.records[0]];
  return { manifest, evidence };
}
function result(manifest: HandoffManifest, evidence: DestinationEvidence, time = now) {
  return reconcileHandoff(manifest, evidence, time).rows[0];
}

describe('handoff evidence parsing', () => {
  it('bounds cohorts, rejects duplicate row IDs and invalid dates, and validates criteria', () => {
    const { manifest, evidence } = fixture();
    expect(parseHandoffManifest(manifest)).toEqual(manifest);
    expect(parseDestinationEvidence(evidence)).toEqual(evidence);
    expect(() => parseHandoffManifest({ ...manifest, rows: [manifest.rows[0], manifest.rows[0]] })).toThrow('rowId');
    expect(() => parseHandoffManifest({ ...manifest, capturedAt: 'yesterday' })).toThrow();
    expect(() => parseHandoffManifest({ ...manifest, policy: { ...manifest.policy, eligibilityRules: [{ field: 'score', operator: 'number_gte', values: [''] }] } })).toThrow('finite numeric');
    expect(() => parseHandoffManifest({ ...manifest, policy: { ...manifest.policy, eligibilityRules: [{ field: 'score', operator: 'equals', values: [] }] } })).toThrow('requires 1');
    expect(() => parseDestinationEvidence({ ...evidence, records: Array(10_001).fill(evidence.records[0]) })).toThrow();
  });

  it('retains malformed target IDs for explicit row uncertainty', () => {
    const { manifest, evidence } = fixture();
    manifest.rows[0].destinationIds = [{ objectType: 'Lead', id: '' }];
    expect(parseHandoffManifest(manifest).rows[0].destinationIds[0].id).toBe('');
    expect(result(manifest, evidence)).toMatchObject({ status: 'unknown', routing: 'unknown' });
  });
});

describe('cohort accounting and identity', () => {
  it('accounts for every synthetic source and destination record without mutating input', () => {
    const { manifest, evidence } = createHandoffExample(now);
    const before = JSON.stringify({ manifest, evidence });
    const report = reconcileHandoff(manifest, evidence, now);
    expect(JSON.stringify({ manifest, evidence })).toBe(before);
    expect(report.rows.map((row) => row.rowId)).toEqual(manifest.rows.map((row) => row.rowId));
    expect(report.counts).toEqual({ present: 3, awaiting_sync: 1, excluded: 1, failed: 1, missing: 1, unknown: 5 });
    expect(Object.values(report.counts).reduce((sum, count) => sum + count, 0)).toBe(12);
    expect(Object.values(report.routingCounts).reduce((sum, count) => sum + count, 0)).toBe(12);
    expect(report.evidenceSummary.recordAccounting).toHaveLength(evidence.records.length);
    expect(report.evidenceSummary.unmatchedRecordIds).toEqual([{ objectType: 'Lead', id: '00Q000000000099' }]);
    expect(report.rows[1]).toMatchObject({ status: 'present', routing: 'unrouted' });
    expect(report.rows[10]).toMatchObject({ status: 'present', routing: 'awaiting_routing' });
  });

  it('makes absent, blank, and duplicate source IDs unknown even if an explicit target exists', () => {
    for (const sourceId of [null, '', '   ']) {
      const { manifest, evidence } = fixture();
      manifest.rows[0].sourceId = sourceId;
      manifest.rows[0].destinationIds = [{ objectType: 'Lead', id: evidence.records[0].id }];
      expect(result(manifest, evidence).status).toBe('unknown');
    }
    const { manifest, evidence } = fixture();
    manifest.rows.push({ ...manifest.rows[0], rowId: 'second' });
    expect(reconcileHandoff(manifest, evidence, now).rows.map((row) => row.status)).toEqual(['unknown', 'unknown']);
  });

  it('refuses duplicate target records, one-to-many matches, and shared target associations', () => {
    const { manifest, evidence } = fixture();
    evidence.records.push(structuredClone(evidence.records[0]));
    expect(result(manifest, evidence).status).toBe('unknown');
    evidence.records[1].id = '00Q000000000002';
    expect(result(manifest, evidence).status).toBe('unknown');
    evidence.records.pop();
    manifest.rows.push({ ...structuredClone(manifest.rows[0]), rowId: 'second', sourceId: 'source-other', destinationIds: [{ objectType: 'Lead', id: evidence.records[0].id }] });
    expect(reconcileHandoff(manifest, evidence, now).rows.map((row) => row.status)).toEqual(['unknown', 'unknown']);
  });

  it('matches canonical 15/18 Salesforce forms while preserving case sensitivity', () => {
    const { manifest, evidence } = fixture();
    manifest.policy.destinationMatchField = null;
    manifest.rows[0].destinationIds = [{ objectType: 'Lead', id: '00Q000000000001EAA' }];
    expect(result(manifest, evidence).status).toBe('present');
    manifest.rows[0].destinationIds[0].id = `00QA${'0'.repeat(10)}1`;
    evidence.records[0].id = `00Qa${'0'.repeat(10)}1`;
    expect(result(manifest, evidence).status).toBe('missing');
    manifest.rows[0].destinationIds[0].id = '00Q000000000001eaa';
    expect(result(manifest, evidence).status).toBe('unknown');
  });

  it('reports conflicting field mappings and invalid evidence IDs without dropping records', () => {
    const { manifest, evidence } = fixture();
    manifest.rows[0].destinationIds = [{ objectType: 'Lead', id: evidence.records[0].id }];
    evidence.records[0].properties.Source_Record_ID__c = 'other-source';
    expect(result(manifest, evidence).status).toBe('unknown');
    evidence.records[0].id = 'invalid-id';
    const report = reconcileHandoff(manifest, evidence, now);
    expect(report.rows[0].status).toBe('unknown');
    expect(report.evidenceSummary.recordAccounting[0]).toMatchObject({ id: 'invalid-id', rowIds: [] });
    expect(report.evidenceSummary.recordAccounting[0].issues).not.toHaveLength(0);
  });
});

describe('captured eligibility and coverage', () => {
  it('distinguishes explicit exclusions, observed false criteria, empty fields, and unobserved fields', () => {
    const { manifest, evidence } = fixture();
    evidence.records = [];
    manifest.rows[0].exclusionReason = 'Not part of the agreed audience.';
    expect(result(manifest, evidence)).toMatchObject({ status: 'excluded', routing: 'not_applicable' });
    manifest.rows[0].exclusionReason = null;
    manifest.rows[0].properties.consent = 'no';
    expect(result(manifest, evidence).status).toBe('excluded');
    delete manifest.rows[0].properties.score;
    expect(result(manifest, evidence).status).toBe('unknown');
    manifest.policy.eligibilityRules = [{ field: 'consent', operator: 'not_empty', values: [] }];
    manifest.rows[0].properties.consent = '';
    expect(result(manifest, evidence).status).toBe('excluded');
    delete manifest.rows[0].properties.consent;
    expect(result(manifest, evidence).status).toBe('unknown');
  });

  it('freezes source eligibility at capture and does not confuse old modification times with stale observations', () => {
    const { manifest, evidence } = fixture();
    manifest.rows[0].sourceUpdatedAt = '2020-01-01T00:00:00Z';
    evidence.records[0].sourceUpdatedAt = '2020-01-01T00:00:00Z';
    expect(result(manifest, evidence).status).toBe('present');
    const later = at(60);
    evidence.observedAt = later; evidence.records[0].observedAt = later;
    expect(result(manifest, evidence, later).status).toBe('present');
    manifest.rows[0].observedAt = at(-60);
    expect(result(manifest, evidence, later).status).toBe('unknown');
  });

  it('requires fresh complete evidence through the deadline to call a record missing', () => {
    const { manifest, evidence } = fixture();
    evidence.records = [];
    expect(result(manifest, evidence).status).toBe('missing');
    evidence.coverage = 'incomplete';
    expect(result(manifest, evidence).status).toBe('unknown');
    evidence.coverage = 'complete'; evidence.completeThrough = at(-80);
    expect(result(manifest, evidence).status).toBe('unknown');
    evidence.completeThrough = null;
    expect(result(manifest, evidence).status).toBe('unknown');
    evidence.completeThrough = at(-1); evidence.observedAt = at(-50);
    expect(result(manifest, evidence).status).toBe('unknown');
  });

  it('never uses incomplete matching fields or absent mappings as proof of absence', () => {
    const { manifest, evidence } = fixture();
    delete evidence.records[0].properties.Source_Record_ID__c;
    expect(result(manifest, evidence).status).toBe('unknown');
    manifest.rows[0].destinationIds = [{ objectType: 'Lead', id: evidence.records[0].id }];
    expect(result(manifest, evidence).status).toBe('present');
    evidence.records = [];
    manifest.rows[0].destinationIds = []; manifest.policy.destinationMatchField = null;
    expect(result(manifest, evidence).status).toBe('unknown');
  });

  it('knows arrival without an eligibility clock but cannot invent a missing deadline', () => {
    const { manifest, evidence } = fixture();
    manifest.rows[0].eligibleAt = null;
    expect(result(manifest, evidence)).toMatchObject({ status: 'present', deadlineAt: null });
    evidence.records = [];
    expect(result(manifest, evidence)).toMatchObject({ status: 'unknown', deadlineAt: null });
  });

  it('makes future or contradictory evidence timestamps and wrong account evidence unknown', () => {
    const edits: Array<(manifest: HandoffManifest, evidence: DestinationEvidence) => void> = [
      (manifest) => { manifest.capturedAt = at(5); },
      (manifest) => { manifest.rows[0].observedAt = at(5); },
      (manifest) => { manifest.rows[0].eligibleAt = at(5); },
      (manifest) => { manifest.rows[0].sourceUpdatedAt = at(5); },
      (_, evidence) => { evidence.observedAt = at(5); },
      (_, evidence) => { evidence.completeThrough = at(5); },
      (_, evidence) => { evidence.records[0].observedAt = at(5); },
      (_, evidence) => { evidence.records[0].sourceUpdatedAt = at(5); },
      (_, evidence) => { evidence.records[0].firstObservedAt = at(5); },
      (_, evidence) => { evidence.accountId = 'another-account'; },
    ];
    for (const edit of edits) {
      const { manifest, evidence } = fixture(); edit(manifest, evidence);
      expect(result(manifest, evidence).status).toBe('unknown');
    }
  });
});

describe('partial failures, freshness, and routing', () => {
  it('retains failure history and lets later arrivals resolve the current failed status', () => {
    const { manifest, evidence } = fixture();
    const record = evidence.records[0]; evidence.records = [];
    manifest.rows[0].failure = { message: 'Synthetic validation failure', occurredAt: at(-3), evidenceRef: 'synthetic://failure-1' };
    expect(result(manifest, evidence).status).toBe('failed');
    evidence.records = [record];
    expect(result(manifest, evidence)).toMatchObject({ status: 'present', evidence: { failure: manifest.rows[0].failure } });
    record.observedAt = at(-5);
    expect(result(manifest, evidence).status).toBe('unknown');
    record.observedAt = at(-1); manifest.rows[0].failure.occurredAt = at(5);
    expect(result(manifest, evidence).status).toBe('unknown');
  });

  it('does not call old failure evidence current and retains the last observed failure', () => {
    const { manifest, evidence } = fixture(); evidence.records = [];
    manifest.rows[0].failure = { message: 'Old failure', occurredAt: at(-40), evidenceRef: 'synthetic://old-failure' };
    expect(result(manifest, evidence)).toMatchObject({ status: 'unknown', evidence: { lastObservedStatus: 'failed' } });
  });

  it('retains stale arrival and routing history without claiming current health', () => {
    const { manifest, evidence } = fixture();
    evidence.records[0].observedAt = at(-40);
    expect(result(manifest, evidence)).toMatchObject({ status: 'unknown', routing: 'unknown', evidence: { lastObservedStatus: 'present', lastObservedRouting: 'routed' } });
    evidence.records[0].observedAt = at(-1); evidence.observedAt = at(-40);
    expect(result(manifest, evidence).status).toBe('unknown');
  });

  it('retains stale complete missing evidence as history without claiming current absence', () => {
    const { manifest, evidence } = fixture(); evidence.records = [];
    evidence.observedAt = at(-40); evidence.completeThrough = at(-40);
    expect(result(manifest, evidence)).toMatchObject({ status: 'unknown', evidence: { lastObservedStatus: 'missing' } });
    evidence.observedAt = now;
    expect(result(manifest, evidence)).toMatchObject({ status: 'unknown', evidence: { lastObservedStatus: 'missing' } });
    expect(result(manifest, evidence).reasons.join(' ')).toContain('Complete-through coverage is stale');
  });

  it('cannot claim a handoff arrived or routed from an observation predating the handoff', () => {
    const { manifest, evidence } = fixture();
    manifest.capturedAt = now; manifest.rows[0].observedAt = now; manifest.rows[0].eligibleAt = at(-1);
    evidence.records[0].observedAt = at(-2);
    expect(result(manifest, evidence)).toMatchObject({ status: 'unknown', routing: 'unknown', evidence: { lastObservedStatus: 'present', lastObservedRouting: 'routed' } });
    expect(result(manifest, evidence).reasons.join(' ')).toContain('predates this handoff');
  });

  it('checks routing independently and never treats an owner as routing completion by default', () => {
    const { manifest, evidence } = fixture();
    evidence.records[0].properties.Routing_Status__c = 'Pending';
    expect(result(manifest, evidence)).toMatchObject({ status: 'present', routing: 'unrouted' });
    manifest.policy.routingRules = [];
    expect(result(manifest, evidence)).toMatchObject({ status: 'present', routing: 'unknown' });
    manifest.policy.routingRules = [{ field: 'OwnerId', operator: 'not_empty', values: [] }];
    expect(result(manifest, evidence).routing).toBe('routed');
    delete evidence.records[0].properties.OwnerId;
    expect(result(manifest, evidence).routing).toBe('unknown');
  });

  it('does not declare routing overdue without a record observation after the routing deadline', () => {
    const { manifest, evidence } = fixture();
    evidence.records[0].firstObservedAt = at(-20); evidence.records[0].observedAt = at(-10); evidence.records[0].sourceUpdatedAt = at(-15);
    evidence.records[0].properties.Routing_Status__c = 'Pending';
    expect(result(manifest, evidence)).toMatchObject({ status: 'present', routing: 'unknown', evidence: { lastObservedRouting: 'awaiting_routing' } });
    evidence.records[0].observedAt = at(-1);
    expect(result(manifest, evidence).routing).toBe('unrouted');
  });

  it('uses the handoff time for existing records and discloses the first-observation limitation', () => {
    const { manifest, evidence } = fixture();
    manifest.rows[0].eligibleAt = at(-5); evidence.records[0].properties.Routing_Status__c = 'Pending';
    const row = result(manifest, evidence);
    expect(row).toMatchObject({ status: 'present', routing: 'awaiting_routing', routingDeadlineAt: at(10) });
    expect(row.reasons.join(' ')).toContain('first observation after handoff is not known');
  });

  it('runs a realistic synthetic delayed-arrival and partial-error flow without changing the denominator', () => {
    const { manifest, evidence } = createHandoffExample(now);
    const initial = reconcileHandoff(manifest, evidence, now);
    expect(initial.rows[2].status).toBe('awaiting_sync');
    expect(initial.rows[4].status).toBe('failed');
    const later = at(5);
    evidence.observedAt = later; evidence.completeThrough = later;
    evidence.records.push({ objectType: 'Lead', id: '00Q000000000003', observedAt: later, sourceUpdatedAt: later, firstObservedAt: later,
      properties: { Source_Record_ID__c: 'source-3', Routing_Status__c: 'Pending' } });
    let report = reconcileHandoff(manifest, evidence, later);
    expect(report.rows[2]).toMatchObject({ status: 'present', routing: 'awaiting_routing' });
    expect(report.rows[4].status).toBe('failed');
    expect(report.rows[3].status).toBe('excluded');
    const finalTime = at(22); evidence.observedAt = finalTime; evidence.completeThrough = finalTime;
    evidence.records.at(-1)!.observedAt = finalTime;
    evidence.records.at(-1)!.properties.Routing_Status__c = 'Complete';
    report = reconcileHandoff(manifest, evidence, finalTime);
    expect(report.rows[2]).toMatchObject({ status: 'present', routing: 'routed' });
    expect(report.rows).toHaveLength(initial.rows.length);
    expect(report.manifest).toEqual(manifest);
    expect(report.rows[4].evidence.failure?.evidenceRef).toBe('synthetic://sync-error/5');
  });
});
