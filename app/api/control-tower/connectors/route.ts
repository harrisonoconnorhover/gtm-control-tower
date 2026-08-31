import type { ConnectorCatalog } from '@/lib/connector-contract';
import { persistenceEnabled } from '@/lib/workspace-store';

export async function GET() {
  const sheetsRead = Boolean(process.env.N8N_GOOGLE_SHEETS_READ_WEBHOOK_URL);
  const sheetsWrite = Boolean(process.env.N8N_GOOGLE_SHEETS_WRITE_WEBHOOK_URL);
  const hubSpotDirect = Boolean(process.env.HUBSPOT_ACCESS_TOKEN);
  const hubSpotN8nWrite = Boolean(process.env.N8N_HUBSPOT_SYNC_WEBHOOK_URL);
  const hubSpotN8nRead = Boolean(process.env.N8N_HUBSPOT_SOURCE_WEBHOOK_URL);
  const hubSpot = hubSpotDirect || hubSpotN8nWrite || hubSpotN8nRead;
  const salesforce = Boolean(process.env.SALESFORCE_INSTANCE_URL && process.env.SALESFORCE_ACCESS_TOKEN);
  const bigQuery = Boolean(process.env.N8N_STATE_WEBHOOK_URL && process.env.N8N_REPAIR_WEBHOOK_URL);
  const fullLifecycle = ['preview', 'validate', 'execute', 'receipt', 'undo', 'export'] as const;
  const catalog: ConnectorCatalog = {
    persistenceEnabled: persistenceEnabled(),
    accessKeyRequired: Boolean(process.env.CONTROL_TOWER_SYNC_KEY),
    connectors: [
      { id: 'csv', label: 'CSV file', configured: true, directions: ['source', 'destination'], phases: [...fullLifecycle], mode: 'built-in', features: ['preview', 'write', 'rollback'] },
      { id: 'google-sheets', label: 'Google Sheets through n8n', configured: sheetsRead && sheetsWrite, directions: ['source', 'destination'], phases: [...fullLifecycle], mode: 'n8n', features: ['preview', 'write'] },
      {
        id: 'hubspot', label: 'HubSpot', configured: hubSpot,
        directions: [...(hubSpotDirect || hubSpotN8nRead ? ['source'] as const : []), ...(hubSpotDirect || hubSpotN8nWrite ? ['destination'] as const : [])],
        phases: [...fullLifecycle], mode: hubSpotDirect && (hubSpotN8nWrite || hubSpotN8nRead) ? 'hybrid' : hubSpotDirect ? 'direct' : 'n8n',
        features: [...(hubSpotDirect || hubSpotN8nRead ? ['preview'] as const : []), ...(hubSpotDirect || hubSpotN8nWrite ? ['write'] as const : []), ...(hubSpotDirect ? ['safe-writeback', 'rollback', 'account-scan'] as const : [])],
        setupHint: 'Add a service key with contact read/write access for account scans, diffs, writes, and rollback; or n8n webhooks for delegated OAuth.',
      },
      { id: 'salesforce', label: 'Salesforce', configured: salesforce, directions: ['source', 'destination'], phases: [...fullLifecycle], mode: 'direct', features: ['preview', 'write', 'safe-writeback', 'rollback', 'account-scan'], setupHint: 'Add the Salesforce instance URL and access token.' },
      { id: 'bigquery', label: 'BigQuery through n8n', configured: bigQuery, directions: ['source'], phases: [...fullLifecycle], setupHint: 'Import the warehouse workflow and set its n8n webhook URLs.' },
    ],
  };
  return Response.json(catalog, { headers: { 'Cache-Control': 'no-store' } });
}
