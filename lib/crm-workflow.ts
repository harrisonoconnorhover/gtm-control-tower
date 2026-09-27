import type { ConnectorId, ConnectorStatus } from './connector-contract';
import type { MatchEvidence } from './identity-resolution';

export type CrmPossibleMatch = {
  nativeId: string;
  objectType: 'lead' | 'contact';
  email: string;
  fullName: string;
  score: number;
  evidence: MatchEvidence[];
};

export type CrmCreateReview = {
  status: 'clear' | 'held';
  scanId: string | null;
  startedAt: string | null;
  ruleVersion: string;
  candidateCount: number;
  warnings: string[];
};

export type CrmCreateReviewResult = {
  review: CrmCreateReview;
  reason: string;
  possibleMatches: CrmPossibleMatch[];
};

export const portableCrmFieldNames = ['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website'] as const;
export type PortableCrmFieldName = (typeof portableCrmFieldNames)[number];

export type PortableCrmContact = {
  contactId: string;
  email: string;
  firstName: string;
  lastName: string;
  company: string | null;
  phone: string | null;
  jobTitle: string | null;
  website: string | null;
};

export type NativeCrmRecord = {
  nativeId: string;
  objectType: 'lead' | 'contact';
  isConverted?: boolean;
  email: string;
  fields: Record<PortableCrmFieldName, string | null>;
};

export type CrmFieldChange = {
  field: PortableCrmFieldName;
  before: string | null;
  after: string | null;
};

export type CrmMatch = Pick<NativeCrmRecord, 'nativeId' | 'objectType' | 'email' | 'isConverted'>;

export type CrmPlanRecord = {
  contactId: string;
  email: string;
  nativeId: string | null;
  operation: 'create' | 'update' | 'unchanged' | 'hold';
  matches: CrmMatch[];
  before: Record<PortableCrmFieldName, string | null> | null;
  after: Record<PortableCrmFieldName, string | null>;
  changes: CrmFieldChange[];
  reason: string | null;
  possibleMatches?: CrmPossibleMatch[];
  createReview?: CrmCreateReview;
};

export type CrmWritePlan = {
  planId: string;
  fingerprint: string;
  connectorId: Extract<ConnectorId, 'hubspot' | 'salesforce'>;
  sourceFile: string;
  createdAt: string;
  expiresAt: string;
  requested: number;
  creates: number;
  updates: number;
  unchanged: number;
  held: number;
  records: CrmPlanRecord[];
};

export type CrmRollbackRecord = {
  contactId: string;
  email: string;
  nativeId: string;
  before: Record<PortableCrmFieldName, string | null>;
  after: Record<PortableCrmFieldName, string | null>;
  changedFields: PortableCrmFieldName[];
};

export type CrmRollbackPlan = {
  rollbackId: string;
  connectorId: Extract<ConnectorId, 'hubspot' | 'salesforce'>;
  sourcePlanId: string;
  createdAt: string;
  records: CrmRollbackRecord[];
  createdRecordsSkipped: number;
};

export type CrmWritebackReceipt = {
  accepted: true;
  status: ConnectorStatus;
  runId: string;
  connectorId: Extract<ConnectorId, 'hubspot' | 'salesforce'>;
  planId: string;
  requested: number;
  created: number;
  updated: number;
  unchanged: number;
  held: number;
  failed: number;
  completedAt: string;
  records: Array<{
    contactId: string;
    email: string;
    nativeId: string | null;
    status: 'created' | 'updated' | 'unchanged' | 'held' | 'failed' | 'rolled_back';
    error: string | null;
  }>;
  rollback: CrmRollbackPlan | null;
};

// A workspace summary, not a synthetic execution receipt: run IDs and rollback
// plans belong to the individual native receipts recorded in run history.
export type CrmWritebackProgress = Pick<CrmWritebackReceipt,
  'records' | 'requested' | 'created' | 'updated' | 'unchanged' | 'held' | 'failed'>;

export function combineCrmWritebackProgress(
  previous: CrmWritebackProgress | null,
  receipt: CrmWritebackReceipt,
): CrmWritebackProgress {
  const byContact = new Map(previous?.records.map((record) => [record.contactId, record]));
  for (const record of receipt.records) byContact.set(record.contactId, record);
  const records = [...byContact.values()];
  return {
    records,
    requested: records.length,
    created: records.filter((record) => record.status === 'created').length,
    updated: records.filter((record) => record.status === 'updated').length,
    unchanged: records.filter((record) => record.status === 'unchanged').length,
    held: records.filter((record) => record.status === 'held').length,
    failed: records.filter((record) => record.status === 'failed').length,
  };
}

export function isSuccessfulCrmWritebackRecord(record: CrmWritebackReceipt['records'][number]): boolean {
  return record.status === 'created' || record.status === 'updated' || record.status === 'unchanged';
}

export function buildCrmWritePlan(
  connectorId: CrmWritePlan['connectorId'],
  sourceFile: string,
  proposed: PortableCrmContact[],
  existingByEmail: Map<string, NativeCrmRecord[]>,
  now = new Date(),
  createReviews?: Map<string, CrmCreateReviewResult>,
): CrmWritePlan {
  const matchedInputs = new Map<string, Set<string>>();
  const recordKey = (record: NativeCrmRecord) => `${record.objectType}:${record.nativeId}`;
  for (const contact of proposed) {
    for (const match of existingByEmail.get(contact.email.toLowerCase()) ?? []) {
      const key = recordKey(match);
      const inputs = matchedInputs.get(key) ?? new Set<string>();
      inputs.add(contact.contactId);
      matchedInputs.set(key, inputs);
    }
  }
  const records = proposed.map((contact): CrmPlanRecord => {
    const after = contactFields(contact);
    const nativeMatches = existingByEmail.get(contact.email.toLowerCase()) ?? [];
    const matches = nativeMatches.map(({ nativeId, objectType, email, isConverted }) => ({ nativeId, objectType, email, isConverted }));
    const hold = (reason: string): CrmPlanRecord => ({
      contactId: contact.contactId, email: contact.email, nativeId: null, operation: 'hold',
      matches, before: null, after, changes: [], reason,
    });
    if (matches.length > 1) {
      return hold(`${matches.length} CRM records match this email. Review the existing records before importing.`);
    }
    if (!matches.length) {
      const reviewed = createReviews?.get(contact.contactId);
      if (reviewed?.review.status === 'held') return {
        ...hold(reviewed.reason), possibleMatches: reviewed.possibleMatches, createReview: reviewed.review,
      };
      return {
        contactId: contact.contactId, email: contact.email, nativeId: null, operation: 'create', matches,
        before: null, after,
        changes: portableCrmFieldNames.filter((field) => after[field] !== null).map((field) => ({ field, before: null, after: after[field] })),
        reason: reviewed?.reason ?? 'No existing exact email match was returned by the CRM lookup.',
        ...(reviewed ? { possibleMatches: reviewed.possibleMatches, createReview: reviewed.review } : {}),
      };
    }
    const match = nativeMatches[0];
    if ((matchedInputs.get(recordKey(match))?.size ?? 0) > 1) {
      return hold('Multiple imported rows match the same CRM record. Resolve the rows before writing.');
    }
    if (connectorId === 'salesforce' && (match.objectType === 'contact' || match.isConverted)) {
      return hold(match.objectType === 'contact'
        ? 'An existing Salesforce Contact has this email. Review that Contact instead of creating a Lead.'
        : 'An existing converted Salesforce Lead has this email. Review its conversion instead of creating another Lead.');
    }
    const changes = portableCrmFieldNames.flatMap((field) => {
      const before = cleanValue(match.fields[field]);
      const next = cleanValue(after[field]);
      return before === next ? [] : [{ field, before, after: next }];
    });
    return {
      contactId: contact.contactId, email: contact.email, nativeId: match.nativeId,
      operation: changes.length ? 'update' : 'unchanged', matches,
      before: match.fields, after, changes, reason: null,
    };
  });
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const fingerprint = fingerprintPlan(connectorId, records);
  return {
    planId: `${connectorId}-${fingerprint}-${now.getTime()}`,
    fingerprint,
    connectorId,
    sourceFile: sourceFile.trim().slice(0, 255) || 'crm-workspace',
    createdAt,
    expiresAt,
    requested: records.length,
    creates: records.filter((record) => record.operation === 'create').length,
    updates: records.filter((record) => record.operation === 'update').length,
    unchanged: records.filter((record) => record.operation === 'unchanged').length,
    held: records.filter((record) => record.operation === 'hold').length,
    records,
  };
}

export function rollbackFromPlan(plan: CrmWritePlan): CrmRollbackPlan | null {
  const records = plan.records.flatMap((record): CrmRollbackRecord[] => record.operation === 'update' && record.nativeId && record.before
    ? [{
      contactId: record.contactId, email: record.email, nativeId: record.nativeId,
      before: record.before, after: record.after, changedFields: record.changes.map((change) => change.field),
    }]
    : []);
  if (!records.length) return null;
  return {
    rollbackId: crypto.randomUUID(), connectorId: plan.connectorId, sourcePlanId: plan.planId,
    createdAt: new Date().toISOString(), records,
    createdRecordsSkipped: plan.records.filter((record) => record.operation === 'create').length,
  };
}

export function planStillMatches(expected: CrmWritePlan, current: CrmWritePlan): boolean {
  return expected.connectorId === current.connectorId
    && expected.fingerprint === current.fingerprint
    && new Date(expected.expiresAt).getTime() >= Date.now();
}

export function isCrmWritePlan(value: unknown): value is CrmWritePlan {
  if (!isRecord(value) || (value.connectorId !== 'hubspot' && value.connectorId !== 'salesforce')) return false;
  return typeof value.planId === 'string' && typeof value.fingerprint === 'string'
    && typeof value.expiresAt === 'string' && Array.isArray(value.records)
    && value.records.length <= 100;
}

export function isCrmRollbackPlan(value: unknown): value is CrmRollbackPlan {
  if (!isRecord(value) || (value.connectorId !== 'hubspot' && value.connectorId !== 'salesforce')) return false;
  return typeof value.rollbackId === 'string'
    && typeof value.sourcePlanId === 'string'
    && typeof value.createdAt === 'string'
    && typeof value.createdRecordsSkipped === 'number'
    && Number.isInteger(value.createdRecordsSkipped)
    && value.createdRecordsSkipped >= 0
    && Array.isArray(value.records)
    && value.records.length <= 100
    && value.records.every(isRollbackRecord);
}

export function rollbackRecordStillMatches(record: CrmRollbackRecord, current: NativeCrmRecord | null): boolean {
  return rollbackFieldsMatch(record, current, record.after);
}

export function rollbackRecordAlreadyRestored(record: CrmRollbackRecord, current: NativeCrmRecord | null): boolean {
  return rollbackFieldsMatch(record, current, record.before);
}

function rollbackFieldsMatch(record: CrmRollbackRecord, current: NativeCrmRecord | null, expected: CrmRollbackRecord['before']): boolean {
  return Boolean(current)
    && current?.nativeId === record.nativeId
    && record.changedFields.every((field) => cleanValue(current.fields[field]) === cleanValue(expected[field]));
}

function contactFields(contact: PortableCrmContact): Record<PortableCrmFieldName, string | null> {
  return {
    firstName: cleanValue(contact.firstName), lastName: cleanValue(contact.lastName), company: cleanValue(contact.company),
    phone: cleanValue(contact.phone), jobTitle: cleanValue(contact.jobTitle), website: cleanValue(contact.website),
  };
}

function cleanValue(value: string | null | undefined): string | null {
  const cleaned = value?.trim() ?? '';
  return cleaned || null;
}

function fingerprintPlan(connectorId: string, records: CrmPlanRecord[]): string {
  const stable = JSON.stringify([connectorId, records.map(({ contactId, email, nativeId, operation, matches, before, after, reason, possibleMatches, createReview }) => ({ contactId, email, nativeId, operation, matches, before, after, reason, possibleMatches, createReview }))]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < stable.length; index += 1) {
    hash ^= stable.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isRollbackRecord(value: unknown): value is CrmRollbackRecord {
  if (!isRecord(value)) return false;
  return typeof value.contactId === 'string'
    && typeof value.email === 'string'
    && typeof value.nativeId === 'string'
    && isPortableFieldRecord(value.before)
    && isPortableFieldRecord(value.after)
    && Array.isArray(value.changedFields)
    && value.changedFields.length > 0
    && value.changedFields.every((field) => portableCrmFieldNames.includes(field as PortableCrmFieldName));
}

function isPortableFieldRecord(value: unknown): value is Record<PortableCrmFieldName, string | null> {
  return isRecord(value) && portableCrmFieldNames.every((field) => value[field] === null || typeof value[field] === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
