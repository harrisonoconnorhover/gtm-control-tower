import type { MonitorCapability, MonitorContact, MonitorObjectType, MonitorProvider } from './monitor-types';

export const MONITOR_PROPERTIES = [
  'email', 'firstname', 'lastname', 'company', 'jobtitle',
  'hubspot_owner_id', 'lifecyclestage', 'lastmodifieddate', 'associatedcompanyid',
] as const;
const definitions = {
  Contact: { api: 'contacts', modified: 'lastmodifieddate', fields: [...MONITOR_PROPERTIES] },
  Company: { api: 'companies', modified: 'hs_lastmodifieddate', fields: ['name', 'domain', 'hubspot_owner_id', 'hs_lastmodifieddate'] },
  Deal: { api: 'deals', modified: 'hs_lastmodifieddate', fields: ['dealname', 'dealstage', 'pipeline', 'amount', 'closedate', 'hubspot_owner_id', 'hs_lastmodifieddate'] },
} as const;
type ObjectType = keyof typeof definitions;
const objectTypes: ObjectType[] = ['Contact', 'Company', 'Deal'];

export type MonitorPage = { contacts: MonitorContact[]; after: string | null; total?: number };
export type MonitorSource = {
  provider?: MonitorProvider;
  accountId?: string;
  capabilities?: () => Promise<MonitorCapability[]>;
  list: (after: string | null) => Promise<MonitorPage>;
  changes: (from: string, through: string, after: string | null) => Promise<MonitorPage>;
  read: (id: string, objectType?: MonitorObjectType) => Promise<MonitorContact>;
  patch: (id: string, properties: Record<string, string>, objectType?: MonitorObjectType) => Promise<void>;
};

class NativeMonitorHttpError extends Error {
  constructor(readonly status: number) { super('HubSpot monitor request failed (HTTP ' + status + ').'); }
}
class NativeMonitorCoverageError extends Error {}

/** Full native read coverage; only existing Contact whitespace repairs have write authority. */
export function hubspotMonitorSource(token: string): MonitorSource {
  if (!token.trim()) throw new Error('A HubSpot access token is required.');
  const unavailable = new Set<ObjectType>();
  const readable = new Map<ObjectType, string[]>();
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`https://api.hubapi.com${path}`, {
      ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new NativeMonitorHttpError(response.status);
    return response.status === 204 ? null : response.json();
  }
  const fields = (type: ObjectType) => readable.get(type) ?? [...definitions[type].fields];
  async function page(after: string | null, from?: string, through?: string): Promise<MonitorPage> {
    let { objectType, cursor } = parseCursor(after);
    const contacts: MonitorContact[] = [];
    let total = 0;
    for (let index = objectTypes.indexOf(objectType); index < objectTypes.length; index++) {
      objectType = objectTypes[index];
      if (unavailable.has(objectType)) { cursor = null; continue; }
      const definition = definitions[objectType];
      const limit = 50 - contacts.length;
      let raw: unknown;
      if (from !== undefined && through !== undefined) {
        if (![from, through].every((v) => Number.isFinite(Date.parse(v)))) throw new Error('Invalid HubSpot change window.');
        if (cursor && !/^\d+$/.test(cursor)) throw new Error('Invalid HubSpot change cursor.');
        raw = await request(`/crm/v3/objects/${definition.api}/search`, {
          method: 'POST', body: JSON.stringify({
            limit, properties: fields(objectType), sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
            filterGroups: [{ filters: [
              { propertyName: definition.modified, operator: 'GTE', value: String(Date.parse(from)) },
              { propertyName: definition.modified, operator: 'LTE', value: String(Date.parse(through)) },
              ...(cursor ? [{ propertyName: 'hs_object_id', operator: 'GT', value: cursor }] : []),
            ] }],
          }),
        });
      } else {
        const query = new URLSearchParams({ limit: String(limit), archived: 'false', properties: fields(objectType).join(',') });
        if (cursor) query.set('after', cursor);
        raw = await request(`/crm/v3/objects/${definition.api}?${query}`);
      }
      const parsed = parsePage(raw, objectType, limit);
      // Missing totals or the native search cap explicitly trigger full reconciliation in the engine.
      if (from !== undefined && (parsed.total === undefined || parsed.total >= 10_000)) {
        return { contacts: [], after: null, ...(parsed.total === undefined ? {} : { total: parsed.total }) };
      }
      total = Math.max(total, parsed.total ?? 0); // Search cap is per object, not the sum across object types.
      contacts.push(...parsed.contacts);
      if (parsed.after !== null) {
        const next = from === undefined ? parsed.after : parsed.contacts.at(-1)!.id;
        return { contacts, after: encodeCursor(objectType, next), ...(from === undefined ? {} : { total }) };
      }
      if (contacts.length === 50) {
        const nextType = objectTypes[index + 1];
        return { contacts, after: nextType ? encodeCursor(nextType, null) : null, ...(from === undefined ? {} : { total }) };
      }
      cursor = null;
    }
    return { contacts, after: null, ...(from === undefined ? {} : { total }) };
  }
  async function relationships(records: MonitorContact[]): Promise<MonitorContact[]> {
    for (const type of ['Company', 'Deal'] as const) {
      const selected = records.filter((record) => record.objectType === type);
      if (!selected.length) continue;
      for (const target of (type === 'Deal' ? ['companies', 'contacts'] : ['contacts'])) {
        const key = target === 'companies' ? 'company_ids' : 'contact_ids';
        try {
          const response = await request(`/crm/v4/associations/${definitions[type].api}/${target}/batch/read`, {
            method: 'POST', body: JSON.stringify({ inputs: selected.map((record) => ({ id: record.id })) }),
          });
          if (!isRecord(response) || !Array.isArray(response.results) || (Array.isArray(response.errors) && response.errors.length)) throw new Error('Association batch incomplete.');
          for (const record of selected) {
            const row = response.results.find((item) => isRecord(item) && isRecord(item.from) && String(item.from.id) === record.id);
            if (!isRecord(row) || !Array.isArray(row.to) || row.paging || row.to.length > 1000) {
              record.coverage = [...record.coverage ?? [], `${key}: association response missing or truncated.`]; continue;
            }
            const ids = row.to.map((edge: unknown) => {
              if (!isRecord(edge) || (typeof edge.toObjectId === 'number' && !Number.isSafeInteger(edge.toObjectId))) return '';
              return String(edge.toObjectId);
            });
            if (ids.some((id: string) => !/^\d{1,30}$/.test(id))) throw new Error('Invalid native association ID.');
            record.properties[key] = JSON.stringify([...new Set(ids)].sort());
            if (key === 'company_ids' && ids.length <= 1) record.properties.company_id = ids[0] ?? '';
          }
        } catch {
          for (const record of selected) record.coverage = [...record.coverage ?? [], `${key}: native association read unavailable; no relationship conclusion is possible.`];
        }
      }
    }
    return records;
  }
  return {
    provider: 'hubspot',
    async capabilities() {
      const capabilities: MonitorCapability[] = [];
      for (const objectType of objectTypes) {
        const definition = definitions[objectType];
        try {
          const metadata = await request(`/crm/v3/properties/${definition.api}`);
          if (!isRecord(metadata) || !Array.isArray(metadata.results)) throw new Error('Invalid property metadata.');
          const names = new Set(metadata.results.filter(isRecord).map((row) => row.name));
          const supported = definition.fields.filter((field) => names.has(field));
          const missingFields = definition.fields.filter((field) => !names.has(field));
          // Metadata availability alone does not prove object read permission.
          await request(`/crm/v3/objects/${definition.api}?limit=1&properties=${supported.join(',')}`);
          if (!supported.includes(definition.modified)) throw new NativeMonitorCoverageError('Required modified timestamp field is unavailable.');
          readable.set(objectType, supported); unavailable.delete(objectType);
          capabilities.push({ objectType, status: missingFields.length ? 'partial' : 'available', fields: supported, missingFields,
            detail: `${missingFields.length ? `Missing fields: ${missingFields.join(', ')}. ` : ''}${definition.api} native reads; no association history. ${objectType === 'Contact' ? 'Company ID is the native primary-company property when available.' : 'Company/contact relationships use bounded native association reads; missing or truncated responses are explicit record coverage gaps.'}` });
        } catch (error) {
          if (!(error instanceof NativeMonitorCoverageError) && !(error instanceof NativeMonitorHttpError && [403, 404].includes(error.status))) throw error;
          unavailable.add(objectType);
          capabilities.push({ objectType, status: 'unavailable', fields: [], missingFields: [...definition.fields],
            detail: error instanceof Error ? error.message : 'Native coverage could not be verified.' });
        }
      }
      return capabilities;
    },
    list: async (after) => { const result = await page(after); await relationships(result.contacts); return result; },
    changes: async (from, through, after) => { const result = await page(after, from, through); await relationships(result.contacts); return result; },
    async read(id, objectType = 'Contact') {
      const type = nativeType(objectType);
      if (!/^\d+$/.test(id)) throw new Error('Invalid HubSpot monitor record ID.');
      const record = parseContact(await request(`/crm/v3/objects/${definitions[type].api}/${encodeURIComponent(id)}?properties=${fields(type).join(',')}`), type);
      if (record.id !== id) throw new Error('HubSpot returned a different monitor record.');
      await relationships([record]);
      return record;
    },
    async patch(id, properties, objectType = 'Contact') {
      const entries = Object.entries(properties);
      if (objectType !== 'Contact' || !/^\d+$/.test(id) || !entries.length || entries.some(([key, value]) => !['company', 'jobtitle'].includes(key) || !value || value !== value.trim())) {
        throw new Error('Monitor repairs are limited to nonempty, trimmed Contact company and job title values.');
      }
      await request(`/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
    },
  };
}

function parsePage(value: unknown, objectType: ObjectType, limit: number): MonitorPage {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length > limit) throw new Error('HubSpot returned an invalid monitor page.');
  if (value.paging !== undefined && !isRecord(value.paging)) throw new Error('HubSpot returned invalid monitor paging.');
  const paging = isRecord(value.paging) ? value.paging : null;
  if (paging?.next !== undefined && !isRecord(paging.next)) throw new Error('HubSpot returned invalid monitor paging.');
  const next = paging && isRecord(paging.next) ? paging.next : null;
  const after = next?.after;
  if (next && (!['string', 'number'].includes(typeof after) || !String(after).trim())) throw new Error('HubSpot returned an invalid monitor cursor.');
  if (next && value.results.length === 0) throw new Error('HubSpot returned a continuation cursor without any records.');
  const total = value.total;
  if (total !== undefined && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)) throw new Error('HubSpot returned an invalid monitor result count.');
  return { contacts: value.results.map((row) => parseContact(row, objectType)), after: after === undefined ? null : String(after), ...(typeof total === 'number' ? { total } : {}) };
}
function parseContact(value: unknown, objectType: ObjectType): MonitorContact {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^\d+$/.test(value.id) || !isRecord(value.properties)
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || value.archived === true) {
    throw new Error('HubSpot returned an invalid or archived monitor record.');
  }
  const properties: Record<string, string> = {};
  for (const key of definitions[objectType].fields) {
    if (!(key in value.properties)) continue; // Missing means unobserved, not blank.
    const field = value.properties[key];
    if (field !== null && typeof field !== 'string') throw new Error('HubSpot returned an invalid record property.');
    properties[key] = typeof field === 'string' ? field : '';
  }
  const alias = (target: string, native: string) => { if (native in properties) properties[target] = properties[native]; };
  alias('owner_id', 'hubspot_owner_id');
  if (objectType === 'Contact') { if ('firstname' in properties || 'lastname' in properties) properties.name = [properties.firstname, properties.lastname].filter(Boolean).join(' '); alias('company_id', 'associatedcompanyid'); }
  if (objectType === 'Deal') { alias('name', 'dealname'); alias('stage', 'dealstage'); alias('close_date', 'closedate'); }
  return { provider: 'hubspot', objectType, id: value.id, updatedAt: new Date(value.updatedAt).toISOString(), properties };
}
function nativeType(value: MonitorObjectType): ObjectType {
  if (!objectTypes.includes(value as ObjectType)) throw new Error('Unsupported HubSpot monitor object type.');
  return value as ObjectType;
}
function parseCursor(after: string | null): { objectType: ObjectType; cursor: string | null } {
  if (!after) return { objectType: 'Contact', cursor: null };
  if (!after.includes(':')) return { objectType: 'Contact', cursor: after }; // Preserve existing saved Contact cursors.
  const [type, ...parts] = after.split(':');
  const cursor = parts.join(':');
  if (!objectTypes.includes(type as ObjectType) || !cursor || cursor.includes(':')) throw new Error('Invalid HubSpot monitor cursor.');
  return { objectType: type as ObjectType, cursor: cursor === 'start' ? null : cursor };
}
function encodeCursor(type: ObjectType, cursor: string | null): string { return type === 'Contact' && cursor ? cursor : `${type}:${cursor ?? 'start'}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
