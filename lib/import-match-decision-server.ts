import { readHubSpotRecordById } from './crm-existing-hubspot';
import { readSalesforceLeadById } from './crm-existing-salesforce';
import { nativeMatchTargetKey, type ConfirmedImportMatch } from './import-match-decision';

export async function readConfirmedTarget(connectorId: 'hubspot' | 'salesforce', nativeId: string) {
  if (connectorId === 'hubspot') return readHubSpotRecordById(nativeId, connectionToken(connectorId));
  const origin = new URL(process.env.SALESFORCE_INSTANCE_URL || '');
  if (origin.protocol !== 'https:') throw new Error('Salesforce requires an HTTPS instance.');
  const version = process.env.SALESFORCE_API_VERSION ?? '67.0';
  return readSalesforceLeadById(nativeId, `${origin.origin}/services/data/v${version}`, {
    authorization: `Bearer ${connectionToken(connectorId)}`, accept: 'application/json',
  });
}

// Workspace JSON can be edited independently of the authenticated confirmation
// endpoint. Bind its decision to this workspace and current CRM credential so a
// fabricated target or a changed connection cannot become an approved match.
export async function signImportMatch(workspaceId: string, decision: Omit<ConfirmedImportMatch, 'signature'>): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(connectionToken(decision.connectorId)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = JSON.stringify([workspaceId, decision.connectorId,
    decision.connectorId === 'salesforce' ? process.env.SALESFORCE_INSTANCE_URL : 'hubspot',
    decision.scanId, decision.sourceKey, nativeMatchTargetKey(decision.target), decision.reason, decision.confirmedAt]);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyImportMatch(workspaceId: string, decision: ConfirmedImportMatch): Promise<boolean> {
  return decision.signature === await signImportMatch(workspaceId, decision);
}

function connectionToken(connectorId: 'hubspot' | 'salesforce'): string {
  const token = process.env[connectorId === 'hubspot' ? 'HUBSPOT_ACCESS_TOKEN' : 'SALESFORCE_ACCESS_TOKEN'];
  if (!token) throw new Error('A direct CRM connection is required to confirm an existing person.');
  return token;
}
