import type { IdentityRecord } from './identity-resolution';

export type CrmSourceContact = {
  nativeId: string;
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  phone: string;
  jobTitle: string;
  website: string;
};

export type HubSpotScanCursor = { after: string | null };
export type SalesforceScanCursor = { objectType: 'lead' | 'contact'; nextRecordsUrl: string | null };
export type CrmScanPage<TCursor> = {
  records: IdentityRecord[];
  nextCursor: TCursor | null;
  complete: boolean;
};

export type CrmSourcePreview = {
  connectorId: 'hubspot' | 'salesforce';
  sourceLabel: string;
  contacts: CrmSourceContact[];
  csv: string;
  truncated: boolean;
  readAt: string;
};

const properties = ['email', 'hs_additional_emails', 'firstname', 'lastname', 'company', 'phone', 'mobilephone', 'jobtitle', 'website', 'state'];

export async function readHubSpotIdentityPage(
  accessToken: string,
  cursor: HubSpotScanCursor = { after: null },
): Promise<CrmScanPage<HubSpotScanCursor>> {
  const url = new URL('https://api.hubapi.com/crm/objects/2026-03/contacts');
  url.searchParams.set('limit', '100');
  url.searchParams.set('properties', properties.join(','));
  if (cursor.after) url.searchParams.set('after', cursor.after);
  const { response, payload } = await fetchJsonWithRetry(url, { headers: hubSpotHeaders(accessToken) });
  if (!response.ok) throw new Error(`HubSpot source returned ${response.status}`);
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error('HubSpot source returned malformed records');
  let after: string | null = null;
  if (payload.paging !== undefined) {
    if (!isRecord(payload.paging)) throw new Error('HubSpot source returned malformed pagination');
    if (payload.paging.next !== undefined) {
      const next = payload.paging.next;
      if (!isRecord(next) || typeof next.after !== 'string' || !next.after.trim()) {
        throw new Error('HubSpot source omitted its pagination cursor');
      }
      after = next.after;
      if (after === cursor.after) throw new Error('HubSpot source repeated its pagination cursor');
    }
  }
  return {
    records: payload.results.map(toHubSpotIdentityRecord),
    nextCursor: after ? { after } : null,
    complete: !after,
  };
}

export async function readSalesforceIdentityPage(
  instanceUrl: string,
  accessToken: string,
  apiVersion: string,
  cursor: SalesforceScanCursor = { objectType: 'lead', nextRecordsUrl: null },
): Promise<CrmScanPage<SalesforceScanCursor>> {
  const apiRoot = `${instanceUrl}/services/data/v${apiVersion}`;
  const query = cursor.objectType === 'lead'
    ? 'SELECT Id, FirstName, LastName, Email, Company, Phone, MobilePhone, Title, Website, State, CreatedDate, LastModifiedDate FROM Lead WHERE IsConverted = FALSE ORDER BY Id'
    : 'SELECT Id, FirstName, LastName, Email, Phone, MobilePhone, Title, MailingState, CreatedDate, LastModifiedDate, Account.Name, Account.Website FROM Contact ORDER BY Id';
  const url = cursor.nextRecordsUrl
    ? salesforceCursorUrl(cursor.nextRecordsUrl, apiRoot)
    : new URL(`${apiRoot}/query?q=${encodeURIComponent(query)}`);
  const { response, payload } = await fetchJsonWithRetry(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'sforce-query-options': 'batchSize=200',
    },
  });
  if (!response.ok) throw new Error(`Salesforce ${cursor.objectType} source returned ${response.status}`);
  if (!isRecord(payload) || !Array.isArray(payload.records) || typeof payload.done !== 'boolean') {
    throw new Error('Salesforce source returned malformed records or pagination');
  }
  const records = payload.records.map((record) => toSalesforceIdentityRecord(cursor.objectType, record));
  if (!payload.done) {
    const nextUrl = salesforceCursorUrl(payload.nextRecordsUrl, apiRoot);
    if (nextUrl.href === url.href) throw new Error('Salesforce source repeated its pagination cursor');
    return { records, nextCursor: { objectType: cursor.objectType, nextRecordsUrl: nextUrl.pathname }, complete: false };
  }
  if (payload.nextRecordsUrl !== undefined && payload.nextRecordsUrl !== null) {
    throw new Error('Salesforce completed source unexpectedly returned a pagination cursor');
  }
  if (cursor.objectType === 'lead') return { records, nextCursor: { objectType: 'contact', nextRecordsUrl: null }, complete: false };
  return { records, nextCursor: null, complete: true };
}

export async function readHubSpotContacts(accessToken: string, limit: number): Promise<CrmSourceContact[]> {
  const contacts: CrmSourceContact[] = [];
  let cursor: HubSpotScanCursor | null = { after: null };
  while (contacts.length < limit) {
    if (!cursor) break;
    const page = await readHubSpotIdentityPage(accessToken, cursor);
    contacts.push(...page.records.map(identityToSourceContact));
    cursor = page.nextCursor;
    if (page.complete || !page.records.length) break;
  }
  return contacts.slice(0, limit);
}

export async function readHubSpotContactsThroughN8n(webhookUrl: string, limit: number): Promise<CrmSourceContact[]> {
  const response = await fetch(webhookUrl, {
    method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ action: 'preview', limit }), signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* validated below */ }
  if (!response.ok || !isRecord(payload) || !Array.isArray(payload.contacts)) {
    throw new Error(`n8n HubSpot source returned ${response.status} without a valid contact preview. Verify the workflow execution and crm.objects.contacts.read scope.`);
  }
  return payload.contacts.filter(isCrmSourceContact).slice(0, limit);
}

export async function readSalesforceLeads(
  instanceUrl: string,
  accessToken: string,
  apiVersion: string,
  limit: number,
): Promise<CrmSourceContact[]> {
  const query = `SELECT Id, FirstName, LastName, Email, Company, Phone, Title, Website FROM Lead WHERE IsConverted = FALSE ORDER BY LastModifiedDate DESC LIMIT ${limit}`;
  const response = await fetch(`${instanceUrl}/services/data/v${apiVersion}/query?q=${encodeURIComponent(query)}`, {
    cache: 'no-store', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
  });
  const payload: unknown = await response.json();
  if (!response.ok || !isRecord(payload) || !Array.isArray(payload.records)) throw new Error(`Salesforce source returned ${response.status}`);
  return payload.records.filter(isRecord).flatMap((record): CrmSourceContact[] => {
    const nativeId = stringValue(record.Id);
    if (!nativeId) return [];
    const firstName = stringValue(record.FirstName);
    const lastName = stringValue(record.LastName);
    return [{
      nativeId, firstName, lastName, fullName: [firstName, lastName].filter(Boolean).join(' '),
      email: stringValue(record.Email), company: stringValue(record.Company), phone: stringValue(record.Phone),
      jobTitle: stringValue(record.Title), website: stringValue(record.Website),
    }];
  });
}

export function toCrmSourcePreview(
  connectorId: CrmSourcePreview['connectorId'],
  sourceLabel: string,
  contacts: CrmSourceContact[],
  requestedLimit: number,
): CrmSourcePreview {
  return {
    connectorId, sourceLabel, contacts, csv: sourceContactsToCsv(connectorId, contacts),
    truncated: contacts.length >= requestedLimit, readAt: new Date().toISOString(),
  };
}

export function sourceContactsToCsv(connectorId: string, contacts: CrmSourceContact[]): string {
  const headers = ['record_id', 'contact_name', 'first_name', 'last_name', 'email_address', 'account_name', 'mobile', 'title', 'company_website', 'record_status', 'issues'];
  const rows = contacts.map((contact) => [
    `${connectorId}:${contact.nativeId}`, contact.fullName, contact.firstName, contact.lastName, contact.email,
    contact.company, contact.phone, contact.jobTitle, contact.website, 'active', '',
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

export function isCrmSourceContact(value: unknown): value is CrmSourceContact {
  if (!isRecord(value)) return false;
  return ['nativeId', 'fullName', 'firstName', 'lastName', 'email', 'company', 'phone', 'jobTitle', 'website']
    .every((key) => typeof value[key] === 'string');
}

function toHubSpotIdentityRecord(value: unknown): IdentityRecord {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || !isRecord(value.properties)) {
    throw new Error('HubSpot source returned a malformed contact identity or properties');
  }
  const nativeId = value.id;
  const props = value.properties;
  if (props.hs_additional_emails !== undefined && props.hs_additional_emails !== null
    && typeof props.hs_additional_emails !== 'string') {
    throw new Error('HubSpot source returned malformed additional emails');
  }
  const firstName = stringValue(props.firstname);
  const lastName = stringValue(props.lastname);
  return {
    recordKey: `hubspot:contact:${nativeId}`,
    connectorId: 'hubspot',
    objectType: 'contact',
    nativeId,
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    email: stringValue(props.email),
    additionalEmails: [...new Set(stringValue(props.hs_additional_emails).split(';').map((email) => email.trim()).filter(Boolean))],
    state: stringValue(props.state),
    company: stringValue(props.company),
    phone: stringValue(props.phone) || stringValue(props.mobilephone),
    secondaryPhone: stringValue(props.phone) ? stringValue(props.mobilephone) : '',
    jobTitle: stringValue(props.jobtitle),
    website: stringValue(props.website),
    createdAt: nullableDate(value.createdAt),
    updatedAt: nullableDate(value.updatedAt),
  };
}

function toSalesforceIdentityRecord(objectType: SalesforceScanCursor['objectType'], value: unknown): IdentityRecord {
  if (!isRecord(value) || typeof value.Id !== 'string' || !value.Id.trim()) {
    throw new Error('Salesforce source returned a malformed record identity');
  }
  const nativeId = value.Id;
  const firstName = stringValue(value.FirstName);
  const lastName = stringValue(value.LastName);
  const account = isRecord(value.Account) ? value.Account : {};
  return {
    recordKey: `salesforce:${objectType}:${nativeId}`,
    connectorId: 'salesforce',
    objectType,
    nativeId,
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    email: stringValue(value.Email),
    state: objectType === 'lead' ? stringValue(value.State) : stringValue(value.MailingState),
    company: objectType === 'lead' ? stringValue(value.Company) : stringValue(account.Name),
    phone: stringValue(value.Phone) || stringValue(value.MobilePhone),
    secondaryPhone: stringValue(value.Phone) ? stringValue(value.MobilePhone) : '',
    jobTitle: stringValue(value.Title),
    website: objectType === 'lead' ? stringValue(value.Website) : stringValue(account.Website),
    createdAt: nullableDate(value.CreatedDate),
    updatedAt: nullableDate(value.LastModifiedDate),
  };
}

function salesforceCursorUrl(value: unknown, apiRoot: string): URL {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Salesforce source omitted its pagination cursor');
  const root = new URL(apiRoot);
  const cursor = new URL(value, root.origin);
  const prefix = `${root.pathname}/query/`;
  if (cursor.origin !== root.origin || cursor.username || cursor.password || cursor.search || cursor.hash
    || !cursor.pathname.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(cursor.pathname.slice(prefix.length))) {
    throw new Error('Salesforce source returned an invalid pagination cursor');
  }
  return cursor;
}

function identityToSourceContact(record: IdentityRecord): CrmSourceContact {
  return {
    nativeId: record.nativeId,
    firstName: record.firstName,
    lastName: record.lastName,
    fullName: record.fullName,
    email: record.email,
    company: record.company,
    phone: record.phone,
    jobTitle: record.jobTitle,
    website: record.website,
  };
}

function hubSpotHeaders(accessToken: string) {
  return { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
}

async function fetchJsonWithRetry(url: URL, init: RequestInit): Promise<{ response: Response; payload: unknown }> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { ...init, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    lastResponse = response;
    const payload: unknown = await response.json().catch(() => null);
    if (response.status !== 429 && response.status < 500) return { response, payload };
    if (attempt === 3) return { response, payload };
    const retryAfter = Number(response.headers.get('retry-after') ?? 0);
    const delay = retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 250 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`CRM source returned ${lastResponse?.status ?? 'no response'}`);
}

function nullableDate(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
