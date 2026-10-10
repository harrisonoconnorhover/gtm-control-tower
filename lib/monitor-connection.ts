import { readHubSpotAccountIdentity, readSalesforceAccountIdentity, salesforceConnection } from './crm-account';
import { hubspotMonitorSource, type MonitorSource } from './monitor-hubspot';
import { salesforceMonitorSource } from './monitor-salesforce';
import { getMonitorOverview } from './monitor';
import { monitorAccountScope, type MonitorOverview, type MonitorProvider } from './monitor-types';

export type MonitorConnection = {
  provider: MonitorProvider; accountId: string; scope: string; token: string;
  source: MonitorSource; instanceUrl?: string;
};

/** Native identity is read for every operator action. The request cannot select an arbitrary account. */
export async function getMonitorConnection(provider: MonitorProvider = 'hubspot'): Promise<MonitorConnection> {
  if (process.env.CONTROL_TOWER_PERSISTENCE_ENABLED === 'false') {
    throw new Error('Monitor requires persistent local SQLite storage. Enable CONTROL_TOWER_PERSISTENCE_ENABLED.');
  }
  if (provider === 'salesforce') {
    const { apiRoot, headers } = salesforceConnection();
    const { accountId } = await readSalesforceAccountIdentity(apiRoot, headers);
    return { provider, accountId, scope: monitorAccountScope(provider, accountId), token: '',
      source: salesforceMonitorSource(apiRoot, headers, accountId), instanceUrl: new URL(apiRoot).origin };
  }
  const token = process.env.HUBSPOT_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Connect HubSpot with HUBSPOT_ACCESS_TOKEN on the self-hosted server to use Monitor.');
  const { accountId } = await readHubSpotAccountIdentity(token);
  return { provider, accountId, scope: monitorAccountScope(provider, accountId), token, source: hubspotMonitorSource(token) };
}

export async function getConnectedMonitorOverview(provider: MonitorProvider = 'hubspot'): Promise<MonitorOverview> {
  const connection = await getMonitorConnection(provider);
  return { ...await getMonitorOverview(connection.scope), ...(connection.instanceUrl ? { instanceUrl: connection.instanceUrl } : {}) };
}
