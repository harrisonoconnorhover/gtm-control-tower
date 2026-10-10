import { incidentAccess } from '@/lib/incident-access';
import { incidentAccounts, resolveIncidentScope } from '@/lib/incident-accounts';
import { configureIncidentPolicy, flushIncidentNotifications, getIncident, getIncidentOverview, resumeIncidentRepairs, triageIncident,
  readIncidentEvidence, type IncidentPolicy, type IncidentResolution } from '@/lib/crm-incidents';
import { investigateIncident, investigationConfiguration, latestIncidentInvestigation } from '@/lib/incident-investigator';
import type { MonitorProvider } from '@/lib/monitor-types';
import { getMonitorEventStatus, retryHeldMonitorEvents } from '@/lib/monitor-events';

const headers = { 'cache-control': 'no-store' };
export async function GET(request: Request) {
  const access = incidentAccess(request);
  if (access instanceof Response) return access;
  try {
    const url = new URL(request.url), provider = parseProvider(url.searchParams.get('provider'));
    const accounts = await incidentAccounts(provider);
    const scope = await resolveIncidentScope(provider, url.searchParams.get('account'));
    const id = url.searchParams.get('incident');
    const detail = scope && id ? await getIncident(scope, id) : null;
    if (id && !detail) return Response.json({ error: 'Incident not found in this saved account.' }, { status: 404, headers });
    return Response.json({ accounts, scope, role: access.role, model: investigationConfiguration(),
      overview: scope ? await getIncidentOverview(scope) : null, detail, evidence: scope && id ? await readIncidentEvidence(scope, id) : null,
      events: scope ? await getMonitorEventStatus(scope) : null,
      investigation: scope && id ? await latestIncidentInvestigation(scope, id) : null }, { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const access = incidentAccess(request);
  if (access instanceof Response) return access;
  try {
    const raw = await request.text();
    if (raw.length > 32_000) throw new Error('Incident action exceeds the supported size.');
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose an incident action.');
    const body = value as Record<string, unknown>;
    if (access.role === 'investigator' && body.action !== 'investigate') {
      return Response.json({ error: 'Investigators may read evidence and prepare explanations only. An operator must change policy, resume repairs, or resolve work.' }, { status: 403, headers });
    }
    if (body.action === 'flush_notifications') {
      await flushIncidentNotifications();
      return Response.json({ flushed: true }, { headers });
    }
    const provider = parseProvider(body.provider);
    const scope = await resolveIncidentScope(provider, typeof body.account === 'string' ? body.account : null);
    if (!scope) throw new Error('Enable CRM Monitor and collect a baseline before managing incidents.');
    let investigation = null;
    if (body.action === 'investigate') {
      if (typeof body.id !== 'string' || !body.id || (body.useModel !== undefined && typeof body.useModel !== 'boolean')) throw new Error('An incident ID and optional model choice are required.');
      investigation = await investigateIncident(scope, body.id, body.useModel === true);
    } else if (body.action === 'policy') {
      if (!body.policy || typeof body.policy !== 'object' || !Number.isInteger(body.expectedVersion)) throw new Error('A complete policy and its current version are required.');
      await configureIncidentPolicy(scope, body.policy as IncidentPolicy, body.expectedVersion as number);
    } else if (body.action === 'resume_repairs') {
      await resumeIncidentRepairs(scope);
    } else if (body.action === 'retry_events') {
      await retryHeldMonitorEvents(scope);
    } else if (body.action === 'triage') {
      if (typeof body.id !== 'string' || !['open', 'investigating', 'resolved'].includes(String(body.status))
        || typeof body.assignee !== 'string' || typeof body.note !== 'string') throw new Error('Incident triage needs an ID, status, assignee and note.');
      await triageIncident(scope, { id: body.id, status: body.status as 'open' | 'investigating' | 'resolved',
        assignee: body.assignee, note: body.note, ...(typeof body.resolution === 'string' ? { resolution: body.resolution as IncidentResolution } : {}) });
    } else throw new Error('Choose investigate, policy, triage, or resume_repairs.');
    const id = typeof body.id === 'string' ? body.id : null;
    return Response.json({ scope, overview: await getIncidentOverview(scope), events: await getMonitorEventStatus(scope), detail: id ? await getIncident(scope, id) : null, evidence: id ? await readIncidentEvidence(scope, id) : null, investigation: investigation ?? (id ? await latestIncidentInvestigation(scope, id) : null) }, { headers });
  } catch (error) { return failure(error); }
}

function parseProvider(value: unknown): MonitorProvider {
  if (value === undefined || value === null || value === 'hubspot') return 'hubspot';
  if (value === 'salesforce') return 'salesforce';
  throw new Error('Choose HubSpot or Salesforce.');
}
function failure(error: unknown) { return Response.json({ error: error instanceof Error ? error.message : 'Incident operation failed.' }, { status: 409, headers }); }
