import type { CrmAccountIdentity } from './safe-import';

/** Actual account identity, verified by HubSpot; credentials are never persisted. */
export async function readHubSpotAccountIdentity(accessToken: string): Promise<CrmAccountIdentity> {
  if (!accessToken.trim()) throw new Error('HubSpot credentials are required to verify the CRM account.');
  // https://developers.hubspot.com/docs/api-reference/legacy/account/account-information/guide
  const response = await fetch('https://api.hubapi.com/account-info/v3/details', {
    cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!response.ok || response.status === 207) throw new Error(`HubSpot account identity could not be verified (${response.status}).`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object' || !('portalId' in payload)) {
    throw new Error('HubSpot did not return a verified account ID.');
  }
  const portalId = payload.portalId;
  if (typeof portalId !== 'number' || !Number.isSafeInteger(portalId) || portalId <= 0) {
    throw new Error('HubSpot returned an invalid account ID.');
  }
  return { connectorId: 'hubspot', accountId: String(portalId) };
}

export function sameCrmAccount(left: CrmAccountIdentity, right: CrmAccountIdentity): boolean {
  return left.connectorId === right.connectorId && left.accountId === right.accountId;
}

/** Capture one direct Salesforce session. Never persist credentials with evidence. */
export function salesforceConnection(): { apiRoot: string; headers: Record<string, string> } {
  if (!process.env.SALESFORCE_INSTANCE_URL?.trim() || !process.env.SALESFORCE_ACCESS_TOKEN?.trim()) {
    throw new Error('Connect Salesforce with SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN on the self-hosted server.');
  }
  const instance = new URL(process.env.SALESFORCE_INSTANCE_URL || '');
  const version = process.env.SALESFORCE_API_VERSION ?? '67.0';
  if (instance.protocol !== 'https:' || instance.username || instance.password || instance.search || instance.hash
    || !['', '/'].includes(instance.pathname) || !/^\d+\.\d+$/.test(version)) {
    throw new Error('Salesforce requires an HTTPS instance origin and a valid API version.');
  }
  const accessToken = process.env.SALESFORCE_ACCESS_TOKEN;
  if (!accessToken?.trim()) throw new Error('Salesforce connection unavailable.');
  return { apiRoot: `${instance.origin}/services/data/v${version}`,
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } };
}

/** Organization.Id is native account evidence; an instance URL is not an org ID. */
export async function readSalesforceAccountIdentity(apiRoot: string, headers: Record<string, string>): Promise<CrmAccountIdentity> {
  const root = new URL(apiRoot);
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash
    || !/^\/services\/data\/v\d+\.\d+$/.test(root.pathname)) throw new Error('Salesforce requires an instance API root.');
  const query = new URLSearchParams({ q: 'SELECT Id FROM Organization LIMIT 1' });
  const response = await fetch(`${root.href}/query?${query}`, {
    cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(30_000), headers,
  });
  if (!response.ok || response.status === 207) throw new Error(`Salesforce account identity could not be verified (${response.status}).`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object' || !('done' in payload) || payload.done !== true
    || !('records' in payload) || !Array.isArray(payload.records) || payload.records.length !== 1
    || ('nextRecordsUrl' in payload && payload.nextRecordsUrl != null)) throw new Error('Salesforce did not return one verified organization.');
  const record: unknown = payload.records[0];
  if (!record || typeof record !== 'object' || !('Id' in record) || typeof record.Id !== 'string'
    || !/^00D(?:[A-Za-z0-9]{12}|[A-Za-z0-9]{15})$/.test(record.Id)) throw new Error('Salesforce returned an invalid organization ID.');
  return { connectorId: 'salesforce', accountId: record.Id };
}

export async function readCrmAccountIdentity(connectorId: CrmAccountIdentity['connectorId']): Promise<CrmAccountIdentity> {
  if (connectorId === 'hubspot') return readHubSpotAccountIdentity(process.env.HUBSPOT_ACCESS_TOKEN ?? '');
  const { apiRoot, headers } = salesforceConnection();
  return readSalesforceAccountIdentity(apiRoot, headers);
}
