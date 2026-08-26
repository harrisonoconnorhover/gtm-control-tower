import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const snapshotPath = resolve(root, 'fixtures/sec-company-snapshot.json');
const outputPath = resolve(root, 'public/sec-public-company-messy-crm.csv');
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));

const people = [
  ['Avery', 'Stone'], ['Jordan', 'Vale'], ['Casey', 'Rowan'], ['Morgan', 'Reed'],
  ['Riley', 'Hart'], ['Cameron', 'Quinn'], ['Taylor', 'Brooks'], ['Parker', 'Lane'],
  ['Reese', 'Arden'], ['Drew', 'Monroe'], ['Skyler', 'Blake'], ['Hayden', 'Sage'],
  ['Emerson', 'Wells'], ['Finley', 'Gray'], ['Robin', 'Ellis'], ['Alex', 'Marlow'],
  ['Jamie', 'Hollis'], ['Devon', 'Lake'], ['Rowan', 'Bell'], ['Sasha', 'Perry'],
  ['Marin', 'Fox'], ['Noel', 'Winter'], ['Shay', 'River'], ['Dakota', 'West'],
];
const regions = ['Northeast', 'West', 'Central', 'Europe'];
const segments = ['Enterprise', 'Mid-Market', 'SMB'];
const titles = ['Revenue Operations Manager', 'Sales Systems Analyst', 'GTM Engineer'];
const stages = ['lead', 'mql', 'sql', 'opportunity'];

const headers = [
  'record_id', 'contact_name', 'email_address', 'account_name', 'mobile',
  'title', 'company_website', 'sales_region', 'company_segment', 'status',
  'expected_stage', 'sales_owner', 'record_status', 'issues', 'sec_cik',
  'ticker', 'exchange', 'source_note',
];

const rows = snapshot.data.flatMap(([cik, company, ticker, exchange], companyIndex) => (
  [0, 1, 2].map((variant) => {
    const [firstName, lastName] = people[(companyIndex * 3 + variant) % people.length];
    const [primaryFirstName, primaryLastName] = people[(companyIndex * 3) % people.length];
    const fullName = variant === 1 && companyIndex % 3 === 0
      ? `  ${primaryFirstName} ${primaryLastName}  `
      : `${firstName} ${lastName}`;
    const localPart = `${firstName}.${lastName}.${String(companyIndex + 1).padStart(2, '0')}`.toLowerCase();
    const primaryEmail = `${primaryFirstName}.${primaryLastName}.${String(companyIndex + 1).padStart(2, '0')}@example.com`.toLowerCase();
    let email = variant === 0 ? primaryEmail : `${localPart}.${variant + 1}@example.com`;
    if (variant === 1 && companyIndex % 3 === 0) email = primaryEmail.toUpperCase();
    if (variant === 2 && companyIndex % 4 === 0) email = `${localPart} at example.com`;
    if (variant === 2 && companyIndex % 4 === 1) email = `${localPart}+event@example.com`;
    if (variant === 2 && companyIndex % 4 === 2) email = `${localPart}@überdata.example.com`;

    const region = regions[companyIndex % regions.length];
    const segment = segments[(companyIndex + variant) % segments.length];
    const owner = (variant === 1 && companyIndex % 4 === 0) || (variant === 2 && companyIndex % 6 === 1)
      ? ''
      : `${region.slice(0, 2).toUpperCase()}-${segment.slice(0, 3).toUpperCase()}`;
    const lifecycleStage = stages[(companyIndex + variant) % stages.length];
    let expectedStage = lifecycleStage;
    if (variant === 1 && companyIndex % 5 === 0) expectedStage = 'sql';
    if (variant === 2 && companyIndex % 7 === 0) expectedStage = 'opportunity';

    const account = variant === 1 && companyIndex % 6 === 0
      ? ''
      : variant === 1 && companyIndex % 3 === 0
        ? String(company).toLowerCase()
        : String(company);
    const issues = [
      variant === 1 && companyIndex % 3 === 0 ? 'duplicate_from_event_list' : '',
      variant === 2 && companyIndex % 4 === 0 ? 'email_needs_review' : '',
      variant === 2 && companyIndex % 5 === 1 ? 'inconsistent_company_format' : '',
    ].filter(Boolean).join('|');

    return [
      `SEC-${String(companyIndex + 1).padStart(2, '0')}-${variant + 1}`,
      fullName,
      email,
      account,
      variant === 2 ? `+1 (412) 555-${String(1100 + companyIndex).padStart(4, '0')} x${variant + 20}` : `+1412555${String(1000 + companyIndex * 3 + variant).padStart(4, '0')}`,
      titles[(companyIndex + variant) % titles.length],
      `https://${String(ticker).toLowerCase().replaceAll('-', '')}.example`,
      variant === 1 ? ` ${region} ` : region,
      segment,
      lifecycleStage,
      expectedStage,
      owner,
      'active',
      issues,
      cik,
      ticker,
      exchange,
      'Company fields: SEC public data; contact fields: synthetic',
    ];
  })
));

const csv = [headers, ...rows]
  .map((row) => row.map(csvCell).join(','))
  .join('\n');

await writeFile(outputPath, `${csv}\n`, 'utf8');
console.log(`Wrote ${rows.length} privacy-safe messy CRM rows to ${outputPath}.`);

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
