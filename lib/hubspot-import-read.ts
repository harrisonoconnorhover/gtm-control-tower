import { readHubSpotAccountIdentity } from './crm-account';
import { isCrmReadDeferredError, readCrmJson } from './crm-read-transport';
import { companyHostname } from './company-associations';
import type { LiveContactState } from './live-control-tower';
import type { HubSpotImportBinding, HubSpotImportLookup, HubSpotImportLookups, HubSpotImportObject, HubSpotImportProperty, HubSpotImportRecord, HubSpotImportSchema } from './hubspot-import';

const ORIGIN = 'https://api.hubapi.com';
const objects = { contact: 'contacts', company: 'companies' } as const;
class HubSpotImportReadError extends Error {
  constructor(readonly status: number, object: string) { super(`HubSpot ${object} read failed (HTTP ${status}). Check the connection and read permissions.`); }
}

/** Native metadata only; this deliberately does not request deal or pipeline scopes. */
export async function readHubSpotImportSchema(token: string, signal?: AbortSignal): Promise<HubSpotImportSchema> {
  const account = await readHubSpotAccountIdentity(token, signal);
  const read = client(token, signal);
  const properties = { contact: [] as HubSpotImportProperty[], company: [] as HubSpotImportProperty[] };
  for (const object of ['contact', 'company'] as const) {
    const { response, payload } = await read(`/crm/v3/properties/${objects[object]}`, object);
    if (!response.ok || response.status === 207) throw new HubSpotImportReadError(response.status, `${object} property metadata`);
    if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error(`HubSpot ${object} property metadata is invalid.`);
    properties[object] = payload.results.map((entry: unknown) => parseProperty(entry, object));
    if (new Set(properties[object].map((property) => property.name)).size !== properties[object].length) throw new Error(`HubSpot ${object} metadata repeats a property name.`);
  }
  return { portalId: account.accountId, fetchedAt: new Date().toISOString(), properties, warnings: [] };
}

/** Read current identities and mapped properties without producing a writable CRM plan. */
export async function readHubSpotImportLookups(token: string, rows: LiveContactState[], binding: HubSpotImportBinding, signal?: AbortSignal): Promise<HubSpotImportLookups> {
  if (!rows.length || rows.length > 5_000 || new Set(rows.map((row) => row.contactId)).size !== rows.length) throw new Error('Read between 1 and 5,000 uniquely identified source rows.');
  const account = await readHubSpotAccountIdentity(token, signal);
  if (account.accountId !== binding.portalId) throw new Error('The connected HubSpot portal differs from this import template. Reload its fields before reviewing.');
  const read = client(token, signal);
  const output: HubSpotImportLookups = { contacts: {}, companies: {} };
  const contactProperties = projection(binding, 'contact', ['email', 'hs_additional_emails']);
  const companyProperties = projection(binding, 'company', ['domain', 'name']);
  const byEmail = new Map<string, string[]>();
  const byId = new Map<string, string[]>();
  const companyRows: LiveContactState[] = [];
  const explicitContactId = binding.fields.contactId?.object === 'contact' && binding.fields.contactId.propertyName === 'hs_object_id';
  for (const row of rows) {
    if (row.recordStatus !== 'active' || row.importExclusion || row.suppressionMatches?.length) {
      output.contacts[row.contactId] = output.companies[row.contactId] = unresolved('This source row is excluded from CRM lookup.');
      continue;
    }
    if (row.importObject !== 'company') {
      const identity = explicitContactId ? nativeId(row.contactId) : email(row.normalizedEmail) || email(row.rawEmail);
      if (!identity) output.contacts[row.contactId] = unresolved(explicitContactId ? 'Map a valid numeric HubSpot contact record ID.' : 'A valid email or explicitly mapped HubSpot record ID is required.');
      else {
        const target = explicitContactId ? byId : byEmail;
        target.set(identity, [...target.get(identity) ?? [], row.contactId]);
      }
    }
    if (row.importObject === 'company' || row.importObject === 'contact_company') companyRows.push(row);
  }
  for (const [identities, idProperty] of [[byEmail, 'email'], [byId, 'id']] as const) {
    const keys = [...identities.keys()];
    for (let start = 0; start < keys.length; start += 100) {
      const batch = keys.slice(start, start + 100);
      const found = await readContacts(read, batch, idProperty, contactProperties, signal);
      for (const key of batch) for (const sourceId of identities.get(key)!) output.contacts[sourceId] = found.get(key)!;
    }
  }
  const companyCache = new Map<string, HubSpotImportLookup>();
  for (const row of companyRows) {
    const declaredId = row.importObject === 'contact_company' ? row.associatedCompany?.recordId?.trim()
      : binding.fields.contactId?.object === 'company' && binding.fields.contactId.propertyName === 'hs_object_id' ? row.contactId : undefined;
    const host = companyHostname(row.importObject === 'contact_company' ? row.associatedCompany?.website ?? '' : row.website ?? '');
    const key = declaredId ? `id:${declaredId}` : host ? `domain:${host}` : '';
    if (!key || (declaredId && !nativeId(declaredId))) {
      output.companies[row.contactId] = unresolved(declaredId ? 'The company record ID must be a numeric HubSpot ID.' : 'A company record ID or valid website hostname is required; names alone do not establish identity.');
      continue;
    }
    if (!companyCache.has(key)) companyCache.set(key, await readCompany(read, declaredId || null, host, companyProperties, signal));
    output.companies[row.contactId] = companyCache.get(key)!;
  }
  return output;
}

type Read = ReturnType<typeof client>;
function client(token: string, signal?: AbortSignal) {
  if (!token.trim()) throw new Error('HubSpot credentials are required for import reads.');
  const stopped = new Map<string, Error>();
  return async (path: string, object: HubSpotImportObject, body?: unknown) => {
    signal?.throwIfAborted();
    const failure = stopped.get('all') ?? stopped.get(object);
    if (failure) throw failure;
    const result = await readCrmJson(`${ORIGIN}${path}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' } },
    { provider: 'hubspot', accessToken: token }, { signal });
    if ([401, 403].includes(result.response.status)) {
      const error = new HubSpotImportReadError(result.response.status, object);
      stopped.set(result.response.status === 401 ? 'all' : object, error);
      throw error;
    }
    return result;
  };
}

async function readContacts(read: Read, identities: string[], idProperty: 'email' | 'id', properties: string[], signal?: AbortSignal): Promise<Map<string, HubSpotImportLookup>> {
  const output = new Map<string, HubSpotImportLookup>();
  const wanted = new Set(identities);
  const accept = (value: unknown, required?: string) => {
    const record = parseRecord(value);
    const keys = idProperty === 'id' ? [record.id] : [...contactEmails(record)];
    const requested = keys.filter((key) => wanted.has(key));
    if (!requested.length || (required && !keys.includes(required))) throw new Error('HubSpot returned an unrelated contact identity.');
    for (const key of requested) {
      const records = output.get(key)?.records ?? [];
      if (!records.some((previous) => previous.id === record.id)) records.push(record);
      output.set(key, { status: records.length > 1 ? 'ambiguous' : 'matched', records,
        ...(records.length > 1 ? { reason: 'More than one HubSpot contact matches this identity.' } : {}) });
    }
  };
  try {
    const { response, payload } = await read('/crm/v3/objects/contacts/batch/read', 'contact', {
      ...(idProperty === 'email' ? { idProperty: 'email' } : {}), properties, inputs: identities.map((id) => ({ id })),
    });
    if (!response.ok || !isRecord(payload) || payload.status !== 'COMPLETE' || !Array.isArray(payload.results)) throw new Error(`HubSpot contact batch read is incomplete or invalid (HTTP ${response.status}).`);
    const errors = payload.errors ?? [];
    if (!Array.isArray(errors) || errors.some((error) => !isRecord(error) || error.category !== 'OBJECT_NOT_FOUND')
      || (payload.numErrors !== undefined && (!Number.isSafeInteger(payload.numErrors) || Number(payload.numErrors) < 0 || (Number(payload.numErrors) > 0 && !errors.length)))) throw new Error('HubSpot contact batch errors do not establish identity.');
    for (const value of payload.results) accept(value);
  } catch (error) {
    propagateDeferred(error, signal);
    return new Map(identities.map((id) => [id, unresolved(message(error))]));
  }
  // Batch omissions and not-found errors are not proof of absence, especially for additional emails.
  for (const identity of identities) {
    if (output.has(identity)) continue;
    try {
      const query = new URLSearchParams({ ...(idProperty === 'email' ? { idProperty: 'email' } : {}), properties: properties.join(','), archived: 'false' });
      const { response, payload } = await read(`/crm/v3/objects/contacts/${encodeURIComponent(identity)}?${query}`, 'contact');
      if (response.status === 404) { output.set(identity, { status: 'absent', records: [] }); continue; }
      if (!response.ok || response.status === 207) throw new HubSpotImportReadError(response.status, 'contact');
      accept(payload, identity);
    } catch (error) { propagateDeferred(error, signal); output.set(identity, unresolved(message(error))); }
  }
  return output;
}

async function readCompany(read: Read, id: string | null, host: string, properties: string[], signal?: AbortSignal): Promise<HubSpotImportLookup> {
  try {
    if (id) {
      const query = new URLSearchParams({ properties: properties.join(','), archived: 'false' });
      const { response, payload } = await read(`/crm/v3/objects/companies/${id}?${query}`, 'company');
      if (response.status === 404) return { status: 'absent', records: [] };
      if (!response.ok || response.status === 207) throw new HubSpotImportReadError(response.status, 'company');
      const record = parseRecord(payload);
      if (record.id !== id) throw new Error('HubSpot returned an unrequested company record ID.');
      return { status: 'matched', records: [record] };
    }
    const { response, payload } = await read('/crm/v3/objects/companies/search', 'company', {
      limit: 2, properties, filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: host }] }],
    });
    if (!response.ok || response.status === 207) throw new HubSpotImportReadError(response.status, 'company');
    if (!isRecord(payload) || !Array.isArray(payload.results) || payload.results.length > 2
      || !Number.isSafeInteger(payload.total) || Number(payload.total) < payload.results.length) throw new Error('HubSpot company search returned incomplete or invalid coverage.');
    const records = payload.results.map(parseRecord);
    if (records.some((record) => companyHostname(record.properties.domain ?? '') !== host)) throw new Error('HubSpot company search returned an unrelated domain.');
    if (Number(payload.total) > 1 || records.length > 1 || payload.paging != null) return { status: 'ambiguous', records, reason: 'The company domain has multiple or incomplete search results. Choose a verified company record ID.' };
    if (Number(payload.total) !== records.length) throw new Error('HubSpot company search did not return its complete result.');
    return { status: records.length ? 'matched' : 'absent', records };
  } catch (error) { propagateDeferred(error, signal); return unresolved(message(error)); }
}

function projection(binding: HubSpotImportBinding, object: HubSpotImportObject, identities: string[]) {
  const fields = Object.values(binding.fields).filter((field) => field?.object === object).map((field) => field!.propertyName);
  if (fields.some((field) => !/^[a-zA-Z][a-zA-Z0-9_]{0,119}$/.test(field))) throw new Error('Choose valid HubSpot property internal names.');
  return [...new Set([...identities, ...fields])];
}
function parseProperty(value: unknown, object: HubSpotImportObject): HubSpotImportProperty {
  if (!isRecord(value) || typeof value.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,119}$/.test(value.name)
    || typeof value.label !== 'string' || typeof value.type !== 'string' || typeof value.fieldType !== 'string'
    || (value.options !== undefined && !Array.isArray(value.options))) throw new Error(`HubSpot ${object} property metadata is invalid.`);
  const options = (value.options ?? []).map((option: unknown) => {
    if (!isRecord(option) || typeof option.value !== 'string' || typeof option.label !== 'string'
      || (option.hidden !== undefined && typeof option.hidden !== 'boolean')) throw new Error(`HubSpot ${object} picklist metadata is invalid.`);
    return { value: option.value, label: option.label, hidden: option.hidden === true };
  });
  if (new Set(options.map((option: { value: string }) => option.value)).size !== options.length) throw new Error(`HubSpot ${object} picklist repeats an internal value.`);
  for (const flag of ['calculated', 'externalOptions', 'hidden']) if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw new Error(`HubSpot ${object} property flags are invalid.`);
  const metadata = value.modificationMetadata;
  if (metadata !== undefined && (!isRecord(metadata) || (metadata.readOnlyValue !== undefined && typeof metadata.readOnlyValue !== 'boolean'))) throw new Error(`HubSpot ${object} property permissions are invalid.`);
  return { name: value.name, label: value.label, type: value.type, fieldType: value.fieldType, options,
    readOnly: isRecord(metadata) && metadata.readOnlyValue === true, calculated: value.calculated === true,
    externalOptions: value.externalOptions === true, hidden: value.hidden === true };
}
function parseRecord(value: unknown): HubSpotImportRecord {
  if (!isRecord(value) || typeof value.id !== 'string' || !nativeId(value.id) || !isRecord(value.properties)
    || (value.archived !== undefined && value.archived !== false)) throw new Error('HubSpot returned a malformed or archived record.');
  const properties: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(value.properties)) {
    if (item !== null && typeof item !== 'string') throw new Error('HubSpot returned a malformed property value.');
    properties[key] = item;
  }
  return { id: value.id, properties };
}
function contactEmails(record: HubSpotImportRecord): Set<string> {
  const primary = email(record.properties.email);
  if (!primary) throw new Error('HubSpot returned a contact without a valid primary email identity.');
  const values = new Set([primary]);
  for (const alias of (record.properties.hs_additional_emails ?? '').split(';').filter((item) => item.trim())) {
    const normalized = email(alias);
    if (!normalized) throw new Error('HubSpot returned an invalid additional email identity.');
    values.add(normalized);
  }
  return values;
}
function email(value: unknown): string | null { return typeof value === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value.trim()) ? value.trim().toLowerCase() : null; }
function nativeId(value: string): string | null { return /^\d{1,30}$/.test(value) ? value : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function unresolved(reason: string): HubSpotImportLookup { return { status: 'unresolved', records: [], reason }; }
function message(error: unknown): string { return error instanceof Error ? error.message : 'HubSpot lookup did not complete.'; }
function propagateDeferred(error: unknown, signal?: AbortSignal) { signal?.throwIfAborted(); if (isCrmReadDeferredError(error)) throw error; }
