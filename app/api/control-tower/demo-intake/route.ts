import { parseDemoReceipt, parseDemoSubmission } from '@/lib/demo-intake';
import { operatorAccessError } from '@/lib/operator-auth';

const responseHeaders = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  const connection = salesforceConnection();
  if (!connection) return Response.json({ ready: false, error: 'Configure Salesforce on the server to use connected intake.' }, { headers: responseHeaders });
  try {
    const response = await fetch(connection.endpoint, { headers: connection.headers, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    const result = await response.json() as { ready?: boolean };
    return Response.json({ ready: response.ok && result.ready === true, error: response.ok ? null : connectionError(response.status) }, { headers: responseHeaders });
  } catch {
    return Response.json({ ready: false, error: 'Salesforce could not be reached. Check the server connection.' }, { headers: responseHeaders });
  }
}

export async function POST(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: 'Submit from the Control Tower form.' }, { status: 403 });
  if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'A JSON request is required.' }, { status: 415 });
  const connection = salesforceConnection();
  if (!connection) return Response.json({ error: 'Configure Salesforce on the server before submitting.' }, { status: 503 });
  let submission;
  try {
    const body = await request.text();
    if (body.length > 8192) return Response.json({ error: 'The form request is too large.' }, { status: 413 });
    submission = parseDemoSubmission(JSON.parse(body));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Supply a valid form request.' }, { status: 400 });
  }
  try {
    const response = await fetch(connection.endpoint, {
      method: 'POST', headers: connection.headers, cache: 'no-store', signal: AbortSignal.timeout(30_000), body: JSON.stringify(submission),
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const message = (response.status === 400 || response.status === 409) && result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? result.error : connectionError(response.status);
      return Response.json({ error: message, requestId: submission.requestId }, { status: [400, 409].includes(response.status) ? response.status : 502, headers: responseHeaders });
    }
    return Response.json(parseDemoReceipt(result, submission.requestId, connection.instanceUrl), { headers: responseHeaders });
  } catch {
    // A timeout is an unknown outcome. The client must keep the ID and original payload.
    return Response.json({ error: 'No complete Salesforce response arrived. Retry this same request to check its outcome.', requestId: submission.requestId }, { status: 502, headers: responseHeaders });
  }
}

function salesforceConnection() {
  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
  const token = process.env.SALESFORCE_ACCESS_TOKEN;
  if (!instanceUrl || !token) return null;
  try {
    const url = new URL(instanceUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return { instanceUrl: url.origin, endpoint: `${url.origin}/services/apexrest/gtm/demo-intake`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } };
  } catch { return null; }
}

function connectionError(status: number) {
  if (status === 401) return 'The Salesforce session has expired. Refresh the server connection, then retry the same request.';
  if (status === 403) return 'The Salesforce integration needs the Demo Intake Integration permission set.';
  if (status === 404) return 'Deploy the Demo Intake metadata to the connected Salesforce org first.';
  return 'Salesforce could not complete the request. Retry with the same request ID.';
}
