// Register only the bundled English locale; the Node entry dynamically loads every language.
import countries from 'i18n-iso-countries/index.js';
import englishCountries from 'i18n-iso-countries/langs/en.json';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import type { CustomFieldDefinition } from './import-fields';
import type { ImportObject, LiveContactState } from './live-control-tower';
import { isSuppressed } from './suppression';

countries.registerLocale(englishCountries);

export type NormalizationSettings = {
  trimWhitespace: boolean;
  nameCase: 'preserve' | 'title';
  splitFullName: boolean;
  countryFormat: 'name' | 'code';
  normalizeCountries: boolean;
  normalizeStates: boolean;
  defaultCountry: string;
  normalizePhones: boolean;
  normalizeAddresses: boolean;
  normalizeJobTitles: boolean;
  titleRules: Array<{ keywords: string[]; department: string; persona: string }>;
  valueRules: Array<{ field: string; from: string; to: string }>;
};

export type NormalizationPreview = {
  contacts: LiveContactState[];
  changes: Array<{ contactId: string; field: string; before: string; after: string; reason: string }>;
  warnings: Array<{ contactId: string; field: string; reason: string }>;
  changedRows: number;
};

const builtInFields: Record<string, string> = {
  fullName: 'Full name', firstName: 'First name', lastName: 'Last name', company: 'Company',
  phone: 'Phone', jobTitle: 'Job title', website: 'Website', country: 'Country', state: 'State / province',
  address: 'Street address', city: 'City', postalCode: 'Postal code', department: 'Department', persona: 'Persona',
  region: 'Region / territory', segment: 'Segment', associatedCompanyName: 'Associated company name',
  associatedCompanyWebsite: 'Associated company website', associatedCompanyPhone: 'Associated company phone',
  associatedCompanyCountry: 'Associated company country', associatedCompanyState: 'Associated company state / province',
  associatedCompanyAddress: 'Associated company street address', associatedCompanyCity: 'Associated company city',
  associatedCompanyPostalCode: 'Associated company postal code',
};
const personFields = new Set(['fullName', 'firstName', 'lastName', 'jobTitle', 'department', 'persona']);
const associatedKeys: Record<string, string> = {
  associatedCompanyName: 'name', associatedCompanyWebsite: 'website', associatedCompanyPhone: 'phone',
  associatedCompanyCountry: 'country', associatedCompanyState: 'state', associatedCompanyAddress: 'address',
  associatedCompanyCity: 'city', associatedCompanyPostalCode: 'postalCode',
};
const nameFields = new Set(['fullName', 'firstName', 'lastName']);
const addressFields = new Set(['address', 'city', 'postalCode', 'associatedCompanyAddress', 'associatedCompanyCity', 'associatedCompanyPostalCode']);
const customPattern = /^custom:(contact|company):[a-zA-Z][a-zA-Z0-9_]{0,79}$/u;

export function normalizationFieldLabels(importObject: ImportObject, customFields: CustomFieldDefinition[] = []): Record<string, string> {
  const fields = Object.fromEntries(Object.entries(builtInFields).filter(([field]) =>
    importObject === 'contact_company' || (!field.startsWith('associatedCompany') && (importObject !== 'company' || !personFields.has(field)))));
  for (const field of customFields) {
    if (importObject === 'contact_company' || field.object === importObject) fields[`custom:${field.object}:${field.key}`] = `${field.label} (${field.object})`;
  }
  return fields;
}

export function defaultNormalizationSettings(): NormalizationSettings {
  return {
    trimWhitespace: true, nameCase: 'preserve', splitFullName: true, countryFormat: 'name',
    normalizeCountries: true, normalizeStates: true, defaultCountry: '', normalizePhones: true,
    normalizeAddresses: true, normalizeJobTitles: true,
    titleRules: [
      { keywords: ['revenue operations', 'revops', 'sales operations', 'marketing operations'], department: 'Revenue Operations', persona: 'Operations' },
      { keywords: ['account executive', 'sales representative', 'sales director', 'vp sales'], department: 'Sales', persona: 'Sales' },
      { keywords: ['marketing manager', 'marketing director', 'chief marketing officer', 'cmo'], department: 'Marketing', persona: 'Marketing' },
      { keywords: ['software engineer', 'developer', 'engineering manager', 'chief technology officer', 'cto'], department: 'Engineering', persona: 'Technical' },
      { keywords: ['chief executive officer', 'ceo', 'founder'], department: 'Executive', persona: 'Executive' },
    ],
    valueRules: [],
  };
}

export function validateNormalizationSettings(value: unknown): NormalizationSettings {
  if (value === undefined || value === null) return defaultNormalizationSettings();
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Normalization settings must be an object.');
  const input = value as Partial<NormalizationSettings>;
  const settings = { ...defaultNormalizationSettings(), ...input };
  for (const field of ['trimWhitespace', 'splitFullName', 'normalizeCountries', 'normalizeStates', 'normalizePhones', 'normalizeAddresses', 'normalizeJobTitles'] as const) {
    if (typeof settings[field] !== 'boolean') throw new Error('Normalization switches must be true or false.');
  }
  if (!['preserve', 'title'].includes(settings.nameCase) || !['name', 'code'].includes(settings.countryFormat)) throw new Error('Choose a supported name and country format.');
  if (typeof settings.defaultCountry !== 'string' || settings.defaultCountry.length > 100) throw new Error('Default country is invalid.');
  const defaultCountry = countryCode(settings.defaultCountry);
  if (settings.defaultCountry.trim() && !defaultCountry) throw new Error('Choose a recognized default country, or leave it blank.');
  if (!Array.isArray(settings.titleRules) || settings.titleRules.length > 100 || !Array.isArray(settings.valueRules) || settings.valueRules.length > 200) throw new Error('Use at most 100 title rules and 200 value rules.');
  const titleRules = settings.titleRules.map((rule) => {
    if (!rule || !Array.isArray(rule.keywords) || rule.keywords.length > 30
      || rule.keywords.some((word) => typeof word !== 'string' || word.length > 150)
      || typeof rule.department !== 'string' || rule.department.length > 200
      || typeof rule.persona !== 'string' || rule.persona.length > 200) throw new Error('A job title rule is invalid.');
    return { keywords: [...rule.keywords], department: rule.department, persona: rule.persona };
  });
  const valueRules = settings.valueRules.map((rule) => {
    if (!rule || typeof rule.field !== 'string' || (!Object.hasOwn(builtInFields, rule.field) && !customPattern.test(rule.field))
      || typeof rule.from !== 'string' || rule.from.length > 1_000 || typeof rule.to !== 'string' || rule.to.length > 1_000) {
      throw new Error('Value rules can only change supported data fields, never IDs, email addresses, owners, or review controls.');
    }
    return { field: rule.field, from: rule.from, to: rule.to };
  });
  return { ...settings, defaultCountry: defaultCountry ?? '', titleRules, valueRules };
}

export function previewNormalization(contacts: LiveContactState[], value: NormalizationSettings, customFields: CustomFieldDefinition[] = []): NormalizationPreview {
  const settings = validateNormalizationSettings(value);
  const changes: NormalizationPreview['changes'] = [];
  const warnings: NormalizationPreview['warnings'] = [];
  const changedIds = new Set<string>();
  const nextContacts = contacts.map((original) => {
    if (original.recordStatus !== 'active' || original.importExclusion || isSuppressed(original)) return original;
    const changesBeforeRow = changes.length;
    const contact = structuredClone(original);
    const object = original.importObject ?? 'contact';
    const fields = normalizationFieldLabels(object, customFields);
    const reasons = new Map<string, string[]>();
    const warn = (field: string, reason: string) => { warnings.push({ contactId: contact.contactId, field, reason }); };
    const set = (field: string, after: string, reason: string) => {
      if (getValue(contact, field) === after) return;
      setValue(contact, field, after);
      reasons.set(field, [...(reasons.get(field) ?? []), reason]);
    };
    for (const field of Object.keys(fields)) {
      const raw = getValue(contact, field);
      const tidy = settings.trimWhitespace || (settings.normalizeAddresses && addressFields.has(field)) || (settings.normalizeJobTitles && field === 'jobTitle')
        ? whitespace(raw) : raw;
      if (tidy !== raw) set(field, tidy, addressFields.has(field) ? 'Cleaned address spacing; postal accuracy was not verified.' : 'Removed extra whitespace.');
      if (settings.nameCase === 'title' && nameFields.has(field) && tidy) set(field, titleCase(tidy), 'Applied the selected name casing; review spelling and cultural conventions.');
    }
    // Resolve alias chains to their terminal value in one pass, so applying the
    // same template twice cannot quietly keep changing a record.
    const applyValueRule = (field: string) => {
      if (!Object.hasOwn(fields, field)) return;
      const before = getValue(contact, field);
      const rules = settings.valueRules.filter((rule) => rule.field === field && rule.from.trim());
      let candidate = before;
      let failure = '';
      const visited = new Set<string>();
      while (true) {
        const key = folded(candidate);
        const options = new Set(rules.filter((rule) => folded(rule.from) === key).map((rule) => settings.trimWhitespace ? whitespace(rule.to) : rule.to));
        if (!options.size) break;
        if (options.size > 1) { failure = 'Conflicting value rules suggest different replacements; the value was preserved.'; break; }
        const replacement = [...options][0];
        if (replacement === candidate) break;
        if (folded(replacement) === key) { candidate = replacement; break; }
        if (visited.has(key)) { failure = 'Value rules form a cycle; the value was preserved.'; break; }
        visited.add(key);
        candidate = replacement;
      }
      if (failure) warn(field, failure);
      else if (candidate !== before) set(field, candidate, 'Applied the saved exact-value replacement rule.');
    };
    const derivedFields = new Set(['firstName', 'lastName', 'department', 'persona']);
    for (const field of new Set(settings.valueRules.map((rule) => rule.field))) {
      if (!derivedFields.has(field)) applyValueRule(field);
    }
    if (object !== 'company' && settings.splitFullName) {
      const fullName = getValue(contact, 'fullName');
      if (fullName && fullName !== contact.contactId && (!contact.firstName?.trim() || !contact.lastName?.trim())) {
        const split = splitName(fullName);
        if (!split) warn('fullName', 'Name order is ambiguous. Enter First name and Last name explicitly; no split was applied.');
        else if ((contact.firstName?.trim() && folded(contact.firstName) !== folded(split.firstName))
          || (contact.lastName?.trim() && folded(contact.lastName) !== folded(split.lastName))) {
          warn('fullName', 'Existing name parts disagree with this split. Existing First name and Last name were preserved.');
        } else {
          if (!contact.firstName?.trim()) set('firstName', split.firstName, 'Split the two-part full name; existing name parts are preserved.');
          if (!contact.lastName?.trim()) set('lastName', split.lastName, 'Split the two-part full name; existing name parts are preserved.');
        }
      }
    }
    for (const prefix of object === 'contact_company' ? ['', 'associatedCompany'] : ['']) {
      const countryField = prefix ? `${prefix}Country` : 'country';
      const stateField = prefix ? `${prefix}State` : 'state';
      const phoneField = prefix ? `${prefix}Phone` : 'phone';
      const countryValue = getValue(contact, countryField);
      const context = countryValue.trim() ? countryCode(countryValue) : settings.defaultCountry || undefined;
      if (settings.normalizeCountries && countryValue.trim()) {
        if (context) set(countryField, settings.countryFormat === 'code' ? context : countryName(context), 'Matched a country name or ISO country code to the selected picklist standard.');
        else warn(countryField, 'Country was not recognized; the value was preserved for review.');
      }
      const state = getValue(contact, stateField);
      if (settings.normalizeStates && state.trim()) {
        const subdivisions = context === 'US' ? usStates : context === 'CA' ? canadianProvinces : undefined;
        const match = subdivisions?.find(([code, name]) => folded(state).replaceAll('.', '') === folded(code) || folded(state) === folded(name));
        if (match) set(stateField, settings.countryFormat === 'code' ? match[0] : match[1], `Matched a ${context === 'US' ? 'US state' : 'Canadian province / territory'} using the row country or explicit default country.`);
        else warn(stateField, !context ? 'State / province needs a recognized row country or explicit default country; preserved for review.'
          : subdivisions ? 'State / province was not recognized for this country; preserved for review.' : 'State normalization currently supports the United States and Canada; preserved for review.');
      }
      const phone = getValue(contact, phoneField);
      if (settings.normalizePhones && phone.trim()) {
        if (!phone.trim().startsWith('+') && !context) warn(phoneField, 'National phone numbers need a recognized row country or explicit default country; preserved for review.');
        else {
          const parsed = parsePhoneNumberFromString(phone, { defaultCountry: context as CountryCode | undefined, extract: false });
          if (!parsed?.isValid()) warn(phoneField, 'Phone format is not valid for the available country context; preserved for review.');
          else set(phoneField, `${parsed.number}${parsed.ext ? ` ext. ${parsed.ext}` : ''}`, 'Standardized international phone format and preserved the extension; reachability was not verified.');
        }
      }
    }
    if (object !== 'company' && settings.normalizeJobTitles && contact.jobTitle?.trim()) {
      const matches = settings.titleRules.filter((rule) => rule.keywords.some((keyword) => keyword.trim() && phraseMatches(contact.jobTitle!, keyword)));
      const outputs = new Set(matches.map((rule) => JSON.stringify([rule.department.trim(), rule.persona.trim()])));
      if (outputs.size > 1) warn('jobTitle', 'Multiple title rules suggest different categories. Department and persona were preserved for review.');
      else if (matches.length) {
        const match = matches[0];
        if (!contact.department?.trim() && match.department.trim()) set('department', match.department.trim(), 'Filled an empty department using a matching job title rule.');
        if (!contact.persona?.trim() && match.persona.trim()) set('persona', match.persona.trim(), 'Filled an empty persona using a matching job title rule.');
      }
    }
    for (const field of derivedFields) applyValueRule(field);
    const companyIdentityChanged = ['company', 'website', 'associatedCompanyName', 'associatedCompanyWebsite']
      .some((field) => getValue(original, field) !== getValue(contact, field));
    if (companyIdentityChanged) {
      const flags = new Set(contact.qualityFlags);
      if (object === 'company') {
        flags.delete('missing_company_name');
        flags.delete('missing_website');
        if (!contact.company?.trim()) flags.add('missing_company_name');
        if (!contact.website?.trim()) flags.add('missing_website');
        set('fullName', contact.company?.trim() || contact.website?.trim() || contact.contactId, 'Updated the company display name from its name or website.');
      } else {
        flags.delete('missing_company');
        const associated = object === 'contact_company' ? contact.associatedCompany : undefined;
        if (!contact.company?.trim() && !associated?.name.trim() && !associated?.website.trim() && !associated?.recordId?.trim()) flags.add('missing_company');
      }
      contact.qualityFlags = [...flags];
    }
    for (const [field, why] of reasons) {
      const before = getValue(original, field);
      const after = getValue(contact, field);
      if (before !== after) changes.push({ contactId: contact.contactId, field, before, after, reason: [...new Set(why)].join(' ') });
    }
    if (changes.length > changesBeforeRow) {
      changedIds.add(contact.contactId);
      return contact;
    }
    return original;
  });
  return { contacts: nextContacts, changes, warnings, changedRows: changedIds.size };
}

function whitespace(value: string): string { return value.replace(/\s+/gu, ' ').trim(); }
function folded(value: string): string { return whitespace(value).normalize('NFKC').toLocaleLowerCase('en-US'); }
function countryCode(value: string): string | undefined {
  const clean = whitespace(value);
  if (!clean) return undefined;
  const code = clean.replaceAll('.', '').toUpperCase();
  if (['UK', 'GREAT BRITAIN', 'BRITAIN'].includes(code)) return 'GB';
  if (['USA', 'US', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(code)) return 'US';
  if (/^\d{1,3}$/u.test(code)) return countries.numericToAlpha2(code);
  if (countries.isValid(code)) return countries.alpha3ToAlpha2(code) ?? code;
  return countries.getAlpha2Code(clean, 'en');
}
function countryName(code: string): string {
  return code === 'US' ? 'United States' : code === 'GB' ? 'United Kingdom' : countries.getName(code, 'en') ?? code;
}
function titleCase(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/(^|[\s\-'’])\p{L}/gu, (letter) => letter.toLocaleUpperCase('en-US'));
}
function splitName(value: string): { firstName: string; lastName: string } | null {
  const clean = whitespace(value);
  const tokens = clean.includes(',') ? clean.split(',').map(whitespace) : clean.split(' ');
  if (tokens.length !== 2 || tokens.some((token) => !token || /\s/u.test(token)
    || /^(?:mr|mrs|ms|miss|dr|prof|jr|sr|ii|iii|iv)\.?$/iu.test(token) || !/\p{L}/u.test(token))) return null;
  return clean.includes(',') ? { firstName: tokens[1], lastName: tokens[0] } : { firstName: tokens[0], lastName: tokens[1] };
}
function phraseMatches(value: string, keyword: string): boolean {
  const words = (text: string) => folded(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const phrase = words(keyword);
  return Boolean(phrase) && ` ${words(value)} `.includes(` ${phrase} `);
}
function getValue(contact: LiveContactState, field: string): string {
  if (field.startsWith('custom:')) {
    const [, object, key] = field.split(':');
    const source = object === 'company' && contact.importObject === 'contact_company' ? contact.associatedCompany : contact;
    return source?.customFields?.[key] ?? '';
  }
  const value = Object.hasOwn(associatedKeys, field)
    ? (contact.associatedCompany as unknown as Record<string, unknown> | undefined)?.[associatedKeys[field]]
    : (contact as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}
function setValue(contact: LiveContactState, field: string, value: string): void {
  if (field.startsWith('custom:')) {
    const [, object, key] = field.split(':');
    const target = object === 'company' && contact.importObject === 'contact_company' ? contact.associatedCompany : contact;
    if (target) target.customFields = { ...target.customFields, [key]: value };
  } else if (Object.hasOwn(associatedKeys, field)) {
    if (contact.associatedCompany) (contact.associatedCompany as unknown as Record<string, unknown>)[associatedKeys[field]] = value;
  } else (contact as unknown as Record<string, unknown>)[field] = value;
}

const usStates = Object.entries({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin',
  WY: 'Wyoming', AS: 'American Samoa', GU: 'Guam', MP: 'Northern Mariana Islands', PR: 'Puerto Rico', VI: 'U.S. Virgin Islands',
});
const canadianProvinces = Object.entries({
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
});
