import type { ScenarioKey } from './control-tower';
import { isImportExclusion, recomputeImportDuplicateFlags } from './import-exclusions';
import type { LiveContactState, RepairReceipt, RepairRun } from './live-control-tower';

export type CsvImportResult = {
  contacts: LiveContactState[];
  sourceRows: number;
  lifecycleComparedRows: number;
  expectedStageMapped: boolean;
};

export type CsvFieldKey = keyof typeof fieldAliases;
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
  contactId: ['contact_id', 'contactid', 'id', 'record_id'],
  fullName: ['full_name', 'fullname', 'name', 'contact_name'],
  firstName: ['first_name', 'firstname'],
  lastName: ['last_name', 'lastname', 'surname'],
  rawEmail: ['raw_email', 'email', 'email_address', 'emailaddress'],
  normalizedEmail: ['normalized_email', 'normalizedemail'],
  company: ['company', 'company_name', 'companyname', 'account', 'account_name'],
  phone: ['phone', 'phone_number', 'phonenumber', 'mobile_phone', 'mobile'],
  jobTitle: ['job_title', 'jobtitle', 'title', 'position'],
  website: ['website', 'website_url', 'company_website', 'url'],
  state: ['state', 'state_province', 'stateprovince', 'mailing_state', 'mailingstate', 'province'],
  region: ['region', 'territory', 'sales_region'],
  segment: ['segment', 'market_segment', 'company_segment'],
  lifecycleStage: ['lifecycle_stage', 'lifecyclestage', 'stage', 'status'],
  expectedLifecycleStage: ['expected_lifecycle_stage', 'expected_stage', 'target_stage'],
  ownerId: ['owner_id', 'ownerid', 'owner', 'sales_owner'],
  canonicalContactId: ['canonical_contact_id', 'canonical_id', 'merged_into'],
  recordStatus: ['record_status', 'recordstatus'],
  lastAction: ['last_action', 'lastaction'],
  qualityFlags: ['quality_flags', 'qualityflags', 'issues', 'flags'],
  importExclusionReason: ['import_skip_reason'],
  importExcludedAt: ['import_skipped_at'],
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
  region: 'Region / territory',
  segment: 'Segment',
  lifecycleStage: 'Lifecycle stage',
  expectedLifecycleStage: 'Expected lifecycle stage',
  ownerId: 'Owner',
  canonicalContactId: 'Canonical contact ID',
  recordStatus: 'Record status',
  lastAction: 'Last action',
  qualityFlags: 'Quality flags',
  importExclusionReason: 'Import skip reason',
  importExcludedAt: 'Import skipped at',
};

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
  return contact.recordStatus === 'active' && !contact.importExclusion && destinationHoldFlags(contact).length === 0;
}

export function previewContactsCsv(csv: string): CsvPreview {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one contact.');

  const originalHeaders = validatedCsvHeaders(rows[0]);
  const dataRows = rows.slice(1).filter((row) => row.some((cell) => cell.trim() !== ''));
  const suggestedMapping = suggestCsvMapping(originalHeaders);
  return {
    headers: originalHeaders,
    sampleRows: dataRows.slice(0, 5).map((cells) => Object.fromEntries(
      originalHeaders.map((header, index) => [header, cells[index]?.trim() ?? '']),
    )),
    suggestedMapping,
    sourceRows: dataRows.length,
  };
}

export function suggestCsvMapping(headers: string[]): CsvColumnMapping {
  const normalizedHeaders = headers.map((header) => ({ original: header, normalized: normalizeHeader(header) }));
  return Object.fromEntries(
    Object.entries(fieldAliases).flatMap(([field, aliases]) => {
      const match = normalizedHeaders.find((header) => (aliases as readonly string[]).includes(header.normalized));
      return match ? [[field, match.original]] : [];
    }),
  ) as CsvColumnMapping;
}

export function importContactsCsv(csv: string, mapping: CsvColumnMapping = {}): CsvImportResult {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one contact.');

  const originalHeaders = validatedCsvHeaders(rows[0]);
  const headers = originalHeaders.map(normalizeHeader);
  const effectiveMapping = { ...suggestCsvMapping(originalHeaders), ...mapping };
  if (!effectiveMapping.rawEmail && !effectiveMapping.fullName && !effectiveMapping.firstName && !effectiveMapping.lastName) {
    throw new Error('Add an email or full_name column so contacts can be identified.');
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
    const contactId = readField('contactId') || `CSV-${String(index + 1).padStart(3, '0')}`;
    const firstRow = contactIdRows.get(contactId);
    if (firstRow !== undefined) {
      throw new Error(`CSV row ${rowNumber} has duplicate contact ID "${contactId}" (first used on row ${firstRow}). Give each source record a unique contact ID and try again.`);
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
    if (recordStatus === 'active'
      && !importExclusion
      && Object.hasOwn(stageRank, suppliedLifecycleStage)
      && Object.hasOwn(stageRank, suppliedExpectedLifecycleStage)) lifecycleComparedRows += 1;

    if (!normalizedEmail) qualityFlags.add('invalid_email');
    if (!company) qualityFlags.add('missing_company');
    if (!ownerId) qualityFlags.add('missing_owner');
    if (rawEmail.split('@')[0]?.includes('+')) qualityFlags.add('plus_address_present');
    if (containsNonAscii(rawEmail.split('@')[1] ?? '')) qualityFlags.add('unicode_domain_present');
    if (isStageRegression(lifecycleStage, expectedLifecycleStage)) qualityFlags.add('stage_regression');

    return {
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
    contacts: recomputeImportDuplicateFlags(contacts),
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
      if (contact.recordStatus !== 'active' || contact.importExclusion) continue;
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
  const timestamp = new Date().toISOString();
  const requestId = globalThis.crypto.randomUUID();
  let affectedRecords = 0;
  let nextContacts = contacts.map(cloneContact);

  if (scenario === 'duplicate-surge') {
    const canonicalByContact = new Map<string, string>();
    for (const group of groupActiveByEmail(nextContacts).values()) {
      if (group.length < 2) continue;
      const canonical = [...group].sort(compareCanonicalCandidates)[0];
      for (const contact of group) canonicalByContact.set(contact.contactId, canonical.contactId);
    }
    nextContacts = nextContacts.map((contact) => {
      const canonicalId = canonicalByContact.get(contact.contactId);
      if (!canonicalId) return contact;
      if (canonicalId === contact.contactId) {
        return {
          ...contact,
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
        && !contact.importExclusion
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
        && !contact.importExclusion
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
  if (scenario === 'duplicate-surge') {
    return [...groupActiveByEmail(contacts).values()]
      .filter((group) => group.length > 1)
      .reduce((total, group) => total + group.length - 1, 0);
  }
  if (scenario === 'routing-overload') {
    return contacts.filter((contact) => contact.recordStatus === 'active'
      && !contact.importExclusion
      && contact.region.trim().toLowerCase() === 'northeast'
      && contact.segment.trim().toLowerCase() === 'enterprise'
      && contact.ownerId !== 'CE-ENT-OVERFLOW').length;
  }
  return contacts.filter((contact) => contact.recordStatus === 'active'
    && !contact.importExclusion
    && contact.qualityFlags.includes('stage_regression')).length;
}

export function exportContactsCsv(contacts: LiveContactState[]): string {
  const headers = [
    'contact_id', 'full_name', 'first_name', 'last_name', 'email', 'normalized_email',
    'company', 'phone', 'job_title', 'website', 'state', 'region',
    'segment', 'lifecycle_stage', 'expected_lifecycle_stage', 'owner_id',
    'canonical_contact_id', 'record_status', 'last_action', 'quality_flags',
    'import_skip_reason', 'import_skipped_at',
  ];
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
  ]);
  return [headers, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\n');
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
    if (contact.recordStatus !== 'active' || contact.importExclusion || !contact.normalizedEmail) continue;
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
  return { ...contact, qualityFlags: [...contact.qualityFlags] };
}

function withoutFlag(flags: string[], flagToRemove: string): string[] {
  return flags.filter((flag) => flag !== flagToRemove);
}

function escapeCsvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
