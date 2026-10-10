import { afterEach, describe, expect, it, vi } from 'vitest';
import { hubspotWatchdogSource } from '../lib/watchdog-hubspot';

afterEach(() => vi.unstubAllGlobals());
const native = (id: string) => ({ id, updatedAt: '2026-10-01T12:00:00.000Z', properties: { email: 'test@example.com' }, archived: false });

describe('HubSpot watchdog native adapter', () => {
  it('uses native list cursors then immutable-ID keyset change paging that repairs cannot shift', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ results: [native('10')], paging: { next: { after: 'native-cursor' } } }))
      .mockResolvedValueOnce(Response.json({ total: 3, results: [native('100'), native('101')], paging: { next: { after: '2' } } }))
      .mockResolvedValueOnce(Response.json({ total: 1, results: [native('102')] }));
    vi.stubGlobal('fetch', fetcher);
    const source = hubspotWatchdogSource('fixture-token');
    expect((await source.list('previous-native-cursor')).after).toBe('native-cursor');
    const from = '2026-10-01T00:00:00.000Z';
    const through = '2026-10-02T00:00:00.000Z';
    expect((await source.changes(from, through, null)).after).toBe('101');
    // Earlier rows may now be changed and absent; query still resumes past ID 101.
    expect((await source.changes(from, through, '101')).contacts[0].id).toBe('102');
    const call = fetcher.mock.calls[2];
    const body = JSON.parse(call[1].body);
    expect(body.after).toBeUndefined();
    expect(body.sorts).toEqual([{ propertyName: 'hs_object_id', direction: 'ASCENDING' }]);
    expect(body.filterGroups[0].filters).toContainEqual({ propertyName: 'hs_object_id', operator: 'GT', value: '101' });
    expect(body.filterGroups[0].filters[0].propertyName).toBe('lastmodifieddate');
    expect(call[1]).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(fetcher.mock.calls[0][0]).toContain('limit=50');
  });

  it.each([{ results: [], paging: null }, { results: [], paging: { next: {} } }, { results: [], paging: { next: { after: '' } } }, { results: [], paging: { next: { after: '50' } } }, { results: Array.from({ length: 51 }, () => native('1')) }])('rejects malformed or oversized pages: %j', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(hubspotWatchdogSource('fixture').list(null)).rejects.toThrow();
  });

  it('forbids protected properties and empty values at the write boundary', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal('fetch', fetcher);
    const source = hubspotWatchdogSource('fixture');
    await expect(source.patch('1', { email: 'other@example.com' })).rejects.toThrow('limited');
    await expect(source.patch('1', { company: '' })).rejects.toThrow('limited');
    expect(fetcher).not.toHaveBeenCalled();
    await source.patch('1', { company: 'Acme' });
    expect(fetcher.mock.calls[0][1].method).toBe('PATCH');
  });
});
