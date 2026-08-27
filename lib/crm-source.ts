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

export type CrmSourcePreview = {
  connectorId: 'hubspot' | 'salesforce';
  sourceLabel: string;
  contacts: CrmSourceContact[];
  csv: string;
  truncated: boolean;
  readAt: string;
};

const properties = ['email', 'firstname', 'lastname', 'company', 'phone', 'jobtitle', 'website'];

export async function readHubSpotContacts(accessToken: string, limit: number): Promise<CrmSourceContact[]> {
  const contacts: CrmSourceContact[] = [];
  let after: string | null = null;
  while (contacts.length < limit) {
    const pageLimit = Math.min(100, limit - contacts.length);
    const url = new URL('https://api.hubapi.com/crm/objects/2026-03/contacts');
    url.searchParams.set('limit', String(pageLimit));
    url.searchParams.set('properties', properties.join(','));
    if (after) url.searchParams.set('after', after);
    const response = await fetch(url, { cache: 'no-store', headers: hubSpotHeaders(accessToken), signal: AbortSignal.timeout(30_000) });
    const payload: unknown = await response.json();
    if (!response.ok || !isRecord(payload)) throw new Error(`HubSpot source returned ${response.status}`);
    const results = Array.isArray(payload.results) ? payload.results.filter(isRecord) : [];
    contacts.push(...results.flatMap(toHubSpotSourceContact));
    const paging = isRecord(payload.paging) && isRecord(payload.paging.next) ? payload.paging.next : null;
    after = paging && typeof paging.after === 'string' ? paging.after : null;
    if (!after || !results.length) break;
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

function toHubSpotSourceContact(value: Record<string, unknown>): CrmSourceContact[] {
  const nativeId = stringValue(value.id);
  const props = isRecord(value.properties) ? value.properties : {};
  if (!nativeId) return [];
  const firstName = stringValue(props.firstname);
  const lastName = stringValue(props.lastname);
  return [{
    nativeId, firstName, lastName, fullName: [firstName, lastName].filter(Boolean).join(' '),
    email: stringValue(props.email), company: stringValue(props.company), phone: stringValue(props.phone),
    jobTitle: stringValue(props.jobtitle), website: stringValue(props.website),
  }];
}

function hubSpotHeaders(accessToken: string) {
  return { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
