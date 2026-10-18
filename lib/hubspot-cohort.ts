import { isCrmReadDeferredError, readCrmJson } from './crm-read-transport';
import { readHubSpotAccountIdentity } from './crm-account';
import { parseCrmCohortDefinition, type CrmCohortContact, type CrmCohortDeal, type CrmCohortDefinition } from './crm-cohort';
import { MAX_CRM_EVIDENCE_CHARACTERS, MAX_CRM_EVIDENCE_CONTACTS, type CrmEvidenceCoverage, type CrmEvidenceItem } from './crm-evidence-request';

export type HubSpotCohortProperty = { name: string; label: string; type: string; options: { value: string; label: string }[] };
export type HubSpotCohortPipeline = { id: string; label: string; stages: { id: string; label: string; closed: boolean; won: boolean }[] };
export type HubSpotCohortMetadata = {
  portalId: string; pipelines: HubSpotCohortPipeline[];
  properties: { contact: HubSpotCohortProperty[]; company: HubSpotCohortProperty[]; deal: HubSpotCohortProperty[] };
  warnings: string[];
};
export type HubSpotCohortPage = {
  portalId: string; contacts: CrmCohortContact[]; coverage: CrmEvidenceCoverage;
  nextCursor: string | null; totalDeals: number | null; scannedDealIds: string[];
};
export type HubSpotCohortSelection = { contactId: string; dealIds: string[] };

const DEAL_PAGE_SIZE = 20;
const ASSOCIATION_CAP = 100;
const NOTE_CAP = 20;
const OBJECTS = { contact: 'contacts', company: 'companies', deal: 'deals', note: 'notes' } as const;
type ObjectType = keyof typeof OBJECTS;
type NativeRecord = { id: string; properties: Record<string, string | null>; updatedAt: string | null };
type AssociationRead = { ids: string[]; complete: boolean; omitted: string[]; missing: string[] };

/** Metadata and all cohort operations use native read endpoints only. */
export async function readHubSpotCohortMetadata(token: string, signal?: AbortSignal): Promise<HubSpotCohortMetadata> {
  const account = await readHubSpotAccountIdentity(token, signal);
  const client = readClient(token, signal);
  const warnings: string[] = [];
  const [pipelines, contact, deal, company] = await Promise.all([
    readPipelines(client), readProperties(client, 'contact'), readProperties(client, 'deal'),
    readProperties(client, 'company').catch((error: unknown) => {
      throwIfDeferredOrCancelled(error);
      warnings.push(`Company property metadata unavailable: ${errorMessage(error)}`); return [];
    }),
  ]);
  return { portalId: account.accountId, pipelines, properties: { contact, company, deal }, warnings };
}

/** One explicit native search page. The caller retains the cursor, prior rows and coverage. */
export async function readHubSpotCohortPage(token: string, input: CrmCohortDefinition, after: string | null = null, signal?: AbortSignal): Promise<HubSpotCohortPage> {
  const definition = parseCrmCohortDefinition(input);
  if (after !== null && (!/^\d{1,5}$/.test(after) || Number(after) >= 10_000)) throw new Error('Use a valid HubSpot cohort cursor below the 10,000-result search limit.');
  const client = readClient(token, signal);
  const portalId = await verifyPortal(token, definition.portalId, signal);
  await verifySelection(client, definition);
  const payload = await client('/crm/v3/objects/deals/search', {
    method: 'POST', body: JSON.stringify({ limit: DEAL_PAGE_SIZE, properties: dealProperties(definition),
      sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      filterGroups: [{ filters: [
        { propertyName: 'pipeline', operator: 'EQ', value: definition.pipelineId },
        { propertyName: 'dealstage', operator: 'IN', values: definition.lostStageIds },
        { propertyName: definition.closeDateProperty, operator: 'GTE', value: String(Date.parse(`${definition.dateFrom}T00:00:00.000Z`)) },
        { propertyName: definition.closeDateProperty, operator: 'LTE', value: String(Date.parse(`${definition.dateTo}T23:59:59.999Z`)) },
      ] }], ...(after === null ? {} : { after }),
    }),
  });
  const page = parsePage(payload, DEAL_PAGE_SIZE, after);
  const deals = page.results.map((record) => parseRecord(record));
  const coverage = completeCoverage();
  if (page.after !== null) coverage.missing.push('More matching deals are available; continue reading pages before claiming a complete population.');
  if (page.total === null) coverage.missing.push('HubSpot did not report the total matching deal count.');
  if ((page.total !== null && page.total >= 10_000) || (page.after !== null && Number(page.after) >= 10_000)) coverage.missing.push('The selected population reaches the HubSpot search limit; narrow the date range.');
  const origins = new Map<string, Set<string>>();
  for (const deal of deals) {
    const associations = await readAssociations(client, 'deal', deal.id, 'contact');
    addAssociationCoverage(coverage, associations);
    for (const id of associations.ids) {
      if (!origins.has(id)) origins.set(id, new Set());
      origins.get(id)!.add(deal.id);
    }
  }
  const allIds = [...origins.keys()];
  if (allIds.length > MAX_CRM_EVIDENCE_CONTACTS) {
    coverage.missing.push('This page exceeds 100 contacts; narrow the date range to review omitted contacts.');
    coverage.omittedSourceIds.push(...allIds.slice(MAX_CRM_EVIDENCE_CONTACTS).map((id) => `contact:${id}`));
  }
  const selections = allIds.slice(0, MAX_CRM_EVIDENCE_CONTACTS).map((contactId) => ({ contactId, dealIds: [...origins.get(contactId)!] }));
  const contacts = await hydrateContacts(client, definition, selections, portalId, deals);
  coverage.complete = coverage.missing.length === 0 && coverage.omittedSourceIds.length === 0;
  return { portalId, contacts, coverage, nextCursor: page.after !== null && Number(page.after) < 10_000 ? page.after : null,
    totalDeals: page.total, scannedDealIds: deals.map((deal) => deal.id) };
}

/** Recheck saved native identities and the same eligibility inputs; never rematch by email. */
export async function readHubSpotCohortContacts(token: string, input: CrmCohortDefinition, selections: HubSpotCohortSelection[], signal?: AbortSignal): Promise<HubSpotCohortPage> {
  const definition = parseCrmCohortDefinition(input);
  validateSelections(selections);
  const portalId = await verifyPortal(token, definition.portalId, signal);
  const client = readClient(token, signal);
  await verifySelection(client, definition);
  const contacts = await hydrateContacts(client, definition, selections, portalId);
  return { portalId, contacts, coverage: completeCoverage(), nextCursor: null, totalDeals: null,
    scannedDealIds: [...new Set(selections.flatMap((selection) => selection.dealIds))] };
}

function validateSelections(selections: HubSpotCohortSelection[]) {
  if (!Array.isArray(selections) || !selections.length || selections.length > MAX_CRM_EVIDENCE_CONTACTS
    || selections.some((selection) => !isRecord(selection) || !nativeId(selection.contactId) || !Array.isArray(selection.dealIds)
      || !selection.dealIds.length || selection.dealIds.length > ASSOCIATION_CAP || selection.dealIds.some((id) => !nativeId(id))
      || new Set(selection.dealIds).size !== selection.dealIds.length)
    || new Set(selections.map((selection) => selection.contactId)).size !== selections.length) {
    throw new Error('Recheck 1–100 unique native contacts with their original native deal IDs.');
  }
}

async function hydrateContacts(client: ReadClient, definition: CrmCohortDefinition, selections: HubSpotCohortSelection[], portalId: string, seedDeals: NativeRecord[] = []): Promise<CrmCohortContact[]> {
  const retrievedAt = new Date().toISOString();
  const records = new Map<string, Promise<NativeRecord | null>>(seedDeals.map((deal) => [`deal:${deal.id}`, Promise.resolve(deal)]));
  const associations = new Map<string, Promise<AssociationRead>>();
  const read = (object: ObjectType, id: string, properties: string[]) => {
    const key = `${object}:${id}`;
    if (!records.has(key)) records.set(key, readRecord(client, object, id, properties));
    return records.get(key)!;
  };
  const related = (from: ObjectType, id: string, to: ObjectType) => {
    const key = `${from}:${id}:${to}`;
    if (!associations.has(key)) associations.set(key, readAssociations(client, from, id, to));
    return associations.get(key)!;
  };
  return mapBounded(selections, 4, async (selection) => {
    const coverage = completeCoverage();
    const evidence: CrmEvidenceItem[] = [];
    const contact = await read('contact', selection.contactId, contactProperties(definition)).catch((error: unknown) => {
      throwIfDeferredOrCancelled(error);
      coverage.missing.push(`Contact ${selection.contactId}: ${errorMessage(error)}`); return null;
    });
    if (!contact) coverage.missing.push(`Native contact ${selection.contactId} is missing, archived or unreadable.`);
    const properties = contact?.properties ?? {};
    for (const property of contactProperties(definition)) if (!(property in properties)) coverage.missing.push(`Contact property unreadable or omitted: ${property}`);
    const firstName = properties.firstname ?? null;
    const lastName = properties.lastname ?? null;
    const row: CrmCohortContact = {
      contactId: selection.contactId, properties, dealIds: [...selection.dealIds], companyIds: [], deals: [], evidence, coverage,
      existingValues: { firstName, lastName, fullName: [firstName, lastName].filter(Boolean).join(' ') || null,
        email: properties.email ?? null, company: properties[definition.fieldProperties.company] ?? null,
        phone: properties[definition.fieldProperties.phone] ?? null, jobTitle: properties[definition.fieldProperties.jobTitle] ?? null,
        website: properties[definition.fieldProperties.website] ?? null },
    };
    if (!contact) { coverage.complete = false; return row; }
    const [dealLinks, companyLinks] = await Promise.all([related('contact', contact.id, 'deal'), related('contact', contact.id, 'company')]);
    addAssociationCoverage(coverage, dealLinks); addAssociationCoverage(coverage, companyLinks);
    row.companyIds = companyLinks.ids;
    for (const dealId of selection.dealIds) {
      if (!dealLinks.ids.includes(dealId)) coverage.missing.push(`Originating deal ${dealId} is no longer confirmed as associated with contact ${contact.id}.`);
    }
    evidence.push(...propertyEvidence(contact, 'contact', definition.evidenceProperties.contact, [contact.id], portalId, retrievedAt));
    for (const id of [...new Set([...selection.dealIds, ...dealLinks.ids])]) {
      const deal = await read('deal', id, dealProperties(definition)).catch((error: unknown) => {
        throwIfDeferredOrCancelled(error);
        coverage.missing.push(`Deal ${id}: ${errorMessage(error)}`); return null;
      });
      if (!deal) { coverage.missing.push(`Associated deal ${id} is missing or unreadable.`); continue; }
      row.deals.push({ dealId: deal.id, properties: deal.properties } satisfies CrmCohortDeal);
      for (const property of dealProperties(definition)) if (!(property in deal.properties)) coverage.missing.push(`Deal ${id} property unreadable or omitted: ${property}`);
      if (selection.dealIds.includes(id)) {
        evidence.push(...propertyEvidence(deal, 'deal', dealProperties(definition), [], portalId, retrievedAt));
        if (definition.includeNotes) await appendNotes('deal', id, []);
      }
    }
    for (const id of companyLinks.ids) {
      if (!definition.evidenceProperties.company.length) continue;
      const company = await read('company', id, definition.evidenceProperties.company).catch((error: unknown) => {
        throwIfDeferredOrCancelled(error);
        coverage.missing.push(`Company ${id}: ${errorMessage(error)}`); return null;
      });
      if (!company) { coverage.missing.push(`Company ${id} is missing or unreadable.`); continue; }
      for (const property of definition.evidenceProperties.company) if (!(property in company.properties)) coverage.missing.push(`Company ${id} property unreadable or omitted: ${property}`);
      evidence.push(...propertyEvidence(company, 'company', definition.evidenceProperties.company, [], portalId, retrievedAt));
    }
    if (definition.includeNotes) await appendNotes('contact', contact.id, [contact.id]);
    let used = 0;
    row.evidence = evidence.filter((item) => {
      if (used + item.text.length > MAX_CRM_EVIDENCE_CHARACTERS) { coverage.omittedSourceIds.push(item.id); return false; }
      used += item.text.length; return true;
    });
    if (row.evidence.length !== evidence.length) coverage.missing.push('Evidence exceeds 10,000 characters. Reduce selected properties or notes; omitted sources remain listed.');
    coverage.missing = [...new Set(coverage.missing)];
    coverage.omittedSourceIds = [...new Set(coverage.omittedSourceIds)];
    coverage.complete = coverage.missing.length === 0 && coverage.omittedSourceIds.length === 0;
    return row;

    async function appendNotes(from: 'contact' | 'deal', id: string, contactIds: string[]) {
      const links = await related(from, id, 'note');
      addAssociationCoverage(coverage, links);
      if (links.ids.length > NOTE_CAP) {
        coverage.missing.push(`Only ${NOTE_CAP} linked notes are included for ${from} ${id}; reduce the evidence selection.`);
        coverage.omittedSourceIds.push(...links.ids.slice(NOTE_CAP).map((noteId) => `note:${noteId}`));
      }
      for (const noteId of links.ids.slice(0, NOTE_CAP)) {
        const note = await read('note', noteId, ['hs_note_body', 'hs_timestamp']).catch((error: unknown) => {
          throwIfDeferredOrCancelled(error);
          coverage.missing.push(`Note ${noteId}: ${errorMessage(error)}`); return null;
        });
        if (!note || !('hs_note_body' in note.properties)) { coverage.missing.push(`Note ${noteId} is missing or unreadable.`); continue; }
        const text = note.properties.hs_note_body;
        if (!text) continue;
        const prior = evidence.find((item) => item.id === `note:${noteId}`);
        if (prior) { prior.contactIds = [...new Set([...prior.contactIds, ...contactIds])]; continue; }
        const eventAt = validDate(note.properties.hs_timestamp);
        if (eventAt === null) coverage.missing.push(`Note ${noteId} has no valid event date; its age requires review.`);
        evidence.push({ id: `note:${noteId}`, objectType: 'note', recordId: noteId, property: 'hs_note_body', noteId,
          text, eventAt, retrievedAt, contactIds,
          url: `https://app.hubspot.com/contacts/${portalId}/record/${from === 'contact' ? '0-1' : '0-3'}/${id}` });
      }
    }
  });
}

function propertyEvidence(record: NativeRecord, object: Exclude<ObjectType, 'note'>, selected: string[], contactIds: string[], portalId: string, retrievedAt: string): CrmEvidenceItem[] {
  return [...new Set(selected)].flatMap((property) => {
    const value = record.properties[property];
    return value ? [{ id: `${object}:${record.id}:${property}`, objectType: object, recordId: record.id, property, noteId: null,
      text: value, eventAt: null, retrievedAt, contactIds,
      url: `https://app.hubspot.com/contacts/${portalId}/record/${{ contact: '0-1', company: '0-2', deal: '0-3' }[object]}/${record.id}` }] : [];
  });
}

function contactProperties(definition: CrmCohortDefinition): string[] {
  return [...new Set(['firstname', 'lastname', 'email', ...Object.values(definition.fieldProperties), definition.inactivity.property,
    ...definition.exclusions.map((rule) => rule.property), ...definition.fitRules.map((rule) => rule.property),
    ...(definition.followUpProperty ? [definition.followUpProperty] : []),
    ...(definition.verification ? [definition.verification.statusProperty, definition.verification.addressProperty, definition.verification.dateProperty] : []),
    ...definition.evidenceProperties.contact])];
}
function dealProperties(definition: CrmCohortDefinition): string[] {
  return [...new Set(['dealname', 'pipeline', 'dealstage', definition.closeDateProperty,
    ...(definition.lossReasonProperty ? [definition.lossReasonProperty] : []), ...definition.evidenceProperties.deal])];
}
async function verifyPortal(token: string, expected: string, signal?: AbortSignal) {
  const identity = await readHubSpotAccountIdentity(token, signal);
  if (identity.accountId !== expected) throw new Error('The connected HubSpot portal differs from this cohort definition.');
  return identity.accountId;
}
async function verifySelection(client: ReadClient, definition: CrmCohortDefinition) {
  const pipelines = await readPipelines(client);
  const pipeline = pipelines.find((item) => item.id === definition.pipelineId);
  if (!pipeline || definition.lostStageIds.some((id) => !pipeline.stages.some((stage) => stage.id === id))) throw new Error('The saved pipeline or lost-stage IDs no longer exist. Refresh the cohort definition.');
  if (definition.lostStageIds.some((id) => !pipeline.stages.some((stage) => stage.id === id && stage.closed && !stage.won))) throw new Error('Selected lost stages must be closed and non-winning in HubSpot pipeline metadata.');
  const stages = new Set(pipelines.flatMap((item) => item.stages.map((stage) => stage.id)));
  if ([...definition.activeStageIds, ...definition.wonStageIds].some((id) => !stages.has(id))) throw new Error('A saved active/won stage no longer exists. Refresh the cohort definition.');
}

type ReadClient = (path: string, init?: RequestInit) => Promise<unknown>;
class HubSpotReadError extends Error { constructor(readonly status: number) { super(`HubSpot read failed (HTTP ${status}).`); } }
function readClient(token: string, signal?: AbortSignal): ReadClient {
  if (!token.trim()) throw new Error('HubSpot credentials are required for CRM cohort reads.');
  let stopped: unknown;
  return async (path, init = {}) => {
    if (stopped) throw stopped;
    try {
      const { response, payload } = await readCrmJson(`https://api.hubapi.com${path}`, { ...init,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' } },
      { provider: 'hubspot', accessToken: token }, { signal });
      if (!response.ok || response.status === 207) throw new HubSpotReadError(response.status);
      return payload;
    } catch (error) {
      if (signal?.aborted) { stopped = new DOMException('CRM cohort read cancelled.', 'AbortError'); throw stopped; }
      if (isCrmReadDeferredError(error)) stopped = error;
      throw error;
    }
  };
}
function throwIfDeferredOrCancelled(error: unknown) {
  if (isCrmReadDeferredError(error) || (error instanceof DOMException && error.name === 'AbortError')) throw error;
}
async function readProperties(client: ReadClient, object: Exclude<ObjectType, 'note'>): Promise<HubSpotCohortProperty[]> {
  const payload = await client(`/crm/v3/properties/${OBJECTS[object]}`);
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error('HubSpot returned invalid property metadata.');
  return payload.results.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.label !== 'string' || typeof entry.type !== 'string'
      || (entry.options !== undefined && !Array.isArray(entry.options))) throw new Error('HubSpot returned invalid property metadata.');
    const options = (entry.options ?? []).map((option: unknown) => {
      if (!isRecord(option) || typeof option.value !== 'string' || typeof option.label !== 'string') throw new Error('HubSpot returned invalid property options.');
      return { value: option.value, label: option.label };
    });
    return { name: entry.name, label: entry.label, type: entry.type, options };
  });
}
async function readPipelines(client: ReadClient): Promise<HubSpotCohortPipeline[]> {
  const payload = await client('/crm/v3/pipelines/deals');
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error('HubSpot returned invalid pipeline metadata.');
  return payload.results.map((pipeline) => {
    if (!isRecord(pipeline) || typeof pipeline.id !== 'string' || typeof pipeline.label !== 'string' || !Array.isArray(pipeline.stages)) throw new Error('HubSpot returned invalid pipeline metadata.');
    return { id: pipeline.id, label: pipeline.label, stages: pipeline.stages.map((stage: unknown) => {
      if (!isRecord(stage) || typeof stage.id !== 'string' || typeof stage.label !== 'string') throw new Error('HubSpot returned invalid stage metadata.');
      const metadata = isRecord(stage.metadata) ? stage.metadata : {};
      return { id: stage.id, label: stage.label, closed: metadata.isClosed === 'true' || metadata.isClosed === true,
        won: Number(metadata.probability) === 1 };
    }) };
  });
}
async function readRecord(client: ReadClient, object: ObjectType, id: string, properties: string[]): Promise<NativeRecord | null> {
  const query = new URLSearchParams({ properties: properties.join(','), archived: 'false' });
  const payload = await client(`/crm/v3/objects/${OBJECTS[object]}/${id}?${query}`).catch((error: unknown) => {
    throwIfDeferredOrCancelled(error);
    if (error instanceof HubSpotReadError && error.status === 404) return null; throw error;
  });
  if (payload === null || (isRecord(payload) && payload.archived === true)) return null;
  const record = parseRecord(payload);
  if (record.id !== id) throw new Error('HubSpot returned an unrequested native record.');
  return record;
}
async function readAssociations(client: ReadClient, from: ObjectType, id: string, to: ObjectType): Promise<AssociationRead> {
  const output: AssociationRead = { ids: [], complete: true, omitted: [], missing: [] };
  let after: string | null = null;
  const seen = new Set<string>();
  try {
    do {
      const query = new URLSearchParams({ limit: String(ASSOCIATION_CAP) });
      if (after) query.set('after', after);
      const payload = await client(`/crm/v4/objects/${OBJECTS[from]}/${id}/associations/${OBJECTS[to]}?${query}`);
      const page = parsePage(payload, ASSOCIATION_CAP, after);
      for (const entry of page.results) {
        if (!isRecord(entry) || !['string', 'number'].includes(typeof entry.toObjectId) || !nativeId(String(entry.toObjectId))
          || (typeof entry.toObjectId === 'number' && !Number.isSafeInteger(entry.toObjectId))) throw new Error('HubSpot returned malformed associations.');
        const linkedId = String(entry.toObjectId);
        if (!output.ids.includes(linkedId)) {
          if (output.ids.length < ASSOCIATION_CAP) output.ids.push(linkedId);
          else output.omitted.push(`${to}:${linkedId}`);
        }
      }
      after = page.after;
      if (after && seen.has(after)) throw new Error('HubSpot repeated an association cursor.');
      if (after) seen.add(after);
      if (output.omitted.length || (output.ids.length >= ASSOCIATION_CAP && after)) {
        output.complete = false;
        output.missing.push(`More ${to} associations exist for ${from} ${id}; the ${ASSOCIATION_CAP}-association limit was reached${after ? ` (cursor ${after})` : ''}.`);
        if (after) output.omitted.push(`${from}:${id}:${to}:after:${after}`);
        break;
      }
    } while (after);
  } catch (error) {
    throwIfDeferredOrCancelled(error);
    output.complete = false; output.missing.push(`${from} ${id} → ${to} associations: ${errorMessage(error)}`);
  }
  return output;
}
function parseRecord(value: unknown): NativeRecord {
  if (!isRecord(value) || !nativeId(value.id) || !isRecord(value.properties) || value.archived === true) throw new Error('HubSpot returned a malformed or archived native record.');
  const properties: Record<string, string | null> = {};
  for (const [name, item] of Object.entries(value.properties)) {
    if (item !== null && typeof item !== 'string') throw new Error('HubSpot returned a malformed record property.');
    properties[name] = item;
  }
  return { id: value.id as string, properties, updatedAt: validDate(value.updatedAt) };
}
function parsePage(value: unknown, limit: number, previous: string | null): { results: unknown[]; after: string | null; total: number | null } {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length > limit) throw new Error('HubSpot returned a malformed page.');
  if (value.paging !== undefined && !isRecord(value.paging)) throw new Error('HubSpot returned malformed pagination.');
  const paging = isRecord(value.paging) ? value.paging : {};
  if (paging.next !== undefined && !isRecord(paging.next)) throw new Error('HubSpot returned malformed pagination.');
  const next = isRecord(paging.next) ? paging.next : null;
  const after = next ? String(next.after) : null;
  if (after !== null && (!/^\d{1,30}$/.test(after) || after === previous || !value.results.length)) throw new Error('HubSpot returned an invalid or repeated cursor.');
  if (value.total !== undefined && (typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0)) throw new Error('HubSpot returned an invalid total count.');
  return { results: value.results, after, total: typeof value.total === 'number' ? value.total : null };
}
function addAssociationCoverage(coverage: CrmEvidenceCoverage, associations: AssociationRead) {
  coverage.missing.push(...associations.missing); coverage.omittedSourceIds.push(...associations.omitted);
  if (!associations.complete) coverage.complete = false;
}
function completeCoverage(): CrmEvidenceCoverage { return { complete: true, missing: [], omittedSourceIds: [] }; }
function validDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = /^\d{13}$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function nativeId(value: unknown): value is string { return typeof value === 'string' && /^\d{1,30}$/.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Read unavailable.'; }
async function mapBounded<T, U>(items: T[], parallelism: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallelism, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index]); }
  }));
  return results;
}
