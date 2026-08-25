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
    const responses = [
      { ok: true, status: 200, json: async () => ({ done: true, records: [
        { Id: '00Q-EXISTING', Email: 'alex@example.com' },
        { Id: '00Q-DUP-1', Email: 'sam@example.com' },
        { Id: '00Q-DUP-2', Email: 'sam@example.com' },
      ] }) },
      { ok: true, status: 200, json: async () => ([{ id: '00Q-CREATED', success: true, errors: [] }]) },
      { ok: true, status: 200, json: async () => ([{ id: '00Q-EXISTING', success: true, errors: [] }]) },
    ];
    const fetchMock = vi.fn(async () => responses.shift() as Response);
    vi.stubGlobal('fetch', fetchMock);
    const lead = (contactId: string, email: string) => ({
      contactId, email, firstName: 'Test', lastName: 'Person', company: 'Synthetic Lab',
      phone: null, jobTitle: null, website: null,
    });

    const receipt = await syncDirectlyToSalesforce({
      syncId: 'sync-live-shape',
      sourceFile: 'synthetic.csv',
      leads: [lead('C-1', 'alex@example.com'), lead('C-2', 'new@example.com'), lead('C-3', 'sam@example.com')],
    }, 'https://example.my.salesforce.com', 'secret', '67.0');

    expect(receipt).toMatchObject({ status: 'partial', created: 1, updated: 1, failed: 1 });
    expect(receipt.records.map((record) => record.status)).toEqual(['updated', 'created', 'failed']);
    expect(receipt.records[2].error).toMatch(/2 active Leads/);
    const createCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const createBody = JSON.parse(String(createCall[1]?.body));
    expect(createBody.records[0]).toMatchObject({ Email: 'new@example.com', Company: 'Synthetic Lab' });
    expect(createBody.records[0]).not.toHaveProperty('OwnerId');
  });
});
