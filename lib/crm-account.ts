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
