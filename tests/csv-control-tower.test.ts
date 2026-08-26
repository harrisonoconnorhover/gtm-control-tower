import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  countCsvRepairCandidates,
  executeCsvRepair,
  exportContactsCsv,
  importContactsCsv,
  isDestinationReadyContact,
  previewContactsCsv,
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

  it('holds unresolved active contacts out of generic destinations', () => {
    const imported = importContactsCsv(funkyCsv).contacts;
    expect(imported.filter(isDestinationReadyContact)).toHaveLength(0);
    const merged = executeCsvRepair(imported, 'duplicate-surge').contacts;
    const rerouted = executeCsvRepair(merged, 'routing-overload').contacts;
    const replayed = executeCsvRepair(rerouted, 'stage-regression').contacts;
    expect(replayed.filter(isDestinationReadyContact).map((contact) => contact.contactId)).toEqual(['C-1', 'C-4']);
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

  it('previews and imports arbitrary columns through an explicit visual mapping', () => {
    const csv = 'Person label,Primary inbox,Organization label\nAda Lovelace,ada@example.com,Analytical Engines';
    const preview = previewContactsCsv(csv);
    expect(preview.headers).toEqual(['Person label', 'Primary inbox', 'Organization label']);
    expect(preview.sampleRows[0]['Primary inbox']).toBe('ada@example.com');
    const imported = importContactsCsv(csv, {
      fullName: 'Person label',
      rawEmail: 'Primary inbox',
      company: 'Organization label',
    });
    expect(imported.contacts[0]).toMatchObject({
      fullName: 'Ada Lovelace',
      normalizedEmail: 'ada@example.com',
      company: 'Analytical Engines',
    });
  });

  it('rejects duplicate normalized headers before mapping', () => {
    expect(() => previewContactsCsv('Email,email!\na@example.com,b@example.com')).toThrow(/duplicate column names/i);
  });

  it('keeps the downloadable template importable with HubSpot standard fields', () => {
    const template = readFileSync(new URL('../public/control-tower-csv-template.csv', import.meta.url), 'utf8');
    const contacts = importContactsCsv(template).contacts;
    expect(contacts).toHaveLength(10);
    expect(countCsvRepairCandidates(contacts, 'duplicate-surge')).toBe(2);
    expect(countCsvRepairCandidates(contacts, 'stage-regression')).toBe(3);
    expect(contacts[0]).toMatchObject({ phone: '+14125550101', jobTitle: 'VP Sales', website: 'https://northstar.ai' });
  });
});
