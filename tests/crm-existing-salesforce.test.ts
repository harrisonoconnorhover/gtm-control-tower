import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSalesforceExisting } from '../lib/crm-existing-salesforce';
import type { PortableCrmContact } from '../lib/crm-workflow';

const apiRoot = 'https://synthetic.my.salesforce.com/services/data/v67.0';
const headers = { authorization: 'Bearer synthetic-token' };
const contact: PortableCrmContact = {
  contactId: 'C-1', email: 'alex@example.com', firstName: 'Alex', lastName: 'Morgan',
  company: 'Synthetic Lab', phone: null, jobTitle: null, website: null,
};
const leadRecord = {
  Id: '00Q-1', Email: 'alex@example.com', IsConverted: false,
  FirstName: 'Alex', LastName: 'Morgan', Company: 'Synthetic Lab',
  Phone: null, Title: 'Analyst', Website: null,
};
const contactRecord = {
  Id: '003-1', Email: 'alex@example.com', FirstName: 'Alex', LastName: 'Morgan',
  Phone: null, Title: 'Analyst', Account: { Name: 'Synthetic Account', Website: 'https://example.com' },
};

function mockPages(...pages: unknown[]) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(pages.shift()), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Salesforce exact-email comparison reads', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads converted Leads and Contacts, mapping Account fields and normalizing exact emails', async () => {
    const fetchMock = mockPages(
      { done: true, records: [{ ...leadRecord, IsConverted: true }] },
      { done: true, records: [contactRecord] },
    );
    const matches = await readSalesforceExisting([{ ...contact, email: ' ALEX@example.com ' }], apiRoot, headers);
    expect(matches.get('alex@example.com')).toEqual([
      {
        nativeId: '00Q-1', objectType: 'lead', isConverted: true, email: 'alex@example.com',
        fields: { firstName: 'Alex', lastName: 'Morgan', company: 'Synthetic Lab', phone: null, jobTitle: 'Analyst', website: null },
      },
      {
        nativeId: '003-1', objectType: 'contact', email: 'alex@example.com',
        fields: { firstName: 'Alex', lastName: 'Morgan', company: 'Synthetic Account', phone: null, jobTitle: 'Analyst', website: 'https://example.com' },
      },
    ]);
    const urls = fetchMock.mock.calls.map((call) => new URL((call as unknown as [string])[0]));
    expect(urls[0].searchParams.get('q')).toContain("FROM Lead WHERE Email IN ('alex@example.com')");
    expect(urls[0].searchParams.get('q')).toContain('IsConverted');
    expect(urls[0].searchParams.get('q')).not.toContain('IsConverted = FALSE');
    expect(urls[1].searchParams.get('q')).toContain('Account.Name, Account.Website FROM Contact');
  });

  it('reads every page of both objects and counts a repeated identity only once', async () => {
    const fetchMock = mockPages(
      { done: false, records: [leadRecord], nextRecordsUrl: '/services/data/v67.0/query/lead-2' },
      { done: true, records: [leadRecord, { ...leadRecord, Id: '00Q-2' }] },
      { done: false, records: [], nextRecordsUrl: `${apiRoot}/query/contact-2` },
      { done: true, records: [contactRecord] },
    );
    const matches = await readSalesforceExisting([contact], apiRoot, headers);
    expect(matches.get(contact.email)?.map((record) => record.nativeId)).toEqual(['00Q-1', '00Q-2', '003-1']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('allows a Contact with no Account while preserving its native identity', async () => {
    mockPages({ done: true, records: [] }, { done: true, records: [{ ...contactRecord, Account: null }] });
    const matches = await readSalesforceExisting([contact], apiRoot, headers);
    expect(matches.get(contact.email)?.[0]).toMatchObject({
      objectType: 'contact', fields: { company: null, website: null },
    });
  });

  it('rejects contradictory evidence for one identity instead of selecting a version', async () => {
    mockPages(
      { done: false, records: [leadRecord], nextRecordsUrl: '/services/data/v67.0/query/lead-2' },
      { done: true, records: [{ ...leadRecord, IsConverted: true }] },
    );
    await expect(readSalesforceExisting([contact], apiRoot, headers)).rejects.toThrow(/contradictory evidence/);
  });

  it.each([
    { records: [] },
    { done: true, records: null },
    { done: true, records: [null] },
    { done: true, records: [{ ...leadRecord, IsConverted: undefined }] },
    { done: true, records: [{ ...leadRecord, Company: 42 }] },
    { done: true, records: [{ ...leadRecord, Email: 'unrequested@example.com' }] },
    { done: false, records: [] },
    { done: true, records: [], nextRecordsUrl: '/services/data/v67.0/query/unexpected' },
  ])('rejects incomplete or malformed query evidence: %j', async (page) => {
    mockPages(page);
    await expect(readSalesforceExisting([contact], apiRoot, headers)).rejects.toThrow();
  });

  it.each([
    'https://other.my.salesforce.com/services/data/v67.0/query/cursor',
    '/services/data/v67.0/sobjects/Lead',
    '/services/data/v66.0/query/cursor',
    '/services/data/v67.0/query/cursor?other=true',
  ])('rejects a cursor outside this instance query endpoint: %s', async (nextRecordsUrl) => {
    const fetchMock = mockPages({ done: false, records: [], nextRecordsUrl });
    await expect(readSalesforceExisting([contact], apiRoot, headers)).rejects.toThrow(/invalid pagination cursor/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unfinished query at the ten-page ceiling', async () => {
    const fetchMock = mockPages(...Array.from({ length: 10 }, (_, page) => ({
      done: false, records: [], nextRecordsUrl: `/services/data/v67.0/query/page-${page + 2}`,
    })));
    await expect(readSalesforceExisting([contact], apiRoot, headers)).rejects.toThrow(/pagination limit/);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });
});
