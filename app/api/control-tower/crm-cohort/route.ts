import { parseCrmCohortDefinition } from '@/lib/crm-cohort';
import { readHubSpotCohortContacts, readHubSpotCohortMetadata, readHubSpotCohortPage, type HubSpotCohortSelection } from '@/lib/hubspot-cohort';
import { operatorAccessError } from '@/lib/operator-auth';
import { isCrmReadDeferredError } from '@/lib/crm-read-transport';

export async function GET(request: Request) {
  const denied = operatorAccessError(request);
  if (denied) return denied;
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token?.trim()) return failure('Connect HubSpot directly on the self-hosted server to prepare CRM cohorts.', 503);
  try { return Response.json({ metadata: await readHubSpotCohortMetadata(token, request.signal) }, { headers: { 'cache-control': 'no-store' } }); }
  catch (error) { return readFailure(error, 'HubSpot metadata could not be read.'); }
}

export async function POST(request: Request) {
  const denied = operatorAccessError(request);
  if (denied) return denied;
  let payload: unknown;
  try { payload = await request.json(); } catch { return failure('Send a JSON cohort action.', 400); }
  if (!isRecord(payload) || !['preview', 'recheck'].includes(String(payload.action))) return failure('Choose preview or recheck.', 400);
  let definition;
  try {
    definition = parseCrmCohortDefinition(payload.definition);
    if (payload.action === 'preview' && payload.after !== undefined && payload.after !== null
      && (typeof payload.after !== 'string' || !/^\d{1,5}$/.test(payload.after) || Number(payload.after) >= 10_000)) throw new Error('Use a valid cohort cursor.');
    if (payload.action === 'recheck' && (!Array.isArray(payload.contacts) || !payload.contacts.length || payload.contacts.length > 100
      || payload.contacts.some((entry) => !isRecord(entry) || typeof entry.contactId !== 'string' || !/^\d{1,30}$/.test(entry.contactId)
        || !Array.isArray(entry.dealIds) || !entry.dealIds.length || entry.dealIds.length > 100
        || entry.dealIds.some((id: unknown) => typeof id !== 'string' || !/^\d{1,30}$/.test(id))
        || new Set(entry.dealIds).size !== entry.dealIds.length)
      || new Set(payload.contacts.map((entry) => (entry as HubSpotCohortSelection).contactId)).size !== payload.contacts.length)) throw new Error('Recheck 1–100 unique contacts and their original deal IDs.');
  } catch (error) { return failure(error instanceof Error ? error.message : 'Invalid cohort definition.', 400); }
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token?.trim()) return failure('Connect HubSpot directly on the self-hosted server to prepare CRM cohorts.', 503);
  try {
    const result = payload.action === 'preview'
      ? await readHubSpotCohortPage(token, definition, typeof payload.after === 'string' ? payload.after : null, request.signal)
      : await readHubSpotCohortContacts(token, definition, payload.contacts as HubSpotCohortSelection[], request.signal);
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return readFailure(error, 'HubSpot cohort could not be read.'); }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function failure(error: string, status: number) { return Response.json({ error, retryable: false }, { status, headers: { 'cache-control': 'no-store' } }); }
function readFailure(error: unknown, fallback: string) {
  if (isCrmReadDeferredError(error)) return Response.json({ error: error.message, retryable: true, retryAt: error.retryAt, reason: error.reason }, {
    status: 503, headers: { 'cache-control': 'no-store', 'retry-after': new Date(error.retryAt).toUTCString() },
  });
  return failure(error instanceof Error ? error.message : fallback, 502);
}
