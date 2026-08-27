import {
  readHubSpotContacts,
  readHubSpotContactsThroughN8n,
  readSalesforceLeads,
  toCrmSourcePreview,
} from '@/lib/crm-source';

const DEFAULT_API_VERSION = '67.0';

export async function POST(request: Request) {
  let payload: unknown;
  try { payload = await request.json(); } catch { return Response.json({ error: 'A JSON body is required.' }, { status: 400 }); }
  if (!isRecord(payload) || (payload.connectorId !== 'hubspot' && payload.connectorId !== 'salesforce')) {
    return Response.json({ error: 'Choose HubSpot or Salesforce.' }, { status: 400 });
  }
  const requestedLimit = Number(payload.limit ?? 100);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, Math.floor(requestedLimit))) : 100;
  try {
    if (payload.connectorId === 'hubspot') {
      const token = process.env.HUBSPOT_ACCESS_TOKEN;
      const webhook = process.env.N8N_HUBSPOT_SOURCE_WEBHOOK_URL;
      if (!token && !webhook) return Response.json({ error: 'HubSpot source import is not configured.' }, { status: 503 });
      const effectiveLimit = token ? limit : Math.min(limit, 100);
      const contacts = token
        ? await readHubSpotContacts(token, effectiveLimit)
        : await readHubSpotContactsThroughN8n(webhook as string, effectiveLimit);
      return Response.json(toCrmSourcePreview('hubspot', 'HubSpot contacts', contacts, effectiveLimit), { headers: { 'Cache-Control': 'no-store' } });
    }
    const instance = normalizeInstanceUrl(process.env.SALESFORCE_INSTANCE_URL);
    const token = process.env.SALESFORCE_ACCESS_TOKEN;
    if (!instance || !token) return Response.json({ error: 'Salesforce source import is not configured.' }, { status: 503 });
    const contacts = await readSalesforceLeads(instance, token, process.env.SALESFORCE_API_VERSION ?? DEFAULT_API_VERSION, limit);
    return Response.json(toCrmSourcePreview('salesforce', 'Salesforce active Leads', contacts, limit), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('CRM source preview failed', error);
    return Response.json({ error: error instanceof Error ? error.message : 'CRM source preview failed.' }, { status: 502 });
  }
}

function normalizeInstanceUrl(value: string | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.origin : null; } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
