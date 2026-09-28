import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSalesforceExisting, readSalesforceLeadById } from '../lib/crm-existing-salesforce';
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
  Id: '003-1', Email: 'alex@example.com',
};

function mockPages(...pages: unknown[]) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(pages.shift()), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Salesforce selected-Lead reads', () => {
  const selectedId = '00Q000000000001EAA';
  const selectedLead = { ...leadRecord, Id: selectedId };
  afterEach(() => vi.unstubAllGlobals());

  it.each(['00Q000000000001', selectedId])('reads a Lead by ID and preserves its CRM email: %s', async (nativeId) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ...selectedLead, Id: nativeId, Email: ' CRM@example.com ' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await readSalesforceLeadById(nativeId, apiRoot, headers)).toEqual({
      nativeId, objectType: 'lead', isConverted: false, email: 'crm@example.com',
      fields: { firstName: 'Alex', lastName: 'Morgan', company: 'Synthetic Lab', phone: null, jobTitle: 'Analyst', website: null },
    });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe(`/services/data/v67.0/sobjects/Lead/${nativeId}`);
    expect(url.searchParams.get('fields')).toBe('Id,Email,IsConverted,FirstName,LastName,Company,Phone,Title,Website');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store', redirect: 'manual', headers });
  });

  it('returns null for a missing Lead and exposes converted status for the caller to hold', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ...selectedLead, IsConverted: true })));
    expect(await readSalesforceLeadById(selectedId, apiRoot, headers)).toBeNull();
    expect(await readSalesforceLeadById(selectedId, apiRoot, headers)).toMatchObject({ nativeId: selectedId, isConverted: true });
  });

  it.each(['', '00Q-1', '00Q000000000001 ', '../00Q000000000001', '00Q000000000001EA'])('rejects a malformed requested ID before reading: %s', async (nativeId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(readSalesforceLeadById(nativeId, apiRoot, headers)).rejects.toThrow('record ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates the instance API root before sending credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(readSalesforceLeadById(selectedId, 'http://synthetic.my.salesforce.com/services/data/v67.0', headers)).rejects.toThrow('instance API root');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong ID', { ...selectedLead, Id: '00Q000000000002EAA' }, 200],
    ['missing conversion status', { ...selectedLead, IsConverted: undefined }, 200],
    ['invalid email', { ...selectedLead, Email: 'invalid-email' }, 200],
    ['missing identity', { ...selectedLead, Id: undefined }, 200],
    ['invalid property', { ...selectedLead, Company: 42 }, 200],
    ['service error', { message: 'Unavailable' }, 503],
    ['partial result', selectedLead, 207],
    ['redirect', selectedLead, 302],
  ])('rejects %s instead of establishing an update target', async (_label, payload, status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload, { status: status as number })));
    await expect(readSalesforceLeadById(selectedId, apiRoot, headers)).rejects.toThrow('Salesforce');
  });
});

describe('Salesforce exact-email comparison reads', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads converted Leads and identity-only Contacts, normalizing exact emails', async () => {
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
        fields: { firstName: null, lastName: null, company: null, phone: null, jobTitle: null, website: null },
      },
    ]);
    const urls = fetchMock.mock.calls.map((call) => new URL((call as unknown as [string])[0]));
    expect(urls[0].searchParams.get('q')).toContain("FROM Lead WHERE Email IN ('alex@example.com')");
    expect(urls[0].searchParams.get('q')).toContain('IsConverted');
    expect(urls[0].searchParams.get('q')).not.toContain('IsConverted = FALSE');
    expect(urls[1].searchParams.get('q')).toBe("SELECT Id, Email FROM Contact WHERE Email IN ('alex@example.com')");
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

  it('ignores unused Contact properties while preserving its native identity', async () => {
    mockPages({ done: true, records: [] }, { done: true, records: [{ ...contactRecord, Account: 42, FirstName: false }] });
    const matches = await readSalesforceExisting([contact], apiRoot, headers);
    expect(matches.get(contact.email)?.[0]).toMatchObject({
      objectType: 'contact', fields: { company: null, website: null },
    });
  });

  it('rejects redirects without following them or accepting incomplete match evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: 'https://other.my.salesforce.com/query' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readSalesforceExisting([contact], apiRoot, headers)).rejects.toThrow('Salesforce query returned 302');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
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
