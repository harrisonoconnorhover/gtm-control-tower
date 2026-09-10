import { parseDemoReceipt, parseDemoSubmission } from '../lib/demo-intake';

export type HollisEnv = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  INTAKE_RATE_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> };
  PUBLIC_ORIGIN: string;
  SALESFORCE_INSTANCE_URL: string;
  SALESFORCE_CLIENT_ID: string;
  SALESFORCE_CLIENT_SECRET?: string;
  SALESFORCE_REFRESH_TOKEN: string;
};

type Session = { token: string; expires: number };
let session: Session | undefined;
let renewing: Promise<Session> | undefined;

async function salesforceToken(env: HollisEnv): Promise<string> {
  if (session && session.expires > Date.now()) return session.token;
  if (!renewing) renewing = (async () => {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.SALESFORCE_CLIENT_ID, refresh_token: env.SALESFORCE_REFRESH_TOKEN });
    if (env.SALESFORCE_CLIENT_SECRET) body.set('client_secret', env.SALESFORCE_CLIENT_SECRET);
    const response = await fetch(`${env.SALESFORCE_INSTANCE_URL}/services/oauth2/token`, {
      method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(12000),
    });
    const result = await response.json() as { access_token?: string; instance_url?: string };
    if (!response.ok || !result.access_token || result.instance_url !== env.SALESFORCE_INSTANCE_URL) throw new Error(`Salesforce authorization unavailable (HTTP ${response.status})`);
    session = { token: result.access_token, expires: Date.now() + 20 * 60 * 1000 };
    return session;
  })().finally(() => { renewing = undefined; });
  return (await renewing).token;
}

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function json(status: number, body: object, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...securityHeaders, 'Cache-Control': 'no-store', ...extra } });
}

async function smallJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > 8192) throw new Error('Form is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Supply a demo request.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new Error('Form is too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('Supply a valid form.'); }
}

async function intake(request: Request, env: HollisEnv): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Submit the demo request form to continue.' }, { Allow: 'POST' });
  if (request.headers.get('origin') !== env.PUBLIC_ORIGIN || new URL(request.url).origin !== env.PUBLIC_ORIGIN) {
    return json(403, { error: 'Submit your request from the Hollis Consulting website.' });
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json(415, { error: 'Please use the demo request form.' });
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || !(await env.INTAKE_RATE_LIMIT.limit({ key: ip })).success) {
    return json(429, { error: 'Please wait a minute before trying again.' }, { 'Retry-After': '60' });
  }
  let input;
  try {
    const raw = await smallJson(request);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Supply a valid form.');
    if ('website' in raw && raw.website) return json(400, { error: 'Please leave the extra website field empty.' });
    input = parseDemoSubmission({ ...raw, source: 'hollis-website', campaign: 'request-a-demo' });
  } catch (error) { return json(400, { error: error instanceof Error ? error.message : 'Check the form details.' }); }

  if (!/^https:\/\/[a-zA-Z0-9.-]+\.my\.salesforce\.com$/.test(env.SALESFORCE_INSTANCE_URL) || !env.SALESFORCE_CLIENT_ID || !env.SALESFORCE_REFRESH_TOKEN) {
    return json(503, { error: 'The form is temporarily unavailable. Please try again shortly.' });
  }
  try {
    const send = async () => fetch(`${env.SALESFORCE_INSTANCE_URL}/services/apexrest/gtm/demo-intake`, {
      // Leave room for a recovery attempt inside the unchanged form's 45s timeout.
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${await salesforceToken(env)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, createContact: true }),
    });
    const sendWithRenewal = async () => {
      let response = await send();
      if (response.status === 401) { session = undefined; response = await send(); }
      return response;
    };
    // The same immutable payload and request ID reconcile a lost response or
    // transient Salesforce transaction failure. Never retry a validation conflict.
    let first: Response | undefined;
    try { first = await sendWithRenewal(); }
    catch { /* A missing response is reconciled once using the same request ID. */ }
    const response = !first || [502, 503, 504].includes(first.status) ? await sendWithRenewal() : first;
    if (response.status === 409) return json(409, { error: 'These details changed after the request was sent. Edit a field and submit again.' });
    if (!response.ok) throw new Error(`Intake returned ${response.status}`);
    const rawReceipt: unknown = await response.json();
    const receipt = parseDemoReceipt(rawReceipt, input.requestId, env.SALESFORCE_INSTANCE_URL);
    const accountId = (rawReceipt as { accountId?: string }).accountId;
    if (receipt.status !== 'Held' && (receipt.personType !== 'Contact' || !accountId || !/^[a-zA-Z0-9]{18}$/.test(accountId))) {
      throw new Error('Account and Contact receipt incomplete');
    }
    // A held match is safely recorded for review. Never expose CRM identity, ownership,
    // existence, internal IDs, or provider errors to an anonymous website visitor.
    return json(200, { accepted: true, requestId: input.requestId });
  } catch (error) {
    console.error('Hollis intake could not confirm request', input.requestId, error instanceof Error ? error.message : 'Unknown provider failure');
    return json(503, { error: 'We could not confirm your request. Please try again; retries will not duplicate it.' });
  }
}

const worker = {
  async fetch(request: Request, env: HollisEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/api/demo-request') return await intake(request, env);
      if (path.startsWith('/api/') || path.startsWith('/.')) return json(404, { error: 'Not found.' });
      if (!['GET', 'HEAD'].includes(request.method)) return json(405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
      const asset = await env.ASSETS.fetch(request);
      const result = new Response(asset.body, asset);
      for (const [key, value] of Object.entries(securityHeaders)) result.headers.set(key, value);
      return result;
    } catch { return json(503, { error: 'The website is temporarily unavailable. Please try again shortly.' }); }
  },
};

export default worker;
