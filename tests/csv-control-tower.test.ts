import { describe, expect, it } from 'vitest';
import {
  countCsvRepairCandidates,
  executeCsvRepair,
  exportContactsCsv,
  importContactsCsv,
} from '../lib/csv-control-tower';

const funkyCsv = `contact_id,full_name,email,normalized_email,company,region,segment,lifecycle_stage,expected_lifecycle_stage,owner_id
C-1,Alex Morgan,alex@example.com,,Example Inc,Northeast,Enterprise,customer,customer,NE-ENT
C-2," Alex, Jr. ",ALEX+EVENT@EXAMPLE.COM,alex@example.com,"Example, Incorporated",Northeast,Enterprise,mql,customer,NE-ENT
C-3,Mia Santos,mia.santos @ gmail.com,,,West,SMB,lead,lead,
C-4,Robin Cho,robin@oak.co,,Oak Co,Northeast,Mid-Market,mql,sql,NE-MM`;

describe('CSV control tower', () => {
  it('imports common contact fields and infers quality flags', () => {
    const result = importContactsCsv(funkyCsv);
    expect(result.sourceRows).toBe(4);
    expect(result.contacts[1]).toMatchObject({
      fullName: 'Alex, Jr.',
      normalizedEmail: 'alex@example.com',
      qualityFlags: expect.arrayContaining(['duplicate_identity', 'plus_address_present', 'stage_regression']),
    });
    expect(result.contacts[2]).toMatchObject({
      normalizedEmail: null,
      qualityFlags: expect.arrayContaining(['invalid_email', 'missing_company', 'missing_owner']),
    });
  });

  it('executes merge, reroute, and lifecycle replay locally', () => {
    const imported = importContactsCsv(funkyCsv).contacts;
    expect(countCsvRepairCandidates(imported, 'duplicate-surge')).toBe(1);
    const merged = executeCsvRepair(imported, 'duplicate-surge');
    expect(merged.receipt.affectedRecords).toBe(1);
    expect(merged.contacts[1]).toMatchObject({ recordStatus: 'merged', canonicalContactId: 'C-1' });

    const rerouted = executeCsvRepair(merged.contacts, 'routing-overload');
    expect(rerouted.receipt.affectedRecords).toBe(1);
    expect(rerouted.contacts[0].ownerId).toBe('CE-ENT-OVERFLOW');

    const replayed = executeCsvRepair(rerouted.contacts, 'stage-regression');
    expect(replayed.receipt.affectedRecords).toBe(1);
    expect(replayed.contacts[3]).toMatchObject({ lifecycleStage: 'sql', lastAction: 'lifecycle_replayed' });
  });

  it('exports repaired state as valid quoted CSV', () => {
    const contacts = importContactsCsv(funkyCsv).contacts;
    const exported = exportContactsCsv(contacts);
    expect(exported).toContain('"Alex, Jr."');
    expect(importContactsCsv(exported).contacts).toHaveLength(4);
  });

  it('rejects files without a usable identity column', () => {
    expect(() => importContactsCsv('company,region\nAcme,West')).toThrow(/email or full_name/);
  });
});
