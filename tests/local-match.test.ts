import { describe, expect, it } from 'vitest';
import { buildLocalMatchReport, type LocalMatchAnalysis, type LocalMatchFinding } from '../lib/local-match';
import type { IdentityRecord } from '../lib/identity-resolution';
import type { LiveContactState } from '../lib/live-control-tower';
import type { SuppressionRule } from '../lib/suppression';

function contact(id: string, patch: Partial<LiveContactState> = {}): LiveContactState {
  return { contactId: id, fullName: '', rawEmail: '', normalizedEmail: null, company: null, website: null, phone: null,
    region: '', segment: '', lifecycleStage: 'lead', expectedLifecycleStage: 'lead', ownerId: null, canonicalContactId: null,
    recordStatus: 'active', lastAction: 'imported', qualityFlags: [], updatedAt: '2026-10-16T12:00:00.000Z', ...patch };
}
function crm(id: string, patch: Partial<IdentityRecord> = {}): IdentityRecord {
  return { recordKey: id, connectorId: 'hubspot', objectType: 'contact', nativeId: id, firstName: '', lastName: '', fullName: '',
    email: '', company: '', website: '', phone: '', jobTitle: '', createdAt: null, updatedAt: null, ...patch };
}
function suppression(id: string, patch: Partial<SuppressionRule> = {}): SuppressionRule {
  return { id, listName: 'Vendors', type: 'company_name', value: 'microsoft', reason: 'Existing vendor', enabled: true,
    includeSubdomains: false, createdAt: '2026-10-16T12:00:00.000Z', updatedAt: '2026-10-16T12:00:00.000Z', ...patch };
}
const findings = (report: LocalMatchAnalysis, kind: LocalMatchFinding['kind']) => report.findings.filter((finding) => finding.kind === kind);
const codes = (finding: LocalMatchFinding) => finding.reasons.map((reason) => reason.code);

describe('local company suggestions', () => {
  it('recognizes an adjacent transposition with website support without changing source data', () => {
    const contacts = [contact('a', { company: 'Microsfot', website: 'https://www.microsoft.com/products' }),
      contact('b', { company: 'Microsoft', website: 'http://microsoft.com/' })];
    const before = structuredClone(contacts);
    const report = buildLocalMatchReport({ contacts });
    const finding = findings(report, 'company_variant').find((item) => item.contactId === 'a')!;
    expect(finding).toMatchObject({ candidate: { company: 'Microsoft' }, priority: 'high', score: 80 });
    expect(codes(finding)).toEqual(['company_typo', 'same_website', 'not_canonical']);
    expect(contacts).toEqual(before);
  });

  it.each([
    ['Acme, Incorporated', 'Acme', 'company_suffix'],
    ['Aurora-Solutions', 'Aurora Solutions', 'company_format'],
    ['Aurora Software', 'Software Aurora', 'company_tokens'],
    ['Café Software', 'Cafe Software', 'company_diacritics'],
  ])('explains %s / %s as a candidate, not canonical identity', (a, b, code) => {
    const report = buildLocalMatchReport({ contacts: [contact('a', { company: a })], crmRecords: [crm('b', { company: b })] });
    const finding = findings(report, 'company_variant')[0];
    expect(codes(finding)).toContain(code);
    expect(codes(finding)).toContain('saved_snapshot');
    expect(finding.priority).toBe('low');
  });

  it('does not fuzzy-match short acronyms or wholly different companies', () => {
    for (const pair of [['IBM', 'IBN'], ['Acme', 'Acem'], ['Microsoft', 'Microstrategy'], ['腾讯', '腾讯云']]) {
      expect(findings(buildLocalMatchReport({ contacts: [contact('a', { company: pair[0] }), contact('b', { company: pair[1] })] }), 'company_variant')).toEqual([]);
    }
  });

  it('reduces company suggestion strength for different websites and never equates public suffixes', () => {
    const report = buildLocalMatchReport({ contacts: [contact('a', { company: 'Microsfot', website: 'alpha.co.uk' }),
      contact('b', { company: 'Microsoft', website: 'beta.co.uk' })] });
    expect(findings(report, 'company_variant')[0]).toMatchObject({ priority: 'low', score: 48 });
    expect(codes(findings(report, 'company_variant')[0])).toContain('different_websites');
  });
});

describe('local duplicate evidence and name rarity', () => {
  it('shows one small warning for a same-name/different-email pair without corroboration', () => {
    const report = buildLocalMatchReport({ contacts: [contact('a', { fullName: 'Alex Park', rawEmail: 'alex@gmail.com' }),
      contact('b', { fullName: 'Alex Park', rawEmail: 'alex@outlook.com' })] });
    const matches = findings(report, 'possible_duplicate');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ contactId: 'a', priority: 'low', score: 24 });
    expect(codes(matches[0])).toEqual(['same_name', 'rarity_unknown', 'different_emails', 'limited_context']);
    expect(report.rarity).toEqual({ available: false, sampleSize: 2 });
  });

  it('uses only local deduplicated identities, with a bounded rare-versus-common adjustment', () => {
    const background = Array.from({ length: 100 }, (_, index) => crm(`background-${index}`, { fullName: `Background Person${index}`, email: `person${index}@background.test` }));
    const common = Array.from({ length: 6 }, (_, index) => crm(`common-${index}`, { fullName: 'John Smith', email: `john${index}@example.test` }));
    const contacts = [contact('a', { fullName: 'Zelora Xanthos', rawEmail: 'zelora@gmail.com' }), contact('b', { fullName: 'John Smith', rawEmail: 'john@gmail.com' })];
    const rare = crm('rare', { fullName: 'Zelora Xanthos', email: 'zelora@outlook.com' });
    const report = buildLocalMatchReport({ contacts, crmRecords: [...background, ...common, rare] });
    const matches = findings(report, 'possible_duplicate');
    const rareMatch = matches.find((finding) => finding.contactId === 'a')!;
    const commonMatch = matches.find((finding) => finding.contactId === 'b')!;
    expect(report.rarity).toEqual({ available: true, sampleSize: 109 });
    expect(codes(rareMatch)).toContain('uncommon_local_name');
    expect(codes(commonMatch)).toContain('common_local_name');
    expect(rareMatch.score - commonMatch.score).toBe(14);
    expect(rareMatch.priority).toBe('low');
    const repeated = Array.from({ length: 150 }, (_, index) => crm(`same-${index}`, { fullName: 'John Smith', email: 'john@gmail.com' }));
    expect(buildLocalMatchReport({ contacts: [contacts[1]], crmRecords: repeated }).rarity).toEqual({ sampleSize: 1, available: false });
    const deduped = buildLocalMatchReport({ contacts: [contacts[1]], crmRecords: [...background, ...repeated] });
    expect(deduped.rarity.sampleSize).toBe(101);
    expect(codes(findings(deduped, 'possible_duplicate')[0])).toContain('uncommon_local_name');
  });

  it.each([
    ['Alex Morgan', 'Morgan Alex', 'name_order'],
    ['Alex J Morgan', 'Alex James Morgan', 'name_middle'],
    ['José Morgan', 'Jose Morgan', 'name_diacritics'],
    ['John Morgan', 'Jhon Morgan', 'name_typo'],
    ['A. Morgan', 'Alex Morgan', 'name_initial'],
  ])('needs supporting context for %s / %s', (a, b, code) => {
    const contacts = [contact('a', { fullName: a, company: 'Aurora Software' }), contact('b', { fullName: b, company: 'Aurora Software' })];
    const match = findings(buildLocalMatchReport({ contacts }), 'possible_duplicate')[0];
    expect(codes(match)).toContain(code);
    expect(findings(buildLocalMatchReport({ contacts: contacts.map((row) => ({ ...row, company: '' })) }), 'possible_duplicate')).toEqual([]);
    if (code === 'name_initial') expect(match.priority).toBe('low');
  });

  it('keeps Unicode originals and does not invent nickname equivalence or collapse conflicting middle names', () => {
    for (const pair of [['Robert Young', 'Bob Young'], ['Alex James Morgan', 'Alex Mary Morgan'], ['Li', 'Li']]) {
      const report = buildLocalMatchReport({ contacts: [contact('a', { fullName: pair[0] }), contact('b', { fullName: pair[1] })] });
      expect(findings(report, 'possible_duplicate')).toEqual([]);
    }
    const report = buildLocalMatchReport({ contacts: [contact('a', { fullName: 'José Morgan', phone: '(415) 555-0123' }),
      contact('b', { fullName: 'Jose Morgan', phone: '+1 415 555 0123' })] });
    expect(findings(report, 'possible_duplicate')[0].input.name).toBe('José Morgan');
    expect(codes(findings(report, 'possible_duplicate')[0])).toContain('phone_country_assumption');
  });

  it('normalizes only Gmail aliases and preserves business plus addresses', () => {
    const pair = (a: string, b: string) => buildLocalMatchReport({ contacts: [contact('a', { fullName: 'Alex Park', rawEmail: a }), contact('b', { fullName: 'Alex Park', rawEmail: b })] });
    expect(codes(findings(pair('alex.park+event@gmail.com', 'alexpark@googlemail.com'), 'possible_duplicate')[0])).toContain('gmail_alias');
    const business = findings(pair('alex+event@business.test', 'alex@business.test'), 'possible_duplicate')[0];
    expect(codes(business)).not.toContain('gmail_alias');
    expect(business.input.email).toBe('alex+event@business.test');
    expect(codes(business)).toContain('different_emails');
  });

  it('reports a contextual email typo without suggesting address replacement', () => {
    const report = buildLocalMatchReport({ contacts: [contact('a', { fullName: 'Alex Morgan', rawEmail: 'alex.mrogan@business.test' }),
      contact('b', { fullName: 'Alex Morgan', rawEmail: 'alex.morgan@business.test' })] });
    const match = findings(report, 'possible_duplicate')[0];
    expect(codes(match)).toContain('email_typo');
    expect(match.reasons.find((item) => item.code === 'different_emails')?.message).toContain('neither address will be replaced');
  });

  it('does not treat a shared role inbox as a personal identity anchor', () => {
    const report = buildLocalMatchReport({ contacts: [contact('a', { fullName: 'Alex Park', rawEmail: 'info@business.test', company: 'Business' }),
      contact('b', { fullName: 'Jane Smith', rawEmail: 'info@business.test', company: 'Business' })] });
    expect(findings(report, 'possible_duplicate')).toEqual([]);
    const sameName = buildLocalMatchReport({ contacts: [contact('a', { fullName: 'Alex Park', rawEmail: 'info@business.test', company: 'Business' }),
      contact('b', { fullName: 'Alex Park', rawEmail: 'info@business.test', company: 'Business' })] });
    expect(findings(sameName, 'possible_duplicate')[0].priority).toBe('low');
    expect(codes(findings(sameName, 'possible_duplicate')[0])).toContain('shared_inbox');
  });

  it('counts nameless switchboard records and conflicting extensions as weak phone evidence', () => {
    const contacts = [contact('a', { fullName: 'Alex Park', phone: '4155550123' }), contact('b', { fullName: 'Alex Park', phone: '4155550123' })];
    const report = buildLocalMatchReport({ contacts, crmRecords: [crm('nameless', { phone: '4155550123' })] });
    const match = findings(report, 'possible_duplicate')[0];
    expect(codes(match)).toContain('shared_phone');
    expect(codes(match)).not.toContain('same_phone');
    const extensions = buildLocalMatchReport({ contacts: contacts.map((row, index) => ({ ...row, phone: `${row.phone} ext ${index + 1}` })) });
    expect(codes(findings(extensions, 'possible_duplicate')[0])).toContain('different_extensions');
    expect(findings(extensions, 'possible_duplicate')[0].priority).toBe('low');
  });

  it('treats absent fields neutrally and explicitly lowers scores for contradictory fields', () => {
    const base = [contact('a', { fullName: 'Alex Park' }), contact('b', { fullName: 'Alex Park' })];
    const missing = findings(buildLocalMatchReport({ contacts: base }), 'possible_duplicate')[0];
    expect(missing.score).toBe(28);
    expect(missing.reasons.some((item) => item.tone === 'conflict')).toBe(false);
    const conflicting = findings(buildLocalMatchReport({ contacts: base.map((row, index) => ({ ...row,
      company: index ? 'Microsoft' : 'Salesforce', rawEmail: index ? 'alex@microsoft.com' : 'alex@salesforce.com',
      phone: index ? '4155550123' : '2125550456', state: index ? 'CA' : 'NY' })) }), 'possible_duplicate')[0];
    expect(conflicting.score).toBeLessThan(missing.score);
    expect(codes(conflicting)).toEqual(expect.arrayContaining(['different_companies', 'different_business_domains', 'different_phones', 'different_states']));
    const sameState = findings(buildLocalMatchReport({ contacts: base.map((row, index) => ({ ...row, state: index ? 'CA' : 'California' })) }), 'possible_duplicate')[0];
    expect(codes(sameState)).not.toContain('different_states');
  });
});

describe('suppression suggestions and bounded coverage', () => {
  it.each([
    ['company_name', 'microsoft', { company: 'Microsfot' }, 'company_typo'],
    ['email', 'alex.morgan@microsoft.com', { rawEmail: 'alex.mrogan@microsoft.com' }, 'near_suppressed_email'],
    ['email_domain', 'microsoft.com', { rawEmail: 'alex@microsfot.com' }, 'near_suppressed_domain'],
    ['website_domain', 'microsoft.com', { website: 'https://microsfot.com' }, 'near_suppressed_domain'],
    ['domain', 'microsoft.com', { rawEmail: 'alex@microsfot.com' }, 'near_suppressed_domain'],
  ] as const)('explains near %s suppression with its list and reason', (type, value, patch, code) => {
    const rule = suppression('rule', { type, value });
    const report = buildLocalMatchReport({ contacts: [contact('a', patch)], suppressionRules: [rule] });
    const match = findings(report, 'possible_suppression')[0];
    expect(codes(match)).toEqual([code, 'suppression_rule', 'suppression_review_only']);
    expect(match.reasons[1].message).toContain('Existing vendor');
    expect(match.reasons[1].message).toContain('Vendors');
    expect(match.priority).toBe('low');
  });

  it('omits exact/disabled suppression matches and respects each rule field scope', () => {
    const contacts = [contact('exact', { company: 'Microsoft' }), contact('inactive', { company: 'Microsfot' }),
      contact('wrong-field', { website: 'microsfot.com' })];
    const rules = [suppression('exact'), suppression('disabled', { enabled: false, value: 'microsfot' }), suppression('domain', { type: 'email_domain', value: 'microsoft.com' })];
    const report = buildLocalMatchReport({ contacts, suppressionRules: rules });
    expect(report.findings.some((finding) => finding.contactId === 'exact')).toBe(false);
    expect(report.findings.some((finding) => finding.contactId === 'wrong-field')).toBe(false);
    expect(report.findings.some((finding) => finding.candidate.id === 'disabled')).toBe(false);
    expect(findings(report, 'possible_suppression')).toHaveLength(1);
  });

  it('retains excluded candidates as context while excluding them and merged records from source targets', () => {
    const report = buildLocalMatchReport({ contacts: [contact('a', { fullName: 'Alex Park' }),
      contact('excluded', { fullName: 'Alex Park', importExclusion: { reason: 'Vendor', excludedAt: '2026-10-16T12:00:00.000Z' } }),
      contact('merged', { fullName: 'Alex Park', recordStatus: 'merged' })] });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ contactId: 'a', candidate: { id: 'excluded' } });
    expect(codes(report.findings[0])).toContain('excluded_candidate');
  });

  it('keeps stable order, caps noisy candidate buckets, and explains ambiguity without clustering', () => {
    const contacts = [contact('a', { fullName: 'Alex Park' })];
    const records = Array.from({ length: 125 }, (_, index) => crm(`crm-${String(index).padStart(3, '0')}`, { fullName: 'Alex Park', email: `alex${index}@example.test` }));
    const first = buildLocalMatchReport({ contacts, crmRecords: records });
    const second = buildLocalMatchReport({ contacts: [...contacts].reverse(), crmRecords: [...records].reverse() });
    expect(second).toEqual(first);
    expect(first.coverage.comparedPairs).toBeLessThanOrEqual(120);
    expect(first.findings).toHaveLength(3);
    expect(first.findings.every((finding) => codes(finding).includes('multiple_candidates'))).toBe(true);
    expect(first.warnings.join(' ')).toMatch(/capped.*incomplete/u);
    expect(first.warnings.join(' ')).toContain('three highest-ranked');
    expect(first.warnings.join(' ')).toContain('not probabilities');
  });

  it('reports import size limits instead of claiming all rows were checked', () => {
    const report = buildLocalMatchReport({ contacts: Array.from({ length: 5_001 }, (_, index) => contact(String(index).padStart(5, '0'))) });
    expect(report.coverage.importRows).toBe(5_000);
    expect(report.warnings.join(' ')).toContain('remaining records were not checked');
  });
});
