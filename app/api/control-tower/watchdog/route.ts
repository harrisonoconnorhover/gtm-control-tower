import { readHubSpotAccountIdentity } from '@/lib/crm-account';
import { operatorAccessError } from '@/lib/operator-auth';
import { configureWatchdog, getWatchdogOverview, tickWatchdog, triageWatchdogFinding } from '@/lib/watchdog';
import type { WatchdogConfig } from '@/lib/watchdog-types';

export async function GET(request: Request) {
  const denied = operatorAccessError(request);
  if (denied) return denied;
  try {
    const { accountId } = await connection();
    return Response.json({ watchdog: await getWatchdogOverview(accountId) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  const denied = operatorAccessError(request);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    body = value as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Send a valid watchdog action.' }, { status: 400 });
  }
  try {
    const { accountId, token } = await connection();
    if (body.action === 'configure') {
      const config = parseConfig(body.config);
      await configureWatchdog(accountId, config);
    } else if (body.action === 'tick') {
      if (body.force !== undefined && typeof body.force !== 'boolean') throw new InputError('Force must be true or false.');
      await tickWatchdog(accountId, token, { force: body.force === true });
    } else if (body.action === 'triage') {
      if (typeof body.id !== 'string' || !body.id || body.id.length > 200
        || !['open', 'in_progress', 'resolved'].includes(String(body.status))
        || typeof body.assignee !== 'string' || body.assignee.length > 100
        || typeof body.note !== 'string' || body.note.length > 2000) {
        throw new InputError('Triage needs an issue ID, status, assignee (up to 100 characters), and note (up to 2,000 characters).');
      }
      await triageWatchdogFinding(accountId, {
        id: body.id, status: body.status as 'open' | 'in_progress' | 'resolved',
        assignee: body.assignee.trim(), note: body.note.trim(),
      });
    } else {
      throw new InputError('Choose configure, tick, or triage.');
    }
    return Response.json({ watchdog: await getWatchdogOverview(accountId) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
}

async function connection() {
  if (process.env.CONTROL_TOWER_PERSISTENCE_ENABLED === 'false') {
    throw new Error('Watchdog requires persistent local SQLite storage. Enable CONTROL_TOWER_PERSISTENCE_ENABLED.');
  }
  const token = process.env.HUBSPOT_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Connect HubSpot with HUBSPOT_ACCESS_TOKEN on the self-hosted server to use Watchdog.');
  const { accountId } = await readHubSpotAccountIdentity(token);
  return { accountId, token };
}

function parseConfig(value: unknown): WatchdogConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Watchdog settings are required.');
  const config = value as Record<string, unknown>;
  if (typeof config.enabled !== 'boolean' || typeof config.automaticRepairs !== 'boolean'
    || typeof config.intervalSeconds !== 'number' || !Number.isInteger(config.intervalSeconds)
    || config.intervalSeconds < 60 || config.intervalSeconds > 86400
    || typeof config.defaultAssignee !== 'string' || !config.defaultAssignee.trim() || config.defaultAssignee.length > 100) {
    throw new InputError('Use explicit monitoring/repair settings, a 60–86,400 second interval, and a default assignee.');
  }
  return { enabled: config.enabled, automaticRepairs: config.automaticRepairs,
    intervalSeconds: config.intervalSeconds, defaultAssignee: config.defaultAssignee.trim() };
}

class InputError extends Error {}

function failure(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : 'The watchdog request could not complete.' },
    { status: error instanceof InputError ? 400 : 503, headers: { 'cache-control': 'no-store' } });
}
