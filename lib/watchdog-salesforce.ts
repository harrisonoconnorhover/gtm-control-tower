import type { WatchdogPage, WatchdogSource } from './watchdog-hubspot';
import type { WatchdogContact, WatchdogObjectType } from './watchdog-types';

const COMMON_FIELDS = 'Id,Email,FirstName,LastName,Title,OwnerId,SystemModstamp';
const fieldNames = { email: 'Email', firstname: 'FirstName', lastname: 'LastName', jobtitle: 'Title', owner_id: 'OwnerId' };
type Cursor = { objectType: WatchdogObjectType; id: string | null };

/** Poll stable record IDs in a frozen SystemModstamp window. Never follow server-supplied URLs. */
export function salesforceWatchdogSource(apiRoot: string, headers: Record<string, string>, accountId: string): WatchdogSource {
  const root = new URL(apiRoot);
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash
    || !/^\/services\/data\/v\d+\.\d+$/.test(root.pathname) || !/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId)) {
    throw new Error('Salesforce Watchdog requires a verified organization and HTTPS instance API root.');
  }
  // Capture credentials once: a tick cannot silently switch org or token midway through a repair.
  const requestHeaders = { ...headers, 'content-type': 'application/json' };
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${root.href}${path}`, {
      ...init, headers: { ...requestHeaders, ...(init.method === 'PATCH' ? { 'Sforce-Auto-Assign': 'FALSE' } : {}) }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || response.status === 207) throw new Error(`Salesforce watchdog request failed (HTTP ${response.status}).`);
    if (init.method === 'PATCH' && response.status !== 204) throw new Error(`Salesforce returned an unexpected repair response (${response.status}). Verify the outcome without resending.`);
    return response.status === 204 ? null : response.json();
  }
  async function page(after: string | null, from?: string, through?: string): Promise<WatchdogPage> {
    let cursor = parseCursor(after);
    const contacts: WatchdogContact[] = [];
    while (contacts.length < 50) {
      const limit = 50 - contacts.length;
      const conditions = [cursor.objectType === 'Lead' ? 'IsConverted = false' : 'IsDeleted = false'];
      if (cursor.id) conditions.push(`Id > '${escapeSoqlString(cursor.id)}'`);
      if (from !== undefined && through !== undefined) {
        conditions.push(`SystemModstamp >= ${isoDate(from)}`, `SystemModstamp <= ${isoDate(through)}`);
      }
      const fields = `${COMMON_FIELDS},${cursor.objectType === 'Lead' ? 'Company,IsConverted,Status' : 'AccountId'}`;
      const query = `SELECT ${fields} FROM ${cursor.objectType} WHERE ${conditions.join(' AND ')} ORDER BY Id ASC LIMIT ${limit}`;
      const payload = await request(`/query?q=${encodeURIComponent(query)}`);
      if (!isRecord(payload) || !Array.isArray(payload.records) || payload.records.length > limit
        || payload.done !== true || payload.nextRecordsUrl != null) {
        throw new Error('Salesforce returned an invalid bounded watchdog page.');
      }
      let previousId = cursor.id;
      for (const value of payload.records) {
        const record = parseContact(value, cursor.objectType);
        if (previousId && record.id <= previousId) throw new Error('Salesforce returned unordered or repeated watchdog records.');
        if (from && through && (Date.parse(record.updatedAt) < Date.parse(from) || Date.parse(record.updatedAt) > Date.parse(through))) {
          throw new Error('Salesforce returned a record outside the requested change window.');
        }
        previousId = record.id;
        contacts.push(record);
      }
      // LIMIT queries do not say whether a further keyset page exists. An extra empty read is safe.
      if (payload.records.length === limit) return { contacts, after: `${cursor.objectType}:${previousId}` };
      if (cursor.objectType === 'Contact') return { contacts, after: null };
      cursor = { objectType: 'Contact', id: null };
    }
    throw new Error('Salesforce watchdog page did not terminate.');
  }
  return {
    provider: 'salesforce', accountId,
    list: (after) => page(after),
    changes: (from, through, after) => page(after, from, through),
    async read(id, objectType) {
      assertRecordId(id, objectType);
      const fields = `${COMMON_FIELDS},${objectType === 'Lead' ? 'Company,IsConverted,Status' : 'AccountId'}`;
      const record = parseContact(await request(`/sobjects/${objectType}/${id}?fields=${fields}`), objectType!);
      if (record.id !== id) throw new Error('Salesforce returned a different record than requested.');
      return record;
    },
    async patch(id, properties, objectType) {
      assertRecordId(id, objectType);
      const entries = Object.entries(properties);
      const allowed = objectType === 'Lead' ? ['company', 'jobtitle'] : ['jobtitle'];
      if (!entries.length || entries.some(([key, value]) => !allowed.includes(key) || !value || value !== value.trim())) {
        throw new Error('Salesforce repairs are limited to nonempty trimmed Lead Company/Title or Contact Title.');
      }
      // The engine has just re-read this exact object and rejected converted Leads and stale evidence.
      const body = Object.fromEntries(entries.map(([key, value]) => [key === 'company' ? 'Company' : 'Title', value]));
      await request(`/sobjects/${objectType}/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
  };
}

function parseContact(value: unknown, objectType: WatchdogObjectType): WatchdogContact {
  if (!isRecord(value) || typeof value.Id !== 'string') throw new Error('Salesforce returned an invalid watchdog record.');
  assertRecordId(value.Id, objectType);
  if (!isRecord(value.attributes) || value.attributes.type !== objectType || value.IsDeleted === true
    || typeof value.SystemModstamp !== 'string' || !Number.isFinite(Date.parse(value.SystemModstamp))
    || (objectType === 'Lead' && value.IsConverted !== false)) {
    throw new Error('Salesforce returned a mismatched, converted, deleted, or invalid watchdog record.');
  }
  const properties: Record<string, string> = {};
  for (const [key, field] of Object.entries(fieldNames)) properties[key] = property(value[field]);
  if (objectType === 'Lead') {
    properties.company = property(value.Company);
    properties.status = property(value.Status);
    properties.is_converted = 'false';
  } else properties.account_id = property(value.AccountId);
  return { id: value.Id, provider: 'salesforce', objectType, updatedAt: new Date(value.SystemModstamp).toISOString(), properties };
}

function assertRecordId(id: string, objectType: WatchdogObjectType | undefined): void {
  const prefix = objectType === 'Lead' ? '00Q' : objectType === 'Contact' ? '003' : null;
  if (!prefix || !new RegExp(`^${prefix}[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$`).test(id)) {
    throw new Error('Salesforce Watchdog requires an explicit object type and matching native record ID.');
  }
}
function parseCursor(after: string | null): Cursor {
  if (after === null) return { objectType: 'Lead', id: null };
  const match = /^(Lead|Contact):([A-Za-z0-9]+)$/.exec(after);
  if (!match) throw new Error('Invalid Salesforce watchdog cursor.');
  const objectType = match[1] as WatchdogObjectType;
  assertRecordId(match[2], objectType);
  return { objectType, id: match[2] };
}
function isoDate(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error('Invalid Salesforce change window.');
  return new Date(value).toISOString();
}
function property(value: unknown): string {
  if (value === null) return '';
  if (typeof value !== 'string') throw new Error('Salesforce returned an invalid watchdog field.');
  return value;
}
function escapeSoqlString(value: string): string { return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
