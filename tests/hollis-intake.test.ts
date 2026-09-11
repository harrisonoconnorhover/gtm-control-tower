import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HollisEnv } from '../hollis/worker';

const origin = 'https://hollis-consulting.harrisonoconnorhoover.workers.dev';
const sf = 'https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com';
const input = { requestId: 'hollis-request-000001', firstName: 'Maya', lastName: 'Thompson', email: 'maya@cedar.example', company: 'Cedar Works', phone: '' };
const nativeReceipt = {
  requestId: input.requestId, submissionId: 'a01000000000001AAA', status: 'Routed', reason: 'Internal provider details',
  personId: '003000000000001AAA', accountId: '001000000000001AAA', personType: 'Contact', createdPerson: true,
  ownerId: '005000000000001AAA', ownerName: 'Private Owner', taskId: '00T000000000001AAA',
  notificationStatus: 'Requested', reusedRequest: false,
};
let worker: typeof import('../hollis/worker').default;
let env: HollisEnv;
let network: ReturnType<typeof vi.fn>;
function request(body: unknown = input, headers: Record<string, string> = {}) {
  return new Request(origin + '/api/demo-request', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.8', ...headers }, body: JSON.stringify(body) });
}
beforeEach(async () => {
  vi.resetModules();
  worker = (await import('../hollis/worker')).default;
  env = { PUBLIC_ORIGIN: origin, SALESFORCE_INSTANCE_URL: sf, SALESFORCE_CLIENT_ID: 'test-client', SALESFORCE_REFRESH_TOKEN: 'private-test-refresh',
    ASSETS: { fetch: vi.fn(async () => new Response('<html>Hollis</html>')) }, INTAKE_RATE_LIMIT: { limit: vi.fn(async () => ({ success: true })) } };
  network = vi.fn(async (url: string) => url.endsWith('/token') ? Response.json({ access_token: 'private-test-session', instance_url: sf }) : Response.json(nativeReceipt));
  vi.stubGlobal('fetch', network);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('creates only the server-selected Account/Contact flow and returns a private public receipt', async () => {
  const response = await worker.fetch(request({ ...input, createContact: false, ownerId: 'attacker', instanceUrl: 'https://evil.example', source: 'spoof' }), env);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: true, requestId: input.requestId });
  expect(network.mock.calls[0][1].redirect).toBe('manual');
  expect(network.mock.calls[1][1].redirect).toBe('manual');
  const posted = JSON.parse(network.mock.calls[1][1].body);
  expect(posted).toEqual({ ...input, source: 'hollis-website', campaign: 'request-a-demo', createContact: true });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

it('records a held request without revealing matching CRM information', async () => {
  network.mockImplementation(async (url: string) => url.endsWith('/token') ? Response.json({ access_token: 'token', instance_url: sf }) : Response.json({ ...nativeReceipt, status: 'Held', personId: null, personType: null, accountId: null, taskId: null, ownerId: null, notificationStatus: 'Not requested' }));
  expect(await (await worker.fetch(request(), env)).json()).toEqual({ accepted: true, requestId: input.requestId });
});

it('rejects cross-origin, malformed, oversized, and honeypot submissions before touching Salesforce', async () => {
  expect((await worker.fetch(request(input, { Origin: 'https://elsewhere.example' }), env)).status).toBe(403);
  expect((await worker.fetch(request({ ...input, email: 'bad' }), env)).status).toBe(400);
  expect((await worker.fetch(request({ ...input, website: 'bot-filled' }), env)).status).toBe(400);
  expect((await worker.fetch(request({ ...input, company: 'x'.repeat(9000) }), env)).status).toBe(400);
  expect(network).not.toHaveBeenCalled();
});

it('limits repeated submissions without reaching the CRM', async () => {
  env.INTAKE_RATE_LIMIT.limit = vi.fn(async () => ({ success: false }));
  const response = await worker.fetch(request(), env);
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
  expect(network).not.toHaveBeenCalled();
});

it('refreshes an expired Salesforce session and preserves the request ID when retrying', async () => {
  network.mockResolvedValueOnce(Response.json({ access_token: 'old', instance_url: sf }));
  network.mockResolvedValueOnce(new Response('', { status: 401 }));
  network.mockResolvedValueOnce(Response.json({ access_token: 'new', instance_url: sf }));
  network.mockResolvedValueOnce(Response.json(nativeReceipt));
  expect((await worker.fetch(request(), env)).status).toBe(200);
  expect(network).toHaveBeenCalledTimes(4);
  expect(network.mock.calls[1][1].body).toBe(network.mock.calls[3][1].body);
});

it('does not claim success when Salesforce did not confirm a linked Account and Contact', async () => {
  network.mockImplementation(async (url: string) => url.endsWith('/token') ? Response.json({ access_token: 'token', instance_url: sf }) : Response.json({ ...nativeReceipt, accountId: null, personType: 'Lead' }));
  const response = await worker.fetch(request(), env);
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain('Private Owner');
});

it('reconciles a saved request after its response is lost without changing identity or attribution', async () => {
  const saved = new Map<string, unknown>();
  let deliveries = 0;
  network.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith('/token')) return Response.json({ access_token: 'token', instance_url: sf });
    const body = String(init.body);
    const submission = JSON.parse(body);
    if (!saved.has(submission.requestId)) saved.set(submission.requestId, body);
    else expect(saved.get(submission.requestId)).toBe(body);
    if (++deliveries === 1) throw new TypeError('Response lost after CRM commit');
    return Response.json({ ...nativeReceipt, reusedRequest: true });
  });
  expect((await worker.fetch(request(), env)).status).toBe(200);
  expect(deliveries).toBe(2);
  expect(saved.size).toBe(1);
  expect(JSON.parse(String(saved.get(input.requestId)))).toMatchObject({ source: 'hollis-website', campaign: 'request-a-demo' });
});

it('retries a temporary CRM failure once and preserves a clear failure after exhaustion', async () => {
  network.mockResolvedValueOnce(Response.json({ access_token: 'token', instance_url: sf }));
  network.mockResolvedValueOnce(new Response('', { status: 503 }));
  network.mockResolvedValueOnce(Response.json(nativeReceipt));
  expect((await worker.fetch(request(), env)).status).toBe(200);
  expect(network.mock.calls[1][1].body).toBe(network.mock.calls[2][1].body);
  network.mockClear();
  network.mockRejectedValue(new TypeError('CRM unreachable'));
  expect((await worker.fetch(request(), env)).status).toBe(503);
  expect(network).toHaveBeenCalledTimes(2);
});

it('reconciles a receipt body interrupted after successful response headers', async () => {
  network.mockResolvedValueOnce(Response.json({ access_token: 'token', instance_url: sf }));
  const partial = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"requestId":'));
    controller.error(new TypeError('Connection reset while reading receipt'));
  } }));
  network.mockResolvedValueOnce(partial);
  network.mockResolvedValueOnce(Response.json({ ...nativeReceipt, reusedRequest: true }));
  expect((await worker.fetch(request(), env)).status).toBe(200);
  expect(network).toHaveBeenCalledTimes(3);
  expect(network.mock.calls[1][1].body).toBe(network.mock.calls[2][1].body);
});

it('finishes before the browser deadline even when shared authorization never resolves', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
  network.mockImplementation(() => new Promise(() => {}));
  const result = worker.fetch(request(), env);
  await vi.advanceTimersByTimeAsync(40000);
  expect((await result).status).toBe(503);
  expect(network).toHaveBeenCalledTimes(1);
});

it('does not retry changed-payload conflicts or CRM throttling', async () => {
  network.mockResolvedValueOnce(Response.json({ access_token: 'token', instance_url: sf }));
  network.mockResolvedValueOnce(new Response('', { status: 409 }));
  expect((await worker.fetch(request(), env)).status).toBe(409);
  expect(network).toHaveBeenCalledTimes(2);
  network.mockClear();
  network.mockResolvedValue(new Response('', { status: 429 }));
  expect((await worker.fetch(request(), env)).status).toBe(503);
  expect(network).toHaveBeenCalledTimes(1);
});

it('keeps provider failures and credentials off the public response', async () => {
  network.mockResolvedValue(Response.json({ error: 'private-test-refresh', error_description: 'Private org details' }, { status: 400 }));
  const response = await worker.fetch(request(), env);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toMatch(/private-test|Private org/);
});

it('serves only the public website and refuses private Control Tower endpoints', async () => {
  expect((await worker.fetch(new Request(origin + '/api/control-tower/demo-intake'), env)).status).toBe(404);
  expect((await worker.fetch(new Request(origin + '/.env.local'), env)).status).toBe(404);
  const response = await worker.fetch(new Request(origin), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(network).not.toHaveBeenCalled();
});
