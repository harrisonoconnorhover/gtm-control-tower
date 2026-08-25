import { NextResponse } from 'next/server';
import {
  isSalesforceSyncBatch,
  isSalesforceSyncReceipt,
  type SalesforceSyncBatch,
  type SalesforceSyncLead,
  type SalesforceSyncReceipt,
  type SalesforceSyncRecord,
} from '../../../../lib/salesforce-sync';

const DEFAULT_API_VERSION = '67.0';

export async function POST(request: Request) {
  const instanceUrl = normalizeInstanceUrl(process.env.SALESFORCE_INSTANCE_URL);
  const accessToken = process.env.SALESFORCE_ACCESS_TOKEN;
  const requiredKey = process.env.CONTROL_TOWER_SYNC_KEY;

  if (!instanceUrl || !accessToken) {
    return NextResponse.json(
      { error: 'Salesforce sync is not configured.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (process.env.NODE_ENV === 'production' && !requiredKey) {
    return NextResponse.json(
      { error: 'Salesforce sync requires CONTROL_TOWER_SYNC_KEY in production.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (requiredKey && !safeEqual(request.headers.get('x-control-tower-key') ?? '', requiredKey)) {
    return NextResponse.json({ error: 'The sync access key is invalid.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'A JSON body is required.' }, { status: 400 });
  }
  if (!isSalesforceSyncBatch(body)) {
    return NextResponse.json(
      { error: 'The Salesforce batch is invalid or exceeds 100 leads.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const receipt = await syncDirectlyToSalesforce(
      body,
      instanceUrl,
      accessToken,
      process.env.SALESFORCE_API_VERSION ?? DEFAULT_API_VERSION,
    );
    if (!isSalesforceSyncReceipt(receipt)) throw new Error('The connector returned an invalid Salesforce receipt');
    return NextResponse.json(receipt, {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('Control Tower Salesforce sync failed', error);
    return NextResponse.json(
      { error: 'Salesforce did not return a valid sync receipt.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

export async function syncDirectlyToSalesforce(
  batch: SalesforceSyncBatch,
  instanceUrl: string,
  accessToken: string,
  apiVersion: string,
): Promise<SalesforceSyncReceipt> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const apiRoot = `${instanceUrl}/services/data/v${apiVersion}`;
  const existing = await findExistingLeads(batch.leads, apiRoot, headers);
  const recordsByContact = new Map<string, SalesforceSyncRecord>();
  const creates: SalesforceSyncLead[] = [];
  const updates: Array<{ lead: SalesforceSyncLead; id: string }> = [];

  for (const lead of batch.leads) {
    const matches = existing.get(lead.email.toLowerCase()) ?? [];
    if (matches.length > 1) {
      recordsByContact.set(lead.contactId, {
        contactId: lead.contactId,
        email: lead.email,
        status: 'failed',
        salesforceId: null,
        error: `Held: Salesforce already has ${matches.length} active Leads with this email.`,
      });
    } else if (matches.length === 1) {
      updates.push({ lead, id: matches[0] });
    } else {
      creates.push(lead);
    }
  }

  if (creates.length) {
    const results = await writeLeadCollection('POST', creates.map(toCreateRecord), apiRoot, headers);
    creates.forEach((lead, index) => recordsByContact.set(
      lead.contactId,
      toReceiptRecord(lead, results[index], 'created'),
    ));
  }
  if (updates.length) {
    const results = await writeLeadCollection('PATCH', updates.map(({ lead, id }) => toUpdateRecord(lead, id)), apiRoot, headers);
    updates.forEach(({ lead, id }, index) => recordsByContact.set(
      lead.contactId,
      toReceiptRecord(lead, results[index], 'updated', id),
    ));
  }

  const records = batch.leads.map((lead) => recordsByContact.get(lead.contactId) ?? ({
    contactId: lead.contactId,
    email: lead.email,
    status: 'failed' as const,
    salesforceId: null,
    error: 'Salesforce did not return a result for this record.',
  }));
  const created = records.filter((record) => record.status === 'created').length;
  const updated = records.filter((record) => record.status === 'updated').length;
  const failed = records.length - created - updated;
  return {
    accepted: true,
    status: failed ? 'partial' : 'complete',
    syncId: batch.syncId,
    requested: records.length,
    created,
    updated,
    failed,
    records,
    completedAt: new Date().toISOString(),
  };
}

async function findExistingLeads(
  leads: SalesforceSyncLead[],
  apiRoot: string,
  headers: Record<string, string>,
): Promise<Map<string, string[]>> {
  const quotedEmails = leads.map((lead) => `'${escapeSoqlString(lead.email)}'`).join(',');
  const query = `SELECT Id, Email FROM Lead WHERE IsConverted = FALSE AND Email IN (${quotedEmails})`;
  let nextUrl: string | null = `${apiRoot}/query?q=${encodeURIComponent(query)}`;
  const matches = new Map<string, string[]>();
  let pages = 0;

  while (nextUrl && pages < 10) {
    const response = await fetch(nextUrl.startsWith('http') ? nextUrl : `${new URL(apiRoot).origin}${nextUrl}`, {
      cache: 'no-store',
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const payload: unknown = await response.json();
    if (!response.ok || !isRecord(payload)) throw new Error(`Salesforce query returned ${response.status}`);
    const records = Array.isArray(payload.records) ? payload.records.filter(isRecord) : [];
    for (const record of records) {
      const email = typeof record.Email === 'string' ? record.Email.toLowerCase() : '';
      const id = typeof record.Id === 'string' ? record.Id : '';
      if (!email || !id) continue;
      matches.set(email, [...(matches.get(email) ?? []), id]);
    }
    nextUrl = payload.done === false && typeof payload.nextRecordsUrl === 'string' ? payload.nextRecordsUrl : null;
    pages += 1;
  }
  if (nextUrl) throw new Error('Salesforce query exceeded the bounded pagination limit');
  return matches;
}

async function writeLeadCollection(
  method: 'POST' | 'PATCH',
  records: Array<Record<string, unknown>>,
  apiRoot: string,
  headers: Record<string, string>,
): Promise<unknown[]> {
  const response = await fetch(`${apiRoot}/composite/sobjects`, {
    method,
    cache: 'no-store',
    headers,
    body: JSON.stringify({ allOrNone: false, records }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload: unknown = await response.json();
  if (!response.ok || !Array.isArray(payload)) throw new Error(`Salesforce collection write returned ${response.status}`);
  return payload;
}

function toCreateRecord(lead: SalesforceSyncLead): Record<string, unknown> {
  return { attributes: { type: 'Lead' }, ...toLeadFields(lead) };
}

function toUpdateRecord(lead: SalesforceSyncLead, id: string): Record<string, unknown> {
  return { attributes: { type: 'Lead' }, Id: id, ...toLeadFields(lead) };
}

function toLeadFields(lead: SalesforceSyncLead): Record<string, string> {
  return Object.fromEntries(Object.entries({
    Email: lead.email,
    FirstName: lead.firstName,
    LastName: lead.lastName,
    Company: lead.company,
    Phone: lead.phone,
    Title: lead.jobTitle,
    Website: lead.website,
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
}

function toReceiptRecord(
  lead: SalesforceSyncLead,
  result: unknown,
  successStatus: 'created' | 'updated',
  fallbackId: string | null = null,
): SalesforceSyncRecord {
  const value = isRecord(result) ? result : {};
  if (value.success === true) {
    return {
      contactId: lead.contactId,
      email: lead.email,
      status: successStatus,
      salesforceId: typeof value.id === 'string' ? value.id : fallbackId,
      error: null,
    };
  }
  const errors = Array.isArray(value.errors) ? value.errors.filter(isRecord) : [];
  const message = errors.map((error) => String(error.message ?? '')).filter(Boolean).join('; ');
  return {
    contactId: lead.contactId,
    email: lead.email,
    status: 'failed',
    salesforceId: fallbackId,
    error: (message || 'Salesforce rejected this record.').slice(0, 1000),
  };
}

function escapeSoqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function normalizeInstanceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const maximumLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximumLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
