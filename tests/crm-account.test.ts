import { resetCrmReadTransportForTests } from '../lib/crm-read-transport';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readHubSpotAccountIdentity } from '../lib/crm-account';

beforeEach(() => resetCrmReadTransportForTests({ minimumIntervalMs: 0, defaultBudgetMs: 20, backoffBaseMs: 1 }));
afterEach(() => vi.unstubAllGlobals());
describe('verified HubSpot account identity', () => {
  it('persists only the official portal ID and reads with a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ portalId: 12345, accountType: 'STANDARD' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await readHubSpotAccountIdentity('test-token')).toEqual({ connectorId: 'hubspot', accountId: '12345' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.hubapi.com/account-info/v3/details');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store', redirect: 'manual', headers: { authorization: 'Bearer test-token' } });
  });
  it.each([{}, { portalId: '12345' }, { portalId: 0 }, { portalId: -5 }, { portalId: 1.5 }])('rejects an unavailable or invalid account identity %j', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(readHubSpotAccountIdentity('test-token')).rejects.toThrow('account ID');
  });
  it('does not use a token fingerprint when the provider denies account identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(readHubSpotAccountIdentity('test-token')).rejects.toThrow('403');
  });
});
