import { describe, expect, it } from 'vitest';
import { applySuppressionRules, exportSuppressionCsv, isSuppressed, matchSuppressionRules, normalizeSuppressionRule, parseSuppressionCsv, type SuppressionRule, type SuppressionRuleInput } from '../lib/suppression';

const rule = (input: SuppressionRuleInput, id = 'rule-1'): SuppressionRule => ({
  ...normalizeSuppressionRule(input), id, createdAt: '2026-10-16T10:00:00.000Z', updatedAt: '2026-10-16T10:00:00.000Z',
});

describe('suppression rule matching', () => {
  it('normalizes email case and IDN, and treats complete email addresses as exact matches', () => {
    const saved = rule({ type: 'email', value: ' Ada+event@MAÑANA.EXAMPLE ', reason: 'Requested no outreach' });
    expect(saved.value).toBe('ada+event@xn--maana-pta.example');
    expect(matchSuppressionRules({ rawEmail: 'ADA+EVENT@mañana.example' }, [saved])).toHaveLength(1);
    expect(matchSuppressionRules({ rawEmail: 'ada@mañana.example' }, [saved])).toEqual([]);
    expect(matchSuppressionRules({ rawEmail: 'ada+event@sub.mañana.example' }, [saved])).toEqual([]);
  });

  it('matches website hostnames independently of scheme, path and www, with explicit subdomain boundaries', () => {
    const exact = rule({ type: 'website_domain', value: 'https://WWW.Example.COM/a?b=2', reason: 'Vendor' });
    expect(exact.value).toBe('example.com');
    expect(matchSuppressionRules({ website: 'http://example.com/elsewhere' }, [exact])).toHaveLength(1);
    expect(matchSuppressionRules({ website: 'https://sub.example.com' }, [exact])).toEqual([]);
    const children = { ...exact, includeSubdomains: true };
    expect(matchSuppressionRules({ website: 'https://sub.example.com' }, [children])).toHaveLength(1);
    expect(matchSuppressionRules({ website: 'https://notexample.com' }, [children])).toEqual([]);
    expect(matchSuppressionRules({ website: 'https://example.com.evil.org' }, [children])).toEqual([]);
  });

  it('distinguishes email domains, website domains, and either domain', () => {
    const email = rule({ type: 'email_domain', value: 'example.com', reason: 'Competitor' });
    const website = rule({ type: 'website_domain', value: 'example.com', reason: 'Vendor' }, 'rule-2');
    const either = rule({ type: 'domain', value: 'example.com', reason: 'Industry exclusion' }, 'rule-3');
    expect(matchSuppressionRules({ rawEmail: 'ada@example.com', website: 'other.com' }, [email, website, either]).map((match) => match.ruleId)).toEqual(['rule-1', 'rule-3']);
    expect(matchSuppressionRules({ rawEmail: 'ada@other.com', website: 'example.com' }, [email, website, either]).map((match) => match.ruleId)).toEqual(['rule-2', 'rule-3']);
    expect(matchSuppressionRules({ rawEmail: 'ada@sub.example.com' }, [{ ...email, includeSubdomains: true }])).toHaveLength(1);
    expect(matchSuppressionRules({ rawEmail: 'ada@notexample.com' }, [{ ...email, includeSubdomains: true }])).toEqual([]);
  });

  it('matches company names exactly after whitespace and case cleanup, and retains every applicable reason', () => {
    const company = rule({ listName: 'Vendors', type: 'company_name', value: '  Example   Incorporated ', reason: 'Current vendor' });
    const email = rule({ listName: 'Do not contact', type: 'email', value: 'ada@example.com', reason: 'Requested no outreach' }, 'rule-2');
    const matches = matchSuppressionRules({ company: 'EXAMPLE\nIncorporated', rawEmail: 'ada@example.com' }, [company, email]);
    expect(matches.map((match) => match.reason)).toEqual(['Current vendor', 'Requested no outreach']);
    expect(matches[0]).toEqual({ ruleId: 'rule-1', listName: 'Vendors', type: 'company_name', value: 'example incorporated', reason: 'Current vendor' });
    expect(matchSuppressionRules({ company: 'Example Incorporated North' }, [company])).toEqual([]);
  });

  it('clears stale matches, ignores disabled rules, and preserves manual exclusions and source fields', () => {
    const saved = rule({ type: 'email_domain', value: 'example.com', reason: 'Vendor' });
    const source = [{ id: 'row-1', rawEmail: 'ada@example.com', company: 'Example', importExclusion: { reason: 'Manual skip' }, suppressionMatches: [{ ruleId: 'old', listName: 'Old', type: 'email' as const, value: 'old@example.com', reason: 'Old reason' }] }];
    const matched = applySuppressionRules(source, [saved]);
    expect(isSuppressed(matched[0])).toBe(true);
    expect(matched[0].suppressionMatches?.[0].ruleId).toBe('rule-1');
    expect(matched[0].importExclusion).toEqual(source[0].importExclusion);
    expect(source[0].suppressionMatches[0].ruleId).toBe('old');
    const disabled = applySuppressionRules(source, [{ ...saved, enabled: false }]);
    expect(isSuppressed(disabled[0])).toBe(false);
    expect(disabled[0]).not.toHaveProperty('suppressionMatches');
    expect(disabled[0].importExclusion).toEqual(source[0].importExclusion);
  });

  it('rejects missing reasons, ambiguous rule types, malformed email/domain values and irrelevant subdomain settings', () => {
    for (const input of [
      { type: 'email', value: 'ada@example.com', reason: '' },
      { type: 'regex', value: '.*', reason: 'All' },
      { type: 'email', value: 'bad@@example.com', reason: 'Bad' },
      { type: 'domain', value: 'http://user:password@example.com', reason: 'Bad' },
      { type: 'domain', value: '*.example.com', reason: 'Bad' },
      { type: 'company_name', value: 'Example', reason: 'Vendor', includeSubdomains: true },
      { type: 'email_domain', value: 'example.com/path', reason: 'Bad' },
      { type: 'email_domain', value: 'localhost', reason: 'Bad' },
    ]) expect(() => normalizeSuppressionRule(input)).toThrow();
    expect(() => normalizeSuppressionRule({ type: 'email', value: 'ada@example.com', reason: 'x'.repeat(501) })).toThrow('500');
  });

  it('parses CSV with defaults and quoted reasons, rejects the whole malformed input, and round-trips exported lists', () => {
    const imported = parseSuppressionCsv('type,value,reason\nemail,Ada@EXAMPLE.com,"Requested no outreach, by email"\ncompany_name,Example Incorporated,Vendor');
    expect(imported[0]).toMatchObject({ listName: 'Suppression list', value: 'ada@example.com', enabled: true, includeSubdomains: false, reason: 'Requested no outreach, by email' });
    expect(() => parseSuppressionCsv('type,value,reason\nemail,ada@example.com,Valid\nemail,not-an-email,Invalid')).toThrow('CSV row 3');
    expect(() => parseSuppressionCsv('type,value,reason,reason\nemail,ada@example.com,x,y')).toThrow('headers');
    const rules = imported.map((item, index) => rule(item, `rule-${index}`));
    expect(parseSuppressionCsv(exportSuppressionCsv(rules))).toEqual(imported);
    expect(parseSuppressionCsv('list_name,type,value,reason,include_subdomains,enabled\nVendors,domain,example.com,Vendor,yes,no')[0]).toMatchObject({ listName: 'Vendors', includeSubdomains: true, enabled: false });
    expect(exportSuppressionCsv([rule({ type: 'company_name', value: 'Example', reason: '=1+1' })])).toContain("'=1+1");
  });
});
