import {
  countCsvRepairCandidates,
  executeCsvRepair,
  importContactsCsv,
  isDestinationReadyContact,
} from './csv-control-tower';
import type { LiveContactState } from './live-control-tower';

const firstNames = ['Avery', 'Jordan', 'Morgan', 'Riley', 'Casey', 'Taylor', 'Quinn', 'Rowan'];
const lastNames = ['Chen', 'Santos', 'Morgan', 'Patel', 'Kim', 'Nguyen', 'Brooks', 'Rivera'];
const companies = ['Northstar AI', 'Copper Finch', 'Atlas Works', 'Juniper Labs', 'Signal Harbor', 'Brightline Cloud', 'Acme, Incorporated', 'Paper Kite'];
const domains = ['northstar.example', 'copperfinch.example', 'atlasworks.example', 'juniperlabs.example', 'signalharbor.example', 'brightline.example', 'acme.example', 'paperkite.example'];
const titles = ['VP Sales', 'Revenue Operations Manager', 'Founder', 'Demand Generation Lead', 'Sales Director', 'GTM Systems Manager', 'COO', 'Growth Lead'];
const headers = [
  'contact_id', 'full_name', 'email', 'normalized_email', 'company', 'phone', 'job_title',
  'website', 'region', 'segment', 'lifecycle_stage', 'expected_lifecycle_stage', 'owner_id',
];

export type DemoPipelineResult = {
  rawRows: number;
  duplicateRows: number;
  routingExceptions: number;
  lifecycleRegressions: number;
  initiallyFlagged: number;
  mergedRows: number;
  reroutedRows: number;
  replayedRows: number;
  activeRows: number;
  readyRows: number;
  heldRows: number;
  beforeQuality: number;
  afterQuality: number;
  sample: LiveContactState[];
  repairedSample: LiveContactState[];
};

export function messyLeadDemoCsv(): string {
  const rows = Array.from({ length: 64 }, (_, index) => buildRow(index + 1));
  return [headers, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\n');
}

export function previewMessyLeadDemo(): Pick<DemoPipelineResult,
  'rawRows' | 'duplicateRows' | 'routingExceptions' | 'lifecycleRegressions' | 'initiallyFlagged' | 'beforeQuality' | 'sample'> {
  const contacts = importContactsCsv(messyLeadDemoCsv()).contacts;
  const initiallyFlagged = contacts.filter((contact) => contact.qualityFlags.length > 0).length;
  return {
    rawRows: contacts.length,
    duplicateRows: countCsvRepairCandidates(contacts, 'duplicate-surge'),
    routingExceptions: countCsvRepairCandidates(contacts, 'routing-overload'),
    lifecycleRegressions: countCsvRepairCandidates(contacts, 'stage-regression'),
    initiallyFlagged,
    beforeQuality: qualityRate(contacts),
    sample: sampleContacts(contacts),
  };
}

export function runMessyLeadDemo(): DemoPipelineResult {
  const initial = importContactsCsv(messyLeadDemoCsv()).contacts;
  const duplicateRows = countCsvRepairCandidates(initial, 'duplicate-surge');
  const routingExceptions = countCsvRepairCandidates(initial, 'routing-overload');
  const lifecycleRegressions = countCsvRepairCandidates(initial, 'stage-regression');
  const initiallyFlagged = initial.filter((contact) => contact.qualityFlags.length > 0).length;
  const merged = executeCsvRepair(initial, 'duplicate-surge');
  const rerouted = executeCsvRepair(merged.contacts, 'routing-overload');
  const replayed = executeCsvRepair(rerouted.contacts, 'stage-regression');
  const active = replayed.contacts.filter((contact) => contact.recordStatus === 'active');
  const ready = active.filter(isDestinationReadyContact);

  return {
    rawRows: initial.length,
    duplicateRows,
    routingExceptions,
    lifecycleRegressions,
    initiallyFlagged,
    mergedRows: merged.receipt.affectedRecords,
    reroutedRows: rerouted.receipt.affectedRecords,
    replayedRows: replayed.receipt.affectedRecords,
    activeRows: active.length,
    readyRows: ready.length,
    heldRows: active.length - ready.length,
    beforeQuality: qualityRate(initial),
    afterQuality: qualityRate(active),
    sample: sampleContacts(initial),
    repairedSample: sampleContacts(replayed.contacts),
  };
}

function buildRow(rowNumber: number): string[] {
  const index = rowNumber - 1;
  const duplicateOf = rowNumber % 8 === 0 ? rowNumber - 1 : rowNumber;
  const identityIndex = duplicateOf - 1;
  const domain = domains[identityIndex % domains.length];
  const canonicalEmail = `lead${duplicateOf}@${domain}`;
  const invalidEmail = [14, 30, 46, 62].includes(rowNumber);
  const unicodeDomain = rowNumber === 42;
  const duplicate = duplicateOf !== rowNumber;
  const rawEmail = invalidEmail
    ? `lead${rowNumber} at broken.test`
    : unicodeDomain
      ? 'signal@mañana.example'
      : duplicate
        ? `LEAD${duplicateOf}+ROADSHOW@${domain.toUpperCase()}`
        : canonicalEmail;
  const normalizedEmail = duplicate ? canonicalEmail : unicodeDomain ? 'signal@manana.example' : '';
  const region = rowNumber % 6 === 0 || rowNumber % 7 === 0 ? 'Northeast' : ['West', 'Central', 'Southeast'][rowNumber % 3];
  const segment = region === 'Northeast' && rowNumber % 2 === 0 ? 'Enterprise' : ['SMB', 'Mid-Market', 'Enterprise'][rowNumber % 3];
  const regressed = rowNumber % 7 === 3 && !duplicate;
  const company = rowNumber % 13 === 4 ? '' : companies[index % companies.length];
  const owner = rowNumber % 11 === 3 ? '' : region === 'Northeast' && segment === 'Enterprise' ? 'NE-ENT-01' : `${region.slice(0, 2).toUpperCase()}-${segment.slice(0, 3).toUpperCase()}-01`;
  const fullName = duplicate
    ? `${firstNames[identityIndex % firstNames.length]} ${lastNames[identityIndex % lastNames.length]} (event list)`
    : `${firstNames[index % firstNames.length]} ${lastNames[index % lastNames.length]} ${String(rowNumber).padStart(2, '0')}`;

  return [
    `LAB-${String(rowNumber).padStart(3, '0')}`,
    fullName,
    rawEmail,
    normalizedEmail,
    company,
    rowNumber % 10 === 5 ? '' : `+1412555${String(1000 + rowNumber).slice(-4)}`,
    titles[index % titles.length],
    company ? `https://${domain}` : '',
    region,
    segment,
    regressed ? 'mql' : ['lead', 'mql', 'sql', 'opportunity'][rowNumber % 4],
    regressed ? 'opportunity' : ['lead', 'mql', 'sql', 'opportunity'][rowNumber % 4],
    owner,
  ];
}

function qualityRate(contacts: LiveContactState[]): number {
  const active = contacts.filter((contact) => contact.recordStatus === 'active');
  if (!active.length) return 100;
  return (active.filter(isDestinationReadyContact).length / active.length) * 100;
}

function sampleContacts(contacts: LiveContactState[]): LiveContactState[] {
  return [2, 6, 7, 13, 16, 41].map((index) => contacts[index]);
}

function escapeCsvCell(value: string): string {
  if (!/[",\n\r]/u.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
