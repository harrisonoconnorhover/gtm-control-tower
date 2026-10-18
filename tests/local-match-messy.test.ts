import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importContactsCsv } from '../lib/csv-control-tower';
import { buildLocalMatchReport, type LocalMatchFinding } from '../lib/local-match';

type ExpectedPair = {
  a: string; b: string; kind: LocalMatchFinding['kind'];
  label: 'same_person' | 'same_company' | 'different_people' | 'different_companies';
  expected: 'warning' | 'no_warning' | 'known_miss' | 'warning_or_none';
  reasonCodes: string[];
};
const fixture = new URL('./fixtures/local-matching/messy-contacts.csv', import.meta.url);
const truth = JSON.parse(readFileSync(new URL('./fixtures/local-matching/expected-pairs.json', import.meta.url), 'utf8')) as {
  rowCount: number; pairs: ExpectedPair[];
};
const imported = importContactsCsv(readFileSync(fixture, 'utf8'));
const before = structuredClone(imported.contacts);
const report = buildLocalMatchReport({ contacts: imported.contacts });
const pairFinding = (pair: Pick<ExpectedPair, 'a' | 'b' | 'kind'>) => report.findings.find((finding) => finding.kind === pair.kind
  && ((finding.contactId === pair.a && finding.candidate.id === pair.b) || (finding.contactId === pair.b && finding.candidate.id === pair.a)));
const codes = (finding: LocalMatchFinding | undefined) => finding?.reasons.map((reason) => reason.code) ?? [];

describe('140-row fictional local matching evaluation', () => {
  it('contains enough distinct named identities for local rarity without real contact destinations', () => {
    expect(imported.sourceRows).toBe(truth.rowCount);
    expect(truth.rowCount).toBe(140);
    expect(new Set(imported.contacts.map((row) => row.contactId)).size).toBe(140);
    for (const contact of imported.contacts) {
      expect(contact.rawEmail.split('@')[1]).toMatch(/\.test$/u);
      expect(new URL(contact.website!).hostname).toMatch(/\.test$/u);
    }
    expect(report.rarity).toEqual({ available: true, sampleSize: 138 });
    expect(imported.contacts).toEqual(before);
  });

  it('shows the labeled typo and duplicate cases with their supporting or conflicting reasons', () => {
    for (const pair of truth.pairs.filter((entry) => entry.expected === 'warning')) {
      const match = pairFinding(pair);
      expect(match, `${pair.a}/${pair.b}`).toBeDefined();
      expect(codes(match), `${pair.a}/${pair.b}`).toEqual(expect.arrayContaining(pair.reasonCodes));
    }
    expect(codes(pairFinding({ a: 'alias-01', b: 'alias-02', kind: 'possible_duplicate' }))).not.toContain('gmail_alias');
    expect(pairFinding({ a: 'company-01', b: 'company-02', kind: 'company_variant' })).toMatchObject({ score: 80, priority: 'high' });
  });

  it('weights an uncommon name higher than a common name under the same supporting context', () => {
    const common = pairFinding({ a: 'common-01', b: 'common-02', kind: 'possible_duplicate' })!;
    const rare = pairFinding({ a: 'rare-01', b: 'rare-02', kind: 'possible_duplicate' })!;
    expect(codes(common)).toContain('common_local_name');
    expect(codes(rare)).toContain('uncommon_local_name');
    expect(common).toMatchObject({ priority: 'low', score: 40 });
    expect(rare).toMatchObject({ priority: 'medium', score: 54 });
    expect(rare.score - common.score).toBe(14);
  });

  it('keeps the shared inbox, unrelated switchboard, conflicting middle name, and short acronym controls clear', () => {
    for (const pair of truth.pairs.filter((entry) => entry.expected === 'no_warning')) {
      expect(pairFinding(pair), `${pair.a}/${pair.b}`).toBeUndefined();
    }
    expect(report.findings.some((finding) => finding.contactId.startsWith('bg-') || finding.candidate.id.startsWith('bg-'))).toBe(false);
  });

  it('retains known false positives for Dismiss and admits the nickname miss and bounded common-name coverage', () => {
    const confirm = pairFinding({ a: 'confirm-01', b: 'confirm-02', kind: 'possible_duplicate' });
    const dismiss = pairFinding({ a: 'phone-01', b: 'phone-02', kind: 'possible_duplicate' });
    expect(confirm).toMatchObject({ priority: 'high', score: 82 });
    expect(dismiss).toMatchObject({ priority: 'medium', score: 58 });
    expect(codes(dismiss)).toContain('different_extensions');
    for (const pair of truth.pairs.filter((entry) => entry.expected === 'known_miss')) {
      expect(pairFinding(pair), `${pair.a}/${pair.b}`).toBeUndefined();
    }
    const positivePairs = truth.pairs.filter((pair) => pair.label === 'same_person' || pair.label === 'same_company');
    const negativePairs = truth.pairs.filter((pair) => pair.label === 'different_people' || pair.label === 'different_companies');
    // This is a hand-labeled fixture, not an estimate of population precision or recall.
    expect(positivePairs).toHaveLength(11);
    expect(positivePairs.filter((pair) => pairFinding(pair))).toHaveLength(10);
    expect(negativePairs).toHaveLength(21);
    expect(negativePairs.filter((pair) => pairFinding(pair))).toHaveLength(13);
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Only the three highest-ranked suggestions'),
      expect.stringContaining('common-value candidate groups exceeded 120 records'),
    ]));
  });
});
