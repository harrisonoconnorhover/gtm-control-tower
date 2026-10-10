import { readHubSpotAccountIdentity, readSalesforceAccountIdentity, salesforceConnection } from './crm-account';
import { hubspotWatchdogSource, type WatchdogSource } from './watchdog-hubspot';
import { salesforceWatchdogSource } from './watchdog-salesforce';
import { getWatchdogOverview } from './watchdog';
import { watchdogAccountScope, type WatchdogOverview, type WatchdogProvider } from './watchdog-types';

export type WatchdogConnection = {
  provider: WatchdogProvider; accountId: string; scope: string; token: string;
  source: WatchdogSource; instanceUrl?: string;
};

/** Native identity is read for every operator action. The request cannot select an arbitrary account. */
export async function getWatchdogConnection(provider: WatchdogProvider = 'hubspot'): Promise<WatchdogConnection> {
  if (process.env.CONTROL_TOWER_PERSISTENCE_ENABLED === 'false') {
    throw new Error('Watchdog requires persistent local SQLite storage. Enable CONTROL_TOWER_PERSISTENCE_ENABLED.');
  }
  if (provider === 'salesforce') {
    const { apiRoot, headers } = salesforceConnection();
    const { accountId } = await readSalesforceAccountIdentity(apiRoot, headers);
    return { provider, accountId, scope: watchdogAccountScope(provider, accountId), token: '',
      source: salesforceWatchdogSource(apiRoot, headers, accountId), instanceUrl: new URL(apiRoot).origin };
  }
  const token = process.env.HUBSPOT_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Connect HubSpot with HUBSPOT_ACCESS_TOKEN on the self-hosted server to use Watchdog.');
  const { accountId } = await readHubSpotAccountIdentity(token);
  return { provider, accountId, scope: watchdogAccountScope(provider, accountId), token, source: hubspotWatchdogSource(token) };
}

export async function getConnectedWatchdogOverview(provider: WatchdogProvider = 'hubspot'): Promise<WatchdogOverview> {
  const connection = await getWatchdogConnection(provider);
  return { ...await getWatchdogOverview(connection.scope), ...(connection.instanceUrl ? { instanceUrl: connection.instanceUrl } : {}) };
}
