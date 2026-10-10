import { monitorDatabase } from './monitor-store';
import { monitorAccountIdentity, type MonitorProvider } from './monitor-types';

/** Saved accounts remain inspectable during a credential outage. This never authorizes a CRM write. */
export async function incidentAccounts(provider?: MonitorProvider) {
  const db = await monitorDatabase();
  const rows = (await db.prepare('SELECT account_id FROM monitor_accounts ORDER BY last_checked_at DESC LIMIT 100').all<{ account_id: string }>()).results;
  return rows.map((row) => ({ scope: row.account_id, ...monitorAccountIdentity(row.account_id) }))
    .filter((row) => !provider || row.provider === provider);
}

export async function resolveIncidentScope(provider: MonitorProvider, requested?: string | null): Promise<string | null> {
  const accounts = await incidentAccounts(provider);
  if (!requested) return accounts[0]?.scope ?? null;
  if (!accounts.some((account) => account.scope === requested)) throw new Error('Saved CRM account not found for this provider.');
  return requested;
}
