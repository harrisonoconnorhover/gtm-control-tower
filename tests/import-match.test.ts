import { describe, expect, it } from 'vitest';
import { compareImportedContacts, suggestMatchFields, type ImportMatchInput, type MatchField } from '../lib/import-match';
import { resolveDuplicateIdentities, type IdentityRecord } from '../lib/identity-resolution';

function input(overrides: Partial<ImportMatchInput> = {}): ImportMatchInput {
  return { contactId: 'I-1', fullName: 'Alex Morgan', email: '', phone: '', state: '', company: '', ...overrides };
}
function record(overrides: Partial<IdentityRecord> = {}): IdentityRecord {
  return {
    recordKey: 'hubspot:contact:1', nativeId: '1', connectorId: 'hubspot', objectType: 'contact',
    firstName: 'Alex', lastName: 'Morgan', fullName: 'Alex Morgan', email: '', phone: '', company: '',
    jobTitle: '', website: '', createdAt: null, updatedAt: null, ...overrides,
  };
}
const allFields: MatchField[] = ['name', 'email', 'phone', 'state', 'company'];

describe('import-to-CRM candidate matching', () => {
  it('suggests fields from usable values, not merely populated columns', () => {
    const suggestions = suggestMatchFields([
      input({ fullName: 'I-1', email: 'broken', phone: 'none', state: 'CA', company: 'Example Inc' }),
      input({ email: 'alex@example.com/path', phone: '0000000000', state: 'California' }),
      input({ email: 'alex@example.com', phone: '(415) 555-0101', company: 'Example' }),
    ]);
    expect(suggestions.find((item) => item.field === 'email')).toMatchObject({ populated: 1, total: 3, recommended: true });
    expect(suggestions.find((item) => item.field === 'phone')).toMatchObject({ populated: 1, recommended: true });
    expect(suggestions.find((item) => item.field === 'name')).toMatchObject({ populated: 2, recommended: true });
    const contextOnly = suggestMatchFields([input({ fullName: '', state: 'CA', company: 'Example' })]);
    expect(contextOnly.every((item) => !item.recommended)).toBe(true);
  });

  it('anchors exact primary and additional emails without rewriting corporate plus-addresses', () => {
    const crm = [record({ email: 'primary@example.com', additionalEmails: ['ALEX+WEST@example.com', 'signal@mañana.example'] })];
    const result = compareImportedContacts([
      input({ contactId: 'primary', email: 'PRIMARY@example.com' }),
      input({ contactId: 'alias', email: 'alex+west@example.com' }),
      input({ contactId: 'idna', email: 'signal@xn--maana-pta.example' }),
      input({ contactId: 'different', email: 'alex@example.com' }),
    ], crm, ['email']);
    expect(result.rows.slice(0, 3).every((row) => row.candidates[0]?.score === 90)).toBe(true);
    expect(result.rows[1].candidates[0].comparisons).toEqual([{ field: 'email', imported: 'alex+west@example.com', existing: 'ALEX+WEST@example.com', status: 'match' }]);
    expect(result.rows[3].candidates).toEqual([]);
  });

  it('keeps sparse and context-only selections weak rather than rescaling to 100', () => {
    const imported = input({ state: 'California', company: 'Example Inc' });
    const crm = [record({ state: 'CA', company: 'Example LLC' })];
    expect(compareImportedContacts([imported], crm, ['state', 'company']).rows[0]).toMatchObject({ candidates: [], candidateCount: 0 });
    expect(compareImportedContacts([imported], crm, ['name']).rows[0].candidates[0].score).toBe(32);
    expect(compareImportedContacts([imported], crm, ['name', 'state']).rows[0].candidates[0].score).toBe(38);
    expect(compareImportedContacts([imported], crm, ['name', 'state', 'company']).rows[0].candidates[0].score).toBe(50);
  });

  it('does not award evidence for missing values and reports selected CRM fields missing from the snapshot', () => {
    const result = compareImportedContacts([input({ email: 'alex@example.com' })], [record({ email: 'alex@example.com' })], ['email', 'phone', 'state']);
    expect(result.rows[0].candidates[0]).toMatchObject({ score: 90, comparisons: [
      expect.objectContaining({ field: 'email', status: 'match' }),
      expect.objectContaining({ field: 'phone', status: 'missing' }),
      expect.objectContaining({ field: 'state', status: 'missing' }),
    ] });
    expect(result.rows[0].candidates[0].evidence).toHaveLength(1);
    expect(result.warnings).toContain('No usable state values are present in this CRM snapshot; that field cannot contribute to this analysis.');
    expect(result.warnings[0]).toContain('not probabilities');
  });

  it('ranks name plus unique phone above name plus state, and uses a secondary phone', () => {
    const result = compareImportedContacts([input({ phone: '4155550101', state: 'CA' })], [
      record({ recordKey: 'state', nativeId: 'state', state: 'California' }),
      record({ recordKey: 'phone', nativeId: 'phone', phone: '6505550101', secondaryPhone: '+1 (415) 555-0101' }),
    ], ['name', 'phone', 'state']);
    expect(result.rows[0].candidates.map((candidate) => [candidate.record.recordKey, candidate.score])).toEqual([['phone', 76], ['state', 38]]);
    expect(result.rows[0].candidates[0].comparisons.find((comparison) => comparison.field === 'phone')).toMatchObject({ existing: '+1 (415) 555-0101', status: 'match' });
  });

  it('downweights a shared switchboard and cannot generate people from that phone alone', () => {
    const crm = Array.from({ length: 4 }, (_, index) => record({ recordKey: String(index), nativeId: String(index), phone: '4155550199' }));
    const imported = input({ phone: '+1 415 555 0199' });
    const byName = compareImportedContacts([imported], crm, ['name', 'phone']).rows[0];
    expect(byName).toMatchObject({ candidateCount: 4 });
    expect(byName.candidates).toHaveLength(3);
    expect(byName.candidates.every((candidate) => candidate.score === 40)).toBe(true);
    expect(byName.candidates[0].evidence).toContainEqual(expect.objectContaining({ key: 'phone', tone: 'warning', weight: 8 }));
    expect(byName.warnings.join(' ')).toContain('not to generate candidates on its own');
    expect(compareImportedContacts([imported], crm, ['phone']).rows[0].candidates).toEqual([]);
  });

  it('requires corroboration for fuzzy names and email typos', () => {
    const fuzzyName = input({ fullName: 'Alex Morgann', state: 'New York' });
    const crm = [record({ state: 'NY', email: 'alexander@example.com', company: 'Example' })];
    expect(compareImportedContacts([fuzzyName], crm, ['name']).rows[0].candidates).toEqual([]);
    expect(compareImportedContacts([fuzzyName], crm, ['name', 'state']).rows[0].candidates[0]).toMatchObject({ score: 30 });
    const typo = input({ fullName: '', email: 'zlexander@example.com', company: 'Example Inc' });
    expect(compareImportedContacts([typo], crm, ['email']).rows[0].candidates).toEqual([]);
    expect(compareImportedContacts([typo], crm, ['email', 'company']).rows[0].candidates[0]).toMatchObject({ score: 42 });
    expect(compareImportedContacts([typo], crm, ['email', 'company']).rows[0].candidates[0].comparisons[0].status).toBe('similar');
  });

  it('keeps identifier conflicts visible, and excluding a field removes both its evidence and penalty', () => {
    const imported = input({ email: 'alex@new.example', phone: '4155550101', company: 'Example', state: 'CA' });
    const crm = [record({ email: 'alex@old.example', phone: '4155550101', company: 'Example', state: 'CA' })];
    const withConflict = compareImportedContacts([imported], crm, allFields).rows[0].candidates[0];
    const withoutEmail = compareImportedContacts([imported], crm, ['name', 'phone', 'state', 'company']).rows[0].candidates[0];
    expect(withConflict.score).toBe(withoutEmail.score - 22);
    expect(withConflict.comparisons.find((comparison) => comparison.field === 'email')?.status).toBe('conflict');
    expect(withoutEmail.evidence.some((item) => item.key.startsWith('email'))).toBe(false);
    expect(withoutEmail.comparisons.some((item) => item.field === 'email')).toBe(false);
    const changedPhone = compareImportedContacts([input({ email: 'alex@example.com', phone: '4155550101' })], [record({ email: 'alex@example.com', phone: '4155550102' })], allFields).rows[0].candidates[0];
    expect(changedPhone.score).toBe(86); // The conflict remains after positive evidence reaches the 100-point ceiling.
  });

  it('shows an exact shared-role inbox as weak evidence with explicit name conflicts', () => {
    const result = compareImportedContacts([input({ email: 'sales@example.com' })], [record({ fullName: 'Priya Patel', email: 'sales@example.com' })], ['name', 'email']);
    expect(result.rows[0].candidates[0]).toMatchObject({ score: 0 });
    expect(result.rows[0].candidates[0].evidence).toContainEqual(expect.objectContaining({ key: 'exact_email', tone: 'warning' }));
    expect(result.rows[0].candidates[0].comparisons.find((comparison) => comparison.field === 'name')?.status).toBe('conflict');
  });

  it('uses stable ties, keeps each import independent, and never mutates sources or clusters records', () => {
    const inputs = [input({ contactId: 'first', email: 'alex@example.com' }), input({ contactId: 'second', email: 'alex@example.com' })];
    const crm = ['d', 'b', 'a', 'c'].map((key) => record({ recordKey: key, nativeId: key, email: 'alex@example.com' }));
    const before = JSON.stringify({ inputs, crm });
    const result = compareImportedContacts(inputs, crm, ['email', 'name']);
    expect(result.rows.every((row) => row.candidateCount === 4 && row.candidates.map((candidate) => candidate.record.recordKey).join(',') === 'a,b,c')).toBe(true);
    expect(compareImportedContacts(inputs, [...crm].reverse(), ['name', 'email', 'email'])).toEqual(result);
    expect(JSON.stringify({ inputs, crm })).toBe(before);
    expect(result.ruleVersion).toBe('import-match-v1');
  });

  it('normalizes US state names and codes but does not guess other region abbreviations', () => {
    const crm = [record({ state: 'Ontario' })];
    const candidate = compareImportedContacts([input({ state: 'ON' })], crm, ['name', 'state']).rows[0];
    expect(candidate.candidates).toEqual([]); // 32 name points minus 6 conflict points is below the weak-candidate floor.
    expect(compareImportedContacts([input({ state: 'Ontario' })], crm, ['name', 'state']).rows[0].candidates[0].score).toBe(38);
  });

  it('discloses broad bucket exclusions and exact-email comparison caps', () => {
    const broad = Array.from({ length: 251 }, (_, index) => record({ recordKey: String(index), nativeId: String(index) }));
    const result = compareImportedContacts([input()], broad, ['name']);
    expect(result.rows[0].candidates).toEqual([]);
    expect(result.rows[0].warnings.join(' ')).toContain('exceeded 250');
    expect(result.warnings.join(' ')).toContain('candidate-search limits');
    const exact = Array.from({ length: 1_001 }, (_, index) => record({ recordKey: String(index).padStart(4, '0'), nativeId: String(index), email: 'shared@example.com' }));
    const limited = compareImportedContacts([input({ email: 'shared@example.com' })], exact, ['email']);
    expect(limited.rows[0].candidateCount).toBe(1_000);
    expect(limited.rows[0].warnings.join(' ')).toContain('capped at 1000');
  });

  it('preserves the existing identity-v3 clustering behavior when optional import fields are present', () => {
    const crm = [record({ email: 'alex@example.com' }), record({ recordKey: 'second', nativeId: 'second', email: 'alex@example.com' })];
    const base = resolveDuplicateIdentities(crm);
    const enriched = resolveDuplicateIdentities(crm.map((person) => ({ ...person, state: 'CA', additionalEmails: ['extra@example.com'] })));
    expect(enriched).toMatchObject({ ruleVersion: 'identity-v3', clusterCount: base.clusterCount });
    expect(enriched.clusters.map(({ confidence, band, clusterId }) => ({ confidence, band, clusterId })))
      .toEqual(base.clusters.map(({ confidence, band, clusterId }) => ({ confidence, band, clusterId })));
  });

  it('handles 100 imports against 25,000 CRM records and enforces both ceilings', () => {
    const crm = Array.from({ length: 25_000 }, (_, index) => record({
      recordKey: `crm:${String(index).padStart(5, '0')}`, nativeId: String(index),
      fullName: `Person Number ${index}`, email: `person${index}@example.com`, company: `Company ${index}`, state: 'CA',
    }));
    const inputs = Array.from({ length: 100 }, (_, index) => input({ contactId: String(index), fullName: `Person Number ${index}`, email: `person${index}@example.com`, company: `Company ${index}`, state: 'California' }));
    const result = compareImportedContacts(inputs, crm, allFields);
    expect(result.rows).toHaveLength(100);
    expect(result.rows.every((row, index) => row.candidates[0]?.record.nativeId === String(index) && row.candidates[0].score === 100)).toBe(true);
    expect(() => compareImportedContacts([...inputs, input()], crm, allFields)).toThrow('100');
    expect(() => compareImportedContacts(inputs, [...crm, record()], allFields)).toThrow('25,000');
  }, 10_000);
});
