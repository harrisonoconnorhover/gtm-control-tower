import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  countCsvRepairCandidates,
  destinationHoldFlags,
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

  it('holds malformed supplied normalized emails even when the raw address is valid', () => {
    const csv = `full_name,email,normalized_email,company,owner_id
Alex Chen,not an email,also-not-an-email,Northstar,rep-1
Mia Santos,mia@example.com,not an email,Northstar,rep-1`;
    const contacts = importContactsCsv(csv).contacts;

    for (const contact of contacts) {
      expect(contact.normalizedEmail).toBeNull();
      expect(contact.qualityFlags).toContain('invalid_email');
      expect(isDestinationReadyContact(contact)).toBe(false);
    }
  });

  it('clears a repaired missing owner while preserving independent blockers and repeat safety', () => {
    const csv = `email,company,region,segment,owner_id
ada@example.com,Acme,Northeast,Enterprise,
not an email,Acme,Northeast,Enterprise,`;
    const imported = importContactsCsv(csv).contacts;
    const rerouted = executeCsvRepair(imported, 'routing-overload');

    expect(rerouted.receipt.affectedRecords).toBe(2);
    expect(rerouted.contacts[0]).toMatchObject({ ownerId: 'CE-ENT-OVERFLOW', qualityFlags: [] });
    expect(isDestinationReadyContact(rerouted.contacts[0])).toBe(true);
    expect(rerouted.contacts[1]).toMatchObject({ ownerId: 'CE-ENT-OVERFLOW', qualityFlags: ['invalid_email'] });
    expect(isDestinationReadyContact(rerouted.contacts[1])).toBe(false);
    const repeated = executeCsvRepair(rerouted.contacts, 'routing-overload');
    expect(repeated.receipt.affectedRecords).toBe(0);
    expect(repeated.contacts).toEqual(rerouted.contacts);
  });

  it('validates supplied normalized emails with the same case and IDNA rules as raw emails', () => {
    const csv = `full_name,email,normalized_email,company,owner_id
Alex Chen,original@example.com,SIGNAL@MAÑANA.EXAMPLE,Northstar,rep-1`;
    const [contact] = importContactsCsv(csv).contacts;

    expect(contact.rawEmail).toBe('original@example.com');
    expect(contact.normalizedEmail).toBe('signal@xn--maana-pta.example');
    expect(isDestinationReadyContact(contact)).toBe(true);
  });

  it('holds unresolved active contacts out of generic destinations', () => {
    const imported = importContactsCsv(funkyCsv).contacts;
    expect(imported.filter(isDestinationReadyContact)).toHaveLength(0);
    const merged = executeCsvRepair(imported, 'duplicate-surge').contacts;
    const rerouted = executeCsvRepair(merged, 'routing-overload').contacts;
    const replayed = executeCsvRepair(rerouted, 'stage-regression').contacts;
    expect(replayed.filter(isDestinationReadyContact).map((contact) => contact.contactId)).toEqual(['C-1', 'C-4']);
    expect(destinationHoldFlags(imported[1])).toEqual(['stage_regression', 'duplicate_identity']);
    expect(destinationHoldFlags(replayed[0])).toEqual([]);
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

  it.each([
    ['extra', 'ada@example.com,Acme, Inc,rep-1', 4],
    ['missing', 'ada@example.com,Acme', 2],
  ])('rejects %s CSV columns before preview or import', (_label, row, columns) => {
    const csv = `email,company,owner_id\n${row}`;
    for (const read of [previewContactsCsv, importContactsCsv]) {
      expect(() => read(csv)).toThrow(`CSV row 2 has ${columns} columns; the header has 3.`);
    }
  });

  it('preserves quoted commas, embedded newlines, and explicit empty cells', () => {
    const csv = 'email,company,owner_id\nada@example.com,"Acme, Inc",rep-1\nbob@example.com,"Acme,\nWest",\n';
    const preview = previewContactsCsv(csv);
    const imported = importContactsCsv(csv);

    expect(preview.sourceRows).toBe(2);
    expect(preview.sampleRows[0]).toEqual({ email: 'ada@example.com', company: 'Acme, Inc', owner_id: 'rep-1' });
    expect(imported.contacts[0]).toMatchObject({ company: 'Acme, Inc', ownerId: 'rep-1' });
    expect(imported.contacts[1]).toMatchObject({ company: 'Acme,\nWest', ownerId: null });
  });

  it('identifies the malformed CSV row after a quoted multiline record', () => {
    const csv = 'email,company,owner_id\nada@example.com,"Acme,\nWest",rep-1\nbob@example.com,Acme';
    for (const read of [previewContactsCsv, importContactsCsv]) {
      expect(() => read(csv)).toThrow('CSV row 3 has 2 columns; the header has 3.');
    }
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

  it('rejects duplicate normalized headers before preview or direct import', () => {
    const csv = 'Email,email!,company,owner_id\na@example.com,b@example.com,Acme,rep-1';
    for (const read of [previewContactsCsv, importContactsCsv]) {
      expect(() => read(csv)).toThrow(/duplicate column names/i);
    }
  });

  it.each([
    ['the same identity', 'ADA@example.com'],
    ['different identities', 'bob@example.com'],
  ])('rejects repeated contact IDs for %s with the original CSV row numbers', (_label, email) => {
    const csv = `contact_id,email,company,owner_id\nrepeat,ada@example.com,Acme,rep-1\n\nrepeat,${email},Acme,rep-1`;
    expect(() => importContactsCsv(csv)).toThrow('CSV row 4 has duplicate contact ID "repeat" (first used on row 2).');
  });

  it('rejects a supplied contact ID that collides with a generated ID', () => {
    const csv = 'contact_id,email,company,owner_id\n,ada@example.com,Acme,rep-1\nCSV-001,bob@example.com,Acme,rep-1';
    expect(() => importContactsCsv(csv)).toThrow('CSV row 3 has duplicate contact ID "CSV-001" (first used on row 2).');
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
