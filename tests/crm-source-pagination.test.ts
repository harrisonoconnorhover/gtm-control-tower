import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHubSpotIdentityPage, readSalesforceIdentityPage } from '../lib/crm-source';

afterEach(() => vi.restoreAllMocks());

describe('CRM identity scan pagination', () => {
  it('returns a stable HubSpot cursor and provider metadata', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      results: [{
        id: '101', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        properties: {
          firstname: 'Ada', lastname: 'Lovelace', email: 'ada@example.com', company: 'Engines',
          mobilephone: '8145550100', state: 'Pennsylvania', hs_additional_emails: 'ada@engines.example; ada@old.example ;ada@engines.example;',
        },
      }],
      paging: { next: { after: '102' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const page = await readHubSpotIdentityPage('secret');
    expect(page).toMatchObject({ complete: false, nextCursor: { after: '102' } });
    expect(page.records[0]).toMatchObject({
      recordKey: 'hubspot:contact:101', objectType: 'contact', phone: '8145550100', state: 'Pennsylvania',
      additionalEmails: ['ada@engines.example', 'ada@old.example'],
    });
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get('properties')?.split(',')).toEqual(expect.arrayContaining(['state', 'hs_additional_emails']));
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows Salesforce queryMore and then advances from Leads to Contacts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        done: false,
        nextRecordsUrl: '/services/data/v67.0/query/next-leads',
        records: [{ Id: '00Q1', FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@example.com', Company: 'Engines', State: 'PA' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        done: true,
        records: [{ Id: '00Q2', FirstName: 'Grace', LastName: 'Hopper', Email: 'grace@example.com', Company: 'Navy' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        done: true,
        records: [{ Id: '0031', FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada+contact@example.com', MailingState: 'Pennsylvania', Account: { Name: 'Engines', Website: 'engines.example' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const first = await readSalesforceIdentityPage('https://example.my.salesforce.com', 'secret', '67.0');
    const second = await readSalesforceIdentityPage('https://example.my.salesforce.com', 'secret', '67.0', first.nextCursor!);
    const third = await readSalesforceIdentityPage('https://example.my.salesforce.com', 'secret', '67.0', second.nextCursor!);

    expect(first.nextCursor).toEqual({ objectType: 'lead', nextRecordsUrl: '/services/data/v67.0/query/next-leads' });
    expect(second.nextCursor).toEqual({ objectType: 'contact', nextRecordsUrl: null });
    expect(third).toMatchObject({ complete: true, nextCursor: null });
    expect(first.records[0]).toMatchObject({ state: 'PA' });
    expect(third.records[0]).toMatchObject({ recordKey: 'salesforce:contact:0031', objectType: 'contact', company: 'Engines', website: 'engines.example', state: 'Pennsylvania' });
    expect((fetchMock.mock.calls[0][0] as URL).searchParams.get('q')).toContain('State, CreatedDate');
    expect((fetchMock.mock.calls[0][0] as URL).searchParams.get('q')).toContain('WHERE IsConverted = FALSE');
    expect((fetchMock.mock.calls[2][0] as URL).searchParams.get('q')).toContain('MailingState, CreatedDate');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: 'manual' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['hubspot', 'salesforce'] as const)('rejects a %s redirect without following or retrying it', async (provider) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 302, headers: { location: 'https://elsewhere.example/contacts' },
    }));
    const read = provider === 'hubspot'
      ? readHubSpotIdentityPage('secret')
      : readSalesforceIdentityPage('https://example.my.salesforce.com', 'secret', '67.0');
    await expect(read).rejects.toThrow(/returned 302/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('retries a rate-limited HubSpot page without losing its cursor', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'slow down' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [], paging: {} }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(readHubSpotIdentityPage('secret', { after: '500' })).resolves.toMatchObject({ complete: true, records: [] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves valid identities when optional properties are missing or empty', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: '101', properties: { state: null, hs_additional_emails: null } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ done: true, records: [{ Id: '0031' }] })));
    const hubspot = await readHubSpotIdentityPage('secret');
    const salesforce = await readSalesforceIdentityPage('https://example.my.salesforce.com', 'secret', '67.0', { objectType: 'contact', nextRecordsUrl: null });
    expect(hubspot).toMatchObject({ complete: true, records: [{ nativeId: '101', email: '', state: '', additionalEmails: [] }] });
    expect(salesforce).toMatchObject({ complete: true, records: [{ nativeId: '0031', email: '', state: '' }] });
  });

  it.each([
    {},
    { results: {} },
    { results: [null] },
    { results: [{ id: ' ', properties: {} }] },
    { results: [{ id: '101', properties: [] }] },
    { results: [{ id: '101', properties: { hs_additional_emails: ['ada@example.com'] } }] },
    { results: [], paging: [] },
    { results: [], paging: { next: {} } },
    { results: [], paging: { next: { after: ' ' } } },
  ])('rejects malformed HubSpot records or pagination instead of claiming completion: %j', async (payload) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload)));
    await expect(readHubSpotIdentityPage('secret')).rejects.toThrow(/HubSpot/);
  });

  it('rejects a repeated HubSpot cursor', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: [], paging: { next: { after: '500' } } })));
    await expect(readHubSpotIdentityPage('secret', { after: '500' })).rejects.toThrow(/repeated/);
  });

  it.each([
    { records: [] },
    { records: [], done: 'true' },
    { records: {}, done: true },
    { records: [null], done: true },
    { records: [{ Id: 101 }], done: true },
    { records: [], done: false },
    { records: [], done: false, nextRecordsUrl: '' },
    { records: [], done: true, nextRecordsUrl: '/services/data/v67.0/query/unexpected' },
  ])('rejects malformed Salesforce records or pagination instead of claiming completion: %j', async (payload) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload)));
    await expect(readSalesforceIdentityPage('https://example.my.salesforce.com', 'secret', '67.0')).rejects.toThrow(/Salesforce/);
  });

  it.each([
    'https://elsewhere.example/services/data/v67.0/query/next',
    '/services/data/v66.0/query/next',
    '/services/data/v67.0/sobjects/Lead',
    'https://user:password@example.my.salesforce.com/services/data/v67.0/query/next',
  ])('rejects an unsafe Salesforce response cursor: %s', async (nextRecordsUrl) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ done: false, records: [], nextRecordsUrl })));
    await expect(readSalesforceIdentityPage('https://example.my.salesforce.com', 'secret', '67.0')).rejects.toThrow(/invalid pagination cursor/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a foreign input cursor before sending authorization', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(readSalesforceIdentityPage('https://example.my.salesforce.com', 'secret', '67.0', {
      objectType: 'lead', nextRecordsUrl: 'https://elsewhere.example/services/data/v67.0/query/next',
    })).rejects.toThrow(/invalid pagination cursor/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a repeated Salesforce cursor even when it changes from relative to absolute', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      done: false, records: [], nextRecordsUrl: 'https://example.my.salesforce.com/services/data/v67.0/query/next',
    })));
    await expect(readSalesforceIdentityPage('https://example.my.salesforce.com', 'secret', '67.0', {
      objectType: 'lead', nextRecordsUrl: '/services/data/v67.0/query/next',
    })).rejects.toThrow(/repeated/);
  });
});
