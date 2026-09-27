import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncDirectlyToSalesforce } from '../app/api/control-tower/salesforce-sync/route';
import { importContactsCsv } from '../lib/csv-control-tower';
import {
  combineSalesforceSyncReceipts,
  isSalesforceEligible,
  isSalesforceSyncBatch,
  isSalesforceSyncReceipt,
  toSalesforceSyncLead,
  type SalesforceSyncReceipt,
} from '../lib/salesforce-sync';

const lead = (contactId: string, email = 'alex@example.com') => ({
  contactId, email, firstName: 'Test', lastName: 'Person', company: 'Synthetic Lab',
  phone: null, jobTitle: null, website: null,
});
const nativeLead = (Id = '00Q-EXISTING', Email = 'alex@example.com') => ({
  Id, Email, IsConverted: false, FirstName: 'Test', LastName: 'Person', Company: 'Synthetic Lab',
  Phone: null, Title: null, Website: null,
});
const nativeContact = {
  Id: '003-CONTACT', Email: 'alex@example.com', FirstName: 'Test', LastName: 'Person',
  Phone: null, Title: null, Account: { Name: 'Synthetic Lab', Website: null },
};
const page = (records: unknown[] = []) => new Response(JSON.stringify({ done: true, records }));
function mockResponses(...responses: Response[]) {
  const fetchMock = vi.fn(async () => responses.shift() as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
function sync(leads = [lead('C-1')]) {
  return syncDirectlyToSalesforce({ syncId: 'sync-synthetic', sourceFile: 'synthetic.csv', leads },
    'https://example.my.salesforce.com', 'synthetic-token', '67.0');
}

describe('Salesforce sync contracts', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires a clean active identity plus Salesforce-required company and last name', () => {
    const contacts = importContactsCsv([
      'contact_id,full_name,email,company,expected_lifecycle_stage,lifecycle_stage',
      'C-1,Alex Morgan,alex@example.com,Example Inc,lead,lead',
      'C-2,Prince,prince@example.com,Example Inc,lead,lead',
      'C-3,No Company,nocompany@example.com,,lead,lead',
    ].join('\n')).contacts;

    expect(contacts.map(isSalesforceEligible)).toEqual([true, true, false]);
    expect(toSalesforceSyncLead(contacts[0])).toMatchObject({
      email: 'alex@example.com',
      firstName: 'Alex',
      lastName: 'Morgan',
      company: 'Example Inc',
    });
    expect(toSalesforceSyncLead(contacts[1])).toMatchObject({ firstName: '', lastName: 'Prince' });
  });

  it('validates portable Lead batches and caps them at 100 records', () => {
    const lead = {
      contactId: 'C-1', email: 'alex@example.com', firstName: 'Alex', lastName: 'Morgan',
      company: 'Example Inc', phone: null, jobTitle: null, website: null,
    };
    expect(isSalesforceSyncBatch({ syncId: 'sync-1', sourceFile: 'contacts.csv', leads: [lead] })).toBe(true);
    expect(isSalesforceSyncBatch({ syncId: 'sync-1', sourceFile: 'contacts.csv', leads: Array(101).fill(lead) })).toBe(false);
    expect(isSalesforceSyncBatch({
      syncId: 'sync-1', sourceFile: 'contacts.csv', leads: [{ ...lead, company: '' }],
    })).toBe(false);
    expect(isSalesforceSyncBatch({
      syncId: 'sync-1', sourceFile: 'contacts.csv', leads: [lead, { ...lead, contactId: 'C-2' }],
    })).toBe(false);
  });

  it('validates and combines created, updated, and failed receipts', () => {
    const receipt: SalesforceSyncReceipt = {
      accepted: true,
      status: 'partial',
      syncId: 'sync-1-1',
      requested: 2,
      created: 1,
      updated: 0,
      failed: 1,
      records: [
        { contactId: 'C-1', email: 'alex@example.com', status: 'created', salesforceId: '00Q1', error: null },
        { contactId: 'C-2', email: 'sam@example.com', status: 'failed', salesforceId: null, error: 'duplicate Leads' },
      ],
      completedAt: '2026-08-25T13:00:00.000Z',
    };
    expect(isSalesforceSyncReceipt(receipt)).toBe(true);
    const retried: SalesforceSyncReceipt = {
      ...receipt,
      syncId: 'sync-1-2',
      requested: 1,
      created: 0,
      updated: 1,
      failed: 0,
      records: [{ contactId: 'C-2', email: 'sam@example.com', status: 'updated', salesforceId: '00Q2', error: null }],
    };
    const combined = combineSalesforceSyncReceipts([receipt, retried], 'sync-1');
    expect(combined).toMatchObject({ status: 'complete', requested: 2, created: 1, updated: 1, failed: 0 });
  });

  it('queries first, creates missing Leads, updates one match, and holds duplicate matches', async () => {
    const fetchMock = mockResponses(
      page([nativeLead(), nativeLead('00Q-DUP-1', 'sam@example.com'), nativeLead('00Q-DUP-2', 'sam@example.com')]),
      page(),
      new Response(JSON.stringify([{ id: '00Q-CREATED', success: true, errors: [] }])),
      new Response(JSON.stringify([{ id: '00Q-EXISTING', success: true, errors: [] }])),
    );
    const receipt = await sync([lead('C-1'), lead('C-2', 'new@example.com'), lead('C-3', 'sam@example.com')]);

    expect(receipt).toMatchObject({ status: 'partial', created: 1, updated: 1, failed: 1 });
    expect(receipt.records.map((record) => record.status)).toEqual(['updated', 'created', 'failed']);
    expect(receipt.records[2].error).toMatch(/2 Leads or Contacts/);
    const createCall = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    const createBody = JSON.parse(String(createCall[1]?.body));
    expect(createBody.records[0]).toMatchObject({ Email: 'new@example.com', Company: 'Synthetic Lab' });
    expect(createBody.records[0]).not.toHaveProperty('OwnerId');
    for (const call of fetchMock.mock.calls.slice(2)) {
      const options = (call as unknown as [string, RequestInit])[1];
      expect(options.headers).toMatchObject({ 'Sforce-Duplicate-Rule-Header': 'allowSave=false' });
    }
  });

  it.each([
    { name: 'Contact-only', leads: [], contacts: [nativeContact], reason: /already has a Contact/ },
    { name: 'converted Lead-only', leads: [{ ...nativeLead(), IsConverted: true }], contacts: [], reason: /converted Lead/ },
    { name: 'Lead and Contact', leads: [nativeLead()], contacts: [nativeContact], reason: /2 Leads or Contacts/ },
  ])('holds $name matches without creating or updating a Lead', async ({ leads, contacts, reason }) => {
    const fetchMock = mockResponses(page(leads), page(contacts));
    const receipt = await sync();
    expect(receipt).toMatchObject({ created: 0, updated: 0, failed: 1 });
    expect(receipt.records[0].error).toMatch(reason);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('holds a Contact found on a later query page before any write', async () => {
    const fetchMock = mockResponses(
      page(),
      new Response(JSON.stringify({ done: false, records: [], nextRecordsUrl: '/services/data/v67.0/query/contact-2' })),
      page([nativeContact]),
    );
    const receipt = await sync();
    expect(receipt).toMatchObject({ created: 0, updated: 0, failed: 1 });
    expect(receipt.records[0].error).toMatch(/Contact/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    { status: 503, body: { message: 'Service unavailable' } },
    { status: 200, body: { done: true, records: [null] } },
    { status: 200, body: { records: [] } },
    { status: 200, body: { done: false, records: [] } },
  ])('makes zero writes if the Contact lookup fails or is incomplete: %j', async ({ status, body }) => {
    const fetchMock = mockResponses(page([nativeLead()]), new Response(JSON.stringify(body), { status }));
    await expect(sync()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every((call) => (call as unknown as [string])[0].includes('/query?'))).toBe(true);
  });

  it('holds multiple imported rows targeting the same native Lead', async () => {
    const fetchMock = mockResponses(page([nativeLead()]), page());
    const receipt = await sync([lead('C-1'), lead('C-2', 'ALEX@example.com')]);
    expect(receipt).toMatchObject({ created: 0, updated: 0, failed: 2 });
    expect(receipt.records.every((record) => record.error?.includes('Multiple imported rows'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a duplicate-rule rejection without retrying or bypassing the rule', async () => {
    const fetchMock = mockResponses(page(), page(), new Response(JSON.stringify([{
      success: false, errors: [{ statusCode: 'DUPLICATES_DETECTED', message: 'A matching Contact already exists.' }],
    }])));
    const receipt = await sync();
    expect(receipt).toMatchObject({ created: 0, updated: 0, failed: 1 });
    expect(receipt.records[0].error).toBe('A matching Contact already exists.');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
