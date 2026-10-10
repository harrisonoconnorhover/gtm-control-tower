import type { MonitorPage, MonitorSource } from './monitor-hubspot';
import type { MonitorCapability, MonitorContact, MonitorObjectType } from './monitor-types';

const definitions = {
  Lead: { prefix: '00Q', fields: ['Id', 'Email', 'FirstName', 'LastName', 'Title', 'OwnerId', 'SystemModstamp', 'Company', 'IsConverted', 'Status'] },
  Contact: { prefix: '003', fields: ['Id', 'Email', 'FirstName', 'LastName', 'Title', 'OwnerId', 'SystemModstamp', 'AccountId'] },
  Account: { prefix: '001', fields: ['Id', 'Name', 'Website', 'OwnerId', 'SystemModstamp'] },
  Opportunity: { prefix: '006', fields: ['Id', 'Name', 'StageName', 'Amount', 'CloseDate', 'OwnerId', 'SystemModstamp', 'AccountId', 'IsClosed', 'IsWon'] },
} as const;
type ObjectType = keyof typeof definitions;
const objectTypes: ObjectType[] = ['Lead', 'Contact', 'Account', 'Opportunity'];
const fieldNames: Record<string, string> = { email: 'Email', firstname: 'FirstName', lastname: 'LastName', jobtitle: 'Title', owner_id: 'OwnerId',
  name: 'Name', domain: 'Website', stage: 'StageName', amount: 'Amount', close_date: 'CloseDate', company_id: 'AccountId', account_id: 'AccountId', is_closed: 'IsClosed', is_won: 'IsWon' };
type Cursor = { objectType: ObjectType; id: string | null };

class NativeMonitorHttpError extends Error {
  constructor(readonly status: number) { super('Salesforce monitor request failed (HTTP ' + status + ').'); }
}
class NativeMonitorCoverageError extends Error {}

/** Poll stable record IDs in a frozen SystemModstamp window. Never follow server-supplied URLs. */
export function salesforceMonitorSource(apiRoot: string, headers: Record<string, string>, accountId: string): MonitorSource {
  const root = new URL(apiRoot);
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash
    || !/^\/services\/data\/v\d+\.\d+$/.test(root.pathname) || !/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId)) {
    throw new Error('Salesforce Monitor requires a verified organization and HTTPS instance API root.');
  }
  const requestHeaders = { ...headers, 'content-type': 'application/json' };
  const unavailable = new Set<ObjectType>();
  const readable = new Map<ObjectType, string[]>();
  const fields = (type: ObjectType) => (readable.get(type) ?? [...definitions[type].fields]).join(',');
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${root.href}${path}`, {
      ...init, headers: { ...requestHeaders, ...(init.method === 'PATCH' ? { 'Sforce-Auto-Assign': 'FALSE' } : {}) }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || response.status === 207) throw new NativeMonitorHttpError(response.status);
    if (init.method === 'PATCH' && response.status !== 204) throw new Error(`Salesforce returned an unexpected repair response (${response.status}). Verify the outcome without resending.`);
    return response.status === 204 ? null : response.json();
  }
  async function page(after: string | null, from?: string, through?: string): Promise<MonitorPage> {
    let cursor = parseCursor(after);
    const contacts: MonitorContact[] = [];
    for (let index = objectTypes.indexOf(cursor.objectType); index < objectTypes.length; index++) {
      const objectType = objectTypes[index];
      if (unavailable.has(objectType)) { cursor = { objectType, id: null }; continue; }
      const limit = 50 - contacts.length;
      const conditions = [objectType === 'Lead' ? 'IsConverted = false' : 'IsDeleted = false'];
      if (cursor.objectType === objectType && cursor.id) conditions.push(`Id > '${cursor.id}'`);
      if (from !== undefined && through !== undefined) conditions.push(`SystemModstamp >= ${isoDate(from)}`, `SystemModstamp <= ${isoDate(through)}`);
      const query = `SELECT ${fields(objectType)} FROM ${objectType} WHERE ${conditions.join(' AND ')} ORDER BY Id ASC LIMIT ${limit}`;
      const payload = await request(`/query?q=${encodeURIComponent(query)}`);
      if (!isRecord(payload) || !Array.isArray(payload.records) || payload.records.length > limit || payload.done !== true || payload.nextRecordsUrl != null) {
        throw new Error('Salesforce returned an invalid bounded monitor page.');
      }
      let previousId = cursor.objectType === objectType ? cursor.id : null;
      for (const value of payload.records) {
        const record = parseContact(value, objectType);
        if (previousId && record.id <= previousId) throw new Error('Salesforce returned unordered or repeated monitor records.');
        if (from && through && (Date.parse(record.updatedAt) < Date.parse(from) || Date.parse(record.updatedAt) > Date.parse(through))) {
          throw new Error('Salesforce returned a record outside the requested change window.');
        }
        previousId = record.id; contacts.push(record);
      }
      // LIMIT queries don't say whether a further keyset page exists. An extra empty read is safe.
      if (payload.records.length === limit) return { contacts, after: `${objectType}:${previousId}` };
      cursor = { objectType, id: null };
    }
    return { contacts, after: null };
  }
  async function relationships(records: MonitorContact[]): Promise<MonitorContact[]> {
    const selected = records.filter((record) => record.objectType === 'Opportunity');
    if (!selected.length) return records;
    try {
      const query = `SELECT OpportunityId,ContactId FROM OpportunityContactRole WHERE OpportunityId IN (${selected.map((record) => `'${record.id}'`).join(',')}) ORDER BY Id ASC LIMIT 2000`;
      const response = await request(`/query?q=${encodeURIComponent(query)}`);
      if (!isRecord(response) || !Array.isArray(response.records) || response.done !== true || response.nextRecordsUrl || response.records.length >= 2000) throw new Error('Contact roles were truncated.');
      const byOpportunity = new Map(selected.map((record) => [record.id, new Set<string>()]));
      for (const role of response.records) {
        if (!isRecord(role) || typeof role.OpportunityId !== 'string' || typeof role.ContactId !== 'string' || !byOpportunity.has(role.OpportunityId)) throw new Error('Invalid contact role.');
        assertRecordId(role.ContactId, 'Contact');
        byOpportunity.get(role.OpportunityId)!.add(role.ContactId);
      }
      for (const record of selected) record.properties.contact_ids = JSON.stringify([...byOpportunity.get(record.id)!].sort());
    } catch {
      for (const record of selected) record.coverage = [...record.coverage ?? [], 'contact_ids: native contact roles unavailable or truncated; no relationship conclusion is possible.'];
    }
    return records;
  }
  return {
    provider: 'salesforce', accountId,
    async capabilities() {
      const capabilities: MonitorCapability[] = [];
      for (const objectType of objectTypes) {
        try {
          const metadata = await request(`/sobjects/${objectType}/describe`);
          if (!isRecord(metadata) || typeof metadata.queryable !== 'boolean' || !Array.isArray(metadata.fields)) throw new Error('Invalid Salesforce object metadata.');
          if (!metadata.queryable) throw new NativeMonitorCoverageError('Object is not queryable with the connected permissions.');
          const names = new Set(metadata.fields.filter(isRecord).map((field) => field.name));
          const supported = definitions[objectType].fields.filter((field) => names.has(field));
          const required = objectType === 'Lead' ? ['Id', 'SystemModstamp', 'IsConverted'] : ['Id', 'SystemModstamp'];
          if (required.some((field) => !supported.includes(field as never))) throw new NativeMonitorCoverageError('Required identity or polling fields are unavailable.');
          readable.set(objectType, supported); unavailable.delete(objectType);
          const missingFields = definitions[objectType].fields.filter((field) => !names.has(field));
          capabilities.push({ objectType, status: missingFields.length ? 'partial' : 'available', fields: supported, missingFields,
            detail: `${missingFields.length ? `Missing fields: ${missingFields.join(', ')}. ` : ''}${objectType} native reads. ${objectType === 'Lead' ? 'Converted Leads excluded; Status has no inferred ordering.' : objectType === 'Opportunity' ? 'StageName has no inferred ordering. AccountId is native; contact roles use a bounded native query with explicit coverage gaps when unavailable or truncated.' : objectType === 'Account' ? 'Website supplies the domain observation; Account records are read-only.' : 'AccountId supplies the native company relationship.'}` });
        } catch (error) {
          if (!(error instanceof NativeMonitorCoverageError) && !(error instanceof NativeMonitorHttpError && [403, 404].includes(error.status))) throw error;
          unavailable.add(objectType);
          capabilities.push({ objectType, status: 'unavailable', fields: [], missingFields: [...definitions[objectType].fields], detail: error instanceof Error ? error.message : 'Native coverage could not be verified.' });
        }
      }
      return capabilities;
    },
    list: async (after) => { const result = await page(after); await relationships(result.contacts); return result; },
    changes: async (from, through, after) => { const result = await page(after, from, through); await relationships(result.contacts); return result; },
    async read(id, objectType) {
      assertRecordId(id, objectType);
      const type = objectType as ObjectType;
      const record = parseContact(await request(`/sobjects/${type}/${id}?fields=${fields(type)}`), type);
      if (record.id !== id) throw new Error('Salesforce returned a different record than requested.');
      await relationships([record]);
      return record;
    },
    async patch(id, properties, objectType) {
      assertRecordId(id, objectType);
      const entries = Object.entries(properties);
      const allowed = objectType === 'Lead' ? ['company', 'jobtitle'] : objectType === 'Contact' ? ['jobtitle'] : [];
      if (!entries.length || entries.some(([key, value]) => !allowed.includes(key) || !value || value !== value.trim())) {
        throw new Error('Salesforce repairs are limited to nonempty trimmed Lead Company/Title or Contact Title.');
      }
      const body = Object.fromEntries(entries.map(([key, value]) => [key === 'company' ? 'Company' : 'Title', value]));
      await request(`/sobjects/${objectType}/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
  };
}
function parseContact(value: unknown, objectType: ObjectType): MonitorContact {
  if (!isRecord(value) || typeof value.Id !== 'string') throw new Error('Salesforce returned an invalid monitor record.');
  assertRecordId(value.Id, objectType);
  if (!isRecord(value.attributes) || value.attributes.type !== objectType || value.IsDeleted === true
    || typeof value.SystemModstamp !== 'string' || !Number.isFinite(Date.parse(value.SystemModstamp))
    || (objectType === 'Lead' && value.IsConverted !== false)) {
    throw new Error('Salesforce returned a mismatched, converted, deleted, or invalid monitor record.');
  }
  const properties: Record<string, string> = {};
  for (const [key, field] of Object.entries(fieldNames)) {
    if (!(field in value)) continue; // Permissions/selection absence is not an observed clear.
    properties[key] = property(value[field]);
  }
  if (objectType === 'Lead') {
    if ('Company' in value) properties.company = property(value.Company);
    if ('Status' in value) properties.status = property(value.Status);
    properties.is_converted = 'false';
  }
  if ((objectType === 'Lead' || objectType === 'Contact') && ('firstname' in properties || 'lastname' in properties)) properties.name = [properties.firstname, properties.lastname].filter(Boolean).join(' ');
  return { id: value.Id, provider: 'salesforce', objectType, updatedAt: new Date(value.SystemModstamp).toISOString(), properties };
}
function assertRecordId(id: string, objectType: MonitorObjectType | undefined): void {
  const prefix = objectType && objectType in definitions ? definitions[objectType as ObjectType].prefix : null;
  if (!prefix || !new RegExp(`^${prefix}[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$`).test(id)) throw new Error('Salesforce Monitor requires an explicit object type and matching native record ID.');
}
function parseCursor(after: string | null): Cursor {
  if (after === null) return { objectType: 'Lead', id: null };
  const match = /^(Lead|Contact|Account|Opportunity):([A-Za-z0-9]+)$/.exec(after);
  if (!match) throw new Error('Invalid Salesforce monitor cursor.');
  const objectType = match[1] as ObjectType;
  assertRecordId(match[2], objectType);
  return { objectType, id: match[2] };
}
function isoDate(value: string): string { if (!Number.isFinite(Date.parse(value))) throw new Error('Invalid Salesforce change window.'); return new Date(value).toISOString(); }
function property(value: unknown): string {
  if (value === null) return '';
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value);
  throw new Error('Salesforce returned an invalid monitor field.');
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
