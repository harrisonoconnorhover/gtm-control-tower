import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/control-tower/demo-intake/route';
import { parseDemoReceipt, parseDemoSubmission } from '../lib/demo-intake';

const input = { requestId: 'request-server-00001', firstName: 'Elena', lastName: 'Foster', email: 'elena@cedar.example', phone: '', company: 'Cedar Studio', source: 'website', campaign: 'demo-request' };
const providerReceipt = {
  requestId: input.requestId, submissionId: 'a01000000000001AAA', status: 'Routed', reason: 'Task created and notification accepted.',
  personId: '003000000000001AAA', personType: 'Contact', createdPerson: false, ownerId: '005000000000001AAA', ownerName: 'Demo Owner',
  taskId: '00T000000000001AAA', notificationStatus: 'Requested', reusedRequest: false,
};
const request = (body: unknown = input, headers: Record<string, string> = {}) => new Request('http://localhost/api/control-tower/demo-intake', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

describe('connected Salesforce demo intake', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CONTROL_TOWER_SYNC_KEY', '');
    vi.stubEnv('SALESFORCE_INSTANCE_URL', 'https://example.my.salesforce.com');
    vi.stubEnv('SALESFORCE_ACCESS_TOKEN', 'server-only-test-token');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('normalizes the form and enforces the required fields and provider limits', () => {
    expect(parseDemoSubmission({ ...input, email: ' ELENA@CEDAR.EXAMPLE ', phone: undefined })).toEqual(input);
    expect(() => parseDemoSubmission({ ...input, email: 'bad@@cedar.example' })).toThrow('valid email');
    expect(() => parseDemoSubmission({ ...input, requestId: 'short' })).toThrow('stable request ID');
    expect(() => parseDemoSubmission({ ...input, firstName: 'a'.repeat(41) })).toThrow('40');
    expect(() => parseDemoSubmission({ ...input, company: '' })).toThrow('required');
  });

  it('sends only the form to the fixed server-configured Salesforce endpoint', async () => {
    const fetchMock = vi.fn(async () => Response.json(providerReceipt));
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(request({ ...input, instanceUrl: 'https://untrusted.example', ownerId: 'ignore', accessToken: 'ignore' }));
    expect(response.status).toBe(200);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.my.salesforce.com/services/apexrest/gtm/demo-intake');
    expect(options.headers).toMatchObject({ authorization: 'Bearer server-only-test-token' });
    expect(JSON.parse(options.body as string)).toEqual(input);
    const result = await response.json();
    expect(result).toMatchObject({ personType: 'Contact', createdPerson: false, links: { task: 'https://example.my.salesforce.com/00T000000000001AAA' } });
    expect(JSON.stringify(result)).not.toContain('server-only-test-token');
  });

  it('keeps the same request ID when a lost provider response is retried', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(Response.json({ ...providerReceipt, reusedRequest: true }));
    vi.stubGlobal('fetch', fetchMock);
    const failed = await POST(request());
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ requestId: input.requestId });
    const retried = await POST(request());
    expect(await retried.json()).toMatchObject({ requestId: input.requestId, reusedRequest: true });
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).requestId)).toEqual([input.requestId, input.requestId]);
  });

  it('returns an explicit conflict if the same ID is used for different input', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'This ID already belongs to different form details.' }, { status: 409 })));
    const result = await POST(request());
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ requestId: input.requestId, error: expect.stringContaining('different') });
  });

  it('accepts a hold without claiming a person, task, or notification was created', () => {
    const result = parseDemoReceipt({ ...providerReceipt, status: 'Held', personId: null, personType: null, ownerId: null, ownerName: null, taskId: null, notificationStatus: 'Not requested' }, input.requestId, 'https://example.my.salesforce.com');
    expect(result.links.person).toBeNull();
    expect(result.links.task).toBeNull();
    expect(result.status).toBe('Held');
    expect(() => parseDemoReceipt({ ...providerReceipt, taskId: null }, input.requestId, 'https://example.my.salesforce.com')).toThrow('follow-up task');
    expect(() => parseDemoReceipt({ ...providerReceipt, requestId: 'another-request' }, input.requestId, 'https://example.my.salesforce.com')).toThrow('incomplete receipt');
  });

  it('retains an existing task when Salesforce reports a pending notification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...providerReceipt, status: 'Notification pending', notificationStatus: 'Pending' })));
    const result = await POST(request());
    expect(await result.json()).toMatchObject({ status: 'Notification pending', taskId: providerReceipt.taskId });
  });

  it('checks the installed Salesforce intake service without returning its credentials', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ready: true, version: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(new Request('http://localhost/api/control-tower/demo-intake'));
    expect(await response.json()).toEqual({ ready: true, error: null });
    vi.stubEnv('SALESFORCE_ACCESS_TOKEN', '');
    expect(await (await GET(new Request('http://localhost/api/control-tower/demo-intake'))).json()).toMatchObject({ ready: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('enforces operator access and rejects cross-origin writes before touching Salesforce', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'private-operator-key');
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request(input, { 'x-control-tower-key': 'private-operator-key', origin: 'https://untrusted.example' }))).status).toBe(403);
    vi.stubEnv('CONTROL_TOWER_SYNC_KEY', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect((await POST(request())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed and oversized submissions before touching Salesforce', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await POST(request({ ...input, email: 'broken' }))).status).toBe(400);
    expect((await POST(request({ ...input, company: 'x'.repeat(9000) }))).status).toBe(413);
    expect((await POST(request(input, { 'content-type': 'text/plain' }))).status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
