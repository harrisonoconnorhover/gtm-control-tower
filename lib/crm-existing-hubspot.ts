import type { NativeCrmRecord, PortableCrmContact } from './crm-workflow';

const CONTACTS_URL = 'https://api.hubapi.com/crm/objects/2026-03/contacts';
const PROPERTIES = ['email', 'hs_additional_emails', 'firstname', 'lastname', 'company', 'phone', 'jobtitle', 'website'];

/** Read the current record behind a human-confirmed identity without changing its email. */
export async function readHubSpotRecordById(nativeId: string, accessToken: string): Promise<NativeCrmRecord | null> {
  if (!/^\d+$/.test(nativeId)) throw new Error('HubSpot lookup requires a numeric contact ID.');
  const query = new URLSearchParams({ properties: PROPERTIES.join(',') });
  const response = await fetch(`${CONTACTS_URL}/${nativeId}?${query}`, {
    cache: 'no-store', redirect: 'manual',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok || response.status === 207) {
    throw new Error(`HubSpot could not confirm contact identity (${response.status}).`);
  }
  const value: unknown = await response.json();
  if (!isRecord(value) || value.id !== nativeId) {
    throw new Error('HubSpot lookup returned an unrequested contact ID.');
  }
  if (value.archived !== undefined && typeof value.archived !== 'boolean') {
    throw new Error('HubSpot lookup returned a malformed archive status.');
  }
  if (value.archived === true) return null;
  return parseContact(value).record;
}

export async function readHubSpotExisting(
  contacts: PortableCrmContact[],
  accessToken: string,
): Promise<Map<string, NativeCrmRecord[]>> {
  const emails = new Set(contacts.map((contact) => contact.email.trim().toLowerCase()));
  const matches = new Map<string, NativeCrmRecord[]>();
  if (!emails.size) return matches;
  const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json' };
  const response = await fetch(`${CONTACTS_URL}/batch/read`, {
    method: 'POST', cache: 'no-store', headers, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ idProperty: 'email', properties: PROPERTIES, inputs: [...emails].map((id) => ({ id })) }),
  });
  const payload: unknown = await response.json();
  if (!response.ok || !isRecord(payload) || payload.status !== 'COMPLETE' || !Array.isArray(payload.results)) {
    throw new Error(`HubSpot lookup returned an incomplete or invalid response (${response.status}).`);
  }
  // A batch not-found error is only a reason to check individually, never proof of absence.
  const errors = payload.errors ?? [];
  if (!Array.isArray(errors) || errors.some((error) => !isRecord(error) || error.category !== 'OBJECT_NOT_FOUND')
    || (payload.numErrors !== undefined && (typeof payload.numErrors !== 'number' || !Number.isInteger(payload.numErrors)
      || payload.numErrors < 0 || (payload.numErrors > 0 && !errors.length)))) {
    throw new Error('HubSpot lookup returned errors that do not establish contact identity.');
  }
  for (const result of payload.results) addMatchingRecord(result, emails, matches);

  for (const email of emails) {
    if (matches.get(email)?.length) continue;
    const query = new URLSearchParams({ idProperty: 'email', properties: PROPERTIES.join(',') });
    const individual = await fetch(`${CONTACTS_URL}/${encodeURIComponent(email)}?${query}`, {
      cache: 'no-store', headers, signal: AbortSignal.timeout(30_000),
    });
    if (individual.status === 404) {
      matches.set(email, []);
      continue;
    }
    if (!individual.ok || individual.status === 207) {
      throw new Error(`HubSpot could not confirm contact identity (${individual.status}).`);
    }
    const result: unknown = await individual.json();
    addMatchingRecord(result, emails, matches, email);
  }
  return matches;
}

function addMatchingRecord(
  value: unknown,
  submitted: Set<string>,
  matches: Map<string, NativeCrmRecord[]>,
  requiredEmail?: string,
) {
  const { record, identities } = parseContact(value);
  const keys = [...identities].filter((email) => submitted.has(email));
  if (!keys.length || (requiredEmail && !identities.has(requiredEmail))) {
    throw new Error('HubSpot lookup returned a contact that does not match the requested email.');
  }
  for (const key of keys) {
    const existing = matches.get(key) ?? [];
    if (!existing.some((entry) => entry.nativeId === record.nativeId)) matches.set(key, [...existing, record]);
  }
}

function parseContact(value: unknown): { record: NativeCrmRecord; identities: Set<string> } {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()
    || value.archived === true || !isRecord(value.properties)) {
    throw new Error('HubSpot lookup returned a malformed contact.');
  }
  const properties = value.properties;
  const primary = emailValue(properties.email);
  const aliases = properties.hs_additional_emails;
  if (!primary || (aliases !== undefined && aliases !== null && typeof aliases !== 'string')) {
    throw new Error('HubSpot lookup returned malformed email properties.');
  }
  const identities = new Set([primary]);
  for (const alias of typeof aliases === 'string' ? aliases.split(';').filter((entry) => entry.trim()) : []) {
    const identity = emailValue(alias);
    if (!identity) throw new Error('HubSpot lookup returned a malformed additional email.');
    identities.add(identity);
  }
  const record: NativeCrmRecord = {
    nativeId: value.id, objectType: 'contact', email: primary,
    fields: {
      firstName: fieldValue(properties.firstname), lastName: fieldValue(properties.lastname),
      company: fieldValue(properties.company), phone: fieldValue(properties.phone),
      jobTitle: fieldValue(properties.jobtitle), website: fieldValue(properties.website),
    },
  };
  return { record, identities };
}

function emailValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email) ? email : null;
}

function fieldValue(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('HubSpot lookup returned a malformed contact property.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
