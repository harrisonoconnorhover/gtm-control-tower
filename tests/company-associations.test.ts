import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveCompanyAssociations } from '../lib/company-associations';
import { importContactsCsv } from '../lib/csv-control-tower';
import { buildLocalMatchReport } from '../lib/local-match';
import { matchSuppressionRules, type SuppressionRule } from '../lib/suppression';

const csv = readFileSync(new URL('./fixtures/local-matching/messy-contacts.csv', import.meta.url), 'utf8');

describe('contacts with explicitly mapped associated companies', () => {
  it('preserves the 140-row matching evidence using only the associated company context', () => {
    const plain = buildLocalMatchReport({ contacts: importContactsCsv(csv).contacts });
    const rows = importContactsCsv(csv, {}, 'contact_company').contacts;
    expect(rows.every((row) => !row.company && !row.website)).toBe(true);
    const mixed = buildLocalMatchReport({ contacts: rows });
    expect(mixed.importObject).toBe('contact_company');
    expect(mixed.findings).toEqual(plain.findings);
    expect(mixed.rarity).toEqual(plain.rarity);
    const preview = deriveCompanyAssociations(rows);
    expect(preview.counts.contacts).toBe(140);
    expect(preview.counts.linkedContacts).toBe(140);
    expect(preview.unlinked).toEqual([]);
    const typo = preview.groups.find((group) => group.contactIds.includes('company-01'))!;
    expect(typo.contactIds).toContain('company-02');
    expect(typo.status).toBe('needs_review');
    expect(typo.companyNames).toEqual(['Microsfot', 'Microsoft']);
  });

  it('groups exact IDs or hostnames but never name-only or conflicting IDs', () => {
    const rows = importContactsCsv('Name,Company ID,Company,Website\nA,ID-1,Acme,https://www.acme.test/a\nB,ID-1,Acme,acme.test\nC,ID-2,Acme,acme.test\nD,,Acme,acme.test\nE,,Acme,\nF,,Other,https://other.test/a\nG,,Other,http://www.other.test/b', {}, 'contact_company').contacts;
    const preview = deriveCompanyAssociations(rows);
    expect(preview.counts).toEqual({ contacts: 7, companies: 4, linkedContacts: 6, unlinkedContacts: 1, reviewGroups: 3 });
    expect(preview.groups.find((group) => group.key === 'id:ID-1')?.contactIds).toHaveLength(2);
    expect(preview.groups.find((group) => group.key === 'domain:other.test')?.contactIds).toHaveLength(2);
    expect(preview.unlinked[0].reason).toContain('name alone');
    expect(deriveCompanyAssociations(importContactsCsv(csv).contacts).groups).toEqual([]);
  });

  it('honors associated company suppression rules without borrowing contact company context', () => {
    const [row] = importContactsCsv('Name,Company,Website,contact_company,contact_company_website\nA,Associated,associated.test,Context,context.test', {}, 'contact_company').contacts;
    const rule = (value: string): SuppressionRule => ({ id: value, value, type: 'website_domain', listName: 'Vendors', reason: 'Vendor', enabled: true, includeSubdomains: false, createdAt: '', updatedAt: '' });
    expect(matchSuppressionRules(row, [rule('associated.test'), rule('context.test')]).map((match) => match.value)).toEqual(['associated.test']);
  });

  it('compares company rows as companies without person duplicate or name-rarity claims', () => {
    const contacts = importContactsCsv('Company,Website\nMicrosfot,microsoft.test\nMicrosoft,microsoft.test\nExample,example.test\nExample,example.test', {}, 'company').contacts;
    const report = buildLocalMatchReport({ contacts });
    expect(report.importObject).toBe('company');
    expect(report.findings.some((item) => item.kind === 'possible_duplicate')).toBe(false);
    expect(report.findings.some((item) => item.reasons.some((reason) => reason.code === 'company_typo'))).toBe(true);
    expect(report.findings.some((item) => item.reasons.some((reason) => reason.code === 'same_company_name'))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes('Name rarity'))).toBe(false);
  });
});
