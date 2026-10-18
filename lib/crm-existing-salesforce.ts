import { readCrmJson } from './crm-read-transport';
import type { NativeCrmRecord, PortableCrmContact } from './crm-workflow';

const MAX_QUERY_PAGES = 10;
const LEAD_FIELDS = 'Id, Email, IsConverted, FirstName, LastName, Company, Phone, Title, Website';
const CONTACT_FIELDS = 'Id, Email, FirstName, LastName, Phone, Title';

export function isSalesforcePersonId(nativeId: string, objectType: NativeCrmRecord['objectType']): boolean {
  if (objectType !== 'lead' && objectType !== 'contact') return false;
  return (objectType === 'lead' ? /^00Q(?:[A-Za-z0-9]{12}|[A-Za-z0-9]{15})$/ : /^003(?:[A-Za-z0-9]{12}|[A-Za-z0-9]{15})$/).test(nativeId);
}

/** Read the selected Lead again, including conversion status, before planning an update. */
export async function readSalesforceLeadById(
  nativeId: string,
  apiRoot: string,
  headers: Record<string, string>,
): Promise<NativeCrmRecord | null> {
  return readSalesforceRecordById(nativeId, 'lead', apiRoot, headers);
}

/** Object-qualified native reads keep Contact and Lead evidence separate. */
export async function readSalesforceRecordById(
  nativeId: string, objectType: NativeCrmRecord['objectType'], apiRoot: string, headers: Record<string, string>,
): Promise<NativeCrmRecord | null> {
  if (!isSalesforcePersonId(nativeId, objectType)) {
    throw new Error('Salesforce lookup requires a 15- or 18-character record ID');
  }
  const root = validatedApiRoot(apiRoot);
  const objectName = objectType === 'lead' ? 'Lead' : 'Contact';
  const query = new URLSearchParams({ fields: (objectType === 'lead' ? LEAD_FIELDS : CONTACT_FIELDS).replaceAll(' ', '') });
  const { response, payload: value } = await readCrmJson(`${root.href}/sobjects/${objectName}/${nativeId}?${query}`, { headers },
    { provider: 'salesforce', accessToken: new Headers(headers).get('authorization')?.replace(/^Bearer\s+/i, '') ?? '', origin: root.origin });
  if (response.status === 404) return null;
  if (!response.ok || response.status === 207) throw new Error(`Salesforce lookup returned ${response.status}`);
  const record = toNativeRecord(value, objectType, true);
  if (record.nativeId !== nativeId) throw new Error('Salesforce lookup returned an unrequested record ID');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(record.email)) {
    throw new Error('Salesforce lookup returned a malformed email');
  }
  return record;
}

/** Read exact-email matches completely before a caller decides whether a write is safe. */
export async function readSalesforceExisting(
  contacts: PortableCrmContact[],
  apiRoot: string,
  headers: Record<string, string>,
  includeContactFields = false,
): Promise<Map<string, NativeCrmRecord[]>> {
  const emails = new Set(contacts.map((contact) => contact.email.trim().toLowerCase()));
  const matches = new Map<string, NativeCrmRecord[]>();
  if (emails.size === 0) return matches;
  if (emails.has('')) throw new Error('Salesforce lookup requires nonempty emails');

  const root = validatedApiRoot(apiRoot);
  const quotedEmails = [...emails].map((email) => `'${escapeSoqlString(email)}'`).join(',');
  const seenRecords = new Map<string, NativeCrmRecord>();
  for (const objectType of ['lead', 'contact'] as const) {
    const fields = objectType === 'lead'
      ? LEAD_FIELDS
      : includeContactFields ? CONTACT_FIELDS : 'Id, Email';
    const objectName = objectType === 'lead' ? 'Lead' : 'Contact';
    const query = `SELECT ${fields} FROM ${objectName} WHERE Email IN (${quotedEmails})`;
    let nextUrl = `${root.href}/query?q=${encodeURIComponent(query)}`;
    const visitedUrls = new Set<string>();

    for (let page = 0; page < MAX_QUERY_PAGES; page += 1) {
      if (visitedUrls.has(nextUrl)) throw new Error('Salesforce query repeated a pagination cursor');
      visitedUrls.add(nextUrl);
      const { response, payload } = await readCrmJson(nextUrl, { headers },
        { provider: 'salesforce', accessToken: new Headers(headers).get('authorization')?.replace(/^Bearer\s+/i, '') ?? '', origin: root.origin });
      if (!response.ok || response.status === 207) throw new Error(`Salesforce query returned ${response.status}`);
      if (!isRecord(payload) || !Array.isArray(payload.records) || typeof payload.done !== 'boolean') {
        throw new Error('Salesforce query returned malformed records or pagination metadata');
      }
      for (const value of payload.records) {
        const record = toNativeRecord(value, objectType, includeContactFields);
        if (includeContactFields && !isSalesforcePersonId(record.nativeId, objectType)) throw new Error('Salesforce returned an invalid native object identity');
        if (!emails.has(record.email)) throw new Error('Salesforce query returned an unrequested email');
        const identity = `${record.objectType}:${record.nativeId}`;
        const previous = seenRecords.get(identity);
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(record)) {
            throw new Error('Salesforce query returned contradictory evidence for one record');
          }
          continue;
        }
        seenRecords.set(identity, record);
        matches.set(record.email, [...(matches.get(record.email) ?? []), record]);
      }
      if (payload.done) {
        if (payload.nextRecordsUrl !== undefined && payload.nextRecordsUrl !== null) {
          throw new Error('Salesforce completed query unexpectedly returned a pagination cursor');
        }
        break;
      }
      nextUrl = validatedCursor(payload.nextRecordsUrl, root);
      if (page === MAX_QUERY_PAGES - 1) {
        throw new Error('Salesforce query exceeded the bounded pagination limit');
      }
    }
  }
  return matches;
}

function validatedApiRoot(apiRoot: string): URL {
  const root = new URL(apiRoot);
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash
    || !/^\/services\/data\/v\d+\.\d+$/.test(root.pathname)) {
    throw new Error('Salesforce lookup requires an instance API root');
  }
  return root;
}

function toNativeRecord(value: unknown, objectType: 'lead' | 'contact', includeContactFields = false): NativeCrmRecord {
  if (!isRecord(value) || typeof value.Id !== 'string' || !value.Id.trim()
    || typeof value.Email !== 'string' || !value.Email.trim()) {
    throw new Error('Salesforce query returned a malformed record identity');
  }
  if (objectType === 'contact' && !includeContactFields) {
    return {
      nativeId: value.Id,
      objectType,
      email: value.Email.trim().toLowerCase(),
      fields: { firstName: null, lastName: null, company: null, phone: null, jobTitle: null, website: null },
    };
  }
  if (objectType === 'lead' && typeof value.IsConverted !== 'boolean') {
    throw new Error('Salesforce query returned a Lead without a conversion status');
  }
  return {
    nativeId: value.Id,
    objectType,
    ...(objectType === 'lead' ? { isConverted: value.IsConverted as boolean } : {}),
    email: value.Email.trim().toLowerCase(),
    fields: {
      firstName: nullableString(value.FirstName),
      lastName: nullableString(value.LastName),
      // Contact company/website live on Account; Safe Import never updates Account.
      company: objectType === 'lead' ? nullableString(value.Company) : null,
      phone: nullableString(value.Phone),
      jobTitle: nullableString(value.Title),
      website: objectType === 'lead' ? nullableString(value.Website) : null,
    },
  };
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Salesforce query returned a malformed portable field');
  return value.trim() || null;
}

function validatedCursor(value: unknown, root: URL): string {
  if (typeof value !== 'string' || !value) throw new Error('Salesforce query omitted its pagination cursor');
  const cursor = new URL(value, root.origin);
  const pathPrefix = `${root.pathname}/query/`;
  if (cursor.origin !== root.origin || cursor.username || cursor.password || cursor.search || cursor.hash
    || !cursor.pathname.startsWith(pathPrefix)
    || !/^[A-Za-z0-9_-]+$/.test(cursor.pathname.slice(pathPrefix.length))) {
    throw new Error('Salesforce query returned an invalid pagination cursor');
  }
  return cursor.href;
}

function escapeSoqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
