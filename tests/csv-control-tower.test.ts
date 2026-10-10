import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  countCsvRepairCandidates,
  correctCsvContact,
  destinationHoldFlags,
  executeCsvRepair,
  exportContactsCsv,
  importContactsCsv,
  isDestinationReadyContact,
  previewContactsCsv,
  suggestCsvMapping,
  type CsvColumnMapping,
  type CsvContactCorrectionInput,
} from '../lib/csv-control-tower';
import { isHubSpotEligible } from '../lib/hubspot-sync';
import { isSalesforceEligible } from '../lib/salesforce-sync';
import type { LiveContactState } from '../lib/live-control-tower';

const funkyCsv = `contact_id,full_name,email,normalized_email,company,region,segment,lifecycle_stage,expected_lifecycle_stage,owner_id
C-1,Alex Morgan,alex@example.com,,Example Inc,Northeast,Enterprise,customer,customer,NE-ENT
C-2," Alex, Jr. ",ALEX+EVENT@EXAMPLE.COM,alex@example.com,"Example, Incorporated",Northeast,Enterprise,mql,customer,NE-ENT
C-3,Mia Santos,mia.santos @ gmail.com,,,West,SMB,lead,lead,
C-4,Robin Cho,robin@oak.co,,Oak Co,Northeast,Mid-Market,mql,sql,NE-MM`;

describe('CSV control tower', () => {
  it('auto-maps common CRM headers while preserving their exact source labels', () => {
    const headers = [
      'ContactId', 'Contact Full Name', 'Given-name', 'FamilyName', 'Work E-mail',
      'Account Name', 'Business Phone', 'JobTitle', 'Company Website', 'MailingState',
      'Lifecycle Stage', 'HubSpot Owner ID', 'Untouched custom field',
    ];
    expect(suggestCsvMapping(headers)).toEqual({
      contactId: 'ContactId', fullName: 'Contact Full Name', firstName: 'Given-name', lastName: 'FamilyName',
      rawEmail: 'Work E-mail', company: 'Account Name', phone: 'Business Phone', jobTitle: 'JobTitle',
      website: 'Company Website', state: 'MailingState', lifecycleStage: 'Lifecycle Stage', ownerId: 'HubSpot Owner ID',
    });
    expect(suggestCsvMapping(['  BUSINESS EMAIL  '])).toEqual({ rawEmail: '  BUSINESS EMAIL  ' });
    const csv = `${headers.join(',')}\nC-123,Ada Lovelace,Ada,Lovelace,ada@example.com,Analytical Engines,555-0100,Engineer,https://example.com,Texas,customer,owner-1,untouched`;
    expect(previewContactsCsv(csv).headers).toEqual(headers);
    expect(importContactsCsv(csv).contacts[0]).toMatchObject({
      contactId: 'C-123', fullName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace',
      rawEmail: 'ada@example.com', company: 'Analytical Engines', phone: '555-0100', jobTitle: 'Engineer',
      website: 'https://example.com', state: 'Texas', lifecycleStage: 'customer', ownerId: 'owner-1',
    });
  });

  it.each([
    ['Record ID', { contactId: 'Record ID' }],
    ['Person Full Name', { fullName: 'Person Full Name' }],
    ['Contact Email', { rawEmail: 'Contact Email' }],
    ['BusinessEmail', { rawEmail: 'BusinessEmail' }],
    ['Work Phone', { phone: 'Work Phone' }],
    ['Company Name', { company: 'Company Name' }],
  ])('recognizes the explicit %s alias', (header, expected) => {
    expect(suggestCsvMapping([header])).toEqual(expected);
  });

  it('prefers canonical labels or keys over aliases independently of source order', () => {
    const headers = ['Work Email', 'Email', 'Record ID', 'Contact ID', 'Business Phone', 'Phone', 'Given Name', 'firstName'];
    const expected = { rawEmail: 'Email', contactId: 'Contact ID', phone: 'Phone', firstName: 'firstName' };
    expect(suggestCsvMapping(headers)).toEqual(expected);
    expect(suggestCsvMapping([...headers].reverse())).toEqual(expected);
  });

  it('leaves equally plausible columns unmapped until explicitly chosen', () => {
    const csv = 'Full Name,Work Email,Business Email,Mailing State,Province\nAda Lovelace,work@example.com,business@example.com,Texas,Ontario';
    const headers = previewContactsCsv(csv).headers;
    expect(suggestCsvMapping(headers)).toEqual({ fullName: 'Full Name' });
    expect(suggestCsvMapping([...headers].reverse())).toEqual({ fullName: 'Full Name' });
    expect(importContactsCsv(csv).contacts[0]).toMatchObject({ rawEmail: '', state: null });
    expect(importContactsCsv(csv, { rawEmail: 'Business Email', state: 'Province' }).contacts[0])
      .toMatchObject({ rawEmail: 'business@example.com', state: 'Ontario' });
    // These headers are distinct under the existing parser rules, but equally
    // plausible matches; matching normalization must not reject or choose one.
    expect(previewContactsCsv('First Name,FirstName,Email\nAda,Grace,ada@example.com').suggestedMapping)
      .toEqual({ rawEmail: 'Email' });
  });

  it('does not guess contact IDs from company IDs or owner IDs from owner names', () => {
    expect(suggestCsvMapping(['Account ID', 'Company ID', 'Owner', 'Owner Name', 'Contact Owner', 'Primary inbox']))
      .toEqual({});
    const csv = 'Email,Owner\nada@example.com,reviewed-owner-id';
    expect(importContactsCsv(csv).contacts[0].ownerId).toBeNull();
    expect(importContactsCsv(csv, { ownerId: 'Owner' }).contacts[0].ownerId).toBe('reviewed-owner-id');
  });

  it('preserves explicit ignores after saving and restoring a mapping', () => {
    const mapping = JSON.parse(JSON.stringify({ rawEmail: '', company: '', ownerId: '' })) as CsvColumnMapping;
    const csv = 'Full Name,Email,Company,Owner ID\nAda Lovelace,ada@example.com,Analytical Engines,owner-1';
    expect(importContactsCsv(csv, mapping).contacts[0]).toMatchObject({
      fullName: 'Ada Lovelace', rawEmail: '', normalizedEmail: null, company: null, ownerId: null,
    });
  });

  it('does not auto-fill a source column explicitly reassigned to another target', () => {
    const mapping = JSON.parse(JSON.stringify({ fullName: 'Email', rawEmail: '' })) as CsvColumnMapping;
    expect(importContactsCsv('Email\nAda Lovelace', mapping).contacts[0]).toMatchObject({
      fullName: 'Ada Lovelace', rawEmail: '', normalizedEmail: null,
    });
  });

  it('retains generated CRM fixture mappings and the exported mapping roundtrip', () => {
    const fixture = readFileSync(new URL('../public/sec-public-company-messy-crm.csv', import.meta.url), 'utf8');
    const preview = previewContactsCsv(fixture);
    expect(preview.suggestedMapping).toMatchObject({
      contactId: 'record_id', fullName: 'contact_name', rawEmail: 'email_address', company: 'account_name',
      phone: 'mobile', jobTitle: 'title', website: 'company_website', region: 'sales_region',
      segment: 'company_segment', lifecycleStage: 'status', expectedLifecycleStage: 'expected_stage',
      ownerId: 'sales_owner', recordStatus: 'record_status', qualityFlags: 'issues',
    });
    const contacts = importContactsCsv(fixture).contacts;
    const reimported = importContactsCsv(exportContactsCsv(contacts)).contacts;
    expect(reimported).toEqual(contacts.map((contact, index) => ({ ...contact, updatedAt: reimported[index].updatedAt })));
  });

  it('maps state separately from territory and preserves it in exported CSV', () => {
    const csv = 'contact_id,full_name,email,state_province,region,company,owner_id\nSTATE-1,Alex Example,alex@example.test,Texas,South,Example,owner-1';
    const preview = previewContactsCsv(csv);
    expect(preview.suggestedMapping).toMatchObject({ state: 'state_province', region: 'region' });
    const [contact] = importContactsCsv(csv).contacts;
    expect(contact).toMatchObject({ state: 'Texas', region: 'South' });
    expect(importContactsCsv(exportContactsCsv([contact])).contacts[0]).toMatchObject({ state: 'Texas', region: 'South' });
    expect(importContactsCsv('full_name,email,region\nBlair Example,blair@example.test,West').contacts[0].state).toBeNull();
  });

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

function correctionInput(contact: LiveContactState, changes: Partial<CsvContactCorrectionInput> = {}): CsvContactCorrectionInput {
  return {
    rawEmail: contact.rawEmail,
    company: contact.company ?? '',
    ownerId: contact.ownerId ?? '',
    lifecycleStage: contact.lifecycleStage,
    ...changes,
  };
}

describe('individual CSV contact corrections', () => {
  const heldContacts = () => importContactsCsv('contact_id,full_name,email,company,owner_id,lifecycle_stage,expected_lifecycle_stage,quality_flags\nC-1,Ada Lovelace,invalid email,,,mql,customer,source_review').contacts;

  it('records an isolated before/after correction while preserving unresolved holds and immutable fields', () => {
    const contacts = heldContacts();
    const original = structuredClone(contacts);
    const input = { ...correctionInput(contacts[0], { ownerId: ' rep-1 ' }), contactId: 'other', expectedLifecycleStage: 'mql', recordStatus: 'merged' };
    const result = correctCsvContact(contacts, 'C-1', input, '  Assigned the verified owner.  ');

    expect(contacts).toEqual(original);
    expect(result.contacts[0]).toMatchObject({ contactId: 'C-1', ownerId: 'rep-1', expectedLifecycleStage: 'customer', recordStatus: 'active', lastAction: 'contact_corrected' });
    expect(result.contacts[0].qualityFlags).toEqual(['source_review', 'invalid_email', 'missing_company', 'stage_regression']);
    expect(isDestinationReadyContact(result.contacts[0])).toBe(false);
    expect(result.correction).toMatchObject({ contactId: 'C-1', reason: 'Assigned the verified owner.', before: original[0], after: result.contacts[0] });
    expect(result.correction.id).toEqual(expect.any(String));
    expect(result.correction.reviewedAt).toBe(result.contacts[0].updatedAt);
    expect(result.correction.before).not.toBe(contacts[0]);
    expect(result.correction.after).not.toBe(result.contacts[0]);
    result.correction.after.qualityFlags.push('snapshot_only');
    expect(result.contacts[0].qualityFlags).not.toContain('snapshot_only');
  });

  it('normalizes corrected email and returns a ready record through existing CSV export and CRM eligibility', () => {
    const contacts = heldContacts();
    const result = correctCsvContact(contacts, 'C-1', {
      rawEmail: ' ADA+EVENT@MAÑANA.EXAMPLE ', company: ' Acme ', ownerId: ' rep-1 ', lifecycleStage: ' CUSTOMER ',
    }, 'Confirmed the missing values against the source.');
    const corrected = result.contacts[0];

    expect(corrected).toMatchObject({ rawEmail: 'ADA+EVENT@MAÑANA.EXAMPLE', normalizedEmail: 'ada+event@xn--maana-pta.example', company: 'Acme', ownerId: 'rep-1', lifecycleStage: 'customer' });
    expect(corrected.qualityFlags).toEqual(['source_review', 'plus_address_present', 'unicode_domain_present']);
    expect(isDestinationReadyContact(corrected)).toBe(true);
    expect(isHubSpotEligible(corrected)).toBe(true);
    expect(isSalesforceEligible(corrected)).toBe(true);
    const [reimported] = importContactsCsv(exportContactsCsv(result.contacts)).contacts;
    expect(reimported).toMatchObject({ contactId: 'C-1', normalizedEmail: corrected.normalizedEmail, company: 'Acme', ownerId: 'rep-1', lifecycleStage: 'customer' });
    expect(isDestinationReadyContact(reimported)).toBe(true);
  });

  it('preserves a supplied normalized identity when only another field changes', () => {
    const contacts = importContactsCsv('contact_id,email,normalized_email,company,owner_id\nC-1,original@example.com,canonical@example.com,Acme,').contacts;
    const result = correctCsvContact(contacts, 'C-1', correctionInput(contacts[0], { ownerId: 'rep-1' }), 'Confirmed owner.');
    expect(result.contacts[0]).toMatchObject({ rawEmail: 'original@example.com', normalizedEmail: 'canonical@example.com', ownerId: 'rep-1' });
    expect(isDestinationReadyContact(result.contacts[0])).toBe(true);
  });

  it('allows explicit email rechecking to replace an invalid supplied normalized value without changing raw text', () => {
    const contacts = importContactsCsv('contact_id,email,normalized_email,company,owner_id\nC-1,ada@example.com,invalid supplied value,Acme,rep-1').contacts;
    expect(() => correctCsvContact(contacts, 'C-1', correctionInput(contacts[0]), 'No actual correction.')).toThrow(/Change a contact field/);
    const result = correctCsvContact(contacts, 'C-1', correctionInput(contacts[0], { recheckEmail: true }), 'Rechecked identity against the entered email.');
    expect(result.correction.before.normalizedEmail).toBeNull();
    expect(result.contacts[0]).toMatchObject({ rawEmail: 'ada@example.com', normalizedEmail: 'ada@example.com', qualityFlags: [] });
    expect(isDestinationReadyContact(result.contacts[0])).toBe(true);
  });

  it('keeps invalid replacement email held and refreshes email-specific informational flags', () => {
    const contacts = importContactsCsv('contact_id,email,company,owner_id\nC-1,ada+event@mañana.example,Acme,').contacts;
    const result = correctCsvContact(contacts, 'C-1', correctionInput(contacts[0], { rawEmail: 'still invalid' }), 'Source replacement needs further review.');
    expect(result.contacts[0]).toMatchObject({ normalizedEmail: null });
    expect(result.contacts[0].qualityFlags).toEqual(['missing_owner', 'invalid_email']);
    expect(isDestinationReadyContact(result.contacts[0])).toBe(false);
  });

  it('updates duplicate holds on newly affected peers and clears them when the identity is corrected again', () => {
    const contacts = importContactsCsv('contact_id,email,company,owner_id,record_status,canonical_contact_id\nC-1,invalid email,Acme,rep-1,active,\nC-2,bob@example.com,Acme,rep-1,active,\nC-3,bob@example.com,Acme,rep-1,merged,C-2').contacts;
    const original = structuredClone(contacts);
    const duplicate = correctCsvContact(contacts, 'C-1', correctionInput(contacts[0], { rawEmail: 'BOB@example.com' }), 'First source correction.');
    expect(countCsvRepairCandidates(duplicate.contacts, 'duplicate-surge')).toBe(1);
    expect(duplicate.contacts.slice(0, 2).every((contact) => contact.qualityFlags.includes('duplicate_identity'))).toBe(true);
    expect(duplicate.contacts.slice(0, 2).some(isDestinationReadyContact)).toBe(false);
    expect(duplicate.contacts[2]).toEqual(original[2]);

    const resolved = correctCsvContact(duplicate.contacts, 'C-1', correctionInput(duplicate.contacts[0], { rawEmail: 'ada@example.com' }), 'Verified a distinct identity.');
    expect(resolved.contacts.slice(0, 2).every(isDestinationReadyContact)).toBe(true);
    expect(countCsvRepairCandidates(resolved.contacts, 'duplicate-surge')).toBe(0);
    expect(resolved.contacts[2]).toEqual(original[2]);
    expect(duplicate.correction.after.qualityFlags).toContain('duplicate_identity');
    expect(contacts).toEqual(original);
  });

  it('retains an existing stage hold when an unknown lifecycle cannot establish a valid correction', () => {
    const contacts = importContactsCsv('contact_id,email,company,owner_id,lifecycle_stage,expected_lifecycle_stage,quality_flags\nC-1,ada@example.com,Acme,rep-1,mql,unknown,stage_regression').contacts;
    const result = correctCsvContact(contacts, 'C-1', correctionInput(contacts[0], { lifecycleStage: 'Not recognized' }), 'Source stage is still uncertain.');
    expect(result.contacts[0]).toMatchObject({ lifecycleStage: 'not_recognized', expectedLifecycleStage: 'unknown', qualityFlags: ['stage_regression'] });
    expect(isDestinationReadyContact(result.contacts[0])).toBe(false);
  });

  it('requires a selected active held row, a review reason, and a meaningful change', () => {
    const contacts = heldContacts();
    const input = correctionInput(contacts[0], { company: 'Acme' });
    expect(() => correctCsvContact(contacts, 'missing', input, 'Source review.')).toThrow(/Choose one uniquely identified/);
    expect(() => correctCsvContact([{ ...contacts[0], recordStatus: 'merged' }], 'C-1', input, 'Source review.')).toThrow(/Only active held/);
    expect(() => correctCsvContact([{ ...contacts[0], qualityFlags: [] }], 'C-1', input, 'Source review.')).toThrow(/Only active held/);
    expect(() => correctCsvContact(contacts, 'C-1', input, '   ')).toThrow(/Enter a review reason/);
    expect(() => correctCsvContact(contacts, 'C-1', correctionInput(contacts[0], { recheckEmail: true }), 'Still the same invalid email.')).toThrow(/Change a contact field/);
  });
});
