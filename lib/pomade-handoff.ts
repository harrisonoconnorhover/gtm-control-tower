import { importContactsCsv } from './csv-control-tower';
import { recomputeImportDuplicateFlags } from './import-exclusions';
import type { LiveContactState } from './live-control-tower';

export const POMADE_CONTACT_FIELDS = ['fullName', 'firstName', 'lastName', 'email', 'company', 'phone', 'jobTitle', 'website'] as const;
export type PomadeContactField = (typeof POMADE_CONTACT_FIELDS)[number];
export type PomadeProposedFields = Record<PomadeContactField, string | null>;
export type PomadeDestination = { provider: 'hubspot' | 'salesforce'; objectType: 'contact' | 'lead' };
export type PomadeFieldMapping = { sourceColumnId: string; sourceColumnTitle: string; contactField: PomadeContactField; destinationFields: string[] };
export type PomadeEvidence = { field: PomadeContactField; value: string; sourceUrl: string | null; quote: string | null; observedAt: string | null; reference: string | null };
export type PomadeOrigin = {
  source: 'pomade'; schemaVersion: 1 | null; exportId: string | null; exportedAt: string | null;
  sourceInstanceId: string | null; workspaceId: string; workspaceName: string | null; sourceRevision: string | null;
  rowId: string; externalKey: string | null; sourceStatus: string | null; reviewReason: string | null;
  proposedFields: PomadeProposedFields; evidence: PomadeEvidence[]; fieldMappings: PomadeFieldMapping[];
  destination: PomadeDestination; allowCreate: false; legacyImportId: string | null;
};
export type PomadeHandoffImport = {
  contacts: LiveContactState[]; sourceRows: number; destination: PomadeDestination; workspaceName: string | null;
  schemaVersion: 1 | null; exportId: string | null; warnings: string[];
};

export const MAX_POMADE_HANDOFF_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 100;
const legacyKeys = ['source', 'workspaceId', 'mode', 'destination', 'fieldMappings', 'records', 'guards'];
const versionKeys = ['schemaVersion', 'exportId', 'exportedAt', 'sourceInstanceId', 'workspaceName', 'sourceRevision'];

/** A proposal adapter only: no provider calls, native target IDs, or approvals. */
export async function importPomadeHandoff(input: unknown, options: { legacyImportId?: string; now?: Date } = {}): Promise<PomadeHandoffImport> {
  const serialized = typeof input === 'string' ? input : JSON.stringify(input);
  if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > MAX_POMADE_HANDOFF_BYTES) {
    throw new Error('Use a Pomade handoff smaller than 2 MB.');
  }
  let candidate: unknown = input;
  if (typeof input === 'string') {
    try { candidate = JSON.parse(input); } catch { throw new Error('The Pomade handoff must be valid JSON.'); }
  }
  if (!isRecord(candidate)) throw new Error('A Pomade preview handoff object is required.');
  const version = candidate.schemaVersion === undefined ? null : candidate.schemaVersion;
  if (version !== null && version !== 1) throw new Error('This Pomade handoff version is not supported. Re-export version 1.');
  requireKeys(candidate, version === 1 ? [...legacyKeys, ...versionKeys] : legacyKeys, 'handoff');
  if (candidate.source !== 'pomade' || candidate.mode !== 'preview' || !text(candidate.workspaceId, 500)
    || !isDestination(candidate.destination) || !isRecord(candidate.guards)
    || candidate.guards.allowCreate !== false || candidate.guards.maxRecords !== MAX_ROWS) {
    throw new Error('Use a Pomade preview handoff for HubSpot Contacts or Salesforce Leads with updates-only scope.');
  }
  requireKeys(candidate.guards, ['maxRecords', 'allowCreate'], 'guards');
  if (!Array.isArray(candidate.records) || !candidate.records.length || candidate.records.length > MAX_ROWS) {
    throw new Error('A Pomade handoff must contain 1–100 rows. Select a smaller group; no rows were loaded.');
  }
  if (!validMappings(candidate.fieldMappings)) throw new Error('The Pomade field mapping is invalid. Re-export the handoff.');
  if (version === 1 && (!text(candidate.exportId, 200) || !timestamp(candidate.exportedAt) || !text(candidate.sourceInstanceId, 500)
    || !text(candidate.workspaceName, 500) || !nullableText(candidate.sourceRevision, 500))) {
    throw new Error('Version 1 requires an export ID, UTC export time, source instance, workspace name, and nullable revision.');
  }
  const legacyImportId = version === null ? options.legacyImportId ?? crypto.randomUUID() : null;
  if (legacyImportId !== null && !text(legacyImportId, 200)) throw new Error('The legacy import identity is invalid.');
  const seen = new Set<string>();
  const origins = candidate.records.map((record, index): PomadeOrigin => {
    if (!isRecord(record) || !text(record.rowId, 500) || !nullableText(record.externalKey, 2_000)) {
      throw new Error(`Pomade row ${index + 1} needs a source row ID and nullable external key.`);
    }
    requireKeys(record, version === 1 ? ['rowId', 'externalKey', 'proposedFields', 'sourceStatus', 'reviewReason', 'evidence']
      : ['rowId', 'externalKey', 'proposedFields'], `row ${index + 1}`);
    if (seen.has(record.rowId)) throw new Error(`Duplicate Pomade source row ID "${record.rowId}". No rows were loaded.`);
    seen.add(record.rowId);
    if (!isRecord(record.proposedFields) || Object.keys(record.proposedFields).some((field) => !POMADE_CONTACT_FIELDS.includes(field as PomadeContactField))
      || Object.values(record.proposedFields).some((value) => !nullableText(value, 10_000))) {
      throw new Error(`Pomade row ${index + 1} contains invalid proposed fields. Only the eight portable contact fields are supported.`);
    }
    if (version === 1 && (!nullableText(record.sourceStatus, 100) || !nullableText(record.reviewReason, 2_000)
      || (record.evidence !== undefined && !validEvidence(record.evidence)))) {
      throw new Error(`Pomade row ${index + 1} has invalid status, review reason, or evidence.`);
    }
    return {
      source: 'pomade', schemaVersion: version, exportId: version === 1 ? candidate.exportId as string : null,
      exportedAt: version === 1 ? candidate.exportedAt as string : null,
      sourceInstanceId: version === 1 ? candidate.sourceInstanceId as string : null,
      workspaceId: candidate.workspaceId as string, workspaceName: version === 1 ? candidate.workspaceName as string : null,
      sourceRevision: version === 1 ? candidate.sourceRevision as string | null : null,
      rowId: record.rowId, externalKey: record.externalKey as string | null,
      sourceStatus: version === 1 ? record.sourceStatus as string | null : null,
      reviewReason: version === 1 ? record.reviewReason as string | null : null,
      proposedFields: Object.fromEntries(POMADE_CONTACT_FIELDS.map((field) => [field, (record.proposedFields as Record<string, string | null>)[field]?.trim() ? (record.proposedFields as Record<string, string | null>)[field] : null])) as PomadeProposedFields,
      evidence: version === 1 && Array.isArray(record.evidence) ? structuredClone(record.evidence) as PomadeEvidence[] : [],
      fieldMappings: structuredClone(candidate.fieldMappings) as PomadeFieldMapping[], destination: { ...candidate.destination as PomadeDestination },
      allowCreate: false, legacyImportId,
    };
  });
  const ids = await Promise.all(origins.map(async (origin) => {
    const identity = [origin.sourceInstanceId ?? origin.legacyImportId, origin.workspaceId, origin.rowId];
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(identity)));
    return `pomade-${version === 1 ? 'v1' : 'legacy'}-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }));
  if (new Set(ids).size !== ids.length) throw new Error('Pomade source identities collided. No rows were loaded.');
  const csv = [['contact_id', 'full_name', 'first_name', 'last_name', 'email', 'company', 'phone', 'job_title', 'website'],
    ...origins.map((origin, index) => [ids[index], ...POMADE_CONTACT_FIELDS.map((field) => origin.proposedFields[field] ?? '')])]
    .map((row) => row.map(csvCell).join(',')).join('\n');
  const imported = importContactsCsv(csv);
  const now = (options.now ?? new Date()).toISOString();
  const contacts = imported.contacts.map((contact, index): LiveContactState => {
    const origin = origins[index];
    const sourceNeedsReview = /review|error|fail|stale|blocked/i.test(origin.sourceStatus ?? '');
    return {
      ...contact,
      // CSV uses the row ID as a display fallback. A handoff ID is never a proposed person's name.
      fullName: origin.proposedFields.fullName?.trim() || [contact.firstName, contact.lastName].filter(Boolean).join(' '),
      sourceOrigins: [origin], lastAction: 'pomade_handoff_imported', updatedAt: now,
      ...(sourceNeedsReview ? { importExclusion: {
        reason: `Pomade ${origin.sourceStatus}: ${origin.reviewReason?.trim() || 'Resolve the source review issue before restoring this row.'}`.slice(0, 500).trim(), excludedAt: now,
      } } : {}),
    };
  });
  return {
    contacts: recomputeImportDuplicateFlags(contacts), sourceRows: contacts.length, destination: candidate.destination,
    schemaVersion: version, exportId: version === 1 ? candidate.exportId as string : null,
    workspaceName: version === 1 ? candidate.workspaceName as string : null,
    warnings: version === null ? ['Legacy Pomade preview: export time, source installation, workspace name/revision, row status, and research evidence are unknown. Row identities belong only to this loaded import.'] : [],
  };
}

export function hasPomadeOrigin(contact: Pick<LiveContactState, 'sourceOrigins'>): boolean {
  return Boolean(contact.sourceOrigins?.some((origin) => origin.source === 'pomade'));
}

export function isPomadeContactId(value: string): boolean {
  return /^pomade-(?:v1|legacy)-[a-f0-9]{64}$/.test(value);
}

/** Optional persisted metadata; old CSV workspaces remain valid without it. */
export function validPomadeOrigins(value: unknown): value is PomadeOrigin[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length > 0 && value.length <= MAX_ROWS && value.every((origin) => {
    if (!isRecord(origin) || origin.source !== 'pomade' || (origin.schemaVersion !== null && origin.schemaVersion !== 1)
      || origin.allowCreate !== false || !text(origin.workspaceId, 500) || !text(origin.rowId, 500)
      || !nullableText(origin.externalKey, 2_000) || !nullableText(origin.sourceStatus, 100) || !nullableText(origin.reviewReason, 2_000)
      || !nullableText(origin.workspaceName, 500) || !nullableText(origin.sourceRevision, 500)
      || !isDestination(origin.destination) || !validMappings(origin.fieldMappings) || !validEvidence(origin.evidence)
      || !isRecord(origin.proposedFields) || Object.keys(origin.proposedFields).length !== POMADE_CONTACT_FIELDS.length
      || !POMADE_CONTACT_FIELDS.every((field) => nullableText((origin.proposedFields as Record<string, unknown>)[field], 10_000))) return false;
    return origin.schemaVersion === 1
      ? text(origin.exportId, 200) && timestamp(origin.exportedAt) && text(origin.sourceInstanceId, 500) && origin.legacyImportId === null
      : origin.exportId === null && origin.exportedAt === null && origin.sourceInstanceId === null && text(origin.legacyImportId, 200);
  }));
}

function validMappings(value: unknown): value is PomadeFieldMapping[] {
  return Array.isArray(value) && value.length <= 8 && new Set(value.map((mapping) => isRecord(mapping) ? mapping.contactField : null)).size === value.length
    && value.every((mapping) => isRecord(mapping) && text(mapping.sourceColumnId, 500) && text(mapping.sourceColumnTitle, 500)
      && POMADE_CONTACT_FIELDS.includes(mapping.contactField as PomadeContactField) && Array.isArray(mapping.destinationFields)
      && mapping.destinationFields.length <= 2 && mapping.destinationFields.every((field) => text(field, 100)));
}
function validEvidence(value: unknown): value is PomadeEvidence[] {
  return Array.isArray(value) && value.length <= 24 && value.every((entry) => isRecord(entry)
    && POMADE_CONTACT_FIELDS.includes(entry.field as PomadeContactField) && typeof entry.value === 'string' && entry.value.length <= 10_000
    && nullableText(entry.sourceUrl, 2_000) && nullableText(entry.quote, 4_000) && nullableText(entry.reference, 1_000)
    && (entry.observedAt === null || timestamp(entry.observedAt))
    && (entry.sourceUrl === null || validSourceUrl(entry.sourceUrl)));
}
function validSourceUrl(value: string): boolean {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function isDestination(value: unknown): value is PomadeDestination {
  return isRecord(value) && ((value.provider === 'hubspot' && value.objectType === 'contact') || (value.provider === 'salesforce' && value.objectType === 'lead'));
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim(); }
function nullableText(value: unknown, maximum: number): value is string | null { return value === null || (typeof value === 'string' && value.length <= maximum); }
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function requireKeys(value: Record<string, unknown>, allowed: string[], context: string) {
  const unsupported = Object.keys(value).find((key) => !allowed.includes(key));
  if (unsupported) throw new Error(`Unsupported Pomade ${context} field "${unsupported}". Re-export the preview; supplied control fields are not accepted.`);
}
function csvCell(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
