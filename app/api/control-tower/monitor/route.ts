import { getMonitorConnection } from '@/lib/monitor-connection';
import { operatorAccessError } from '@/lib/operator-auth';
import { configureMonitor, getMonitorOverview, tickMonitor, triageMonitorFinding } from '@/lib/monitor';
import type { MonitorConfig, MonitorProvider } from '@/lib/monitor-types';
import { notifyMonitorConnectionFailure } from '@/lib/operation-notifications';

export async function GET(request: Request) {
  const denied = operatorAccessError(request);
  if (denied) return denied;
  try {
    const connection = await getMonitorConnection(parseProvider(new URL(request.url).searchParams.get('provider') ?? undefined));
    return Response.json({ monitor: { ...await getMonitorOverview(connection.scope), ...(connection.instanceUrl ? { instanceUrl: connection.instanceUrl } : {}) } }, { headers: { 'cache-control': 'no-store' } });
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
    return Response.json({ error: 'Send a valid monitor action.' }, { status: 400 });
  }
  try {
    const provider = parseProvider(body.provider);
    if (body.action === 'tick' && body.force !== undefined && typeof body.force !== 'boolean') throw new InputError('Force must be true or false.');
    const connection = await getMonitorConnection(provider).catch(async (error: unknown) => {
      if (body.action === 'tick') await notifyMonitorConnectionFailure(provider);
      throw error;
    });
    const { scope: accountId, token } = connection;
    if (body.action === 'configure') {
      const config = parseConfig(body.config);
      await configureMonitor(accountId, config);
    } else if (body.action === 'tick') {
      if (body.force !== undefined && typeof body.force !== 'boolean') throw new InputError('Force must be true or false.');
      await tickMonitor(accountId, token, { force: body.force === true, ...(connection.provider === 'salesforce' ? { source: connection.source } : {}) });
    } else if (body.action === 'triage') {
      if (typeof body.id !== 'string' || !body.id || body.id.length > 200
        || !['open', 'in_progress', 'resolved'].includes(String(body.status))
        || typeof body.assignee !== 'string' || body.assignee.length > 100
        || typeof body.note !== 'string' || body.note.length > 2000) {
        throw new InputError('Triage needs an issue ID, status, assignee (up to 100 characters), and note (up to 2,000 characters).');
      }
      await triageMonitorFinding(accountId, {
        id: body.id, status: body.status as 'open' | 'in_progress' | 'resolved',
        assignee: body.assignee.trim(), note: body.note.trim(),
      });
    } else {
      throw new InputError('Choose configure, tick, or triage.');
    }
    return Response.json({ monitor: { ...await getMonitorOverview(accountId), ...(connection.instanceUrl ? { instanceUrl: connection.instanceUrl } : {}) } }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
}

function parseProvider(value: unknown): MonitorProvider {
  if (value === undefined || value === 'hubspot') return 'hubspot';
  if (value === 'salesforce') return 'salesforce';
  throw new InputError('Choose HubSpot or Salesforce for Monitor.');
}

function parseConfig(value: unknown): MonitorConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Monitor settings are required.');
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
  return Response.json({ error: error instanceof Error ? error.message : 'The monitor request could not complete.' },
    { status: error instanceof InputError ? 400 : 503, headers: { 'cache-control': 'no-store' } });
}
