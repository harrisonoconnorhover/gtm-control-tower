import { exportBrowserCsv, parseBrowserCsv } from './browser-csv';

export const MAX_SUPPRESSION_RULES = 5_000;
export const SUPPRESSION_CSV_MAX_BYTES = 5 * 1024 * 1024;
export const SUPPRESSION_TYPES = [
  { value: 'email', label: 'Exact email address', help: 'Anyone with this email address.' },
  { value: 'email_domain', label: 'Email domain', help: 'Anyone whose email uses this domain.' },
  { value: 'website_domain', label: 'Company website', help: 'Anyone at a company with this website hostname; scheme, path, and www are ignored.' },
  { value: 'domain', label: 'Email or website domain', help: 'Anyone whose email or company website uses this domain.' },
  { value: 'company_name', label: 'Exact company name', help: 'Anyone at this company; capitalization and repeated spaces are ignored.' },
] as const;
export type SuppressionType = typeof SUPPRESSION_TYPES[number]['value'];
export type SuppressionRule = {
  id: string;
  listName: string;
  type: SuppressionType;
  value: string;
  reason: string;
  enabled: boolean;
  includeSubdomains: boolean;
  createdAt: string;
  updatedAt: string;
};
export type NormalizedSuppressionRule = Omit<SuppressionRule, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
export type SuppressionRuleInput = {
  id?: string;
  listName?: string;
  type: SuppressionType;
  value: string;
  reason: string;
  enabled?: boolean;
  includeSubdomains?: boolean;
};
export type SuppressionMatch = Pick<SuppressionRule, 'listName' | 'type' | 'value' | 'reason'> & { ruleId: string };
export type SuppressionContact = {
  importObject?: 'contact' | 'company' | 'contact_company';
  associatedCompany?: { name: string; website: string };
  normalizedEmail?: string | null;
  rawEmail?: string | null;
  company?: string | null;
  website?: string | null;
};

/** Canonical values make manual rules and CSV imports use the same comparisons. */
export function normalizeSuppressionRule(input: unknown): NormalizedSuppressionRule {
  if (!isRecord(input)) throw new Error('Provide a suppression rule.');
  const type = SUPPRESSION_TYPES.find((item) => item.value === input.type)?.value;
  if (!type) throw new Error('Choose a supported suppression rule type.');
  const listName = cleanText(input.listName ?? 'Suppression list', 'List name', 120, true);
  const reason = cleanText(input.reason, 'Suppression reason', 500);
  const source = cleanText(input.value, 'Rule value', 2_048);
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('Enabled must be true or false.');
  if (input.includeSubdomains !== undefined && typeof input.includeSubdomains !== 'boolean') {
    throw new Error('Include subdomains must be true or false.');
  }
  const includeSubdomains = input.includeSubdomains ?? false;
  if (includeSubdomains && (type === 'email' || type === 'company_name')) {
    throw new Error('Subdomain matching is only available for domain and website rules.');
  }
  const value = type === 'email' ? normalizeEmail(source)
    : type === 'company_name' ? normalizeCompany(source)
      : normalizeDomain(source, type !== 'email_domain');
  if (!value) throw new Error(type === 'email' ? 'Enter a valid email address.' : 'Enter a valid business domain or HTTP(S) website.');
  if (type === 'company_name' && value.length > 300) throw new Error('Company names must be 300 characters or fewer.');
  const id = input.id === undefined ? undefined : cleanText(input.id, 'Rule ID', 120);
  return { ...(id ? { id } : {}), listName, type, value, reason, enabled: input.enabled ?? true, includeSubdomains };
}

export function suppressionRuleKey(rule: Pick<SuppressionRule, 'listName' | 'type' | 'value' | 'includeSubdomains'>): string {
  return JSON.stringify([rule.listName.toLowerCase(), rule.type, rule.value, rule.includeSubdomains]);
}

export function matchSuppressionRules(contact: SuppressionContact, rules: readonly SuppressionRule[]): SuppressionMatch[] {
  const email = normalizeEmail(contact.normalizedEmail?.trim() || contact.rawEmail || '');
  const emailDomain = email?.split('@')[1] ?? null;
  const websiteDomain = normalizeDomain(contact.importObject === 'contact_company' ? contact.associatedCompany?.website ?? '' : contact.website ?? '', true);
  const company = normalizeCompany(contact.importObject === 'contact_company' ? contact.associatedCompany?.name ?? '' : contact.company ?? '');
  return rules.filter((rule) => {
    if (!rule.enabled) return false;
    if (rule.type === 'email') return email !== null && email === rule.value;
    if (rule.type === 'company_name') return Boolean(company) && company === rule.value;
    if (rule.type === 'email_domain') return domainMatches(emailDomain, rule);
    if (rule.type === 'website_domain') return domainMatches(websiteDomain, rule);
    return domainMatches(emailDomain, rule) || domainMatches(websiteDomain, rule);
  }).map((rule) => ({ ruleId: rule.id, listName: rule.listName, type: rule.type, value: rule.value, reason: rule.reason }));
}

/** Recompute derived matches; never trust client-supplied matches or alter manual exclusions. */
export function applySuppressionRules<T extends SuppressionContact>(contacts: T[], rules: readonly SuppressionRule[]): Array<T & { suppressionMatches?: SuppressionMatch[] }> {
  return contacts.map((contact) => {
    const next = { ...contact } as T & { suppressionMatches?: SuppressionMatch[] };
    delete next.suppressionMatches;
    const matches = matchSuppressionRules(contact, rules);
    if (matches.length) next.suppressionMatches = matches;
    return next;
  });
}

export function isSuppressed(contact: { suppressionMatches?: SuppressionMatch[] }): boolean {
  return Boolean(contact.suppressionMatches?.length);
}

export function parseSuppressionCsv(text: string): NormalizedSuppressionRule[] {
  if (new TextEncoder().encode(text).byteLength > SUPPRESSION_CSV_MAX_BYTES) throw new Error('Choose a suppression CSV of 5 MiB or smaller.');
  const csv = parseBrowserCsv(text);
  if (csv.rows.length > MAX_SUPPRESSION_RULES) throw new Error(`Import ${MAX_SUPPRESSION_RULES.toLocaleString()} suppression rules or fewer.`);
  const headers = csv.headers.map((header) => header.trim().toLowerCase().replaceAll(' ', '_'));
  const allowed = ['list_name', 'type', 'value', 'reason', 'include_subdomains', 'enabled'];
  if (new Set(headers).size !== headers.length || headers.some((header) => !allowed.includes(header))
    || ['type', 'value', 'reason'].some((header) => !headers.includes(header))) {
    throw new Error('Use CSV headers type,value,reason, with optional list_name,include_subdomains,enabled. Do not repeat headers.');
  }
  return csv.rows.map((row, index) => {
    const cells = Object.fromEntries(headers.map((header, column) => [header, row.values[column]]));
    try {
      return normalizeSuppressionRule({
        listName: cells.list_name?.trim() || 'Suppression list', type: cells.type?.trim().toLowerCase(),
        value: cells.value, reason: cells.reason,
        includeSubdomains: csvBoolean(cells.include_subdomains, false), enabled: csvBoolean(cells.enabled, true),
      });
    } catch (error) {
      throw new Error(`CSV row ${index + 2}: ${error instanceof Error ? error.message : 'Invalid rule.'}`);
    }
  });
}

export function exportSuppressionCsv(rules: readonly SuppressionRule[]): string {
  const headers = ['list_name', 'type', 'value', 'reason', 'include_subdomains', 'enabled'];
  const rows = rules.map((rule, id) => {
    const values = [rule.listName, rule.type, rule.value, rule.reason, String(rule.includeSubdomains), String(rule.enabled)];
    return { id, values, original: values, excluded: false };
  });
  return exportBrowserCsv({ headers, rows, emailColumn: null, trimColumns: [] }).csv;
}

function domainMatches(domain: string | null, rule: SuppressionRule): boolean {
  return domain !== null && (domain === rule.value || (rule.includeSubdomains && domain.endsWith(`.${rule.value}`)));
}

function normalizeCompany(source: string): string {
  return source.trim().replace(/\s+/gu, ' ').toLowerCase();
}

function normalizeEmail(source: string): string | null {
  const value = source.trim().toLowerCase();
  const match = /^([^@\s]+)@([^@\s]+)$/u.exec(value);
  if (!match || value.length > 254) return null;
  const [, local, domain] = match;
  if (local.length > 64 || !/^[a-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/u.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  const host = normalizeDomain(domain, false);
  return host ? `${local}@${host}` : null;
}

function normalizeDomain(source: string, website: boolean): string | null {
  const value = source.trim();
  if (!value || (!website && !/^[\p{L}\p{M}\p{N}.\-\u3002\uFF0E\uFF61]+$/u.test(value))) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    let host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (website) host = host.replace(/^www\./u, '');
    const labels = host.split('.');
    if (host.length > 253 || labels.length < 2 || !/[a-z]/u.test(labels.at(-1) ?? '')
      || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return null;
    return host;
  } catch {
    return null;
  }
}

function cleanText(value: unknown, label: string, limit: number, collapse = false): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const clean = collapse ? value.trim().replace(/\s+/gu, ' ') : value.trim();
  if (!clean || clean.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(clean)) {
    throw new Error(`${label} is required and must be ${limit} characters or fewer, without control characters.`);
  }
  return clean;
}

function csvBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  throw new Error('Boolean cells must contain true or false (yes/no and 1/0 also work).');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
