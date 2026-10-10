import { afterEach, describe, expect, it, vi } from 'vitest';
import { salesforceMonitorSource } from '../lib/monitor-salesforce';

const root = 'https://fixture.my.salesforce.com/services/data/v67.0';
const org = '00D000000000001';
const nativeId = (type: 'Lead' | 'Contact', number = 1) => `${type === 'Lead' ? '00Q' : '003'}${String(number).padStart(12, '0')}`;
const native = (type: 'Lead' | 'Contact', number = 1, properties: Record<string, unknown> = {}) => ({
  attributes: { type }, Id: nativeId(type, number), Email: 'fixture@example.com', FirstName: 'Fictional', LastName: 'Person',
  Title: ' Engineer ', OwnerId: '005000000000001', SystemModstamp: '2026-10-01T12:00:00.000+0000',
  ...(type === 'Lead' ? { Company: ' Acme ', Status: 'Custom pipeline stage', IsConverted: false } : { AccountId: '001000000000001' }),
  ...properties,
});
const result = (records: unknown[]) => Response.json({ records, done: true, totalSize: records.length });
const source = () => salesforceMonitorSource(root, { authorization: 'Bearer fixture-token' }, org);
afterEach(() => vi.unstubAllGlobals());

describe('Salesforce Monitor native adapter', () => {
  it('pages both object types using stable IDs and a frozen SystemModstamp window', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => result([]))
      .mockResolvedValueOnce(result(Array.from({ length: 50 }, (_, i) => native('Lead', i + 1))))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([native('Contact')]));
    vi.stubGlobal('fetch', fetcher);
    const adapter = source();
    const from = '2026-10-01T00:00:00.000Z';
    const through = '2026-10-02T00:00:00.000Z';
    const page1 = await adapter.changes(from, through, null);
    expect(page1.after).toBe(`Lead:${nativeId('Lead', 50)}`);
    const page2 = await adapter.changes(from, through, page1.after);
    expect(page2.after).toBeNull();
    expect(page2.contacts[0]).toMatchObject({ objectType: 'Contact', provider: 'salesforce', id: nativeId('Contact') });
    const query = new URL(fetcher.mock.calls[1][0]).searchParams.get('q')!;
    expect(query).toContain(`Id > '${nativeId('Lead', 50)}'`);
    expect(query).toContain('IsConverted = false');
    expect(query).toContain(`SystemModstamp >= ${from}`);
    expect(query).toContain(`SystemModstamp <= ${through}`);
    expect(query).toContain('ORDER BY Id ASC LIMIT 50');
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get('q')).toContain('FROM Contact');
  });

  it('rejects injected cursors, foreign object IDs, converted Leads and unrequested native reads', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(source().list("Lead:00Q000000000001' OR Id != ''")).rejects.toThrow('cursor');
    await expect(source().read(nativeId('Contact'), 'Lead')).rejects.toThrow('matching native');
    await expect(source().patch(nativeId('Lead'), { company: 'Acme' }, 'Contact')).rejects.toThrow('matching native');
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(Response.json(native('Lead', 1, { IsConverted: true })));
    await expect(source().read(nativeId('Lead'), 'Lead')).rejects.toThrow('converted');
    fetcher.mockResolvedValueOnce(Response.json(native('Lead', 2)));
    await expect(source().read(nativeId('Lead'), 'Lead')).rejects.toThrow('different record');
  });

  it.each([
    { records: [native('Contact')], done: true },
    { records: [native('Lead'), native('Lead')], done: true },
    { records: [native('Lead', 1, { attributes: { type: 'Contact' } })], done: true },
    { records: [], done: false, nextRecordsUrl: 'https://hostile.example/query' },
  ])('does not accept malformed or contradictory pages', async (payload) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(payload));
    vi.stubGlobal('fetch', fetcher);
    await expect(source().list(null)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('limits native PATCH fields by object and explicitly suppresses assignment rules', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    for (const properties of ([{ company: 'Acme' }, { owner_id: '005000000000002' }, { AccountId: '001000000000002' }, { jobtitle: '' }] as Record<string, string>[])) {
      await expect(source().patch(nativeId('Contact'), properties, 'Contact')).rejects.toThrow('limited');
    }
    expect(fetcher).not.toHaveBeenCalled();
    await source().patch(nativeId('Lead'), { company: 'Acme', jobtitle: 'Engineer' }, 'Lead');
    await source().patch(nativeId('Contact'), { jobtitle: 'Engineer' }, 'Contact');
    expect(fetcher.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([{ Company: 'Acme', Title: 'Engineer' }, { Title: 'Engineer' }]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'PATCH', redirect: 'error', headers: { 'Sforce-Auto-Assign': 'FALSE' } });
    expect(fetcher.mock.calls[1][0]).toBe(`${root}/sobjects/Contact/${nativeId('Contact')}`);
  });

  it('rejects records outside the change window before exposing observations', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(result([native('Lead')])));
    await expect(source().changes('2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z', null)).rejects.toThrow('outside');
  });

  it('treats unexpected successful PATCH responses as uncertain instead of accepted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ success: true })));
    await expect(source().patch(nativeId('Contact'), { jobtitle: 'Engineer' }, 'Contact')).rejects.toThrow('without resending');
  });
});
