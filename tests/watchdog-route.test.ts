import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  getWatchdogOverview: vi.fn(), configureWatchdog: vi.fn(), tickWatchdog: vi.fn(), triageWatchdogFinding: vi.fn(),
  readHubSpotAccountIdentity: vi.fn(), readSalesforceAccountIdentity: vi.fn(), salesforceConnection: vi.fn(),
}));
vi.mock('@/lib/watchdog', () => service);
vi.mock('@/lib/crm-account', () => ({ readHubSpotAccountIdentity: service.readHubSpotAccountIdentity, readSalesforceAccountIdentity: service.readSalesforceAccountIdentity, salesforceConnection: service.salesforceConnection }));
import { GET, POST } from '@/app/api/control-tower/watchdog/route';

const config = { enabled: true, automaticRepairs: false, intervalSeconds: 300, defaultAssignee: 'RevOps' };
function request(body?: unknown, key = 'operator-test') {
  return new Request('http://localhost/api/control-tower/watchdog', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-control-tower-key': key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'operator-test');
  vi.stubEnv('HUBSPOT_ACCESS_TOKEN', 'fictional-token');
  vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
  service.salesforceConnection.mockReturnValue({ apiRoot: 'https://fixture.my.salesforce.com/services/data/v67.0', headers: { authorization: 'Bearer fictional-sf' } });
  service.readSalesforceAccountIdentity.mockResolvedValue({ connectorId: 'salesforce', accountId: '00D000000000001' });
  service.readHubSpotAccountIdentity.mockResolvedValue({ connectorId: 'hubspot', accountId: '12345' });
  service.getWatchdogOverview.mockResolvedValue({ accountId: '12345', config, findings: [], runs: [] });
});
afterEach(() => vi.unstubAllEnvs());

describe('watchdog operator endpoint', () => {
  it('protects both saved data and actions before accessing the provider', async () => {
    expect((await GET(request(undefined, 'wrong'))).status).toBe(401);
    expect((await POST(request({ action: 'tick' }, 'wrong'))).status).toBe(401);
    expect(service.readHubSpotAccountIdentity).not.toHaveBeenCalled();
    expect(service.tickWatchdog).not.toHaveBeenCalled();
  });

  it('binds actions to the verified portal rather than caller-supplied IDs', async () => {
    const response = await POST(request({ action: 'configure', accountId: 'other-portal', config }));
    expect(response.status).toBe(200);
    expect(service.configureWatchdog).toHaveBeenCalledWith('12345', config);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('passes a manual check without giving the browser authority to supply records or fixes', async () => {
    expect((await POST(request({ action: 'tick', force: true, records: [{ id: 'injected' }] }))).status).toBe(200);
    expect(service.tickWatchdog).toHaveBeenCalledWith('12345', 'fictional-token', { force: true });
  });

  it('rejects malformed configuration and unsupported issue status', async () => {
    expect((await POST(request({ action: 'configure', config: { ...config, automaticRepairs: 'yes' } }))).status).toBe(400);
    expect((await POST(request({ action: 'triage', id: 'issue', status: 'fixed', assignee: 'Alex', note: 'Claimed fixed' }))).status).toBe(400);
    expect(service.configureWatchdog).not.toHaveBeenCalled();
    expect(service.triageWatchdogFinding).not.toHaveBeenCalled();
  });

  it('saves human assignment and notes only in the connected account', async () => {
    const response = await POST(request({ action: 'triage', id: 'issue', status: 'in_progress', assignee: ' Alex ', note: ' Check routing ' }));
    expect(response.status).toBe(200);
    expect(service.triageWatchdogFinding).toHaveBeenCalledWith('12345', { id: 'issue', status: 'in_progress', assignee: 'Alex', note: 'Check routing' });
  });

  it('reports unavailable connection or persistence without starting a check', async () => {
    vi.stubEnv('HUBSPOT_ACCESS_TOKEN', '');
    expect((await GET(request())).status).toBe(503);
    vi.stubEnv('HUBSPOT_ACCESS_TOKEN', 'fictional-token');
    vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'false');
    expect((await POST(request({ action: 'tick' }))).status).toBe(503);
    expect(service.tickWatchdog).not.toHaveBeenCalled();
  });
});


describe('Salesforce Watchdog operator endpoint', () => {
  it('scopes configuration and reads to the verified org and returns its native instance link metadata', async () => {
    service.getWatchdogOverview.mockResolvedValue({ provider: 'salesforce', accountId: '00D000000000001', config, findings: [], runs: [] });
    const response = await POST(request({ action: 'configure', provider: 'salesforce', accountId: '00D000000000002', config }));
    expect(response.status).toBe(200);
    expect(service.configureWatchdog).toHaveBeenCalledWith('salesforce_00D000000000001', config);
    expect(((await response.json()) as { watchdog: { instanceUrl: string } }).watchdog.instanceUrl).toBe('https://fixture.my.salesforce.com');
    expect(service.readHubSpotAccountIdentity).not.toHaveBeenCalled();
    const get = new Request('http://localhost/api/control-tower/watchdog?provider=salesforce', { headers: { 'x-control-tower-key': 'operator-test' } });
    expect((await GET(get)).status).toBe(200);
    expect(service.getWatchdogOverview).toHaveBeenLastCalledWith('salesforce_00D000000000001');
  });

  it('dispatches ticks using a server-created provider source, never caller supplied records or credentials', async () => {
    expect((await POST(request({ action: 'tick', provider: 'salesforce', force: true, records: [{ id: 'injected' }], token: 'injected' }))).status).toBe(200);
    expect(service.tickWatchdog).toHaveBeenCalledWith('salesforce_00D000000000001', '', {
      force: true, source: expect.objectContaining({ provider: 'salesforce', accountId: '00D000000000001' }),
    });
  });

  it('rejects unsupported providers and unverifiable native orgs without scanning or configuring', async () => {
    expect((await POST(request({ action: 'tick', provider: 'other' }))).status).toBe(400);
    service.readSalesforceAccountIdentity.mockRejectedValue(new Error('Organization unavailable'));
    expect((await POST(request({ action: 'configure', provider: 'salesforce', config }))).status).toBe(503);
    expect(service.tickWatchdog).not.toHaveBeenCalled();
    expect(service.configureWatchdog).not.toHaveBeenCalled();
  });
});
