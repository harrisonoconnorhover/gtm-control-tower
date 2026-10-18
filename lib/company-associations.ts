import type { LiveContactState } from './live-control-tower';

export type CompanyAssociationGroup = {
  key: string;
  company: { recordId: string | null; name: string; website: string; phone: string; state: string };
  contactIds: string[];
  companyNames: string[];
  websites: string[];
  reasons: string[];
  status: 'proposed' | 'needs_review';
};
export type CompanyAssociationPreview = {
  groups: CompanyAssociationGroup[];
  unlinked: Array<{ contactId: string; reason: string }>;
  counts: { contacts: number; companies: number; linkedContacts: number; unlinkedContacts: number; reviewGroups: number };
};

/** Proposed local groups only. Names and fuzzy suggestions never establish an association. */
export function deriveCompanyAssociations(contacts: LiveContactState[]): CompanyAssociationPreview {
  const rows = contacts.filter((row) => row.importObject === 'contact_company' && row.recordStatus !== 'merged');
  const groups = new Map<string, CompanyAssociationGroup>();
  const unlinked: CompanyAssociationPreview['unlinked'] = [];
  for (const row of rows) {
    const company = row.associatedCompany;
    const recordId = company?.recordId?.trim() || null;
    const host = companyHostname(company?.website || '');
    if (!company || (!recordId && !host)) {
      unlinked.push({ contactId: row.contactId, reason: 'Map a company record ID or valid website hostname. A company name alone does not establish an association.' });
      continue;
    }
    const key = recordId ? `id:${recordId}` : `domain:${host}`;
    const group = groups.get(key) ?? {
      key, company: { ...company, recordId }, contactIds: [], companyNames: [], websites: [], reasons: [], status: 'proposed',
    };
    group.contactIds.push(row.contactId);
    if (company.name.trim() && !group.companyNames.includes(company.name.trim())) group.companyNames.push(company.name.trim());
    if (host && !group.websites.includes(host)) group.websites.push(host);
    if (company.website.trim() && !host && !group.reasons.includes('A supplied company website is invalid.')) group.reasons.push('A supplied company website is invalid.');
    groups.set(key, group);
  }
  const hosts = new Map<string, Set<string>>();
  for (const group of groups.values()) for (const host of group.websites) {
    const owners = hosts.get(host) ?? new Set<string>(); owners.add(group.key); hosts.set(host, owners);
  }
  for (const group of groups.values()) {
    if (group.companyNames.length > 1) group.reasons.push('This group contains different company spellings. Review the names before choosing a company record.');
    if (group.websites.length > 1) group.reasons.push('The same company record ID has different website hostnames.');
    if (group.websites.some((host) => (hosts.get(host)?.size ?? 0) > 1)) group.reasons.push('This website occurs in separate company groups or record IDs. The groups have not been merged.');
    group.status = group.reasons.length ? 'needs_review' : 'proposed';
    group.reasons.unshift(group.company.recordId
      ? 'Grouped by the supplied company record ID; the ID has not been verified against a CRM.'
      : 'Grouped by the exact website hostname; a shared domain does not prove one legal company.');
  }
  const result = [...groups.values()];
  return { groups: result, unlinked, counts: { contacts: rows.length, companies: result.length,
    linkedContacts: result.reduce((sum, group) => sum + group.contactIds.length, 0), unlinkedContacts: unlinked.length,
    reviewGroups: result.filter((group) => group.status === 'needs_review').length } };
}

export function companyHostname(value: string): string {
  if (!value.trim()) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
    const host = url.hostname.toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && host.includes('.')
      && host.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part)) ? host : '';
  } catch { return ''; }
}
