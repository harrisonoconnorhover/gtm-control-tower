import type { NativeCrmRecord, PortableCrmContact } from './crm-workflow';

const MAX_QUERY_PAGES = 10;

/** Read exact-email matches completely before a caller decides whether a write is safe. */
export async function readSalesforceExisting(
  contacts: PortableCrmContact[],
  apiRoot: string,
  headers: Record<string, string>,
): Promise<Map<string, NativeCrmRecord[]>> {
  const emails = new Set(contacts.map((contact) => contact.email.trim().toLowerCase()));
  const matches = new Map<string, NativeCrmRecord[]>();
  if (emails.size === 0) return matches;
  if (emails.has('')) throw new Error('Salesforce lookup requires nonempty emails');

  const root = new URL(apiRoot);
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash
    || !/^\/services\/data\/v\d+\.\d+$/.test(root.pathname)) {
    throw new Error('Salesforce lookup requires an instance API root');
  }
  const quotedEmails = [...emails].map((email) => `'${escapeSoqlString(email)}'`).join(',');
  const seenRecords = new Map<string, NativeCrmRecord>();
  for (const objectType of ['lead', 'contact'] as const) {
    const fields = objectType === 'lead'
      ? 'Id, Email, IsConverted, FirstName, LastName, Company, Phone, Title, Website'
      : 'Id, Email';
    const objectName = objectType === 'lead' ? 'Lead' : 'Contact';
    const query = `SELECT ${fields} FROM ${objectName} WHERE Email IN (${quotedEmails})`;
    let nextUrl = `${root.href}/query?q=${encodeURIComponent(query)}`;
    const visitedUrls = new Set<string>();

    for (let page = 0; page < MAX_QUERY_PAGES; page += 1) {
      if (visitedUrls.has(nextUrl)) throw new Error('Salesforce query repeated a pagination cursor');
      visitedUrls.add(nextUrl);
      const response = await fetch(nextUrl, {
        cache: 'no-store',
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Salesforce query returned ${response.status}`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.records) || typeof payload.done !== 'boolean') {
        throw new Error('Salesforce query returned malformed records or pagination metadata');
      }
      for (const value of payload.records) {
        const record = toNativeRecord(value, objectType);
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

function toNativeRecord(value: unknown, objectType: 'lead' | 'contact'): NativeCrmRecord {
  if (!isRecord(value) || typeof value.Id !== 'string' || !value.Id.trim()
    || typeof value.Email !== 'string' || !value.Email.trim()) {
    throw new Error('Salesforce query returned a malformed record identity');
  }
  if (objectType === 'contact') {
    return {
      nativeId: value.Id,
      objectType,
      email: value.Email.trim().toLowerCase(),
      fields: { firstName: null, lastName: null, company: null, phone: null, jobTitle: null, website: null },
    };
  }
  if (typeof value.IsConverted !== 'boolean') {
    throw new Error('Salesforce query returned a Lead without a conversion status');
  }
  return {
    nativeId: value.Id,
    objectType,
    isConverted: value.IsConverted,
    email: value.Email.trim().toLowerCase(),
    fields: {
      firstName: nullableString(value.FirstName),
      lastName: nullableString(value.LastName),
      company: nullableString(value.Company),
      phone: nullableString(value.Phone),
      jobTitle: nullableString(value.Title),
      website: nullableString(value.Website),
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
