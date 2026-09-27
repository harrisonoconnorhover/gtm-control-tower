import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHubSpotContacts, syncDirectlyToHubSpot } from '../app/api/control-tower/hubspot-sync/route';
import { executeCsvRepair, importContactsCsv } from '../lib/csv-control-tower';
import {
  combineHubSpotSyncReceipts,
  isHubSpotEligible,
  isHubSpotSyncBatch,
  isHubSpotSyncReceipt,
  toHubSpotSyncContact,
  type HubSpotSyncReceipt,
  type HubSpotSyncBatch,
} from '../lib/hubspot-sync';

const csv = `contact_id,full_name,email,normalized_email,company,region,segment,lifecycle_stage,expected_lifecycle_stage,owner_id,phone,job_title
C-1,Alex Morgan,alex@example.com,,Example Inc,Northeast,Enterprise,customer,customer,NE-ENT,+15551234567,VP Sales
C-2,Alex Morgan,ALEX+EVENT@EXAMPLE.COM,alex@example.com,Example Inc,Northeast,Enterprise,mql,customer,NE-ENT,,
C-3,Robin Cho,robin@oak.co,,Oak Co,Northeast,Mid-Market,mql,sql,NE-MM,,Analyst`;

describe('HubSpot sync contracts', () => {
  it('holds unresolved records and maps only governed active contacts', () => {
    const imported = importContactsCsv(csv).contacts;
    expect(imported.every((contact) => !isHubSpotEligible(contact))).toBe(true);

    const merged = executeCsvRepair(imported, 'duplicate-surge').contacts;
    const replayed = executeCsvRepair(merged, 'stage-regression').contacts;
    const eligible = replayed.filter(isHubSpotEligible);
    expect(eligible.map((contact) => contact.contactId)).toEqual(['C-1', 'C-3']);
    expect(toHubSpotSyncContact(eligible[0])).toMatchObject({
      email: 'alex@example.com',
      firstName: 'Alex',
      lastName: 'Morgan',
      phone: '+15551234567',
      jobTitle: 'VP Sales',
    });
  });

  it('validates portable batches and caps them at 100 records', () => {
    const contact = {
      contactId: 'C-1', email: 'alex@example.com', firstName: 'Alex', lastName: 'Morgan',
      company: 'Example Inc', phone: null, jobTitle: null, website: null,
    };
    expect(isHubSpotSyncBatch({ syncId: 'sync-1', sourceFile: 'contacts.csv', contacts: [contact] })).toBe(true);
    expect(isHubSpotSyncBatch({ syncId: 'sync-1', sourceFile: 'contacts.csv', contacts: Array(101).fill(contact) })).toBe(false);
    expect(isHubSpotSyncBatch({ syncId: 'sync-1', sourceFile: 'contacts.csv', contacts: [contact, { ...contact, email: 'other@example.com' }] })).toBe(false);
    expect(isHubSpotSyncBatch({ syncId: 'sync-1', sourceFile: 'contacts.csv', contacts: [contact, { ...contact, contactId: 'C-2', email: 'ALEX@example.com' }] })).toBe(false);
  });

  it('validates and combines per-record native receipts', () => {
    const receipt: HubSpotSyncReceipt = {
      accepted: true,
      status: 'complete',
      syncId: 'sync-1-1',
      requested: 1,
      synced: 1,
      failed: 0,
      records: [{
        contactId: 'C-1', email: 'alex@example.com', status: 'synced',
        hubSpotId: '123', created: false, error: null,
      }],
      completedAt: '2026-08-25T13:00:00.000Z',
    };
    expect(isHubSpotSyncReceipt(receipt)).toBe(true);
    const retried = {
      ...receipt,
      syncId: 'sync-1-2',
      records: [{ ...receipt.records[0], hubSpotId: '456' }],
    };
    const combined = combineHubSpotSyncReceipts([receipt, retried], 'sync-1');
    expect(combined).toMatchObject({ status: 'complete', requested: 1, synced: 1, failed: 0 });
    expect(combined.records[0].hubSpotId).toBe('456');
  });
});

const directBatch: HubSpotSyncBatch = {
  syncId: 'sync-1', sourceFile: 'contacts.csv', contacts: [{
    contactId: 'C-1', email: 'secondary@example.com', firstName: 'Alex', lastName: 'Morgan',
    company: 'Example Inc', phone: null, jobTitle: '', website: null,
  }],
};
const nativeContact = {
  id: '123', properties: { email: 'primary@example.com', hs_additional_emails: 'secondary@example.com' },
};
const readResponse = (results: unknown[]) => Response.json({ status: 'COMPLETE', results });

afterEach(() => vi.unstubAllGlobals());

describe('direct HubSpot sync identity safeguards', () => {
  it('updates a known secondary-email match by native ID without rewriting email or clearing null fields', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(readResponse([nativeContact]))
      .mockResolvedValueOnce(Response.json({ status: 'COMPLETE', results: [{ id: '123' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const receipt = await syncDirectlyToHubSpot(directBatch, 'test-token');
    expect(receipt.records).toEqual([expect.objectContaining({ status: 'synced', hubSpotId: '123', created: false })]);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/batch\/update$/);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ inputs: [{
      id: '123', objectWriteTraceId: 'sync-1:C-1',
      properties: { firstname: 'Alex', lastname: 'Morgan', company: 'Example Inc', jobtitle: '' },
    }] });
  });

  it('holds primary and secondary input rows targeting the same native record while creating unrelated confirmed-absent rows', async () => {
    const batch = { ...directBatch, contacts: [
      directBatch.contacts[0], { ...directBatch.contacts[0], contactId: 'C-2', email: 'primary@example.com' },
      { ...directBatch.contacts[0], contactId: 'C-3', email: 'new@example.com' },
    ] };
    const fetchMock = vi.fn().mockResolvedValueOnce(readResponse([nativeContact]))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ results: [{ id: '456', objectWriteTraceId: 'sync-1:C-3' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const receipt = await syncDirectlyToHubSpot(batch, 'test-token');
    expect(receipt).toMatchObject({ requested: 3, synced: 1, failed: 2, status: 'partial' });
    expect(receipt.records.slice(0, 2).every((record) => record.error?.startsWith('Held:'))).toBe(true);
    expect(fetchMock.mock.calls[2][0]).toMatch(/\/batch\/create$/);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).inputs).toEqual([expect.objectContaining({ properties: expect.objectContaining({ email: 'new@example.com' }) })]);
  });

  it('holds ambiguous native matches without any write', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(readResponse([nativeContact, { ...nativeContact, id: '456' }]));
    vi.stubGlobal('fetch', fetchMock);
    const receipt = await syncDirectlyToHubSpot(directBatch, 'test-token');
    expect(receipt).toMatchObject({ synced: 0, failed: 1 });
    expect(receipt.records[0].error).toMatch(/^Held:/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops before writes when missing batch results cannot be confirmed', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(readResponse([]))
      .mockResolvedValueOnce(Response.json({ message: 'Rate limited' }, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(syncDirectlyToHubSpot(directBatch, 'test-token')).rejects.toThrow('HubSpot could not confirm');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate input identities before lookup or writing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(syncDirectlyToHubSpot({ ...directBatch, contacts: [directBatch.contacts[0], directBatch.contacts[0]] }, 'test-token')).rejects.toThrow('duplicate');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never falls back to upsert when a confirmed-absent identity conflicts at creation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(readResponse([]))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ message: 'Contact already exists' }, { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const receipt = await syncDirectlyToHubSpot(directBatch, 'test-token');
    expect(receipt.records[0]).toMatchObject({ status: 'failed', created: null, error: 'Contact already exists' });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/\/batch\/read$/), expect.stringContaining('/secondary%40example.com?'),
      expect.stringMatching(/\/batch\/create$/),
    ]);
  });

  it('preserves per-record create errors and correlates successful receipts without relying on response order', async () => {
    const batch = { ...directBatch, contacts: [directBatch.contacts[0], { ...directBatch.contacts[0], contactId: 'C-2', email: 'other@example.com' }] };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({
      results: [{ id: '456', properties: { email: 'other@example.com' } }],
      errors: [{ message: 'Contact already exists', context: { objectWriteTraceId: ['sync-1:C-1'] } }],
    }, { status: 207 }));
    vi.stubGlobal('fetch', fetchMock);
    const receipt = await createHubSpotContacts(batch, 'test-token');
    expect(receipt).toMatchObject({ requested: 2, synced: 1, failed: 1 });
    expect(receipt.records[0]).toMatchObject({ status: 'failed', error: 'Contact already exists' });
    expect(receipt.records[1]).toMatchObject({ status: 'synced', hubSpotId: '456', created: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
