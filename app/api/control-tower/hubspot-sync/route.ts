import { NextResponse } from 'next/server';
import { readHubSpotExisting } from '@/lib/crm-existing-hubspot';
import {
  isHubSpotSyncBatch,
  isHubSpotSyncReceipt,
  type HubSpotSyncBatch,
  type HubSpotSyncContact,
  type HubSpotSyncRecord,
  type HubSpotSyncReceipt,
} from '@/lib/hubspot-sync';

const LOCAL_HUBSPOT_SYNC_URL = 'http://localhost:5678/webhook/gtm-control-tower-hubspot-sync';

export async function POST(request: Request) {
  const webhookUrl = process.env.N8N_HUBSPOT_SYNC_WEBHOOK_URL
    ?? (process.env.NODE_ENV === 'development' ? LOCAL_HUBSPOT_SYNC_URL : null);
  const directAccessToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const requiredKey = process.env.CONTROL_TOWER_SYNC_KEY;

  if (!webhookUrl && !directAccessToken) {
    return NextResponse.json(
      { error: 'HubSpot sync is not configured.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (process.env.NODE_ENV === 'production' && !requiredKey) {
    return NextResponse.json(
      { error: 'HubSpot sync requires CONTROL_TOWER_SYNC_KEY in production.' },
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
  if (!isHubSpotSyncBatch(body)) {
    return NextResponse.json(
      { error: 'The HubSpot batch is invalid or exceeds 100 contacts.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const receipt: unknown = directAccessToken
      ? await syncDirectlyToHubSpot(body, directAccessToken)
      : await syncThroughN8n(body, webhookUrl as string);
    if (!isHubSpotSyncReceipt(receipt)) throw new Error('The connector returned an invalid HubSpot receipt');

    return NextResponse.json(receipt, {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('Control Tower HubSpot sync failed', error);
    return NextResponse.json(
      { error: 'HubSpot did not return a valid sync receipt.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

async function syncThroughN8n(batch: HubSpotSyncBatch, webhookUrl: string): Promise<unknown> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`n8n returned ${response.status}`);
  return response.json();
}

export async function syncDirectlyToHubSpot(
  batch: HubSpotSyncBatch,
  accessToken: string,
): Promise<HubSpotSyncReceipt> {
  if (!isHubSpotSyncBatch(batch)) throw new Error('The HubSpot batch contains invalid or duplicate contact identities.');
  const existing = await readHubSpotExisting(batch.contacts, accessToken);
  const targetCounts = new Map<string, number>();
  for (const contact of batch.contacts) {
    for (const match of existing.get(contact.email.toLowerCase()) ?? []) {
      targetCounts.set(match.nativeId, (targetCounts.get(match.nativeId) ?? 0) + 1);
    }
  }
  const creates: HubSpotSyncContact[] = [];
  const updates: HubSpotSyncContact[] = [];
  const nativeIds = new Map<string, string>();
  const records = new Map<string, HubSpotSyncRecord>();
  for (const contact of batch.contacts) {
    const matches = existing.get(contact.email.toLowerCase()) ?? [];
    if (matches.length > 1 || matches.some((match) => (targetCounts.get(match.nativeId) ?? 0) > 1)) {
      records.set(contact.contactId, failedRecord(contact, 'Held: multiple input rows or CRM records share this HubSpot identity.'));
    } else if (matches.length === 1) {
      updates.push(contact);
      nativeIds.set(contact.contactId, matches[0].nativeId);
    } else {
      creates.push(contact);
    }
  }
  if (updates.length) {
    const receipt = await writeHubSpotBatch({ ...batch, contacts: updates }, accessToken, 'update', nativeIds);
    for (const record of receipt.records) records.set(record.contactId, record);
  }
  if (creates.length) {
    const receipt = await createHubSpotContacts({ ...batch, contacts: creates }, accessToken);
    for (const record of receipt.records) records.set(record.contactId, record);
  }
  return receiptFromRecords(batch, batch.contacts.map((contact) => records.get(contact.contactId)!));
}

export async function createHubSpotContacts(batch: HubSpotSyncBatch, accessToken: string): Promise<HubSpotSyncReceipt> {
  if (!isHubSpotSyncBatch(batch)) throw new Error('The HubSpot batch contains invalid or duplicate contact identities.');
  // A conflicting identity must fail creation, never turn an approved create into an update.
  return writeHubSpotBatch(batch, accessToken, 'create');
}

async function writeHubSpotBatch(
  batch: HubSpotSyncBatch,
  accessToken: string,
  operation: 'create' | 'update',
  nativeIds = new Map<string, string>(),
): Promise<HubSpotSyncReceipt> {
  const response = await fetch(`https://api.hubapi.com/crm/objects/2026-03/contacts/batch/${operation}`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ inputs: batch.contacts.map((contact) => ({
      ...(operation === 'update' ? { id: nativeIds.get(contact.contactId) } : {}),
      objectWriteTraceId: `${batch.syncId}:${contact.contactId}`,
      properties: compactProperties({
        ...(operation === 'create' ? { email: contact.email } : {}),
        firstname: contact.firstName, lastname: contact.lastName, company: contact.company,
        phone: contact.phone, jobtitle: contact.jobTitle, website: contact.website,
      }),
    })) }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.message === 'string' ? payload.message : `HubSpot returned ${response.status}.`;
    return receiptFromRecords(batch, batch.contacts.map((contact) => failedRecord(contact, message)));
  }
  return shapeDirectHubSpotReceipt(batch, payload, operation, nativeIds);
}

function shapeDirectHubSpotReceipt(
  batch: HubSpotSyncBatch,
  payload: unknown,
  operation: 'create' | 'update',
  nativeIds: Map<string, string>,
): HubSpotSyncReceipt {
  const response = isRecord(payload) ? payload : {};
  const results = Array.isArray(response.results) ? response.results.filter(isRecord) : [];
  const errors = Array.isArray(response.errors) ? response.errors.filter(isRecord) : [];
  const resultByTrace = new Map(results.map((result) => [String(result.objectWriteTraceId ?? ''), result]));
  const errorByTrace = new Map(errors.flatMap((error) => {
    const context = isRecord(error.context) ? error.context : {};
    const contextTrace = context.objectWriteTraceId;
    const traces = Array.isArray(contextTrace) ? contextTrace : [contextTrace];
    return traces.map((trace) => [String(trace ?? ''), error] as const);
  }));
  const records = batch.contacts.map((contact) => {
    const traceId = `${batch.syncId}:${contact.contactId}`;
    const candidates = results.filter((result) => operation === 'update'
      ? result.id === nativeIds.get(contact.contactId)
      : isRecord(result.properties) && typeof result.properties.email === 'string'
        && result.properties.email.toLowerCase() === contact.email.toLowerCase());
    const result = resultByTrace.get(traceId) ?? (candidates.length === 1 ? candidates[0] : null);
    if (result && typeof result.id === 'string' && result.id.trim()
      && (operation === 'create' || result.id === nativeIds.get(contact.contactId))) {
      return {
        contactId: contact.contactId,
        email: contact.email,
        status: 'synced' as const,
        hubSpotId: result.id,
        created: operation === 'create',
        error: null,
      };
    }
    const error = errorByTrace.get(traceId);
    return failedRecord(contact, String(error?.message ?? 'HubSpot did not return a confirmed result for this record.'));
  });
  return receiptFromRecords(batch, records, typeof response.completedAt === 'string' ? response.completedAt : undefined);
}

function failedRecord(contact: HubSpotSyncContact, message: string): HubSpotSyncRecord {
  return { contactId: contact.contactId, email: contact.email, status: 'failed', hubSpotId: null, created: null, error: message.slice(0, 1000) };
}

function receiptFromRecords(batch: HubSpotSyncBatch, records: HubSpotSyncRecord[], completedAt = new Date().toISOString()): HubSpotSyncReceipt {
  const synced = records.filter((record) => record.status === 'synced').length;
  return {
    accepted: true,
    status: synced === records.length ? 'complete' : 'partial',
    syncId: batch.syncId,
    requested: records.length,
    synced,
    failed: records.length - synced,
    records,
    completedAt,
  };
}

function compactProperties(properties: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(properties).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
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
