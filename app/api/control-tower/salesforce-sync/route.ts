import { NextResponse } from 'next/server';
import { readSalesforceExisting } from '../../../../lib/crm-existing-salesforce';
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
  const existing = await readSalesforceExisting(batch.leads, apiRoot, headers);
  const recordsByContact = new Map<string, SalesforceSyncRecord>();
  const creates: SalesforceSyncLead[] = [];
  const updates: Array<{ lead: SalesforceSyncLead; id: string }> = [];
  const importedEmailCounts = new Map<string, number>();
  for (const lead of batch.leads) {
    const email = lead.email.trim().toLowerCase();
    importedEmailCounts.set(email, (importedEmailCounts.get(email) ?? 0) + 1);
  }

  for (const lead of batch.leads) {
    const email = lead.email.trim().toLowerCase();
    const matches = existing.get(email) ?? [];
    let holdReason: string | null = null;
    if ((importedEmailCounts.get(email) ?? 0) > 1) {
      holdReason = 'Held: Multiple imported rows use this email and would target the same Salesforce identity.';
    } else if (matches.length > 1) {
      holdReason = `Held: Salesforce already has ${matches.length} Leads or Contacts with this email.`;
    } else if (matches[0]?.objectType === 'contact') {
      holdReason = 'Held: Salesforce already has a Contact with this email; this workflow only writes Leads.';
    } else if (matches[0] && matches[0].isConverted !== false) {
      holdReason = 'Held: Salesforce already has a converted Lead with this email.';
    }
    if (holdReason) {
      recordsByContact.set(lead.contactId, {
        contactId: lead.contactId,
        email: lead.email,
        status: 'failed',
        salesforceId: null,
        error: holdReason,
      });
    } else if (matches.length === 1) {
      updates.push({ lead, id: matches[0].nativeId });
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

async function writeLeadCollection(
  method: 'POST' | 'PATCH',
  records: Array<Record<string, unknown>>,
  apiRoot: string,
  headers: Record<string, string>,
): Promise<unknown[]> {
  const response = await fetch(`${apiRoot}/composite/sobjects`, {
    method,
    cache: 'no-store',
    headers: { ...headers, 'Sforce-Duplicate-Rule-Header': 'allowSave=false' },
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
