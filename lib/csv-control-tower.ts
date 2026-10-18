import { isSuppressed } from './suppression';
import type { ScenarioKey } from './control-tower';
import { isImportExclusion, recomputeImportDuplicateFlags } from './import-exclusions';
import type { ImportObject, LiveContactState, RepairReceipt, RepairRun } from './live-control-tower';
import { customFieldKey, validateCustomFields, type CustomFieldDefinition, type CustomFieldKey } from './import-fields';

export type CsvImportResult = {
  contacts: LiveContactState[];
  sourceRows: number;
  lifecycleComparedRows: number;
  expectedStageMapped: boolean;
};

export type CsvFieldKey = keyof typeof fieldAliases | keyof typeof associatedCompanyAliases | CustomFieldKey;
export type CsvColumnMapping = Partial<Record<CsvFieldKey, string>>;
export type CsvPreview = {
  headers: string[];
  sampleRows: Record<string, string>[];
  suggestedMapping: CsvColumnMapping;
  sourceRows: number;
};

export type CsvRepairResult = {
  contacts: LiveContactState[];
  receipt: RepairReceipt;
  run: RepairRun;
};

export type CsvContactCorrectionInput = {
  rawEmail: string;
  company: string;
  ownerId: string;
  lifecycleStage: string;
  recheckEmail?: boolean;
};

export type CsvContactCorrection = {
  id: string;
  contactId: string;
  reviewedAt: string;
  reason: string;
  before: LiveContactState;
  after: LiveContactState;
};

const fieldAliases = {
  contactId: ['contact_id', 'id', 'record_id', 'hs_object_id'],
  fullName: ['full_name', 'name', 'contact_name', 'contact_full_name', 'person_name', 'person_full_name'],
  firstName: ['first_name', 'given_name', 'contact_first_name'],
  lastName: ['last_name', 'surname', 'family_name', 'contact_last_name'],
  rawEmail: ['raw_email', 'email', 'email_address', 'work_email', 'business_email', 'contact_email', 'primary_email'],
  normalizedEmail: ['normalized_email', 'normalizedemail'],
  company: ['company', 'company_name', 'account', 'account_name', 'organization_name'],
  phone: ['phone', 'phone_number', 'mobile_phone', 'mobile', 'business_phone', 'work_phone', 'contact_phone'],
  jobTitle: ['job_title', 'jobtitle', 'title', 'position'],
  website: ['website', 'website_url', 'company_website', 'account_website', 'url'],
  state: ['state', 'state_province', 'mailing_state', 'mailing_state_province', 'province'],
  country: ['country', 'country_code', 'mailing_country', 'contact_country'],
  address: ['address', 'street_address', 'street', 'mailing_street', 'mailing_address', 'address_line_1'],
  city: ['city', 'mailing_city', 'contact_city'],
  postalCode: ['postal_code', 'postcode', 'zip', 'zip_code', 'mailing_postal_code', 'mailing_zip'],
  department: ['department', 'job_department', 'contact_department'],
  persona: ['persona', 'buyer_persona', 'contact_persona'],
  region: ['region', 'territory', 'sales_region'],
  segment: ['segment', 'market_segment', 'company_segment'],
  lifecycleStage: ['lifecycle_stage', 'lifecyclestage', 'stage', 'status'],
  expectedLifecycleStage: ['expected_lifecycle_stage', 'expected_stage', 'target_stage'],
  // sales_owner is retained for the generated public fixture, where it contains IDs.
  ownerId: ['owner_id', 'hubspot_owner_id', 'contact_owner_id', 'sales_owner_id', 'sales_owner'],
  canonicalContactId: ['canonical_contact_id', 'canonical_id', 'merged_into'],
  recordStatus: ['record_status', 'recordstatus'],
  lastAction: ['last_action', 'lastaction'],
  qualityFlags: ['quality_flags', 'qualityflags', 'issues', 'flags'],
  importExclusionReason: ['import_skip_reason'],
  importExcludedAt: ['import_skipped_at'],
} as const;

const associatedCompanyAliases = {
  associatedCompanyId: ['associated_company_id', 'company_id', 'account_id'],
  associatedCompanyName: ['associated_company_name', 'company', 'company_name', 'account', 'account_name', 'organization_name'],
  associatedCompanyWebsite: ['associated_company_website', 'website', 'domain', 'website_url', 'company_website', 'company_domain', 'account_website', 'account_domain'],
  associatedCompanyPhone: ['associated_company_phone', 'company_phone', 'account_phone'],
  associatedCompanyState: ['associated_company_state', 'company_state', 'account_state'],
  associatedCompanyCountry: ['associated_company_country', 'company_country', 'account_country'],
  associatedCompanyAddress: ['associated_company_address', 'company_address', 'account_address', 'company_street', 'account_street'],
  associatedCompanyCity: ['associated_company_city', 'company_city', 'account_city'],
  associatedCompanyPostalCode: ['associated_company_postal_code', 'company_postal_code', 'company_zip', 'account_postal_code'],
} as const;

export const csvFieldLabels: Record<CsvFieldKey, string> = {
  contactId: 'Contact ID',
  fullName: 'Full name',
  firstName: 'First name',
  lastName: 'Last name',
  rawEmail: 'Email',
  normalizedEmail: 'Normalized email',
  company: 'Company',
  phone: 'Phone',
  jobTitle: 'Job title',
  website: 'Website',
  state: 'State / province',
  country: 'Country',
  address: 'Street address',
  city: 'City',
  postalCode: 'Postal code',
  department: 'Department',
  persona: 'Persona',
  region: 'Region / territory',
  segment: 'Segment',
  lifecycleStage: 'Lifecycle stage',
  expectedLifecycleStage: 'Expected lifecycle stage',
  ownerId: 'Owner ID',
  canonicalContactId: 'Canonical contact ID',
  recordStatus: 'Record status',
  lastAction: 'Last action',
  qualityFlags: 'Quality flags',
  importExclusionReason: 'Import skip reason',
  importExcludedAt: 'Import skipped at',
  associatedCompanyId: 'Associated company ID',
  associatedCompanyName: 'Associated company name',
  associatedCompanyWebsite: 'Associated company website',
  associatedCompanyPhone: 'Associated company phone',
  associatedCompanyState: 'Associated company state',
  associatedCompanyCountry: 'Associated company country',
  associatedCompanyAddress: 'Associated company street address',
  associatedCompanyCity: 'Associated company city',
  associatedCompanyPostalCode: 'Associated company postal code',
};

const companyFieldAliases: Partial<Record<CsvFieldKey, readonly string[]>> = {
  contactId: ['company_id', 'account_id', 'id', 'record_id', 'hs_object_id'],
  company: ['company', 'company_name', 'account', 'account_name', 'organization_name', 'name'],
  website: [...fieldAliases.website, 'domain', 'company_domain', 'account_domain'],
  phone: ['phone', 'phone_number', 'business_phone', 'company_phone', 'account_phone'],
  state: ['state', 'state_province', 'billing_state', 'billing_state_province', 'province'],
  country: ['country', 'country_code', 'billing_country', 'company_country', 'account_country'],
  address: ['address', 'street_address', 'street', 'billing_street', 'billing_address', 'company_address', 'account_address', 'address_line_1'],
  city: ['city', 'billing_city', 'company_city', 'account_city'],
  postalCode: ['postal_code', 'postcode', 'zip', 'zip_code', 'billing_postal_code', 'company_postal_code', 'account_postal_code'],
  region: fieldAliases.region,
  segment: fieldAliases.segment,
  ownerId: ['owner_id', 'hubspot_owner_id', 'company_owner_id', 'account_owner_id', 'sales_owner_id', 'sales_owner'],
  canonicalContactId: ['canonical_company_id', 'canonical_account_id', 'canonical_id', 'merged_into'],
  recordStatus: fieldAliases.recordStatus,
  lastAction: fieldAliases.lastAction,
  qualityFlags: fieldAliases.qualityFlags,
  importExclusionReason: fieldAliases.importExclusionReason,
  importExcludedAt: fieldAliases.importExcludedAt,
};

export function csvFieldLabelsForObject(importObject: ImportObject = 'contact', customFields: CustomFieldDefinition[] = []): Partial<Record<CsvFieldKey, string>> {
  const customLabels = Object.fromEntries(customFieldsForObject(importObject, customFields).map((field) => [customFieldKey(field), field.label]));
  if (importObject === 'contact') return { ...Object.fromEntries(Object.keys(fieldAliases).map((key) => [key, csvFieldLabels[key as CsvFieldKey]])), ...customLabels };
  if (importObject === 'contact_company') return { ...csvFieldLabels, company: 'Contact company context', website: 'Contact company website context', ...customLabels };
  return { ...Object.fromEntries(Object.keys(companyFieldAliases).map((key) => [key,
    key === 'contactId' ? 'Company ID' : key === 'company' ? 'Company name'
      : key === 'canonicalContactId' ? 'Canonical company ID' : csvFieldLabels[key as CsvFieldKey],
  ])), ...customLabels };
}

function customFieldsForObject(importObject: ImportObject, customFields: CustomFieldDefinition[]): CustomFieldDefinition[] {
  return validateCustomFields(customFields).filter((field) => importObject === 'contact_company' || field.object === importObject);
}

const stageRank: Record<string, number> = {
  lead: 1,
  mql: 2,
  sql: 3,
  opportunity: 4,
  customer: 5,
  closed_won: 5,
};

const repairActions: Record<ScenarioKey, string> = {
  'duplicate-surge': 'merge_duplicate_identity_clusters',
  'routing-overload': 'reroute_northeast_enterprise_overflow',
  'stage-regression': 'replay_expected_lifecycle_state',
};

const destinationBlockingFlags = new Set([
  'invalid_email', 'missing_company', 'missing_owner', 'stage_regression', 'duplicate_identity',
]);

export function destinationHoldFlags(contact: LiveContactState): string[] {
  return contact.qualityFlags.filter((flag) => destinationBlockingFlags.has(flag));
}

export function isDestinationReadyContact(contact: LiveContactState): boolean {
  return (contact.importObject ?? 'contact') === 'contact' && contact.recordStatus === 'active' && !contact.importExclusion && !isSuppressed(contact) && destinationHoldFlags(contact).length === 0;
}

export function previewContactsCsv(csv: string, importObject: ImportObject = 'contact', customFields: CustomFieldDefinition[] = []): CsvPreview {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error(`The CSV needs a header row and at least one ${importObject}.`);

  const originalHeaders = validatedCsvHeaders(rows[0]);
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => cell.trim() !== ''));
  const suggestedMapping = suggestCsvMapping(originalHeaders, importObject, customFields);
  return {
    headers: originalHeaders,
    sampleRows: dataRows.slice(0, 5).map((cells) => Object.fromEntries(
      originalHeaders.map((header, index) => [header, cells[index]?.trim() ?? '']),
    )),
    suggestedMapping,
    sourceRows: dataRows.length,
  };
}

export function suggestCsvMapping(headers: string[], importObject: ImportObject = 'contact', customFields: CustomFieldDefinition[] = []): CsvColumnMapping {
  // Matching tolerates CRM label/API spelling differences without changing the
  // parser's header validation or the original source labels used by mappings.
  const matchingKey = (value: string) => normalizeHeader(value).replaceAll('_', '');
  const normalizedHeaders = headers.map((header) => ({ original: header, normalized: matchingKey(header) }));
  const aliasesForObject = importObject === 'company' ? companyFieldAliases : importObject === 'contact_company'
    ? { ...fieldAliases, company: ['contact_company'], website: ['contact_company_website'], ...associatedCompanyAliases }
    : fieldAliases;
  const mapping = Object.fromEntries(
    Object.entries(aliasesForObject).flatMap(([field, aliases]) => {
      // Shared storage keys such as contactId must not make contact-specific
      // source columns look like company IDs when the object is a company.
      const label = csvFieldLabelsForObject(importObject)[field as CsvFieldKey]!;
      const canonicalKeys = new Set([matchingKey(label), ...(importObject === 'contact' ? [matchingKey(field)] : [])]);
      const aliasKeys = new Set((aliases ?? []).map(matchingKey));
      const canonicalMatches = normalizedHeaders.filter((header) => canonicalKeys.has(header.normalized));
      const matches = canonicalMatches.length
        ? canonicalMatches
        : normalizedHeaders.filter((header) => aliasKeys.has(header.normalized));
      // Picking the first equally plausible column hides uncertainty and depends
      // on file order. Leave that destination for the user's explicit mapping.
      return matches.length === 1 ? [[field, matches[0].original]] : [];
    }),
  ) as CsvColumnMapping;
  const customCandidates = customFieldsForObject(importObject, customFields).flatMap((field) => {
    const key = customFieldKey(field);
    const exactMatches = normalizedHeaders.filter((header) => header.original === key);
    const aliasKeys = new Set([matchingKey(key), matchingKey(field.key), matchingKey(field.label)]);
    const matches = exactMatches.length ? exactMatches : normalizedHeaders.filter((header) => aliasKeys.has(header.normalized));
    return matches.length === 1 ? [{ key, source: matches[0].original }] : [];
  });
  for (const candidate of customCandidates) {
    if (Object.values(mapping).includes(candidate.source)) continue;
    // A shared label such as "Region" cannot choose a contact/company scope.
    if (customCandidates.filter((other) => other.source === candidate.source).length > 1) continue;
    mapping[candidate.key] = candidate.source;
  }
  return mapping;
}

export function importContactsCsv(csv: string, mapping: CsvColumnMapping = {}, importObject: ImportObject = 'contact', customFields: CustomFieldDefinition[] = []): CsvImportResult {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error(`The CSV needs a header row and at least one ${importObject}.`);

  const originalHeaders = validatedCsvHeaders(rows[0]);
  const headers = originalHeaders.map(normalizeHeader);
  const customDefinitions = customFieldsForObject(importObject, customFields);
  const effectiveMapping = { ...suggestCsvMapping(originalHeaders, importObject, customDefinitions), ...mapping };
  const fieldLabels = csvFieldLabelsForObject(importObject, customDefinitions);
  const sourceHeaders = new Set(headers);
  const mappedFields = new Set(Object.entries(effectiveMapping).filter(([, source]) => source && sourceHeaders.has(normalizeHeader(source))).map(([field]) => field));
  const mapped = (field: CsvFieldKey) => mappedFields.has(field);
  if (Object.entries(mapping).some(([field, value]) => value && !Object.hasOwn(fieldLabels, field))) {
    throw new Error('This mapping includes fields for another import object. Choose fields for the selected object.');
  }
  if (importObject === 'company' && !effectiveMapping.company && !effectiveMapping.website) {
    throw new Error('Add a company name or website column so companies can be identified.');
  }
  if (importObject !== 'company' && !effectiveMapping.rawEmail && !effectiveMapping.fullName && !effectiveMapping.firstName && !effectiveMapping.lastName) {
    throw new Error('Add an email or full_name column so contacts can be identified.');
  }
  if (importObject === 'contact_company' && !effectiveMapping.associatedCompanyId && !effectiveMapping.associatedCompanyName && !effectiveMapping.associatedCompanyWebsite) {
    throw new Error('Map an associated company name, website or company ID as well as the contact fields.');
  }

  const now = new Date().toISOString();
  const dataRows = rows.slice(1)
    .map((cells, index) => ({ cells, rowNumber: index + 2 }))
    .filter(({ cells }) => cells.some((cell) => cell.trim() !== ''));
  const contactIdRows = new Map<string, number>();
  let lifecycleComparedRows = 0;
  const contacts = dataRows.map(({ cells, rowNumber }, index) => {
    const row = Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex]?.trim() ?? '']));
    const readField = (field: CsvFieldKey) => row[normalizeHeader(effectiveMapping[field] ?? '')] ?? '';
    const additionalFields = Object.fromEntries((['country', 'address', 'city', 'postalCode', ...(importObject === 'company' ? [] : ['department', 'persona'])] as CsvFieldKey[])
      .filter(mapped).map((field) => [field, nullable(readField(field))]));
    const customValues = (object: CustomFieldDefinition['object']) => Object.fromEntries(customDefinitions
      .filter((field) => field.object === object && mapped(customFieldKey(field))).map((field) => [field.key, readField(customFieldKey(field))]));
    const rowCustomFields = customValues(importObject === 'company' ? 'company' : 'contact');
    const contactId = readField('contactId') || `CSV-${String(index + 1).padStart(3, '0')}`;
    const firstRow = contactIdRows.get(contactId);
    if (firstRow !== undefined) {
      throw new Error(`CSV row ${rowNumber} has duplicate ${importObject} ID "${contactId}" (first used on row ${firstRow}). Give each source record a unique ${importObject} ID and try again.`);
    }
    contactIdRows.set(contactId, rowNumber);
    const firstName = readField('firstName');
    const lastName = readField('lastName');
    const fullName = readField('fullName') || [firstName, lastName].filter(Boolean).join(' ') || contactId;
    const rawEmail = readField('rawEmail');
    const suppliedNormalizedEmail = readField('normalizedEmail');
    const normalizedEmail = normalizeEmail(suppliedNormalizedEmail || rawEmail);
    const company = nullable(readField('company'));
    const region = readField('region') || 'Unassigned';
    const segment = readField('segment') || 'Unassigned';
    const suppliedLifecycleStage = normalizeStage(readField('lifecycleStage'));
    const suppliedExpectedLifecycleStage = normalizeStage(readField('expectedLifecycleStage'));
    const lifecycleStage = suppliedLifecycleStage || 'lead';
    const expectedLifecycleStage = suppliedExpectedLifecycleStage || lifecycleStage;
    const ownerId = nullable(readField('ownerId'));
    const canonicalContactId = nullable(readField('canonicalContactId'));
    const recordStatus = readField('recordStatus').toLowerCase() === 'merged' ? 'merged' : 'active';
    const exclusionReason = readField('importExclusionReason');
    const excludedAt = readField('importExcludedAt');
    const importExclusion = exclusionReason || excludedAt ? { reason: exclusionReason, excludedAt } : undefined;
    if (importExclusion && (recordStatus !== 'active' || !isImportExclusion(importExclusion))) {
      throw new Error(`CSV row ${rowNumber} has invalid skip metadata. Use an active row, a reason of 1–500 characters, and an ISO UTC timestamp such as 2026-09-27T22:00:00.000Z in import_skipped_at.`);
    }
    const qualityFlags = new Set(splitFlags(readField('qualityFlags')));
    if (importObject === 'company') {
      for (const flag of ['invalid_email', 'missing_owner', 'stage_regression', 'duplicate_identity', 'plus_address_present', 'unicode_domain_present', 'missing_company']) qualityFlags.delete(flag);
      const website = nullable(readField('website'));
      if (!company) qualityFlags.add('missing_company_name');
      if (!website) qualityFlags.add('missing_website');
      return {
        importObject,
        contactId,
        fullName: company || website || contactId,
        rawEmail: '',
        normalizedEmail: null,
        company,
        phone: nullable(readField('phone')),
        website,
        state: nullable(readField('state')),
        ...additionalFields,
        ...(Object.keys(rowCustomFields).length ? { customFields: rowCustomFields } : {}),
        region,
        segment,
        lifecycleStage: '',
        expectedLifecycleStage: '',
        ownerId,
        canonicalContactId,
        recordStatus,
        ...(importExclusion ? { importExclusion } : {}),
        lastAction: readField('lastAction') || 'csv_imported',
        qualityFlags: [...qualityFlags],
        updatedAt: now,
      } satisfies LiveContactState;
    }
    if (recordStatus === 'active'
      && !importExclusion
      && Object.hasOwn(stageRank, suppliedLifecycleStage)
      && Object.hasOwn(stageRank, suppliedExpectedLifecycleStage)) lifecycleComparedRows += 1;

    if (!normalizedEmail) qualityFlags.add('invalid_email');
    const associatedCompany = importObject === 'contact_company' ? {
      recordId: nullable(readField('associatedCompanyId')),
      name: readField('associatedCompanyName'),
      website: readField('associatedCompanyWebsite'),
      phone: readField('associatedCompanyPhone'),
      state: readField('associatedCompanyState'),
      ...Object.fromEntries((['country', 'address', 'city', 'postalCode'] as const).flatMap((field) => {
        const key = `associatedCompany${field[0].toUpperCase()}${field.slice(1)}` as CsvFieldKey;
        return mapped(key) ? [[field, readField(key)]] : [];
      })),
      ...(Object.keys(customValues('company')).length ? { customFields: customValues('company') } : {}),
    } : undefined;
    if (!company && !associatedCompany?.name && !associatedCompany?.website && !associatedCompany?.recordId) qualityFlags.add('missing_company');
    if (!ownerId) qualityFlags.add('missing_owner');
    if (rawEmail.split('@')[0]?.includes('+')) qualityFlags.add('plus_address_present');
    if (containsNonAscii(rawEmail.split('@')[1] ?? '')) qualityFlags.add('unicode_domain_present');
    if (isStageRegression(lifecycleStage, expectedLifecycleStage)) qualityFlags.add('stage_regression');

    return {
      importObject,
      ...(associatedCompany ? { associatedCompany } : {}),
      contactId,
      fullName,
      firstName,
      lastName,
      rawEmail,
      normalizedEmail,
      company,
      phone: nullable(readField('phone')),
      jobTitle: nullable(readField('jobTitle')),
      website: nullable(readField('website')),
      state: nullable(readField('state')),
      ...additionalFields,
      ...(Object.keys(rowCustomFields).length ? { customFields: rowCustomFields } : {}),
      region,
      segment,
      lifecycleStage,
      expectedLifecycleStage,
      ownerId,
      canonicalContactId,
      recordStatus,
      ...(importExclusion ? { importExclusion } : {}),
      lastAction: readField('lastAction') || 'csv_imported',
      qualityFlags: [...qualityFlags],
      updatedAt: now,
    } satisfies LiveContactState;
  });

  return {
    contacts: importObject === 'company' ? contacts : recomputeImportDuplicateFlags(contacts),
    sourceRows: dataRows.length,
    lifecycleComparedRows,
    expectedStageMapped: Boolean(effectiveMapping.expectedLifecycleStage)
      && headers.includes(normalizeHeader(effectiveMapping.expectedLifecycleStage ?? '')),
  };
}

export function correctCsvContact(
  contacts: LiveContactState[],
  contactId: string,
  input: CsvContactCorrectionInput,
  reason: string,
): { contacts: LiveContactState[]; correction: CsvContactCorrection } {
  const matching = contacts.filter((contact) => contact.contactId === contactId);
  if (matching.length !== 1) throw new Error('Choose one uniquely identified contact to correct.');
  const original = matching[0];
  if ((original.importObject ?? 'contact') !== 'contact') throw new Error('Contact corrections do not apply to company or associated-company imports. Update the source CSV and reload it.');
  if (original.importExclusion) throw new Error('Restore this skipped import row before correcting its fields.');
  if (original.recordStatus !== 'active' || isDestinationReadyContact(original)) {
    throw new Error('Only active held contacts can be corrected.');
  }
  const reviewReason = reason.trim();
  if (!reviewReason) throw new Error('Enter a review reason for this correction.');

  const nextContacts = contacts.map(cloneContact);
  const corrected = nextContacts.find((contact) => contact.contactId === contactId)!;
  const flags = new Set(corrected.qualityFlags);
  const setFlag = (flag: string, present: boolean) => {
    if (present) flags.add(flag);
    else flags.delete(flag);
  };
  corrected.rawEmail = input.rawEmail.trim();
  corrected.company = nullable(input.company);
  corrected.ownerId = nullable(input.ownerId);
  corrected.lifecycleStage = normalizeStage(input.lifecycleStage) || 'lead';
  const recheckEmail = corrected.rawEmail !== original.rawEmail || input.recheckEmail === true;

  if (recheckEmail) {
    corrected.normalizedEmail = normalizeEmail(corrected.rawEmail);
    setFlag('invalid_email', !corrected.normalizedEmail);
    setFlag('plus_address_present', corrected.rawEmail.split('@')[0]?.includes('+') ?? false);
    setFlag('unicode_domain_present', containsNonAscii(corrected.rawEmail.split('@')[1] ?? ''));
  }
  if (corrected.company !== original.company) setFlag('missing_company', !corrected.company);
  if (corrected.ownerId !== original.ownerId) setFlag('missing_owner', !corrected.ownerId);
  if (corrected.lifecycleStage !== original.lifecycleStage) {
    // Unknown stages cannot establish that a previously held lifecycle is safe.
    if (Object.hasOwn(stageRank, corrected.lifecycleStage) && Object.hasOwn(stageRank, corrected.expectedLifecycleStage)) {
      setFlag('stage_regression', isStageRegression(corrected.lifecycleStage, corrected.expectedLifecycleStage));
    } else if (isStageRegression(corrected.lifecycleStage, corrected.expectedLifecycleStage)) {
      flags.add('stage_regression');
    }
  }
  corrected.qualityFlags = [...flags];

  const reviewedAt = new Date().toISOString();
  if (recheckEmail) {
    const duplicateEmails = new Set([...groupActiveByEmail(nextContacts)]
      .filter(([, group]) => group.length > 1).map(([email]) => email));
    for (const contact of nextContacts) {
      if (contact.recordStatus !== 'active' || contact.importExclusion || isSuppressed(contact)) continue;
      const duplicate = Boolean(contact.normalizedEmail && duplicateEmails.has(contact.normalizedEmail));
      if (duplicate === contact.qualityFlags.includes('duplicate_identity')) continue;
      contact.qualityFlags = duplicate
        ? [...contact.qualityFlags, 'duplicate_identity']
        : withoutFlag(contact.qualityFlags, 'duplicate_identity');
      contact.updatedAt = reviewedAt;
    }
  }

  const changed = corrected.rawEmail !== original.rawEmail
    || corrected.normalizedEmail !== original.normalizedEmail
    || corrected.company !== original.company
    || corrected.ownerId !== original.ownerId
    || corrected.lifecycleStage !== original.lifecycleStage
    || corrected.qualityFlags.join('|') !== original.qualityFlags.join('|');
  if (!changed) throw new Error('Change a contact field or recheck an identity that needs correction.');
  corrected.lastAction = 'contact_corrected';
  corrected.updatedAt = reviewedAt;

  return {
    contacts: nextContacts,
    correction: {
      id: globalThis.crypto.randomUUID(), contactId, reviewedAt, reason: reviewReason,
      before: cloneContact(original), after: cloneContact(corrected),
    },
  };
}

export function executeCsvRepair(
  contacts: LiveContactState[],
  scenario: ScenarioKey,
): CsvRepairResult {
  if (contacts.some((contact) => (contact.importObject ?? 'contact') !== 'contact')) throw new Error('Contact repair actions do not apply to company or associated-company imports.');
  const timestamp = new Date().toISOString();
  const requestId = globalThis.crypto.randomUUID();
  let affectedRecords = 0;
  let nextContacts = contacts.map(cloneContact);

  if (scenario === 'duplicate-surge') {
    const canonicalByContact = new Map<string, string>();
    const originsByCanonical = new Map<string, NonNullable<LiveContactState['sourceOrigins']>>();
    for (const group of groupActiveByEmail(nextContacts).values()) {
      if (group.length < 2) continue;
      const canonical = [...group].sort(compareCanonicalCandidates)[0];
      for (const contact of group) canonicalByContact.set(contact.contactId, canonical.contactId);
      const origins = [...new Map(group.flatMap((contact) => contact.sourceOrigins ?? [])
        .map((origin) => [JSON.stringify(origin), origin])).values()];
      if (origins.length) originsByCanonical.set(canonical.contactId, origins);
    }
    nextContacts = nextContacts.map((contact) => {
      const canonicalId = canonicalByContact.get(contact.contactId);
      if (!canonicalId) return contact;
      if (canonicalId === contact.contactId) {
        return {
          ...contact,
          ...(originsByCanonical.has(contact.contactId) ? { sourceOrigins: originsByCanonical.get(contact.contactId)! } : {}),
          qualityFlags: withoutFlag(contact.qualityFlags, 'duplicate_identity'),
          lastAction: 'canonical_record_retained',
          updatedAt: timestamp,
        };
      }
      affectedRecords += 1;
      return {
        ...contact,
        canonicalContactId: canonicalId,
        recordStatus: 'merged',
        lastAction: 'merged_into_canonical',
        updatedAt: timestamp,
      };
    });
  }

  if (scenario === 'routing-overload') {
    nextContacts = nextContacts.map((contact) => {
      const shouldReroute = contact.recordStatus === 'active'
        && !contact.importExclusion && !isSuppressed(contact)
        && contact.region.trim().toLowerCase() === 'northeast'
        && contact.segment.trim().toLowerCase() === 'enterprise'
        && contact.ownerId !== 'CE-ENT-OVERFLOW';
      if (!shouldReroute) return contact;
      affectedRecords += 1;
      return {
        ...contact,
        ownerId: 'CE-ENT-OVERFLOW',
        qualityFlags: withoutFlag(contact.qualityFlags, 'missing_owner'),
        lastAction: 'rerouted_from_ne_enterprise',
        updatedAt: timestamp,
      };
    });
  }

  if (scenario === 'stage-regression') {
    nextContacts = nextContacts.map((contact) => {
      const shouldReplay = contact.recordStatus === 'active'
        && !contact.importExclusion && !isSuppressed(contact)
        && contact.qualityFlags.includes('stage_regression');
      if (!shouldReplay) return contact;
      affectedRecords += 1;
      return {
        ...contact,
        lifecycleStage: contact.expectedLifecycleStage,
        qualityFlags: withoutFlag(contact.qualityFlags, 'stage_regression'),
        lastAction: 'lifecycle_replayed',
        updatedAt: timestamp,
      };
    });
  }

  const receipt: RepairReceipt = {
    accepted: true,
    status: 'executed',
    scenario,
    action: repairActions[scenario],
    requestId,
    eventId: `CSV-${scenario}-${requestId}`,
    affectedRecords,
    approvedAt: timestamp,
  };
  const run: RepairRun = {
    runId: requestId,
    scenario,
    action: repairActions[scenario],
    status: 'executed',
    affectedRecords,
    finishedAt: timestamp,
  };
  return { contacts: nextContacts, receipt, run };
}

export function countCsvRepairCandidates(
  contacts: LiveContactState[],
  scenario: ScenarioKey,
): number {
  contacts = contacts.filter((contact) => (contact.importObject ?? 'contact') === 'contact');
  if (scenario === 'duplicate-surge') {
    return [...groupActiveByEmail(contacts).values()]
      .filter((group) => group.length > 1)
      .reduce((total, group) => total + group.length - 1, 0);
  }
  if (scenario === 'routing-overload') {
    return contacts.filter((contact) => contact.recordStatus === 'active'
      && !contact.importExclusion && !isSuppressed(contact)
      && contact.region.trim().toLowerCase() === 'northeast'
      && contact.segment.trim().toLowerCase() === 'enterprise'
      && contact.ownerId !== 'CE-ENT-OVERFLOW').length;
  }
  return contacts.filter((contact) => contact.recordStatus === 'active'
    && !contact.importExclusion && !isSuppressed(contact)
    && contact.qualityFlags.includes('stage_regression')).length;
}

export function exportContactsCsv(contacts: LiveContactState[], importObject: ImportObject = contacts[0]?.importObject ?? 'contact', customFields: CustomFieldDefinition[] = []): string {
  if (contacts.some((contact) => (contact.importObject ?? 'contact') !== importObject)) throw new Error('Export one import object at a time.');
  const extraFields: { header: string; value: (contact: LiveContactState) => string }[] = [];
  const optionalFields = ['country', 'address', 'city', 'postalCode', 'department', 'persona'] as const;
  for (const field of optionalFields) {
    if (importObject === 'company' && (field === 'department' || field === 'persona')) continue;
    if (!contacts.some((contact) => contact[field] !== undefined)) continue;
    extraFields.push({ header: field === 'postalCode' ? 'postal_code' : field, value: (contact) => contact[field] ?? '' });
  }
  if (importObject === 'contact_company') {
    for (const field of ['country', 'address', 'city', 'postalCode'] as const) {
      if (!contacts.some((contact) => contact.associatedCompany?.[field] !== undefined)) continue;
      extraFields.push({ header: `associated_company_${field === 'postalCode' ? 'postal_code' : field}`, value: (contact) => contact.associatedCompany?.[field] ?? '' });
    }
  }
  for (const field of customFieldsForObject(importObject, customFields)) {
    extraFields.push({ header: customFieldKey(field), value: (contact) => (importObject === 'contact_company' && field.object === 'company'
      ? contact.associatedCompany?.customFields : contact.customFields)?.[field.key] ?? '' });
  }
  const format = (headers: string[], rows: string[][]) => [
    [...headers, ...extraFields.map((field) => field.header)],
    ...rows.map((row, index) => [...row, ...extraFields.map((field) => field.value(contacts[index]))]),
  ].map((row) => row.map(escapeCsvCell).join(',')).join('\n');
  if (importObject === 'company') {
    const headers = ['company_id', 'company_name', 'website', 'phone', 'state', 'region', 'segment', 'owner_id',
      'canonical_company_id', 'record_status', 'last_action', 'quality_flags', 'import_skip_reason', 'import_skipped_at',
      'suppressed', 'suppression_lists', 'suppression_reasons', 'suppression_rules'];
    const rows = contacts.map((company) => [company.contactId, company.company ?? '', company.website ?? '', company.phone ?? '',
      company.state ?? '', company.region, company.segment, company.ownerId ?? '', company.canonicalContactId ?? '',
      company.recordStatus, company.lastAction, company.qualityFlags.join('|'), company.importExclusion?.reason ?? '',
      company.importExclusion?.excludedAt ?? '', isSuppressed(company) ? 'true' : 'false',
      (company.suppressionMatches ?? []).map((match) => match.listName).join('; '),
      (company.suppressionMatches ?? []).map((match) => match.reason).join('; '),
      (company.suppressionMatches ?? []).map((match) => `${match.type}: ${match.value}`).join('; '),
    ]);
    return format(headers, rows);
  }
  const headers = [
    'contact_id', 'full_name', 'first_name', 'last_name', 'email', 'normalized_email',
    'company', 'phone', 'job_title', 'website', 'state', 'region',
    'segment', 'lifecycle_stage', 'expected_lifecycle_stage', 'owner_id',
    'canonical_contact_id', 'record_status', 'last_action', 'quality_flags',
    'import_skip_reason', 'import_skipped_at', 'suppressed', 'suppression_lists', 'suppression_reasons', 'suppression_rules',
  ];
  if (importObject === 'contact_company') {
    headers[headers.indexOf('company')] = 'contact_company';
    headers[headers.indexOf('website')] = 'contact_company_website';
    headers.push('associated_company_id', 'associated_company_name', 'associated_company_website', 'associated_company_phone', 'associated_company_state');
  }
  const rows = contacts.map((contact) => [
    contact.contactId,
    contact.fullName,
    contact.firstName ?? '',
    contact.lastName ?? '',
    contact.rawEmail,
    contact.normalizedEmail ?? '',
    contact.company ?? '',
    contact.phone ?? '',
    contact.jobTitle ?? '',
    contact.website ?? '',
    contact.state ?? '',
    contact.region,
    contact.segment,
    contact.lifecycleStage,
    contact.expectedLifecycleStage,
    contact.ownerId ?? '',
    contact.canonicalContactId ?? '',
    contact.recordStatus,
    contact.lastAction,
    contact.qualityFlags.join('|'),
    contact.importExclusion?.reason ?? '',
    contact.importExclusion?.excludedAt ?? '',
    isSuppressed(contact) ? 'true' : 'false',
    (contact.suppressionMatches ?? []).map((match) => match.listName).join('; '),
    (contact.suppressionMatches ?? []).map((match) => match.reason).join('; '),
    (contact.suppressionMatches ?? []).map((match) => `${match.type}: ${match.value}`).join('; '),
    ...(importObject === 'contact_company' ? [contact.associatedCompany?.recordId ?? '', contact.associatedCompany?.name ?? '',
      contact.associatedCompany?.website ?? '', contact.associatedCompany?.phone ?? '', contact.associatedCompany?.state ?? ''] : []),
  ]);
  return format(headers, rows);
}

function parseCsv(csv: string): string[][] {
  const input = csv.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (character === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error('The CSV has an unmatched quote.');
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  const expectedColumns = rows[0]?.length ?? 0;
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex];
    if (cells.every((value) => value.trim() === '')) continue;
    if (cells.length !== expectedColumns) {
      throw new Error(`CSV row ${rowIndex + 1} has ${cells.length} columns; the header has ${expectedColumns}. Quote values containing commas or line breaks, and use commas to retain empty columns.`);
    }
  }
  return rows;
}

function validatedCsvHeaders(headers: string[]): string[] {
  const originalHeaders = headers.map((header) => header.trim());
  if (new Set(originalHeaders.map(normalizeHeader)).size !== originalHeaders.length) {
    throw new Error('The CSV has duplicate column names after normalization. Rename those columns and try again.');
  }
  return originalHeaders;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function nullable(value: string): string | null {
  return value.trim() || null;
}

function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  const match = email.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/u);
  if (!match) return null;
  if (containsNonAscii(match[1])) return null;
  try {
    const parsedDomain = new URL(`http://${match[2]}`);
    if (parsedDomain.port || parsedDomain.pathname !== '/' || parsedDomain.search || parsedDomain.hash) return null;
    const asciiDomain = parsedDomain.hostname.toLowerCase();
    if (!asciiDomain.includes('.') || !/^[a-z0-9.-]+$/u.test(asciiDomain)) return null;
    return `${match[1]}@${asciiDomain}`;
  } catch {
    return null;
  }
}

function normalizeStage(value: string): string {
  return value.trim().toLowerCase().replace(/[ -]+/g, '_');
}

function isStageRegression(actual: string, expected: string): boolean {
  return (stageRank[actual] ?? 0) < (stageRank[expected] ?? 0);
}

function containsNonAscii(value: string): boolean {
  return /[^\x00-\x7F]/u.test(value);
}

function splitFlags(value: string): string[] {
  if (!value) return [];
  return value.split(/[|;,]/).map((flag) => normalizeHeader(flag)).filter(Boolean);
}

function groupActiveByEmail(contacts: LiveContactState[]): Map<string, LiveContactState[]> {
  const groups = new Map<string, LiveContactState[]>();
  for (const contact of contacts) {
    if (contact.recordStatus !== 'active' || contact.importExclusion || isSuppressed(contact) || !contact.normalizedEmail) continue;
    const group = groups.get(contact.normalizedEmail) ?? [];
    group.push(contact);
    groups.set(contact.normalizedEmail, group);
  }
  return groups;
}

function compareCanonicalCandidates(left: LiveContactState, right: LiveContactState): number {
  const leftClean = left.rawEmail === left.rawEmail.trim().toLowerCase() ? 0 : 1;
  const rightClean = right.rawEmail === right.rawEmail.trim().toLowerCase() ? 0 : 1;
  return leftClean - rightClean || left.contactId.localeCompare(right.contactId);
}

function cloneContact(contact: LiveContactState): LiveContactState {
  return { ...contact, qualityFlags: [...contact.qualityFlags], ...(contact.sourceOrigins ? { sourceOrigins: structuredClone(contact.sourceOrigins) } : {}) };
}

function withoutFlag(flags: string[], flagToRemove: string): string[] {
  return flags.filter((flag) => flag !== flagToRemove);
}

function escapeCsvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
