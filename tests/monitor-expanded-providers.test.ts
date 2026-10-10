import { afterEach, describe, expect, it, vi } from 'vitest';
import { hubspotMonitorSource } from '../lib/monitor-hubspot';
import { salesforceMonitorSource } from '../lib/monitor-salesforce';
import { inspectMonitorContact } from '../lib/monitor-rules';
import { monitorRecordKey } from '../lib/monitor-types';
const updatedAt = '2026-10-01T12:00:00.000Z';
const org = '00D000000000001';
const sfRoot = 'https://fixture.my.salesforce.com/services/data/v67.0';
afterEach(() => vi.unstubAllGlobals());

describe('expanded native monitoring scope', () => {
  it('reads HubSpot contacts, companies, deals and bounded native relationships without colliding IDs', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/associations/')) {
        const key = url.includes('/companies/contacts/') ? '11' : url.includes('/deals/companies/') ? '22' : '11';
        const input = JSON.parse(String(init?.body)).inputs;
        return Response.json({ results: input.map((item: { id: string }) => ({ from: { id: item.id }, to: [{ toObjectId: key }] })) });
      }
      const properties = url.includes('/contacts') ? { email: 'person@example.test', firstname: 'Person', lastname: 'One', associatedcompanyid: '22' }
        : url.includes('/companies') ? { name: 'Company', domain: 'example.test', hubspot_owner_id: '42' }
          : { dealname: 'Deal', dealstage: 'custom_stage', amount: '123.45', closedate: '2026-10-31T00:00:00Z', hubspot_owner_id: '42' };
      return Response.json({ results: [{ id: '1', updatedAt, properties }] });
    });
    vi.stubGlobal('fetch', fetcher);
    const source = hubspotMonitorSource('fixture');
    const page = await source.list(null);
    expect(page.after).toBeNull();
    expect(page.contacts.map((record) => record.objectType)).toEqual(['Contact', 'Company', 'Deal']);
    expect(page.contacts.map(monitorRecordKey)).toEqual(['1', 'Company:1', 'Deal:1']);
    expect(page.contacts[1].properties).toMatchObject({ name: 'Company', domain: 'example.test', owner_id: '42', contact_ids: '["11"]' });
    expect(page.contacts[2].properties).toMatchObject({ name: 'Deal', stage: 'custom_stage', amount: '123.45', company_id: '22', company_ids: '["22"]', contact_ids: '["11"]' });
    for (const record of page.contacts.slice(1)) expect(inspectMonitorContact(record, null).issues).toEqual([]);
    await expect(source.patch('1', { company: 'Acme' }, 'Company')).rejects.toThrow('limited');
    await expect(source.patch('1', { jobtitle: 'Engineer' }, 'Deal')).rejects.toThrow('limited');
    expect(fetcher.mock.calls.some((call) => call[1]?.method === 'PATCH')).toBe(false);
  });

  it('uses object-specific HubSpot modified timestamps and records unavailable/truncated association coverage', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => url.includes('/associations/')
      ? Response.json({ results: [{ from: { id: '2' }, to: [{ toObjectId: '1' }], paging: { next: { after: 'more' } } }] })
      : Response.json({ total: 1, results: [{ id: '2', updatedAt, properties: { name: 'Company' } }] }));
    vi.stubGlobal('fetch', fetcher);
    const page = await hubspotMonitorSource('fixture').changes('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', 'Company:start');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).filterGroups[0].filters[0].propertyName).toBe('hs_lastmodifieddate');
    expect(page.contacts[0].properties.contact_ids).toBeUndefined();
    expect(page.contacts[0].coverage?.[0]).toContain('truncated');
  });

  it('reports per-object denied permissions and missing fields before scanning available native objects', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
      if (url.includes('/companies')) return new Response(null, { status: 403 });
      if (url.includes('/properties/contacts')) return Response.json({ results: [{ name: 'email' }, { name: 'lastmodifieddate' }] });
      if (url.includes('/properties/deals')) return Response.json({ results: [{ name: 'dealname' }, { name: 'hs_lastmodifieddate' }] });
      return Response.json({ results: [] });
    });
    vi.stubGlobal('fetch', fetcher);
    const source = hubspotMonitorSource('fixture');
    expect(await source.capabilities!()).toMatchObject([
      { objectType: 'Contact', status: 'partial', missingFields: expect.arrayContaining(['jobtitle']) },
      { objectType: 'Company', status: 'unavailable', detail: expect.stringContaining('403') },
      { objectType: 'Deal', status: 'partial' },
    ]);
    const before = fetcher.mock.calls.length;
    await source.list(null);
    expect(fetcher.mock.calls.slice(before).some(([url]) => url.includes('/companies'))).toBe(false);
  });

  it('reads Salesforce Accounts and Opportunities with native stage/amount/account/contact-role evidence', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
      const query = new URL(url).searchParams.get('q') ?? '';
      const records = query.includes('FROM Lead') || query.includes('FROM Contact') ? []
        : query.includes('FROM OpportunityContactRole') ? [{ OpportunityId: '006000000000001', ContactId: '003000000000002' }]
          : query.includes('FROM Account') ? [{ attributes: { type: 'Account' }, Id: '001000000000001', Name: 'Company', Website: 'https://example.test', OwnerId: null, SystemModstamp: updatedAt }]
            : [{ attributes: { type: 'Opportunity' }, Id: '006000000000001', Name: 'Deal', StageName: 'Custom commercial stage', Amount: 123.45, CloseDate: '2026-10-31', AccountId: '001000000000001', OwnerId: '005000000000001', IsClosed: false, IsWon: false, SystemModstamp: updatedAt }];
      return Response.json({ records, done: true });
    });
    vi.stubGlobal('fetch', fetcher);
    const source = salesforceMonitorSource(sfRoot, {}, org);
    const page = await source.list(null);
    expect(page.contacts.map((record) => record.objectType)).toEqual(['Account', 'Opportunity']);
    expect(page.contacts[1].properties).toMatchObject({ stage: 'Custom commercial stage', amount: '123.45', close_date: '2026-10-31', company_id: '001000000000001', contact_ids: '["003000000000002"]', is_closed: 'false' });
    for (const record of page.contacts) expect(inspectMonitorContact(record, null).issues).toEqual([]);
    await expect(source.patch('001000000000001', { company: 'Renamed' }, 'Account')).rejects.toThrow('limited');
    await expect(source.patch('006000000000001', { jobtitle: 'Engineer' }, 'Opportunity')).rejects.toThrow('limited');
    expect(fetcher.mock.calls.some((call) => call[1]?.method === 'PATCH')).toBe(false);
  });

  it('does not turn absent Salesforce fields into clears and fails partial relationship reads visibly', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/query?') ? new Response(null, { status: 403 }) : Response.json({
      attributes: { type: 'Opportunity' }, Id: '006000000000001', Name: 'Deal', SystemModstamp: updatedAt, Amount: null,
    })));
    const record = await salesforceMonitorSource(sfRoot, {}, org).read('006000000000001', 'Opportunity');
    expect(record.properties.amount).toBe('');
    expect(record.properties.stage).toBeUndefined();
    expect(record.properties.contact_ids).toBeUndefined();
    expect(record.coverage).toEqual([expect.stringContaining('unavailable')]);
  });
});

it.each([429, 500, 503])('fails transient HubSpot capability HTTP %s rather than completing an excluded-object baseline', async (status) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
  await expect(hubspotMonitorSource('fixture').capabilities!()).rejects.toThrow(`HTTP ${status}`);
});

it.each([429, 500, 503])('fails transient Salesforce capability HTTP %s rather than silently skipping native objects', async (status) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
  await expect(salesforceMonitorSource(sfRoot, {}, org).capabilities!()).rejects.toThrow(`HTTP ${status}`);
});

it('does not convert a timeout or malformed capability response into permission-denied coverage', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fixture request timed out'); }));
  await expect(hubspotMonitorSource('fixture').capabilities!()).rejects.toThrow('timed out');
  await expect(salesforceMonitorSource(sfRoot, {}, org).capabilities!()).rejects.toThrow('timed out');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ unexpected: 'shape' })));
  await expect(hubspotMonitorSource('fixture').capabilities!()).rejects.toThrow('metadata');
  await expect(salesforceMonitorSource(sfRoot, {}, org).capabilities!()).rejects.toThrow('metadata');
});
