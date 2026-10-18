import { parseDestinationEvidence, parseHandoffManifest, type DestinationEvidence, type HandoffManifest, type SourceRow } from './handoff-audit';

/** Entirely synthetic, stable cohort identities. Relative timestamps make the example useful on any day. */
export function createHandoffExample(nowISO: string): { manifest: HandoffManifest; evidence: DestinationEvidence } {
  const at = (minutes: number) => new Date(Date.parse(nowISO) + minutes * 60_000).toISOString();
  const row = (number: number, label: string, overrides: Partial<SourceRow> = {}): SourceRow => ({
    rowId: `cohort-${number}`, sourceId: `source-${number}`, label,
    observedAt: at(-2), sourceUpdatedAt: at(-90), eligibleAt: at(-90),
    properties: { consent: 'yes', score: '80', segment: 'qualified' }, destinationIds: [], exclusionReason: null, failure: null,
    ...overrides,
  });
  const leadId = (number: number) => `00Q${String(number).padStart(12, '0')}`;
  const record = (number: number, sourceId: string, routing = 'Complete', overrides: Partial<DestinationEvidence['records'][number]> = {}): DestinationEvidence['records'][number] => ({
    objectType: 'Lead', id: leadId(number), observedAt: at(-1), sourceUpdatedAt: at(-45), firstObservedAt: at(-60),
    properties: { Source_Record_ID__c: sourceId, Routing_Status__c: routing, OwnerId: 'synthetic-owner' }, ...overrides,
  });
  const manifest: HandoffManifest = {
    version: 1, name: 'Synthetic campaign handoff', sourceAccount: 'synthetic-hubspot', destinationAccount: 'salesforce_synthetic-org',
    capturedAt: at(-2),
    policy: {
      syncDeadlineMinutes: 30, routingDeadlineMinutes: 15, evidenceMaxAgeMinutes: 30,
      destinationMatchField: 'Source_Record_ID__c',
      eligibilityRules: [
        { field: 'consent', operator: 'equals', values: ['yes'] },
        { field: 'score', operator: 'number_gte', values: ['60'] },
        { field: 'segment', operator: 'one_of', values: ['qualified'] },
      ],
      routingRules: [{ field: 'Routing_Status__c', operator: 'equals', values: ['Complete'] }],
    },
    rows: [
      row(1, 'Arrived and routed'),
      row(2, 'Arrived, routing overdue'),
      row(3, 'Waiting within sync deadline', { eligibleAt: at(-10), sourceUpdatedAt: at(-10) }),
      row(4, 'Intentionally excluded', { properties: { consent: 'no', score: '80', segment: 'qualified' }, exclusionReason: 'Consent not granted for this campaign.' }),
      row(5, 'Explicit validation failure', { failure: { message: 'Synthetic validation rule rejected the destination operation.', occurredAt: at(-3), evidenceRef: 'synthetic://sync-error/5' } }),
      row(6, 'Unexplained absence after deadline'),
      row(7, 'Missing stable source ID', { sourceId: null }),
      row(8, 'Ambiguous destination association'),
      row(9, 'Stale arrival evidence'),
      row(10, 'Stale source eligibility', { observedAt: at(-60) }),
      row(11, 'Recent arrival, routing pending'),
      row(12, 'Eligibility field not observed', { properties: { score: '80', segment: 'qualified' } }),
    ],
  };
  const evidence: DestinationEvidence = {
    accountId: manifest.destinationAccount, observedAt: nowISO, completeThrough: at(-1), coverage: 'complete',
    limitations: ['Synthetic observations only. No external account is connected or queried.'],
    records: [
      record(1, 'source-1'), record(2, 'source-2', 'Pending'),
      record(8, 'source-8'), record(18, 'source-8'),
      record(9, 'source-9', 'Complete', { observedAt: at(-50), sourceUpdatedAt: at(-70), firstObservedAt: at(-80) }),
      record(11, 'source-11', 'Pending', { firstObservedAt: at(-5), sourceUpdatedAt: at(-5) }),
      record(99, 'outside-preserved-cohort'),
    ],
  };
  return { manifest: parseHandoffManifest(manifest), evidence: parseDestinationEvidence(evidence) };
}
