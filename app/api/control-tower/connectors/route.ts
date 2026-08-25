import type { ConnectorCatalog } from '@/lib/connector-contract';
import { persistenceEnabled } from '@/lib/workspace-store';

export async function GET() {
  const sheetsRead = Boolean(process.env.N8N_GOOGLE_SHEETS_READ_WEBHOOK_URL);
  const sheetsWrite = Boolean(process.env.N8N_GOOGLE_SHEETS_WRITE_WEBHOOK_URL);
  const hubSpot = Boolean(process.env.HUBSPOT_ACCESS_TOKEN || process.env.N8N_HUBSPOT_SYNC_WEBHOOK_URL);
  const salesforce = Boolean(process.env.SALESFORCE_INSTANCE_URL && process.env.SALESFORCE_ACCESS_TOKEN);
  const bigQuery = Boolean(process.env.N8N_STATE_WEBHOOK_URL && process.env.N8N_REPAIR_WEBHOOK_URL);
  const fullLifecycle = ['preview', 'validate', 'execute', 'receipt', 'undo', 'export'] as const;
  const catalog: ConnectorCatalog = {
    persistenceEnabled: persistenceEnabled(),
    connectors: [
      { id: 'csv', label: 'CSV file', configured: true, directions: ['source', 'destination'], phases: [...fullLifecycle] },
      { id: 'google-sheets', label: 'Google Sheets through n8n', configured: sheetsRead && sheetsWrite, directions: ['source', 'destination'], phases: [...fullLifecycle], setupHint: 'Set the two Google Sheets n8n webhook URLs.' },
      { id: 'hubspot', label: 'HubSpot', configured: hubSpot, directions: ['destination'], phases: [...fullLifecycle], setupHint: 'Add a private-app token or the n8n HubSpot webhook.' },
      { id: 'salesforce', label: 'Salesforce', configured: salesforce, directions: ['destination'], phases: [...fullLifecycle], setupHint: 'Add the Salesforce instance URL and access token.' },
      { id: 'bigquery', label: 'BigQuery through n8n', configured: bigQuery, directions: ['source'], phases: [...fullLifecycle], setupHint: 'Import the warehouse workflow and set its n8n webhook URLs.' },
    ],
  };
  return Response.json(catalog, { headers: { 'Cache-Control': 'no-store' } });
}
