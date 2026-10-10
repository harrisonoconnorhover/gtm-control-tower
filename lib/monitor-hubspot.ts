import type { MonitorContact, MonitorObjectType, MonitorProvider } from './monitor-types';

export const MONITOR_PROPERTIES = [
  'email', 'firstname', 'lastname', 'company', 'jobtitle',
  'hubspot_owner_id', 'lifecyclestage', 'lastmodifieddate',
] as const;

export type MonitorPage = { contacts: MonitorContact[]; after: string | null; total?: number };
export type MonitorSource = {
  provider?: MonitorProvider;
  accountId?: string;
  list: (after: string | null) => Promise<MonitorPage>;
  changes: (from: string, through: string, after: string | null) => Promise<MonitorPage>;
  read: (id: string, objectType?: MonitorObjectType) => Promise<MonitorContact>;
  patch: (id: string, properties: Record<string, string>, objectType?: MonitorObjectType) => Promise<void>;
};

/** Only this narrow adapter can write. It never creates, merges, or deletes records. */
export function hubspotMonitorSource(token: string): MonitorSource {
  if (!token.trim()) throw new Error('A HubSpot access token is required.');
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`https://api.hubapi.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    // Provider response bodies can contain contact data; reports use bounded status text.
    if (!response.ok) throw new Error(`HubSpot monitor request failed (HTTP ${response.status}).`);
    return response.status === 204 ? null : response.json();
  }
  return {
    provider: 'hubspot',
    async list(after) {
      const query = new URLSearchParams({ limit: '50', archived: 'false', properties: MONITOR_PROPERTIES.join(',') });
      if (after) query.set('after', after);
      return parsePage(await request(`/crm/v3/objects/contacts?${query}`));
    },
    async changes(from, through, after) {
      const page = parsePage(await request('/crm/v3/objects/contacts/search', {
        method: 'POST',
        body: JSON.stringify({
          limit: 50, properties: MONITOR_PROPERTIES,
          sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
          filterGroups: [{ filters: [
            { propertyName: 'lastmodifieddate', operator: 'GTE', value: String(Date.parse(from)) },
            { propertyName: 'lastmodifieddate', operator: 'LTE', value: String(Date.parse(through)) },
            ...(after ? [{ propertyName: 'hs_object_id', operator: 'GT', value: after }] : []),
          ] }],
        }),
      }));
      // Offset paging can skip records when our own repairs remove earlier rows
      // from this time window. Resume by immutable object ID instead.
      return { ...page, after: page.after === null ? null : page.contacts.at(-1)?.id ?? null };
    },
    async read(id) {
      return parseContact(await request(`/crm/v3/objects/contacts/${encodeURIComponent(id)}?properties=${MONITOR_PROPERTIES.join(',')}`));
    },
    async patch(id, properties) {
      const entries = Object.entries(properties);
      if (!entries.length || entries.some(([key, value]) => !['company', 'jobtitle'].includes(key) || !value || value !== value.trim())) {
        throw new Error('Monitor repairs are limited to nonempty, trimmed company and job title values.');
      }
      await request(`/crm/v3/objects/contacts/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify({ properties }),
      });
    },
  };
}

function parsePage(value: unknown): MonitorPage {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length > 50) throw new Error('HubSpot returned an invalid monitor page.');
  if (value.paging !== undefined && !isRecord(value.paging)) throw new Error('HubSpot returned invalid monitor paging.');
  const paging = isRecord(value.paging) ? value.paging : null;
  if (paging?.next !== undefined && !isRecord(paging.next)) throw new Error('HubSpot returned invalid monitor paging.');
  const next = paging && isRecord(paging.next) ? paging.next : null;
  const after = next?.after;
  if (next && (!['string', 'number'].includes(typeof after) || !String(after).trim())) throw new Error('HubSpot returned an invalid monitor cursor.');
  if (next && value.results.length === 0) throw new Error('HubSpot returned a continuation cursor without any contacts.');
  const total = value.total;
  if (total !== undefined && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0)) throw new Error('HubSpot returned an invalid monitor result count.');
  return { contacts: value.results.map(parseContact), after: after === undefined ? null : String(after), ...(typeof total === 'number' ? { total } : {}) };
}

function parseContact(value: unknown): MonitorContact {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || !isRecord(value.properties)
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || value.archived === true) {
    throw new Error('HubSpot returned an invalid or archived monitor contact.');
  }
  const properties: Record<string, string> = {};
  for (const key of MONITOR_PROPERTIES) {
    const field = value.properties[key];
    if (field !== null && field !== undefined && typeof field !== 'string') throw new Error('HubSpot returned an invalid contact property.');
    properties[key] = typeof field === 'string' ? field : '';
  }
  return { provider: 'hubspot', objectType: 'Contact', id: value.id, updatedAt: value.updatedAt, properties };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
