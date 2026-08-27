import { NextResponse } from 'next/server';
import {
  isHubSpotSyncBatch,
  isHubSpotSyncReceipt,
  type HubSpotSyncBatch,
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
  const inputs = batch.contacts.map((contact) => ({
    id: contact.email,
    idProperty: 'email',
    objectWriteTraceId: `${batch.syncId}:${contact.contactId}`,
    properties: compactProperties({
      firstname: contact.firstName,
      lastname: contact.lastName,
      company: contact.company,
      phone: contact.phone,
      jobtitle: contact.jobTitle,
      website: contact.website,
    }),
  }));
  const response = await fetch('https://api.hubapi.com/crm/objects/2026-03/contacts/batch/upsert', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ inputs }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload: unknown = await response.json();
  if (!response.ok && response.status !== 207) throw new Error(`HubSpot returned ${response.status}`);
  return shapeDirectHubSpotReceipt(batch, payload);
}

function shapeDirectHubSpotReceipt(batch: HubSpotSyncBatch, payload: unknown): HubSpotSyncReceipt {
  const response = isRecord(payload) ? payload : {};
  const results = Array.isArray(response.results) ? response.results.filter(isRecord) : [];
  const errors = Array.isArray(response.errors) ? response.errors.filter(isRecord) : [];
  const resultByTrace = new Map(results.map((result) => [String(result.objectWriteTraceId ?? ''), result]));
  const errorByTrace = new Map(errors.map((error) => {
    const context = isRecord(error.context) ? error.context : {};
    const contextTrace = context.objectWriteTraceId;
    const traceId = Array.isArray(contextTrace) ? String(contextTrace[0] ?? '') : String(contextTrace ?? '');
    return [traceId, error];
  }));
  const records = batch.contacts.map((contact, index) => {
    const traceId = `${batch.syncId}:${contact.contactId}`;
    const result = resultByTrace.get(traceId) ?? (results.length === batch.contacts.length ? results[index] : null);
    if (result) {
      return {
        contactId: contact.contactId,
        email: contact.email,
        status: 'synced' as const,
        hubSpotId: String(result.id ?? ''),
        created: typeof result.new === 'boolean' ? result.new : null,
        error: null,
      };
    }
    const error = errorByTrace.get(traceId);
    return {
      contactId: contact.contactId,
      email: contact.email,
      status: 'failed' as const,
      hubSpotId: null,
      created: null,
      error: String(error?.message ?? 'HubSpot did not return a result for this record.').slice(0, 1000),
    };
  });
  const synced = records.filter((record) => record.status === 'synced').length;
  return {
    accepted: true,
    status: synced === records.length ? 'complete' : 'partial',
    syncId: batch.syncId,
    requested: records.length,
    synced,
    failed: records.length - synced,
    records,
    completedAt: typeof response.completedAt === 'string' ? response.completedAt : new Date().toISOString(),
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
