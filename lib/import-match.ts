import {
  nameSimilarity, normalizeCompany, normalizeEmail, normalizeName, normalizePhone,
  type IdentityRecord, type MatchEvidence,
} from './identity-resolution';

export type MatchField = 'name' | 'email' | 'phone' | 'state' | 'company';
export type ImportMatchInput = {
  contactId: string; fullName: string; email: string; phone: string; state: string; company: string;
};
export type MatchFieldSuggestion = {
  field: MatchField; label: string; populated: number; total: number; recommended: boolean; reason: string;
};
export type ImportMatchComparison = {
  field: MatchField; imported: string; existing: string; status: 'match' | 'similar' | 'conflict' | 'missing';
};
export type ImportMatchCandidate = {
  record: IdentityRecord; score: number; evidence: MatchEvidence[]; comparisons: ImportMatchComparison[];
};
export type ImportMatchReport = {
  ruleVersion: string; fields: MatchField[];
  rows: Array<{ contactId: string; input: ImportMatchInput; candidates: ImportMatchCandidate[]; candidateCount: number; warnings: string[] }>;
  warnings: string[];
};

export const IMPORT_MATCH_RULE_VERSION = 'import-match-v1';
const fieldLabels: Record<MatchField, string> = { name: 'Name', email: 'Email', phone: 'Phone', state: 'State', company: 'Company' };
const allFields = Object.keys(fieldLabels) as MatchField[];
const MAX_BROAD_BUCKET = 250;
const MAX_CANDIDATES = 1_000;
const genericInboxes = new Set(['admin', 'billing', 'contact', 'hello', 'help', 'info', 'office', 'sales', 'support', 'team']);
const placeholders = new Set(['unknown', 'n/a', 'na', 'none', 'null', 'not provided']);
const usStates = new Map('AL:Alabama;AK:Alaska;AZ:Arizona;AR:Arkansas;CA:California;CO:Colorado;CT:Connecticut;DE:Delaware;FL:Florida;GA:Georgia;HI:Hawaii;ID:Idaho;IL:Illinois;IN:Indiana;IA:Iowa;KS:Kansas;KY:Kentucky;LA:Louisiana;ME:Maine;MD:Maryland;MA:Massachusetts;MI:Michigan;MN:Minnesota;MS:Mississippi;MO:Missouri;MT:Montana;NE:Nebraska;NV:Nevada;NH:New Hampshire;NJ:New Jersey;NM:New Mexico;NY:New York;NC:North Carolina;ND:North Dakota;OH:Ohio;OK:Oklahoma;OR:Oregon;PA:Pennsylvania;RI:Rhode Island;SC:South Carolina;SD:South Dakota;TN:Tennessee;TX:Texas;UT:Utah;VT:Vermont;VA:Virginia;WA:Washington;WV:West Virginia;WI:Wisconsin;WY:Wyoming;DC:District of Columbia'
  .split(';').flatMap((pair) => { const [code, name] = pair.toLowerCase().split(':'); return [[code, code], [name, code]]; }));

type Normalized = {
  name: string | null; emails: string[]; phones: string[]; state: string | null; company: string | null;
};

export function suggestMatchFields(inputs: ImportMatchInput[]): MatchFieldSuggestion[] {
  const normalized = inputs.map((input) => normalize(input));
  const hasPersonalField = normalized.some((item) => Boolean(item.name || item.emails.length || item.phones.length));
  return allFields.map((field) => {
    const populated = normalized.filter((item) => hasField(item, field)).length;
    const supporting = field === 'state' || field === 'company';
    return {
      field, label: fieldLabels[field], populated, total: inputs.length,
      recommended: populated > 0 && (!supporting || hasPersonalField),
      reason: !populated ? 'No usable values in these imported rows.'
        : supporting ? 'Adds context to a person or email match; cannot identify a person alone.'
          : field === 'email' ? 'Valid email values can match primary or additional CRM email addresses.'
            : field === 'phone' ? 'Usable phone values can corroborate identity; shared numbers receive less weight.'
              : 'Full names can suggest candidates; names alone remain weak evidence.',
    };
  });
}

export function compareImportedContacts(inputs: ImportMatchInput[], crm: IdentityRecord[], fields: MatchField[]): ImportMatchReport {
  if (inputs.length > 100) throw new Error('Analyze at most 100 imported contacts at a time.');
  if (crm.length > 25_000) throw new Error('Analyze at most 25,000 CRM records at a time.');
  if (fields.some((field) => !allFields.includes(field))) throw new Error('Choose supported matching fields.');
  const selected = allFields.filter((field) => fields.includes(field));
  const enabled = new Set(selected);
  const stable = [...crm].sort((a, b) => a.recordKey.localeCompare(b.recordKey));
  const normalized = stable.map((record) => normalize({
    ...record, fullName: record.fullName || `${record.firstName} ${record.lastName}`, state: record.state ?? '',
  }, record.additionalEmails, record.secondaryPhone));
  const phoneFrequency = new Map<string, number>();
  for (const item of normalized) for (const phone of item.phones) phoneFrequency.set(phone, (phoneFrequency.get(phone) ?? 0) + 1);
  const buckets = new Map<string, number[]>();
  normalized.forEach((item, index) => {
    for (const key of candidateKeys(item, enabled, phoneFrequency)) {
      const members = buckets.get(key) ?? [];
      members.push(index);
      buckets.set(key, members);
    }
  });
  const warnings = [
    'Match scores are deterministic review signals, not probabilities. No suggestion does not establish that a contact is absent from the CRM.',
    ...(!selected.length ? ['Select at least one field to compare.'] : []),
    ...selected.filter((field) => !normalized.some((item) => hasField(item, field)))
      .map((field) => `No usable ${fieldLabels[field].toLowerCase()} values are present in this CRM snapshot; that field cannot contribute to this analysis.`),
    ...(enabled.has('state') ? ['State comparison treats US state names and two-letter codes as equivalent; other regions use normalized text.'] : []),
    ...(enabled.has('phone') ? ['Phone comparison ignores extensions and assumes a US country code for ten-digit numbers; a shared phone is not proof of identity.'] : []),
  ];
  const rows = inputs.map((input) => {
    const imported = normalize(input);
    const indices = new Set<number>();
    const rowWarnings: string[] = [];
    let skipped = 0;
    let capped = false;
    // Exact emails are considered first, then narrower corroborating buckets.
    const keys = candidateKeys(imported, enabled, phoneFrequency).sort((a, b) =>
      Number(!a.startsWith('email:')) - Number(!b.startsWith('email:'))
      || (buckets.get(a)?.length ?? 0) - (buckets.get(b)?.length ?? 0) || a.localeCompare(b));
    for (const key of keys) {
      const members = buckets.get(key) ?? [];
      if (members.length > MAX_BROAD_BUCKET && !key.startsWith('email:')) { skipped += 1; continue; }
      for (const index of members) {
        if (indices.size >= MAX_CANDIDATES && !indices.has(index)) { capped = true; break; }
        indices.add(index);
      }
    }
    if (skipped) rowWarnings.push(`${skipped} broad candidate bucket(s) exceeded ${MAX_BROAD_BUCKET} CRM records and were skipped. This result is incomplete.`);
    if (capped) rowWarnings.push(`Candidate comparison was capped at ${MAX_CANDIDATES} CRM records. Ranking is limited to those compared.`);
    if (enabled.has('phone') && imported.phones.some((phone) => (phoneFrequency.get(phone) ?? 0) > 3)) {
      rowWarnings.push('This phone appears on more than 3 CRM records and is used only as supporting context, not to generate candidates on its own.');
    }
    if (!selected.some((field) => hasField(imported, field))) rowWarnings.push('This row has no usable values in the selected fields.');
    else if (!(['name', 'email', 'phone'] as MatchField[]).some((field) => enabled.has(field) && hasField(imported, field))) {
      rowWarnings.push('State and company alone cannot suggest a person. Select a populated name, email, or phone field.');
    }
    const candidates = [...indices].flatMap((index) => {
      const match = scoreCandidate(input, imported, stable[index], normalized[index], selected, phoneFrequency);
      return match ? [match] : [];
    }).sort((a, b) => b.score - a.score || a.record.recordKey.localeCompare(b.record.recordKey));
    return { contactId: input.contactId, input, candidates: candidates.slice(0, 3), candidateCount: candidates.length, warnings: rowWarnings };
  });
  if (rows.some((row) => row.warnings.some((warning) => warning.includes('incomplete') || warning.includes('capped')))) {
    warnings.push('Some rows reached candidate-search limits. Read their warnings before interpreting missing suggestions.');
  }
  return { ruleVersion: IMPORT_MATCH_RULE_VERSION, fields: selected, rows, warnings };
}

function candidateKeys(item: Normalized, fields: Set<MatchField>, phoneFrequency: Map<string, number>): string[] {
  const keys = new Set<string>();
  if (fields.has('email')) for (const email of item.emails) keys.add(`email:${email}`);
  if (fields.has('phone')) for (const phone of item.phones) {
    if ((phoneFrequency.get(phone) ?? 0) <= 3) keys.add(`phone:${phone}`);
  }
  if (fields.has('name') && item.name) {
    keys.add(`name:${item.name}`);
    const parts = item.name.split(' ');
    const initials = `${parts[0][0]}:${parts.at(-1)![0]}`;
    const contexts = [
      ...(fields.has('state') && item.state ? [`state:${item.state}`] : []),
      ...(fields.has('company') && item.company ? [`company:${item.company}`] : []),
      ...(fields.has('phone') ? item.phones.map((phone) => `phone:${phone}`) : []),
      ...(fields.has('email') ? item.emails.map((email) => `domain:${email.split('@')[1]}`) : []),
    ];
    for (const context of contexts) {
      keys.add(`initials:${initials}:${context}`);
      keys.add(`surname:${parts.at(-1)}:${context}`);
    }
  }
  if (fields.has('email') && fields.has('company') && item.company) {
    if (item.emails.length) keys.add(`email-company:${item.company}`);
  }
  return [...keys];
}

function scoreCandidate(input: ImportMatchInput, a: Normalized, record: IdentityRecord, b: Normalized, fields: MatchField[], phoneFrequency: Map<string, number>): ImportMatchCandidate | null {
  const selected = new Set(fields);
  const evidence: MatchEvidence[] = [];
  const add = (key: string, label: string, weight: number, tone: MatchEvidence['tone']) => evidence.push({ key, label, weight, tone });
  const sameName = Boolean(selected.has('name') && a.name && a.name === b.name);
  const similarName = Boolean(selected.has('name') && a.name && b.name && !sameName && nameSimilarity(a.name, b.name) >= 0.82);
  const sameCompany = Boolean(selected.has('company') && a.company && a.company === b.company);
  const sameState = Boolean(selected.has('state') && a.state && a.state === b.state);
  const phone = selected.has('phone') ? a.phones.filter((value) => b.phones.includes(value))
    .sort((x, y) => (phoneFrequency.get(x) ?? 0) - (phoneFrequency.get(y) ?? 0) || x.localeCompare(y))[0] : undefined;
  const phoneUses = phone ? phoneFrequency.get(phone) ?? 0 : 0;
  const uniquePhone = Boolean(phone && phoneUses === 1);
  const email = selected.has('email') ? a.emails.find((value) => b.emails.includes(value)) : undefined;
  const genericEmail = Boolean(email && genericInboxes.has(email.split('@')[0].split('+')[0].replaceAll('.', '')));
  const nearEmail = selected.has('email') && !email ? b.emails.find((value) => a.emails.some((imported) => emailTypo(imported, value))) : undefined;
  const contextualName = sameName || similarName;
  const usefulName = sameName || similarName && (sameState || sameCompany || Boolean(phone) || Boolean(nearEmail));
  const usefulTypo = Boolean(nearEmail && (contextualName || sameCompany || uniquePhone));
  const anchored = Boolean(email && !genericEmail || uniquePhone);
  if (!(email || phone && phoneUses <= 3 || usefulName || usefulTypo)) return null;

  const statuses = new Map<MatchField, ImportMatchComparison['status']>();
  for (const field of fields) {
    if (!hasField(a, field) || !hasField(b, field)) { statuses.set(field, 'missing'); continue; }
    let status: ImportMatchComparison['status'] = 'conflict';
    if (field === 'email') {
      if (email) { status = 'match'; add('exact_email', genericEmail ? 'Exact shared-role inbox' : 'Exact primary or additional email', genericEmail ? 25 : 90, genericEmail ? 'warning' : 'strong'); }
      else if (usefulTypo) { status = 'similar'; add('email_typo', 'Email differs by one edit, with corroborating context', 30, 'supporting'); }
      else add('email_conflict', 'Different email identities', -22, 'conflict');
    } else if (field === 'name') {
      if (sameName) { status = 'match'; add('name', 'Exact normalized full name', 32, 'supporting'); }
      else if (similarName) { status = 'similar'; add('name_similar', 'Similar full name', 24, 'supporting'); }
      else add('name_conflict', 'Different full names', -32, 'conflict');
    } else if (field === 'phone') {
      if (phone) { status = 'match'; add('phone', phoneUses > 3 ? `Shared phone on ${phoneUses} CRM records` : `Normalized phone on ${phoneUses} CRM record(s)`, uniquePhone ? 44 : phoneUses <= 3 ? 30 : 8, uniquePhone ? 'strong' : phoneUses > 3 ? 'warning' : 'supporting'); }
      else add('phone_conflict', 'Different phone numbers', -14, 'conflict');
    } else if (field === 'state') {
      if (sameState) { status = 'match'; add('state', 'Same normalized state or region', 6, 'supporting'); }
      else add('state_conflict', 'Different states or regions', -6, 'conflict');
    } else {
      if (sameCompany) { status = 'match'; add('company', 'Same normalized company', 12, 'supporting'); }
      else add('company_conflict', 'Different companies', -8, 'conflict');
    }
    statuses.set(field, status);
  }
  // Apply conflict penalties after the positive score ceiling, so extra weak fields cannot hide a conflict.
  const positive = Math.min(anchored ? 100 : 69, evidence.reduce((sum, item) => sum + Math.max(0, item.weight), 0));
  const score = Math.max(0, positive + evidence.reduce((sum, item) => sum + Math.min(0, item.weight), 0));
  if (score < 28 && !email) return null;
  const comparisons = fields.map((field): ImportMatchComparison => ({
    field, imported: field === 'name' ? input.fullName : input[field],
    existing: field === 'name' ? record.fullName || `${record.firstName} ${record.lastName}`
      : field === 'email' ? ([record.email, ...(record.additionalEmails ?? [])].find((raw) => usableEmail(raw) === (email ?? nearEmail)) ?? record.email)
        : field === 'phone' ? ([record.phone, record.secondaryPhone ?? ''].find((raw) => normalizePhone(raw) === phone) ?? record.phone)
          : record[field] ?? '',
    status: statuses.get(field)!,
  }));
  return { record, score, evidence, comparisons };
}

function normalize(input: Omit<ImportMatchInput, 'contactId'>, additionalEmails: string[] = [], secondaryPhone = ''): Normalized {
  const name = normalizeName(usableText(input.fullName));
  return {
    name: name && name.split(' ').filter((part) => /\p{L}/u.test(part)).length >= 2 ? name : null,
    emails: [...new Set([input.email, ...additionalEmails].map(usableEmail).filter((value): value is string => Boolean(value)))],
    phones: [...new Set([input.phone, secondaryPhone].map(usablePhone).filter((value): value is string => Boolean(value)))],
    state: normalizeState(input.state), company: normalizeCompany(usableText(input.company)),
  };
}

function hasField(item: Normalized, field: MatchField): boolean {
  return field === 'email' ? item.emails.length > 0 : field === 'phone' ? item.phones.length > 0 : Boolean(item[field]);
}

function usableText(value: string): string {
  const text = value.trim();
  return placeholders.has(text.toLowerCase()) ? '' : text;
}

function usableEmail(value: string): string | null {
  // The existing domain normalizer uses URL parsing; reject URL syntax before calling it for an email.
  return /^[^@\s]+@[^@\s/:?#]+\.[^@\s/:?#]+$/u.test(value.trim()) ? normalizeEmail(value) : null;
}

function usablePhone(value: string): string | null {
  const text = usableText(value);
  return /^0+$/u.test(text.replace(/\D/gu, '')) ? null : normalizePhone(text);
}

function normalizeState(value: string): string | null {
  const state = usableText(value).normalize('NFKC').toLowerCase().replaceAll('.', '').replace(/\s+/gu, ' ').trim();
  return /\p{L}/u.test(state) ? usStates.get(state) ?? state : null;
}

function emailTypo(a: string, b: string): boolean {
  const [localA, domainA] = a.split('@');
  const [localB, domainB] = b.split('@');
  // Do not classify different plus-addresses as typos or equivalent identities.
  if (localA.includes('+') || localB.includes('+')) return false;
  return domainA === domainB && Math.min(localA.length, localB.length) >= 5 && oneEditApart(localA, localB)
    || localA === localB && oneEditApart(domainA, domainB);
}

function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let index = 0;
  while (index < Math.min(a.length, b.length) && a[index] === b[index]) index += 1;
  if (a.length === b.length) return a.slice(index + 1) === b.slice(index + 1)
    || a[index] === b[index + 1] && a[index + 1] === b[index] && a.slice(index + 2) === b.slice(index + 2);
  return a.length > b.length ? a.slice(index + 1) === b.slice(index) : a.slice(index) === b.slice(index + 1);
}
