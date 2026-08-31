import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHubSpotIdentityPage, readSalesforceIdentityPage } from '../lib/crm-source';

afterEach(() => vi.restoreAllMocks());

describe('CRM identity scan pagination', () => {
  it('returns a stable HubSpot cursor and provider metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      results: [{
        id: '101', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        properties: { firstname: 'Ada', lastname: 'Lovelace', email: 'ada@example.com', company: 'Engines', mobilephone: '8145550100' },
      }],
      paging: { next: { after: '102' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const page = await readHubSpotIdentityPage('secret');
    expect(page).toMatchObject({ complete: false, nextCursor: { after: '102' } });
    expect(page.records[0]).toMatchObject({ recordKey: 'hubspot:contact:101', objectType: 'contact', phone: '8145550100' });
  });

  it('follows Salesforce queryMore and then advances from Leads to Contacts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        done: false,
        nextRecordsUrl: '/services/data/v67.0/query/next-leads',
        records: [{ Id: '00Q1', FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@example.com', Company: 'Engines' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        done: true,
        records: [{ Id: '00Q2', FirstName: 'Grace', LastName: 'Hopper', Email: 'grace@example.com', Company: 'Navy' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        done: true,
        records: [{ Id: '0031', FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada+contact@example.com', Account: { Name: 'Engines', Website: 'engines.example' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const first = await readSalesforceIdentityPage('https://example.my.salesforce.com', 'secret', '67.0');
    const second = await readSalesforceIdentityPage('https://example.my.salesforce.com', 'secret', '67.0', first.nextCursor!);
    const third = await readSalesforceIdentityPage('https://example.my.salesforce.com', 'secret', '67.0', second.nextCursor!);

    expect(first.nextCursor).toEqual({ objectType: 'lead', nextRecordsUrl: '/services/data/v67.0/query/next-leads' });
    expect(second.nextCursor).toEqual({ objectType: 'contact', nextRecordsUrl: null });
    expect(third).toMatchObject({ complete: true, nextCursor: null });
    expect(third.records[0]).toMatchObject({ recordKey: 'salesforce:contact:0031', objectType: 'contact', company: 'Engines', website: 'engines.example' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a rate-limited HubSpot page without losing its cursor', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'slow down' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [], paging: {} }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(readHubSpotIdentityPage('secret', { after: '500' })).resolves.toMatchObject({ complete: true, records: [] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
