import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });
const properties = z.record(z.string().min(1).max(256), z.string().max(10_000))
  .refine((value) => Object.keys(value).length <= 200, 'At most 200 properties are supported per record.');

export const handoffRuleSchema = z.object({
  field: z.string().trim().min(1).max(256),
  operator: z.enum(['equals', 'one_of', 'not_empty', 'number_gte']),
  values: z.array(z.string().max(2_000)).max(100),
}).strict().superRefine((rule, ctx) => {
  const required = rule.operator === 'not_empty' ? 0 : rule.operator === 'one_of' ? null : 1;
  if (required !== null && rule.values.length !== required) {
    ctx.addIssue({ code: 'custom', message: `${rule.operator} requires ${required} values.`, path: ['values'] });
  }
  if (rule.operator === 'one_of' && rule.values.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'one_of requires at least one value.', path: ['values'] });
  }
  if (rule.operator === 'number_gte' && (!rule.values[0]?.trim() || !Number.isFinite(Number(rule.values[0])))) {
    ctx.addIssue({ code: 'custom', message: 'number_gte requires a finite numeric threshold.', path: ['values'] });
  }
});

// Invalid or absent native IDs remain visible evidence; reconciliation marks affected rows unknown.
const destinationIdSchema = z.object({ objectType: z.enum(['Lead', 'Contact']), id: z.string().max(200) }).strict();
const sourceRowSchema = z.object({
  rowId: z.string().trim().min(1).max(200), sourceId: z.string().max(200).nullable(),
  label: z.string().max(500), observedAt: timestamp, sourceUpdatedAt: timestamp.nullable(), eligibleAt: timestamp.nullable(),
  properties, destinationIds: z.array(destinationIdSchema).max(20),
  exclusionReason: z.string().trim().min(1).max(2_000).nullable(),
  failure: z.object({ message: z.string().min(1).max(2_000), occurredAt: timestamp, evidenceRef: z.string().min(1).max(2_000) }).strict().nullable(),
}).strict();

export const handoffManifestSchema = z.object({
  version: z.literal(1), name: z.string().trim().min(1).max(200),
  sourceAccount: z.string().trim().min(1).max(200), destinationAccount: z.string().trim().min(1).max(200),
  capturedAt: timestamp,
  policy: z.object({
    syncDeadlineMinutes: z.number().finite().min(1).max(525_600),
    routingDeadlineMinutes: z.number().finite().min(1).max(525_600),
    evidenceMaxAgeMinutes: z.number().finite().min(1).max(525_600),
    destinationMatchField: z.string().trim().min(1).max(256).nullable(),
    eligibilityRules: z.array(handoffRuleSchema).max(30), routingRules: z.array(handoffRuleSchema).max(30),
  }).strict(),
  rows: z.array(sourceRowSchema).min(1).max(5_000),
}).strict().superRefine((manifest, ctx) => {
  const seen = new Set<string>();
  manifest.rows.forEach((row, index) => {
    if (seen.has(row.rowId)) ctx.addIssue({ code: 'custom', message: 'rowId must be unique within the cohort.', path: ['rows', index, 'rowId'] });
    seen.add(row.rowId);
  });
});

export const destinationEvidenceSchema = z.object({
  accountId: z.string().trim().min(1).max(200), observedAt: timestamp,
  completeThrough: timestamp.nullable(), coverage: z.enum(['complete', 'incomplete']),
  limitations: z.array(z.string().max(2_000)).max(100),
  records: z.array(z.object({
    ...destinationIdSchema.shape, observedAt: timestamp, sourceUpdatedAt: timestamp.nullable(),
    firstObservedAt: timestamp.nullable(), properties,
  }).strict()).max(10_000),
}).strict();

export type Rule = z.infer<typeof handoffRuleSchema>;
export type DestinationId = z.infer<typeof destinationIdSchema>;
export type SourceRow = z.infer<typeof sourceRowSchema>;
export type HandoffManifest = z.infer<typeof handoffManifestSchema>;
export type DestinationEvidence = z.infer<typeof destinationEvidenceSchema>;
export type HandoffStatus = 'excluded' | 'awaiting_sync' | 'failed' | 'missing' | 'present' | 'unknown';
export type HandoffRoutingStatus = 'not_applicable' | 'awaiting_routing' | 'unrouted' | 'routed' | 'unknown';
export type HandoffRowResult = {
  rowId: string; sourceId: string | null; label: string; status: HandoffStatus; routing: HandoffRoutingStatus;
  reasons: string[]; destinationIds: DestinationId[]; eligibleAt: string | null; deadlineAt: string | null; routingDeadlineAt: string | null;
  evidence: {
    sourceObservedAt: string; sourceUpdatedAt: string | null; destinationObservedAt: string | null;
    destinationSourceUpdatedAt: string | null; firstObservedAt: string | null;
    matchMethod: 'explicit_id' | 'source_id_field' | 'none' | 'ambiguous';
    eligibility: 'eligible' | 'excluded' | 'unknown';
    lastObservedStatus: HandoffStatus | null; lastObservedRouting: HandoffRoutingStatus | null;
    failure: SourceRow['failure'];
  };
};
export type HandoffReport = {
  evaluatedAt: string; manifest: HandoffManifest;
  evidenceSummary: {
    accountId: string; observedAt: string; completeThrough: string | null; coverage: DestinationEvidence['coverage'];
    recordCount: number; fresh: boolean; unmatchedRecordIds: DestinationId[]; limitations: string[];
    recordAccounting: Array<{ index: number; objectType: DestinationId['objectType']; id: string; rowIds: string[]; issues: string[] }>;
  };
  rows: HandoffRowResult[]; counts: Record<HandoffStatus, number>; routingCounts: Record<HandoffRoutingStatus, number>;
  limitations: string[];
};

export function parseHandoffManifest(value: unknown): HandoffManifest { return handoffManifestSchema.parse(value); }
export function parseDestinationEvidence(value: unknown): DestinationEvidence { return destinationEvidenceSchema.parse(value); }

function ms(value: string): number { return Date.parse(value); }
function plusMinutes(value: string, minutes: number): string { return new Date(ms(value) + minutes * 60_000).toISOString(); }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }

/** Salesforce 15-character IDs are case sensitive. Accept canonical 18-character IDs only. */
function nativeKey(value: DestinationId): string | null {
  const { id, objectType } = value;
  if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id)) return null;
  if (!id.startsWith(objectType === 'Lead' ? '00Q' : '003')) return null;
  const base = id.slice(0, 15);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  let checksum = '';
  for (let group = 0; group < 3; group++) {
    let bits = 0;
    for (let bit = 0; bit < 5; bit++) if (/[A-Z]/.test(base[group * 5 + bit])) bits |= 1 << bit;
    checksum += alphabet[bits];
  }
  if (id.length === 18 && id.slice(15) !== checksum) return null;
  return `${objectType}:${base}${checksum}`;
}

function evaluateRules(rules: Rule[], data: Record<string, string>): { result: 'pass' | 'fail' | 'unknown'; reasons: string[] } {
  if (!rules.length) return { result: 'unknown', reasons: ['No criteria were configured.'] };
  let failed = false;
  let unknown = false;
  const reasons: string[] = [];
  for (const rule of rules) {
    if (!Object.prototype.hasOwnProperty.call(data, rule.field)) {
      unknown = true; reasons.push(`Field ${rule.field} was not observed.`); continue;
    }
    const value = data[rule.field];
    if (rule.operator === 'number_gte' && (!value.trim() || !Number.isFinite(Number(value)))) {
      unknown = true; reasons.push(`Field ${rule.field} does not contain an observable finite number.`); continue;
    }
    const passes = rule.operator === 'equals' ? value === rule.values[0]
      : rule.operator === 'one_of' ? rule.values.includes(value)
        : rule.operator === 'not_empty' ? value.trim().length > 0 : Number(value) >= Number(rule.values[0]);
    if (!passes) { failed = true; reasons.push(`Field ${rule.field} does not satisfy ${rule.operator}.`); }
  }
  return { result: unknown ? 'unknown' : failed ? 'fail' : 'pass', reasons };
}

/** Pure, read-only accounting. A missing result is scoped to this supplied observation, never proof of global loss. */
export function reconcileHandoff(manifestInput: HandoffManifest, evidenceInput: DestinationEvidence, nowISO: string): HandoffReport {
  const manifest = parseHandoffManifest(manifestInput);
  const evidence = parseDestinationEvidence(evidenceInput);
  timestamp.parse(nowISO);
  const now = ms(nowISO);
  const captured = ms(manifest.capturedAt);
  const maxAge = manifest.policy.evidenceMaxAgeMinutes * 60_000;
  const field = manifest.policy.destinationMatchField;
  const envelopeProblems: string[] = [];
  if (evidence.accountId !== manifest.destinationAccount) envelopeProblems.push('Destination account does not match the cohort destination.');
  if (ms(evidence.observedAt) > now) envelopeProblems.push('Destination evidence timestamp is in the future.');
  if (evidence.completeThrough && ms(evidence.completeThrough) > ms(evidence.observedAt)) envelopeProblems.push('Destination complete-through timestamp is later than its observation.');
  const envelopeFresh = now - ms(evidence.observedAt) <= maxAge && ms(evidence.observedAt) <= now;
  if (!envelopeFresh) envelopeProblems.push('Destination evidence is stale or future-dated; refresh it before making a current claim.');
  const sourceCounts = new Map<string, number>();
  manifest.rows.forEach((row) => { if (row.sourceId?.trim()) sourceCounts.set(row.sourceId, (sourceCounts.get(row.sourceId) ?? 0) + 1); });
  const recordKeys = evidence.records.map(nativeKey);
  const keyCounts = new Map<string, number>();
  recordKeys.forEach((key) => { if (key) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1); });
  const recordIssues = evidence.records.map((record, index) => {
    const issues: string[] = [];
    if (!recordKeys[index]) issues.push('Invalid native Salesforce ID or noncanonical 18-character checksum/case.');
    if (recordKeys[index] && (keyCounts.get(recordKeys[index]!) ?? 0) > 1) issues.push('Duplicate destination identity appears in evidence.');
    if (ms(record.observedAt) > now || ms(record.observedAt) > ms(evidence.observedAt)) issues.push('Record observation is future-dated or later than the evidence envelope.');
    if (record.sourceUpdatedAt && ms(record.sourceUpdatedAt) > ms(record.observedAt)) issues.push('Destination source update timestamp is later than its observation.');
    if (record.firstObservedAt && ms(record.firstObservedAt) > ms(record.observedAt)) issues.push('First-observed timestamp is later than the record observation.');
    return issues;
  });
  const recordsByKey = new Map<string, number[]>();
  const recordsBySource = new Map<string, number[]>();
  evidence.records.forEach((record, index) => {
    const key = recordKeys[index];
    if (key) recordsByKey.set(key, [...(recordsByKey.get(key) ?? []), index]);
    if (field && Object.prototype.hasOwnProperty.call(record.properties, field)) {
      const sourceId = record.properties[field];
      recordsBySource.set(sourceId, [...(recordsBySource.get(sourceId) ?? []), index]);
    }
  });
  const recordOwners = evidence.records.map(() => new Set<string>());
  const matches = manifest.rows.map((row) => {
    const explicit = row.destinationIds.map(nativeKey);
    const indices = unique([
      ...explicit.flatMap((key) => key ? recordsByKey.get(key) ?? [] : []),
      ...(field && row.sourceId?.trim() ? recordsBySource.get(row.sourceId) ?? [] : []),
    ]);
    indices.forEach((index) => recordOwners[index].add(row.rowId));
    return { explicit, indices };
  });
  const associationOwners = new Map<string, Set<number>>();
  manifest.rows.forEach((_, index) => {
    for (const key of unique([...matches[index].explicit, ...matches[index].indices.map((recordIndex) => recordKeys[recordIndex])])) {
      if (!key) continue;
      const owners = associationOwners.get(key) ?? new Set<number>();
      owners.add(index); associationOwners.set(key, owners);
    }
  });
  const recordAccounting = evidence.records.map((record, index) => ({
    index, objectType: record.objectType, id: record.id,
    rowIds: [...recordOwners[index]],
    issues: recordIssues[index],
  }));

  const rows = manifest.rows.map((row, rowIndex): HandoffRowResult => {
    const match = matches[rowIndex];
    const reasons: string[] = [];
    const identityProblems: string[] = [];
    if (!row.sourceId?.trim()) identityProblems.push('Source ID is missing; stable cohort identity cannot be established.');
    else if ((sourceCounts.get(row.sourceId) ?? 0) > 1) identityProblems.push('Source ID is duplicated within the cohort.');
    if (match.explicit.some((key) => !key)) identityProblems.push('A declared destination ID is invalid or has noncanonical 18-character checksum/case.');
    const associations = unique([...match.explicit, ...match.indices.map((index) => recordKeys[index])].filter((key): key is string => !!key));
    if (associations.length > 1 || match.indices.length > 1) identityProblems.push('Multiple destination associations are ambiguous; no record was selected.');
    if (associations.some((key) => (associationOwners.get(key)?.size ?? 0) > 1)) identityProblems.push('Destination identity is associated with multiple cohort rows.');
    const recordIndex = match.indices.length === 1 ? match.indices[0] : null;
    const record = recordIndex === null ? null : evidence.records[recordIndex];
    if (record && field && row.sourceId && Object.prototype.hasOwnProperty.call(record.properties, field) && record.properties[field] !== row.sourceId) {
      identityProblems.push('Explicit destination ID conflicts with the observed source-ID field.');
    }
    if (recordIndex !== null) identityProblems.push(...recordIssues[recordIndex]);
    const sourceProblems: string[] = [];
    if (captured > now) sourceProblems.push('Cohort capture timestamp is in the future.');
    if (ms(row.observedAt) > captured) sourceProblems.push('Source observation is later than cohort capture.');
    if (captured - ms(row.observedAt) > maxAge) sourceProblems.push('Source evidence was stale at cohort capture; eligibility is unknown.');
    if (row.sourceUpdatedAt && ms(row.sourceUpdatedAt) > ms(row.observedAt)) sourceProblems.push('Source update timestamp is later than its observation.');
    if (row.eligibleAt && ms(row.eligibleAt) > captured) sourceProblems.push('Declared eligibility time is later than cohort capture.');
    const eligibilityCheck = evaluateRules(manifest.policy.eligibilityRules, row.properties);
    const eligibility = sourceProblems.length ? 'unknown' : row.exclusionReason ? 'excluded'
      : eligibilityCheck.result === 'pass' ? 'eligible' : eligibilityCheck.result === 'fail' ? 'excluded' : 'unknown';
    if (row.exclusionReason) reasons.push(`Intentional exclusion at capture: ${row.exclusionReason}`);
    else reasons.push(...eligibilityCheck.reasons.map((reason) => `Eligibility: ${reason}`));
    const deadlineAt = row.eligibleAt && !sourceProblems.length ? plusMinutes(row.eligibleAt, manifest.policy.syncDeadlineMinutes) : null;
    let status: HandoffStatus = 'unknown';
    let routing: HandoffRoutingStatus = 'unknown';
    let routingDeadlineAt: string | null = null;
    let lastObservedStatus: HandoffStatus | null = null;
    let lastObservedRouting: HandoffRoutingStatus | null = null;
    const destinationIds = [...row.destinationIds];
    for (const index of match.indices) {
      const item = evidence.records[index];
      if (!destinationIds.some((id) => id.objectType === item.objectType && id.id === item.id)) destinationIds.push({ objectType: item.objectType, id: item.id });
    }
    const failureProblems: string[] = [];
    if (row.failure) {
      if (ms(row.failure.occurredAt) > captured || ms(row.failure.occurredAt) > now) failureProblems.push('Failure timestamp is later than cohort capture or evaluation.');
      if (row.eligibleAt && ms(row.failure.occurredAt) < ms(row.eligibleAt)) failureProblems.push('Failure predates the declared handoff and is retained as history only.');
    }
    const recordFresh = !!record && now - ms(record.observedAt) <= maxAge;
    const structuralProblems = [...identityProblems, ...sourceProblems];
    if (structuralProblems.length) reasons.push(...structuralProblems);

    if (eligibility === 'excluded' && !identityProblems.length) {
      status = 'excluded'; routing = 'not_applicable'; lastObservedStatus = 'excluded';
      if (record) reasons.push('A destination record was observed, but this row was excluded from the expected handoff at capture.');
    } else if (structuralProblems.length) {
      reasons.push('Resolve the identity or source-evidence uncertainty before classifying this handoff.');
    } else if (record) {
      lastObservedStatus = 'present';
      reasons.push('A uniquely matched destination record was observed.');
      if (row.failure) reasons.push('Earlier failure evidence is retained; an observed arrival takes precedence when its observation is at or after the failure.');
      const contradiction = !!row.failure && !failureProblems.length && ms(row.failure.occurredAt) > ms(record.observedAt);
      const currentProblems = [...envelopeProblems, ...(recordFresh ? [] : ['Matched destination record evidence is stale.']), ...failureProblems];
      if (row.eligibleAt && ms(record.observedAt) < ms(row.eligibleAt)) currentProblems.push('Latest destination observation predates this handoff; current arrival and routing outcomes are unknown.');
      if (contradiction) currentProblems.push('Failure evidence is newer than the last arrival observation; current outcome is unknown.');
      status = currentProblems.length ? 'unknown' : 'present';
      reasons.push(...currentProblems);
      const routeCheck = evaluateRules(manifest.policy.routingRules, record.properties);
      reasons.push(...routeCheck.reasons.map((reason) => `Routing: ${reason}`));
      if (record.firstObservedAt && row.eligibleAt) {
        const starts = new Date(Math.max(ms(record.firstObservedAt), ms(row.eligibleAt))).toISOString();
        routingDeadlineAt = plusMinutes(starts, manifest.policy.routingDeadlineMinutes);
        reasons.push('Routing deadline uses the later of first observation and declared eligibility, not a verified arrival timestamp.');
        if (ms(record.firstObservedAt) < ms(row.eligibleAt)) reasons.push('The destination existed before this handoff; the first observation after handoff is not known.');
      }
      if (routeCheck.result === 'pass') lastObservedRouting = 'routed';
      else if (routeCheck.result === 'fail' && routingDeadlineAt) {
        lastObservedRouting = ms(record.observedAt) >= ms(routingDeadlineAt) ? 'unrouted' : 'awaiting_routing';
      } else lastObservedRouting = 'unknown';
      if (status === 'present' && eligibility === 'eligible') {
        if (routeCheck.result === 'pass') routing = 'routed';
        else if (routeCheck.result === 'fail' && routingDeadlineAt) {
          routing = now < ms(routingDeadlineAt) ? 'awaiting_routing'
            : ms(record.observedAt) >= ms(routingDeadlineAt) ? 'unrouted' : 'unknown';
          if (routing === 'unknown') reasons.push('Routing deadline passed after the latest record observation; refresh before declaring it unrouted.');
        } else reasons.push('Routing completion or its deadline is unknown; configure criteria and supply eligibility/first-observed times.');
      }
      if (eligibility === 'unknown') reasons.push('Arrival is observed, but eligibility and routing obligation remain unknown.');
    } else if (eligibility === 'unknown') {
      reasons.push('Eligibility at capture is unknown.');
    } else {
      reasons.push(...envelopeProblems, ...failureProblems);
      const hasFailure = !!row.failure && !failureProblems.length;
      const failureFresh = hasFailure && now - ms(row.failure!.occurredAt) <= maxAge;
      if (hasFailure) lastObservedStatus = 'failed';
      const canMatch = match.explicit.some(Boolean) || !!field;
      const unreadMatchFields = !row.destinationIds.length && !!field && evidence.records.some((item) => !Object.prototype.hasOwnProperty.call(item.properties, field));
      const invalidDestinationIds = recordKeys.some((key) => !key);
      const coverageFresh = !!evidence.completeThrough && now - ms(evidence.completeThrough) <= maxAge;
      if (!canMatch) reasons.push('No explicit destination ID or source-ID matching field is configured.');
      if (unreadMatchFields) reasons.push('Some destination records lack the source-ID matching field; absence cannot be established.');
      if (invalidDestinationIds) reasons.push('Some destination records have invalid native IDs; complete absence cannot be established.');
      if (evidence.completeThrough && !coverageFresh) reasons.push('Complete-through coverage is stale; a fresh envelope does not refresh the covered time window.');
      const coherentEnvelope = evidence.accountId === manifest.destinationAccount && ms(evidence.observedAt) <= now
        && (!evidence.completeThrough || ms(evidence.completeThrough) <= ms(evidence.observedAt));
      if (!hasFailure && !failureProblems.length && coherentEnvelope && canMatch && !unreadMatchFields && !invalidDestinationIds && deadlineAt) {
        if (evidence.coverage === 'complete' && evidence.completeThrough && ms(evidence.completeThrough) >= ms(deadlineAt)) lastObservedStatus = 'missing';
        else if (ms(evidence.observedAt) < ms(deadlineAt) && row.eligibleAt && ms(evidence.observedAt) >= ms(row.eligibleAt)) lastObservedStatus = 'awaiting_sync';
      }
      if (!envelopeProblems.length && !failureProblems.length) {
        if (hasFailure && failureFresh) { status = 'failed'; reasons.push('Explicit failure evidence exists for this handoff; no later arrival was observed.'); }
        else if (hasFailure) reasons.push('Failure evidence is stale; retained as history without claiming a current failure.');
        else if (!deadlineAt) reasons.push('Declared eligibility time is missing; the sync deadline is unknown.');
        else if (canMatch && !unreadMatchFields && !invalidDestinationIds && now < ms(deadlineAt)) {
          status = 'awaiting_sync'; reasons.push('No arrival was observed; the declared sync deadline has not passed.');
        } else if (canMatch && !unreadMatchFields && !invalidDestinationIds && coverageFresh && evidence.coverage === 'complete' && evidence.completeThrough && ms(evidence.completeThrough) >= ms(deadlineAt)) {
          status = 'missing'; reasons.push('No matched arrival in the supplied complete observation through the sync deadline; this does not establish global record loss.');
        } else reasons.push('The observation does not provide complete coverage through the sync deadline.');
      }
      if (status !== 'unknown') { lastObservedStatus = status; routing = 'not_applicable'; }
    }
    return {
      rowId: row.rowId, sourceId: row.sourceId, label: row.label, status, routing,
      reasons: unique(reasons), destinationIds, eligibleAt: row.eligibleAt, deadlineAt, routingDeadlineAt,
      evidence: {
        sourceObservedAt: row.observedAt, sourceUpdatedAt: row.sourceUpdatedAt,
        destinationObservedAt: record?.observedAt ?? null, destinationSourceUpdatedAt: record?.sourceUpdatedAt ?? null,
        firstObservedAt: record?.firstObservedAt ?? null,
        matchMethod: identityProblems.length && match.indices.length ? 'ambiguous' : record ? (row.destinationIds.length ? 'explicit_id' : 'source_id_field') : 'none',
        eligibility, lastObservedStatus, lastObservedRouting, failure: row.failure,
      },
    };
  });
  const counts: Record<HandoffStatus, number> = { excluded: 0, awaiting_sync: 0, failed: 0, missing: 0, present: 0, unknown: 0 };
  const routingCounts: Record<HandoffRoutingStatus, number> = { not_applicable: 0, awaiting_routing: 0, unrouted: 0, routed: 0, unknown: 0 };
  rows.forEach((row) => { counts[row.status]++; routingCounts[row.routing]++; });
  return {
    evaluatedAt: nowISO, manifest,
    evidenceSummary: {
      accountId: evidence.accountId, observedAt: evidence.observedAt, completeThrough: evidence.completeThrough,
      coverage: evidence.coverage, recordCount: evidence.records.length,
      fresh: envelopeFresh && !envelopeProblems.length,
      unmatchedRecordIds: recordAccounting.filter((item) => !item.rowIds.length).map(({ objectType, id }) => ({ objectType, id })),
      limitations: unique([...evidence.limitations, ...envelopeProblems]), recordAccounting,
    },
    rows, counts, routingCounts,
    limitations: unique([
      'Read-only supplied-evidence audit; no retries, record writes, or routing actions are performed.',
      'Eligibility is frozen at cohort capture. Current CRM membership is not substituted for the original source cohort.',
      'Missing means not observed within the supplied coverage and deadline; it does not identify the cause or prove permanent loss.',
      'Routing criteria must express the intended completion state. A nonempty owner is evidence only if explicitly configured.',
      'First-observed time is an observation bound, not proof of when synchronization or routing actually occurred.',
      'Salesforce IDs must use native 15-character case or canonical 18-character checksum/case; incompatible forms remain unknown.',
      ...evidence.limitations,
    ]),
  };
}
