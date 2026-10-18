/** CRM-only file contract, copied verbatim into Pomade. No providers or write operations. */
export const CRM_EVIDENCE_FIELDS = ['jobTitle', 'company', 'phone', 'website'] as const;
export const CRM_PORTABLE_FIELDS = ['fullName', 'firstName', 'lastName', 'email', 'company', 'phone', 'jobTitle', 'website'] as const;
export const MAX_CRM_EVIDENCE_CONTACTS = 100;
export const MAX_CRM_EVIDENCE_BYTES = 2 * 1024 * 1024;
export const MAX_CRM_EVIDENCE_CHARACTERS = 10_000;
export type CrmEvidenceField = (typeof CRM_EVIDENCE_FIELDS)[number];
export type CrmPortableValues = Record<(typeof CRM_PORTABLE_FIELDS)[number], string | null>;
export type CrmEvidenceItem = {
  id: string; objectType: 'contact' | 'company' | 'deal' | 'note'; recordId: string;
  property: string | null; noteId: string | null; text: string; eventAt: string | null;
  retrievedAt: string; contactIds: string[]; url: string | null;
};
export type CrmCohortAssessments = {
  state: 'ready_for_review' | 'held' | 'excluded'; fit: 'meets' | 'does_not_meet' | 'unknown';
  timing: 'eligible' | 'not_yet' | 'unknown'; emailVerification: 'verified' | 'unverified'; reasons: string[];
};
export type CrmEvidenceCoverage = { complete: boolean; missing: string[]; omittedSourceIds: string[] };
export type CrmEvidenceContact = {
  contactId: string; dealIds: string[]; companyIds: string[]; existingValues: CrmPortableValues;
  requestedFields: CrmEvidenceField[]; evidence: CrmEvidenceItem[];
  assessments: CrmCohortAssessments; coverage: CrmEvidenceCoverage;
};
export type CrmEvidenceRequest = {
  kind: 'crm-evidence-request'; schemaVersion: 1; requestId: string; createdAt: string;
  workspaceId: string; workspaceRevision: string | null; portalId: string;
  definition: Record<string, unknown>; contentDigest: string; contacts: CrmEvidenceContact[];
};
export type CrmEvidenceFieldResult = {
  field: CrmEvidenceField; status: 'supported' | 'conflicting' | 'not_found' | 'not_run' | 'failed';
  value: string | null; rationale: string; evidence: { sourceId: string; quote: string }[];
};
export type CrmEvidenceResultContact = { contactId: string; fields: CrmEvidenceFieldResult[] };
export type CrmEvidenceResult = {
  kind: 'crm-evidence-result'; schemaVersion: 1; requestId: string; requestDigest: string;
  portalId: string; createdAt: string; contacts: CrmEvidenceResultContact[];
};

/** Attribution only: exact quotations remain claims for human review, never approval. */
export function crmEvidenceSourceSupportsField(field: CrmEvidenceField, source: CrmEvidenceItem, contact: Pick<CrmEvidenceContact, 'contactId' | 'companyIds'>): boolean {
  if (source.objectType === 'company') {
    return (field === 'company' || field === 'website') && contact.companyIds.length === 1 && contact.companyIds[0] === source.recordId;
  }
  return source.contactIds.includes(contact.contactId);
}

/** A checksum for correlating files, not a signature or evidence of approval. */
export async function crmEvidenceDigest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createCrmEvidenceRequest(input: Omit<CrmEvidenceRequest, 'kind' | 'schemaVersion' | 'contentDigest'>): Promise<CrmEvidenceRequest> {
  const body = { ...input, kind: 'crm-evidence-request' as const, schemaVersion: 1 as const };
  return parseCrmEvidenceRequest({ ...body, contentDigest: await crmEvidenceDigest(body) });
}

export async function parseCrmEvidenceRequest(input: unknown): Promise<CrmEvidenceRequest> {
  const value = readFile(input);
  keys(value, ['kind', 'schemaVersion', 'requestId', 'createdAt', 'workspaceId', 'workspaceRevision', 'portalId', 'definition', 'contentDigest', 'contacts'], 'request');
  if (value.kind !== 'crm-evidence-request' || value.schemaVersion !== 1) fail('Use a CRM evidence request version 1.');
  if (!text(value.requestId, 200) || !timestamp(value.createdAt) || !text(value.workspaceId, 200)
    || !nullableText(value.workspaceRevision, 200) || !text(value.portalId, 200) || !record(value.definition)
    || !digest(value.contentDigest)) fail('The request identity, definition or digest is invalid.');
  if (value.definition.portalId !== value.portalId) fail('The definition and request portal IDs must match.');
  if (!Array.isArray(value.contacts) || value.contacts.length < 1 || value.contacts.length > MAX_CRM_EVIDENCE_CONTACTS) fail('Select 1–100 CRM contacts; no contacts were loaded.');
  const contacts = value.contacts as unknown[];
  const identities = new Set<string>();
  for (const [index, candidate] of contacts.entries()) {
    if (!record(candidate)) fail(`Contact ${index + 1} is invalid.`);
    const row = candidate as Record<string, unknown>;
    keys(row, ['contactId', 'dealIds', 'companyIds', 'existingValues', 'requestedFields', 'evidence', 'assessments', 'coverage'], 'contact');
    if (!text(row.contactId, 200) || identities.has(row.contactId as string)) fail('Every CRM contact requires a unique native contact ID.');
    identities.add(row.contactId as string);
    if (!stringList(row.dealIds, 200) || !stringList(row.companyIds, 200)) fail('Contact deal/company identities are invalid.');
    if (!record(row.existingValues) || Object.keys(row.existingValues).length !== CRM_PORTABLE_FIELDS.length
      || !CRM_PORTABLE_FIELDS.every((field) => nullableText((row.existingValues as Record<string, unknown>)[field], 10_000))) fail('Existing values must contain the eight portable contact fields.');
    if (!Array.isArray(row.requestedFields) || row.requestedFields.length > CRM_EVIDENCE_FIELDS.length
      || new Set(row.requestedFields).size !== row.requestedFields.length
      || !row.requestedFields.every((field) => CRM_EVIDENCE_FIELDS.includes(field as CrmEvidenceField))) fail('Only missing job title, company, phone and website may be requested.');
    for (const field of row.requestedFields as CrmEvidenceField[]) {
      if ((row.existingValues as CrmPortableValues)[field]?.trim()) fail(`Contact ${row.contactId}: populated field ${field} cannot be requested.`);
    }
    validateAssessments(row.assessments);
    validateCoverage(row.coverage);
    if (!Array.isArray(row.evidence) || row.evidence.length > 200) fail('Contact evidence must be a bounded list.');
    const sourceIds = new Set<string>();
    let characters = 0;
    for (const candidateSource of row.evidence as unknown[]) {
      if (!record(candidateSource)) fail('A CRM evidence source is invalid.');
      const source = candidateSource as Record<string, unknown>;
      keys(source, ['id', 'objectType', 'recordId', 'property', 'noteId', 'text', 'eventAt', 'retrievedAt', 'contactIds', 'url'], 'evidence source');
      if (!text(source.id, 300) || sourceIds.has(source.id as string) || !text(source.recordId, 200)
        || !['contact', 'company', 'deal', 'note'].includes(source.objectType as string)
        || !nullableText(source.property, 200) || !nullableText(source.noteId, 200)
        || typeof source.text !== 'string' || source.text.length > MAX_CRM_EVIDENCE_CHARACTERS
        || !(source.eventAt === null || timestamp(source.eventAt)) || !timestamp(source.retrievedAt)
        || !stringList(source.contactIds, 200) || !(source.url === null || sourceUrl(source.url))) fail('A CRM evidence source has invalid identity, text or dates.');
      if (source.objectType === 'note' ? !text(source.noteId, 200) : !text(source.property, 200)) fail('Evidence must identify its exact source property or CRM note.');
      if (source.objectType === 'contact' && source.recordId !== row.contactId) fail('Contact property evidence belongs to another contact.');
      if (source.objectType === 'company' && !(row.companyIds as string[]).includes(source.recordId as string)) fail('Company evidence must belong to an associated company.');
      sourceIds.add(source.id as string);
      characters += (source.text as string).length;
    }
    if (characters > MAX_CRM_EVIDENCE_CHARACTERS) fail(`Contact ${row.contactId} exceeds 10,000 evidence characters. Select fewer sources; text was not truncated.`);
  }
  const { contentDigest, ...body } = value;
  if (await crmEvidenceDigest(body) !== contentDigest) fail('The request content digest does not match. Re-export the saved request.');
  return structuredClone(value) as CrmEvidenceRequest;
}

export async function createCrmEvidenceResult(request: CrmEvidenceRequest, contacts: CrmEvidenceResultContact[], createdAt = new Date().toISOString()): Promise<CrmEvidenceResult> {
  return parseCrmEvidenceResult({ kind: 'crm-evidence-result', schemaVersion: 1, requestId: request.requestId,
    requestDigest: request.contentDigest, portalId: request.portalId, createdAt, contacts }, request);
}

export async function blankCrmEvidenceResult(request: CrmEvidenceRequest, createdAt = new Date().toISOString()): Promise<CrmEvidenceResult> {
  return createCrmEvidenceResult(request, request.contacts.map((row) => ({ contactId: row.contactId,
    fields: row.requestedFields.map((field) => ({ field, status: 'not_run', value: null, rationale: 'Extraction has not run.', evidence: [] })) })), createdAt);
}

export async function parseCrmEvidenceResult(input: unknown, savedRequest: CrmEvidenceRequest): Promise<CrmEvidenceResult> {
  const request = await parseCrmEvidenceRequest(savedRequest);
  const value = readFile(input);
  keys(value, ['kind', 'schemaVersion', 'requestId', 'requestDigest', 'portalId', 'createdAt', 'contacts'], 'result');
  if (value.kind !== 'crm-evidence-result' || value.schemaVersion !== 1) fail('Use a CRM evidence result version 1.');
  if (value.requestId !== request.requestId || value.requestDigest !== request.contentDigest || value.portalId !== request.portalId) fail('The result must match the saved request, digest and HubSpot portal.');
  if (!timestamp(value.createdAt) || !Array.isArray(value.contacts) || value.contacts.length !== request.contacts.length) fail('The result must account for every requested contact, including contacts not run.');
  const seen = new Set<string>();
  for (const candidate of value.contacts as unknown[]) {
    if (!record(candidate)) fail('A result contact is invalid.');
    const row = candidate as Record<string, unknown>;
    keys(row, ['contactId', 'fields'], 'result contact');
    const original = request.contacts.find((contact) => contact.contactId === row.contactId);
    if (!original || seen.has(row.contactId as string)) fail('The result contains an unknown or duplicate native contact ID.');
    seen.add(row.contactId as string);
    if (!Array.isArray(row.fields) || row.fields.length !== original.requestedFields.length) fail('Every requested field requires an explicit outcome, including not run.');
    const fields = new Set<string>();
    for (const candidateField of row.fields as unknown[]) {
      if (!record(candidateField)) fail('A field outcome is invalid.');
      const field = candidateField as Record<string, unknown>;
      keys(field, ['field', 'status', 'value', 'rationale', 'evidence'], 'field outcome');
      if (!original.requestedFields.includes(field.field as CrmEvidenceField) || fields.has(field.field as string)) fail('The result contains an unrequested, populated, unsupported or duplicate field.');
      fields.add(field.field as string);
      if (!['supported', 'conflicting', 'not_found', 'not_run', 'failed'].includes(field.status as string)
        || !text(field.rationale, 2_000) || !nullableText(field.value, 10_000) || !Array.isArray(field.evidence) || field.evidence.length > 24) fail('A field outcome has invalid status, value, rationale or evidence.');
      if (field.status === 'supported' ? !text(field.value, 10_000) || field.evidence.length === 0 : field.value !== null) fail('Only supported outcomes may propose a value and they require CRM evidence.');
      if (field.status === 'conflicting' && field.evidence.length === 0) fail('A conflicting outcome must identify its conflicting CRM evidence.');
      for (const candidateCitation of field.evidence as unknown[]) {
        if (!record(candidateCitation)) fail('A source citation is invalid.');
        const citation = candidateCitation as Record<string, unknown>;
        keys(citation, ['sourceId', 'quote'], 'source citation');
        const source = original.evidence.find((entry) => entry.id === citation.sourceId);
        if (!source || !text(citation.quote, MAX_CRM_EVIDENCE_CHARACTERS) || !source.text.includes(citation.quote as string)) fail('A source citation must contain an exact excerpt from the supplied CRM evidence.');
        if ((field.field === 'jobTitle' || field.field === 'phone') && !crmEvidenceSourceSupportsField(field.field, source, original)) fail('Person facts require evidence explicitly attributed to that contact.');
        if (field.status === 'supported' && !crmEvidenceSourceSupportsField(field.field as CrmEvidenceField, source, original)) fail('Company facts require an unambiguous associated company or contact-specific evidence.');
      }
    }
  }
  return structuredClone(value) as CrmEvidenceResult;
}

function validateAssessments(value: unknown): void {
  if (!record(value)) fail('Contact assessments are required.');
  const item = value as Record<string, unknown>;
  keys(item, ['state', 'fit', 'timing', 'emailVerification', 'reasons'], 'assessments');
  if (!['ready_for_review', 'held', 'excluded'].includes(item.state as string)
    || !['meets', 'does_not_meet', 'unknown'].includes(item.fit as string)
    || !['eligible', 'not_yet', 'unknown'].includes(item.timing as string)
    || !['verified', 'unverified'].includes(item.emailVerification as string) || !stringList(item.reasons, 2_000, false)) fail('Contact assessments are invalid.');
}
function validateCoverage(value: unknown): void {
  if (!record(value)) fail('Source coverage is required.');
  const item = value as Record<string, unknown>;
  keys(item, ['complete', 'missing', 'omittedSourceIds'], 'coverage');
  if (typeof item.complete !== 'boolean' || !stringList(item.missing, 2_000, false) || !stringList(item.omittedSourceIds, 300)) fail('Source coverage is invalid.');
  if (item.complete && ((item.missing as string[]).length > 0 || (item.omittedSourceIds as string[]).length > 0)) fail('Coverage with missing or omitted sources cannot be complete.');
}
function readFile(input: unknown): Record<string, unknown> {
  let serialized: string;
  try { serialized = typeof input === 'string' ? input : JSON.stringify(input); } catch { fail('CRM evidence files must contain JSON data.'); }
  if (typeof serialized! !== 'string' || new TextEncoder().encode(serialized!).byteLength > MAX_CRM_EVIDENCE_BYTES) fail('Use a CRM evidence file smaller than 2 MiB.');
  let value: unknown;
  try { value = JSON.parse(serialized!); } catch { fail('The CRM evidence file must be valid JSON.'); }
  if (!record(value)) fail('A CRM evidence file object is required.');
  return value as Record<string, unknown>;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  fail('The evidence digest can only cover JSON values.');
}
function keys(value: Record<string, unknown>, allowed: string[], context: string): void {
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) fail(`The CRM evidence ${context} has missing or unsupported fields.`);
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value; }
function nullableText(value: unknown, max: number): value is string | null { return value === null || (typeof value === 'string' && value.length <= max); }
function stringList(value: unknown, max: number, unique = true): value is string[] { return Array.isArray(value) && value.length <= 500 && value.every((entry) => text(entry, max)) && (!unique || new Set(value).size === value.length); }
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function sourceUrl(value: unknown): boolean { try { const url = new URL(value as string); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }
function fail(message: string): never { throw new Error(message); }
