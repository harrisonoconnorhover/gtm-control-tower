import { syncDirectlyToHubSpot } from '@/app/api/control-tower/hubspot-sync/route';
import { syncDirectlyToSalesforce } from '@/app/api/control-tower/salesforce-sync/route';
import { readHubSpotContacts, readHubSpotContactsThroughN8n, readSalesforceLeads } from '@/lib/crm-source';
import type { ConnectorHealth } from '@/lib/connector-contract';

const DEFAULT_API_VERSION = '67.0';
const testEmail = 'gtm-control-tower-connection-test@example.com';

export async function POST(request: Request) {
  let payload: unknown;
  try { payload = await request.json(); } catch { return Response.json({ error: 'A JSON body is required.' }, { status: 400 }); }
  if (!isRecord(payload) || (payload.connectorId !== 'hubspot' && payload.connectorId !== 'salesforce') || (payload.action !== 'read' && payload.action !== 'write')) {
    return Response.json({ error: 'Choose a CRM and read or write test.' }, { status: 400 });
  }
  try {
    const result = payload.connectorId === 'hubspot'
      ? await testHubSpot(payload.action)
      : await testSalesforce(payload.action);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const result: ConnectorHealth = {
      connectorId: payload.connectorId, action: payload.action, status: 'failed',
      message: error instanceof Error ? error.message : 'Connection test failed.', checkedAt: new Date().toISOString(),
    };
    return Response.json(result, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

async function testHubSpot(action: 'read' | 'write'): Promise<ConnectorHealth> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  const sourceWebhook = process.env.N8N_HUBSPOT_SOURCE_WEBHOOK_URL;
  if (action === 'read') {
    if (!token && !sourceWebhook) return health('hubspot', action, 'needs_action', 'Add contact read access through a private app or the n8n source workflow.');
    const contacts = token ? await readHubSpotContacts(token, 1) : await readHubSpotContactsThroughN8n(sourceWebhook as string, 1);
    return health('hubspot', action, 'ready', `Read access verified${contacts.length ? ' with a native contact sample' : '; the portal is currently empty'}.`);
  }
  const batch = { syncId: `connection-test-${Date.now()}`, sourceFile: 'connection-test', contacts: [{ contactId: 'connection-test', email: testEmail, firstName: 'GTM', lastName: 'Control Tower Test', company: 'Example Company', phone: null, jobTitle: 'Connection Test', website: 'https://example.com' }] };
  const receipt = token
    ? await syncDirectlyToHubSpot(batch, token)
    : await syncHubSpotThroughN8n(batch);
  if (receipt.failed) throw new Error(receipt.records[0]?.error ?? 'HubSpot rejected the test contact.');
  return { ...health('hubspot', action, 'ready', 'Write access verified with one idempotent synthetic contact.'), nativeReceiptId: receipt.syncId };
}

async function testSalesforce(action: 'read' | 'write'): Promise<ConnectorHealth> {
  const instance = instanceUrl();
  const token = process.env.SALESFORCE_ACCESS_TOKEN;
  if (!instance || !token) return health('salesforce', action, 'needs_action', 'Run the Salesforce connection helper to add a current local session.');
  const apiVersion = process.env.SALESFORCE_API_VERSION ?? DEFAULT_API_VERSION;
  if (action === 'read') {
    const leads = await readSalesforceLeads(instance, token, apiVersion, 1);
    return health('salesforce', action, 'ready', `Read access verified${leads.length ? ' with a native Lead sample' : '; the org has no active Leads'}.`);
  }
  const syncId = `connection-test-${Date.now()}`;
  const receipt = await syncDirectlyToSalesforce({ syncId, sourceFile: 'connection-test', leads: [{ contactId: 'connection-test', email: testEmail, firstName: 'GTM', lastName: 'Control Tower Test', company: 'Example Company', phone: null, jobTitle: 'Connection Test', website: 'https://example.com' }] }, instance, token, apiVersion);
  if (receipt.failed) throw new Error(receipt.records[0]?.error ?? 'Salesforce rejected the test Lead.');
  return { ...health('salesforce', action, 'ready', 'Write access verified with one idempotent synthetic Lead.'), nativeReceiptId: receipt.syncId };
}

async function syncHubSpotThroughN8n(batch: Parameters<typeof syncDirectlyToHubSpot>[0]) {
  const webhook = process.env.N8N_HUBSPOT_SYNC_WEBHOOK_URL;
  if (!webhook) throw new Error('Add a HubSpot private-app token or the n8n write workflow.');
  const response = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch), signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let receipt: Awaited<ReturnType<typeof syncDirectlyToHubSpot>> | null = null;
  try { receipt = text ? JSON.parse(text) as Awaited<ReturnType<typeof syncDirectlyToHubSpot>> : null; } catch { /* validated below */ }
  if (!response.ok || receipt?.accepted !== true) throw new Error(`n8n HubSpot write test returned ${response.status} without a valid receipt.`);
  return receipt;
}

function health(connectorId: ConnectorHealth['connectorId'], action: ConnectorHealth['action'], status: ConnectorHealth['status'], message: string): ConnectorHealth {
  return { connectorId, action, status, message, checkedAt: new Date().toISOString() };
}
function instanceUrl() { const raw = process.env.SALESFORCE_INSTANCE_URL; if (!raw) return null; try { const url = new URL(raw); return url.protocol === 'https:' ? url.origin : null; } catch { return null; } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
