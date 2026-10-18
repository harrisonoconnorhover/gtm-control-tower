import type { IdentityRecord } from './identity-resolution';
import { normalizeEmail, normalizePhone } from './identity-resolution';
import { normalizeState } from './import-match';
import type { ImportObject, LiveContactState } from './live-control-tower';
import { matchSuppressionRules, type SuppressionRule } from './suppression';

export const LOCAL_MATCH_RULE_VERSION = 'local-match-v1';
export type LocalMatchRecord = {
  id: string; source: 'import' | 'crm' | 'suppression'; name: string; email: string;
  company: string; website: string; phone: string; state: string;
};
export type LocalMatchFinding = {
  key: string; kind: 'company_variant' | 'possible_duplicate' | 'possible_suppression'; contactId: string;
  title: string; priority: 'low' | 'medium' | 'high'; score: number;
  input: LocalMatchRecord; candidate: LocalMatchRecord;
  reasons: Array<{ code: string; message: string; tone: 'supporting' | 'conflict' | 'caution' }>;
};
export type LocalMatchAnalysis = {
  importObject: ImportObject; ruleVersion: string; findings: LocalMatchFinding[]; warnings: string[];
  coverage: { importRows: number; crmRecords: number; suppressionRules: number; comparedPairs: number };
  rarity: { sampleSize: number; available: boolean };
};

type Reason = LocalMatchFinding['reasons'][number];
type Normalized = {
  record: LocalMatchRecord; key: string; name: string; tokens: string[]; company: string; companyBase: string;
  email: string; alias: string; local: string; emailDomain: string; websiteDomain: string; phone: string;
  extension: string; roleInbox: boolean; inactive?: string; rule?: SuppressionRule;
};
const limits = { imports: 5_000, crm: 20_000, rules: 5_000, bucket: 120, rowPairs: 200, totalPairs: 100_000, findings: 3 };
const suffixes = new Set(['co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'llc', 'llp', 'ltd', 'limited', 'plc']);
const freeDomains = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'icloud.com', 'live.com', 'outlook.com', 'yahoo.com', 'aol.com', 'proton.me', 'protonmail.com']);
const roleNames = new Set(['admin', 'billing', 'careers', 'contact', 'hello', 'help', 'info', 'jobs', 'office', 'privacy', 'sales', 'support', 'team']);
const reason = (code: string, message: string, tone: Reason['tone'] = 'supporting'): Reason => ({ code, message, tone });
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const words = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
const fold = (value: string) => value.normalize('NFD').replace(/\p{M}+/gu, '');
const compact = (value: string) => value.replaceAll(' ', '');

/** Advisory only: no network access, edits, merges, or changes to import eligibility. */
export function buildLocalMatchReport({ contacts, crmRecords = [], suppressionRules = [], importObject = contacts[0]?.importObject ?? 'contact' }: {
  contacts: LiveContactState[]; crmRecords?: IdentityRecord[]; suppressionRules?: SuppressionRule[]; importObject?: ImportObject;
}): LocalMatchAnalysis {
  const warnings = new Set<string>(['Suggestions compare selected local candidates, not every possible pair. Scores rank evidence; they are not probabilities or proof of identity.']);
  const take = <T>(items: T[], limit: number, label: string, key: (item: T) => string) => {
    if (items.length > limit) warnings.add(`Only the first ${limit.toLocaleString('en-US')} ${label} in stable ID order were analyzed; the remaining records were not checked.`);
    return [...items].sort((a, b) => lexical(key(a), key(b))).slice(0, limit);
  };
  const rules = take(suppressionRules.filter((rule) => rule.enabled), limits.rules, 'enabled suppression rules', (rule) => rule.id);
  const rows = take(contacts, limits.imports, 'import rows', (row) => row.contactId);
  const crm = take(importObject === 'company' ? [] : crmRecords, limits.crm, 'saved CRM records', (row) => row.recordKey);
  const imports = rows.filter((row) => row.recordStatus !== 'merged').map((row) => normalize({
    id: row.contactId, source: 'import', name: importObject === 'company' ? '' : row.fullName || [row.firstName, row.lastName].filter(Boolean).join(' '),
    email: importObject === 'company' ? '' : row.normalizedEmail || row.rawEmail || '',
    company: importObject === 'contact_company' ? row.associatedCompany?.name || '' : row.company || '',
    website: importObject === 'contact_company' ? row.associatedCompany?.website || '' : row.website || '',
    phone: row.phone || '', state: row.state || '',
  }, row.importExclusion ? 'This candidate is manually excluded from import.'
    : row.suppressionMatches?.length || matchSuppressionRules(row, rules).length ? 'This candidate already matches an exact suppression rule.' : undefined));
  const saved = crm.map((row) => normalize({ id: row.recordKey, source: 'crm', name: row.fullName || [row.firstName, row.lastName].filter(Boolean).join(' '),
    email: row.email || '', company: row.company || '', website: row.website || '', phone: row.phone || '', state: row.state || '' }));
  const people = [...imports, ...saved].sort((a, b) => lexical(a.key, b.key));
  const frequencies = localFrequencies(people);
  const rarity = { sampleSize: frequencies.sampleSize, available: frequencies.sampleSize >= 100 };
  if (importObject !== 'company' && !rarity.available) warnings.add(`Name rarity is unavailable: ${rarity.sampleSize} locally observed identities with names; at least 100 are required. No population-wide rarity is inferred.`);
  const candidates = [...people, ...rules.map((rule) => normalize({ id: rule.id, source: 'suppression', name: rule.listName,
    email: rule.type === 'email' ? rule.value : '', company: rule.type === 'company_name' ? rule.value : '',
    website: ['domain', 'email_domain', 'website_domain'].includes(rule.type) ? rule.value : '', phone: '', state: '' }, undefined, rule))];
  const buckets = new Map<string, Normalized[]>();
  for (const candidate of candidates) {
    for (const key of candidateKeys(candidate).keys()) {
      const bucket = buckets.get(key) ?? [];
      if (bucket.length < limits.bucket) bucket.push(candidate);
      else warnings.add('Some common-value candidate groups exceeded 120 records and were capped. Results are incomplete for those groups; narrow the list for additional review.');
      buckets.set(key, bucket);
    }
  }
  const findings: LocalMatchFinding[] = [];
  let comparedPairs = 0;
  for (const input of imports.filter((row) => !row.inactive)) {
    if (comparedPairs >= limits.totalPairs) break;
    const ranked = new Map<string, { candidate: Normalized; weight: number }>();
    for (const [key, weight] of candidateKeys(input)) {
      for (const candidate of buckets.get(key) ?? []) {
        if (candidate.key === input.key) continue;
        const previous = ranked.get(candidate.key);
        ranked.set(candidate.key, { candidate, weight: (previous?.weight ?? 0) + weight });
      }
    }
    const selected = [...ranked.values()].sort((a, b) => b.weight - a.weight || lexical(a.candidate.key, b.candidate.key));
    if (selected.length > limits.rowPairs) warnings.add('Some rows exceeded 200 candidate comparisons and were capped. Additional matches may exist.');
    const rowFindings: LocalMatchFinding[] = [];
    for (const { candidate } of selected.slice(0, limits.rowPairs)) {
      if (comparedPairs >= limits.totalPairs) break;
      comparedPairs += 1;
      if (candidate.rule) {
        const match = suppressionFinding(input, candidate);
        if (match) rowFindings.push(match);
      } else {
        const company = companyFinding(input, candidate) ?? (importObject === 'company' ? exactCompanyFinding(input, candidate) : null);
        if (company) rowFindings.push(company);
        // One review item per active import pair; excluded candidates remain useful context.
        const duplicate = importObject === 'company' || candidate.record.source === 'import' && !candidate.inactive && lexical(input.record.id, candidate.record.id) > 0
          ? null : duplicateFinding(input, candidate, frequencies, rarity.available);
        if (duplicate) rowFindings.push(duplicate);
      }
    }
    for (const kind of ['company_variant', 'possible_duplicate', 'possible_suppression'] as const) {
      const seen = new Set<string>();
      const matches = rowFindings.filter((finding) => finding.kind === kind).sort(compareFindings).filter((finding) => {
        // Repeated employees at one company should not crowd out other company suggestions.
        const key = kind === 'company_variant' ? words(finding.candidate.company) : finding.key;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      if (matches.length > limits.findings) warnings.add('Only the three highest-ranked suggestions of each kind are shown per row. Multiple plausible candidates need human review.');
      const shown = matches.slice(0, limits.findings);
      if (shown.length > 1) for (const finding of shown) finding.reasons.push(reason('multiple_candidates', 'More than one candidate is plausible; no single match has been established.', 'caution'));
      findings.push(...shown);
    }
  }
  if (comparedPairs >= limits.totalPairs) warnings.add('The 100,000-comparison limit was reached. Later rows may have no suggestions because they were not analyzed; split this list for fuller coverage.');
  return { importObject, ruleVersion: LOCAL_MATCH_RULE_VERSION, findings: findings.sort((a, b) => lexical(a.contactId, b.contactId) || compareFindings(a, b)),
    warnings: [...warnings].sort(lexical), coverage: { importRows: rows.length, crmRecords: crm.length, suppressionRules: rules.length, comparedPairs }, rarity };
}

function normalize(record: LocalMatchRecord, inactive?: string, rule?: SuppressionRule): Normalized {
  const name = words(record.source === 'suppression' ? '' : record.name);
  const company = words(record.company);
  const companyTokens = company.split(' ').filter(Boolean);
  while (companyTokens.length > 1 && suffixes.has(companyTokens.at(-1)!)) companyTokens.pop();
  const email = normalizeEmail(record.email) || '';
  const [local = '', emailDomain = ''] = email.split('@');
  const alias = ['gmail.com', 'googlemail.com'].includes(emailDomain) ? `${local.split('+')[0].replaceAll('.', '')}@gmail.com` : email;
  return { record, key: JSON.stringify([record.source, record.id]), name, tokens: name.split(' ').filter(Boolean), company, companyBase: companyTokens.join(' '),
    email, alias, local, emailDomain, websiteDomain: domain(record.website), phone: normalizePhone(record.phone) || '',
    extension: /(?:ext\.?|extension|x)\s*(\d+)\s*$/iu.exec(record.phone)?.[1] ?? '',
    roleInbox: roleNames.has(local.split('+')[0].replaceAll('.', '')), inactive, rule };
}

function domain(value: string): string {
  if (!value.trim()) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `https://${value}`);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.hostname.toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '') : '';
  } catch { return ''; }
}

function candidateKeys(row: Normalized): Map<string, number> {
  const keys = new Map<string, number>();
  const add = (prefix: string, value: string, weight: number) => { if (value) keys.set(`${prefix}:${value}`, weight); };
  add('email', row.email, 160); add('alias', row.alias, 150); add('name', row.name, 120);
  add('name-tokens', fold([...row.tokens].sort(lexical).join(' ')), 100);
  if (row.tokens.length > 1) {
    add('name-part', `${row.tokens[0]}:${row.tokens.at(-1)![0]}`, 35);
    add('name-part', `${row.tokens.at(-1)}:${row.tokens[0][0]}`, 35);
  }
  add('phone', row.phone, 60); add('company', row.companyBase, 30); add('email-local', row.local.length >= 4 ? row.local : '', 20);
  for (const host of [row.emailDomain, row.websiteDomain]) {
    add('domain', host, 20);
    for (const gram of grams(host)) add('domain-gram', gram, 1);
  }
  for (const gram of grams(compact(row.companyBase))) add('company-gram', gram, 1);
  return keys;
}

function grams(value: string): string[] {
  const chars = Array.from(value.slice(0, 120));
  return chars.length < 4 ? [] : [...new Set(chars.slice(0, -2).map((_, index) => chars.slice(index, index + 3).join('')))].slice(0, 32);
}

/** Bounded optimal-string-alignment distance includes adjacent transpositions. */
function editDistance(left: string, right: string, maximum = 2): number {
  const a = Array.from(left); const b = Array.from(right);
  if (a.length > 120 || b.length > 120 || Math.abs(a.length - b.length) > maximum) return maximum + 1;
  let older: number[] = []; let previous = b.map((_, index) => index + 1); previous.unshift(0);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) next[j] = Math.min(next[j], older[j - 2] + 1);
    }
    older = previous; previous = next;
  }
  return previous[b.length];
}

function near(left: string, right: string): boolean {
  const length = Math.min(Array.from(left).length, Array.from(right).length);
  if (!left || !right || length < 5 || left === right) return false;
  const distance = editDistance(left, right);
  return distance === 1 || length >= 12 && distance === 2;
}

function companyEvidence(a: Normalized, b: Normalized): Reason | null {
  if (!a.companyBase || !b.companyBase || Math.min(compact(a.companyBase).length, compact(b.companyBase).length) < 4) return null;
  if (a.record.company.trim().toLowerCase() === b.record.company.trim().toLowerCase()) return null;
  if (a.company === b.company) return reason('company_format', 'Company names differ only in spacing or punctuation; the stored spelling is not proof of the correct name.');
  if (a.companyBase === b.companyBase) return reason('company_suffix', 'Company names agree after removing a trailing legal suffix; subsidiaries or separate legal entities may still differ.', 'caution');
  if (a.companyBase.split(' ').sort(lexical).join(' ') === b.companyBase.split(' ').sort(lexical).join(' ')) return reason('company_tokens', 'The same company-name words appear in a different order.', 'caution');
  if (fold(a.companyBase) === fold(b.companyBase)) return reason('company_diacritics', 'Company names differ in accents or diacritics; both spellings may be intentional.', 'caution');
  if (near(compact(a.companyBase), compact(b.companyBase))) return reason('company_typo', 'Company names differ by a small spelling edit or adjacent transposition.');
  return null;
}

function companyFinding(a: Normalized, b: Normalized): LocalMatchFinding | null {
  const evidence = companyEvidence(a, b);
  if (!evidence) return null;
  const reasons = [evidence]; let score = evidence.code === 'company_typo' ? 60 : 43;
  if (a.websiteDomain && a.websiteDomain === b.websiteDomain) { score += 20; reasons.push(reason('same_website', 'The company website hostnames also match.')); }
  else if (a.websiteDomain && b.websiteDomain) { score -= 12; reasons.push(reason('different_websites', 'Company website hostnames differ; this may be a different company.', 'conflict')); }
  else reasons.push(reason('missing_company_context', 'A company website is missing, so the name suggestion has less supporting context.', 'caution'));
  reasons.push(reason('not_canonical', 'This is a spelling candidate from available local data, not verified company identity.', 'caution'));
  return finding('company_variant', a, b, `Company name resembles “${b.record.company}”`, score, reasons);
}

function exactCompanyFinding(a: Normalized, b: Normalized): LocalMatchFinding | null {
  const sameWebsite = Boolean(a.websiteDomain && a.websiteDomain === b.websiteDomain);
  const sameName = Boolean(a.company && a.company === b.company);
  if (!sameWebsite && !sameName) return null;
  if (b.record.source === 'import' && !b.inactive && lexical(a.record.id, b.record.id) > 0) return null;
  const reasons: Reason[] = [];
  if (sameWebsite) reasons.push(reason('same_website', 'The company website hostnames match. A shared domain can cover separate entities.', 'caution'));
  if (sameName) reasons.push(reason('same_company_name', 'The normalized company names match; this alone does not prove company identity.', 'caution'));
  if (!sameWebsite && a.websiteDomain && b.websiteDomain) reasons.push(reason('different_websites', 'Website hostnames differ; these may be separate companies.', 'conflict'));
  if (!sameName && a.company && b.company) reasons.push(reason('different_company_names', 'Company names differ despite the shared hostname.', 'conflict'));
  reasons.push(reason('not_canonical', 'Review these company records before selecting a canonical record. Nothing is merged automatically.', 'caution'));
  return finding('company_variant', a, b, `Possible company match: “${b.record.company || b.record.website}”`, sameName && sameWebsite ? 80 : 45, reasons);
}

function localFrequencies(records: Normalized[]) {
  const identities = new Set<string>(); const nameOwners = new Map<string, Set<string>>(); const phones = new Map<string, Set<string>>();
  for (const row of records) {
    const key = row.alias || row.key;
    if (row.name) {
      identities.add(key);
      const owners = nameOwners.get(row.name) ?? new Set<string>(); owners.add(key); nameOwners.set(row.name, owners);
    }
    if (row.phone) { const owners = phones.get(row.phone) ?? new Set<string>(); owners.add(key); phones.set(row.phone, owners); }
  }
  return { names: new Map([...nameOwners].map(([name, owners]) => [name, owners.size])), phones, sampleSize: identities.size };
}

function compatibleName(a: Normalized, b: Normalized): Reason | null {
  if (!a.name || !b.name || a.name === b.name) return null;
  if (fold(a.name) === fold(b.name)) return reason('name_diacritics', 'Names differ only in accents or diacritics; the original spelling is preserved.', 'caution');
  if (a.tokens.length > 1 && [...a.tokens].sort(lexical).join(' ') === [...b.tokens].sort(lexical).join(' ')) return reason('name_order', 'The same name words appear in a different order.', 'caution');
  if (a.tokens.length < 2 || b.tokens.length < 2) return null;
  const firstA = a.tokens[0]; const firstB = b.tokens[0]; const lastA = a.tokens.at(-1)!; const lastB = b.tokens.at(-1)!;
  const middleA = a.tokens.slice(1, -1); const middleB = b.tokens.slice(1, -1);
  const middleCompatible = !middleA.length || !middleB.length || middleA.length === middleB.length && middleA.every((token, index) => token === middleB[index] || token[0] === middleB[index][0] && (token.length === 1 || middleB[index].length === 1));
  if (!middleCompatible) return null;
  if (firstA === firstB && lastA === lastB) return reason('name_middle', 'First and last names agree; middle names or initials differ or are missing.', 'caution');
  if (lastA === lastB && firstA[0] === firstB[0] && (firstA.length === 1 || firstB.length === 1)) return reason('name_initial', 'The surname and first initial agree; an initial can represent many different people.', 'caution');
  const close = (left: string, right: string) => Math.min(left.length, right.length) >= 4 && editDistance(left, right, 1) === 1;
  if (firstA === firstB && close(lastA, lastB) || lastA === lastB && close(firstA, firstB)) return reason('name_typo', 'One name component has a small spelling difference.', 'caution');
  return null;
}

function duplicateFinding(a: Normalized, b: Normalized, frequencies: ReturnType<typeof localFrequencies>, rarityAvailable: boolean): LocalMatchFinding | null {
  const exactName = Boolean(a.name && a.name === b.name);
  const sameCompany = Boolean(a.companyBase && a.companyBase === b.companyBase);
  const sameDomain = Boolean(a.emailDomain && !freeDomains.has(a.emailDomain) && a.emailDomain === b.emailDomain)
    || Boolean(a.websiteDomain && a.websiteDomain === b.websiteDomain);
  const samePhone = Boolean(a.phone && a.phone === b.phone);
  const sharedPhone = samePhone && (frequencies.phones.get(a.phone)?.size ?? 0) > 2;
  const extensionConflict = samePhone && Boolean(a.extension && b.extension && a.extension !== b.extension);
  const strongPhone = samePhone && !sharedPhone && !extensionConflict;
  const exactEmail = Boolean(a.email && a.email === b.email);
  const role = a.roleInbox || b.roleInbox;
  const alias = Boolean(!exactEmail && a.alias && a.alias === b.alias && a.alias.endsWith('@gmail.com'));
  const similarName = compatibleName(a, b);
  const context = sameCompany || sameDomain || strongPhone;
  const emailTypo = Boolean(a.email && b.email && a.email !== b.email && (a.emailDomain === b.emailDomain && near(a.local, b.local) || a.local === b.local && near(a.emailDomain, b.emailDomain)));
  if (!(exactName && (a.tokens.length > 1 || context) || exactEmail && (!role || exactName || similarName)
    || alias || similarName && context || emailTypo && (exactName || similarName || !a.name && !b.name && strongPhone))) return null;
  const reasons: Reason[] = []; let score = 0;
  if (exactName) {
    score += 28; reasons.push(reason('same_name', 'The full names match after case, spacing, and punctuation normalization.'));
    const frequency = frequencies.names.get(a.name) ?? 0;
    if (!rarityAvailable) reasons.push(reason('rarity_unknown', 'Too few local identities to estimate name rarity; this name receives no rarity boost.', 'caution'));
    else if (frequency >= 5 || frequency / frequencies.sampleSize >= 0.05) {
      score -= 8; reasons.push(reason('common_local_name', `This name occurs ${frequency} times among ${frequencies.sampleSize} locally observed identities, so name agreement receives less weight.`, 'caution'));
    } else if (frequency <= 2) {
      score += 6; reasons.push(reason('uncommon_local_name', `This name occurs ${frequency} times among ${frequencies.sampleSize} locally observed identities; a small local rarity adjustment is applied. This is not population rarity.`));
    } else reasons.push(reason('local_name_frequency', `This name occurs ${frequency} times among ${frequencies.sampleSize} locally observed identities; no rarity adjustment is applied.`, 'caution'));
  } else if (similarName) { score += 18; reasons.push(similarName); }
  else if (a.name && b.name) { score -= 25; reasons.push(reason('different_names', 'Names conflict; a shared address may belong to multiple people.', 'conflict')); }
  if (exactEmail) {
    score += role ? 8 : 60; reasons.push(reason(role ? 'shared_inbox' : 'same_email', role ? 'The matching email is a role inbox and is weak evidence of the same person.' : 'The normalized email addresses match.', role ? 'caution' : 'supporting'));
  } else if (alias) { score += 42; reasons.push(reason('gmail_alias', 'Gmail/Googlemail dots and plus tags resolve to the same alias family; ownership is still unverified.')); }
  else if (a.email && b.email) {
    score -= 4; reasons.push(reason('different_emails', 'Email addresses differ; neither address will be replaced.', 'conflict'));
    if (emailTypo) { score += 8; reasons.push(reason('email_typo', 'The email addresses have a small spelling difference supported by other identity clues.', 'caution')); }
  }
  if (role && !exactEmail) reasons.push(reason('role_inbox', 'At least one address is a role inbox, which may be shared by several people.', 'caution'));
  if (sameCompany) { score += 14; reasons.push(reason('same_company', 'Company names agree after conservative legal-suffix normalization.')); }
  else if (a.companyBase && b.companyBase && !companyEvidence(a, b)) { score -= 8; reasons.push(reason('different_companies', 'Company names differ; employment may have changed or these may be different people.', 'conflict')); }
  if (sameDomain) { score += 14; reasons.push(reason('same_business_domain', 'A business email domain or company website hostname matches.')); }
  else if (a.emailDomain && b.emailDomain && !freeDomains.has(a.emailDomain) && !freeDomains.has(b.emailDomain)) {
    score -= 10; reasons.push(reason('different_business_domains', 'Business email domains differ, reducing the strength of this match.', 'conflict'));
  }
  if (samePhone) {
    score += strongPhone ? 24 : 0;
    reasons.push(reason(extensionConflict ? 'different_extensions' : sharedPhone ? 'shared_phone' : 'same_phone', extensionConflict
      ? 'The base phone matches but extensions differ; this may be a shared switchboard.' : sharedPhone
        ? 'This phone appears on more than two local identities and is treated as shared, with no score boost.' : 'Phone numbers match after formatting normalization.', strongPhone ? 'supporting' : 'caution'));
    if (a.extension || b.extension) reasons.push(reason('phone_extension', 'Phone extensions are compared separately from the base number; a missing extension does not establish the same person.', 'caution'));
    if ([a.record.phone, b.record.phone].some((value) => value.replace(/(?:ext\.?|extension|x)\s*\d+\s*$/iu, '').replace(/\D/gu, '').length === 10)) {
      reasons.push(reason('phone_country_assumption', 'A ten-digit phone number was interpreted using country code +1; verify country context.', 'caution'));
    }
  } else if (a.phone && b.phone) { score -= 4; reasons.push(reason('different_phones', 'Phone numbers differ; this is conflicting but not definitive evidence.', 'conflict')); }
  if (a.record.state && b.record.state && normalizeState(a.record.state) !== normalizeState(b.record.state)) {
    score -= 3; reasons.push(reason('different_states', 'State or region values differ; location may have changed.', 'conflict'));
  }
  if (!context && !exactEmail && !alias) reasons.push(reason('limited_context', 'No matching company, business domain, or personal phone corroborates the name; treat this as a small warning.', 'caution'));
  if (!context && !exactEmail && !alias || role && !strongPhone || similarName?.code === 'name_initial') score = Math.min(score, 49);
  return finding('possible_duplicate', a, b, `Possible duplicate: ${b.record.name || b.record.email}`, score, reasons);
}

function suppressionFinding(a: Normalized, b: Normalized): LocalMatchFinding | null {
  const rule = b.rule!;
  if (matchSuppressionRules({ normalizedEmail: a.email, company: a.record.company, website: a.record.website }, [rule]).length) return null;
  let evidence: Reason | null = null;
  if (rule.type === 'company_name') evidence = companyEvidence(a, b);
  else if (rule.type === 'email' && a.email && (a.emailDomain === b.emailDomain && near(a.local, b.local) || a.local === b.local && near(a.emailDomain, b.emailDomain))) {
    evidence = reason('near_suppressed_email', 'The email address is one or two small spelling edits from a saved suppressed address.', 'caution');
  } else if (rule.type !== 'email') {
    const domains = rule.type === 'email_domain' ? [a.emailDomain] : rule.type === 'website_domain' ? [a.websiteDomain] : [a.emailDomain, a.websiteDomain];
    if (domains.some((host) => near(host, b.websiteDomain))) evidence = reason('near_suppressed_domain', 'A hostname has a small spelling difference from a saved suppressed domain; the hostnames are not equal.', 'caution');
  }
  if (!evidence) return null;
  return finding('possible_suppression', a, b, `Possible suppression match: ${rule.value}`, 45, [evidence,
    reason('suppression_rule', `List “${rule.listName}”, ${rule.type.replaceAll('_', ' ')} rule “${rule.value}”. Reason: ${rule.reason}`, 'caution'),
    reason('suppression_review_only', 'This approximate match does not exclude the row or change the suppression list. Review it before taking a separate exclusion action.', 'caution')]);
}

function finding(kind: LocalMatchFinding['kind'], a: Normalized, b: Normalized, title: string, rawScore: number, reasons: Reason[]): LocalMatchFinding {
  const score = Math.max(1, Math.min(99, rawScore));
  if (b.inactive) reasons.push(reason('excluded_candidate', b.inactive, 'caution'));
  if (b.record.source === 'crm') reasons.push(reason('saved_snapshot', 'Candidate comes from a saved local CRM snapshot and may be outdated.', 'caution'));
  return { key: JSON.stringify([kind, a.record.id, b.record.source, b.record.id]), kind, contactId: a.record.id, title,
    priority: score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low', score, input: a.record, candidate: b.record, reasons };
}

function compareFindings(a: LocalMatchFinding, b: LocalMatchFinding): number {
  return b.score - a.score || lexical(a.key, b.key);
}
