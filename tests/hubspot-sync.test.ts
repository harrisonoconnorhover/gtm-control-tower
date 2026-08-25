import { describe, expect, it } from 'vitest';
import { executeCsvRepair, importContactsCsv } from '../lib/csv-control-tower';
import {
  combineHubSpotSyncReceipts,
  isHubSpotEligible,
  isHubSpotSyncBatch,
  isHubSpotSyncReceipt,
  toHubSpotSyncContact,
  type HubSpotSyncReceipt,
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
