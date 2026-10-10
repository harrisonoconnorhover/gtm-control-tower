import { suggestCsvMapping } from './csv-control-tower';

export const BROWSER_CSV_MAX_BYTES = 10 * 1024 * 1024;
export const BROWSER_CSV_MAX_ROWS = 10_000;

export type BrowserCsvRow = {
  id: number;
  original: string[];
  values: string[];
  excluded: boolean;
};

export type BrowserCsv = {
  headers: string[];
  rows: BrowserCsvRow[];
  emailColumn: number | null;
  trimColumns: number[];
};

export type BrowserCsvCleanupProposal = {
  rowId: number;
  column: number;
  before: string;
  after: string;
  reason: string;
};

export type BrowserCsvReviewGroup = {
  kind: 'repeated-row' | 'repeated-email';
  rowIds: number[];
};

export type BrowserCsvReview = {
  issues: Map<number, string[]>;
  groups: BrowserCsvReviewGroup[];
};

export const browserCsvSample = `Record ID,First name,Last name,Email,Company,Phone,Notes
00123, Ada ,Lovelace,Ada+event@EXAMPLE.COM, Northstar ,+44 20 7946 0123,"Met at a conference, follow up next week"
00124,Ada,Lovelace,Ada+event@example.com,Northstar,,Possible repeat — review before excluding
00125, José ,Rivera,jose@MAÑANA.EXAMPLE, Sol ,,"Keep this note exactly as written. "
00126,Mina,Chen,mina.example.com,Orbit,,Needs an email correction
00127,Sam,Reed,, Willow ,,Email not supplied
00128,Alex,Morgan,Alex@example.com,Harbor,,All rows stay unless you exclude them`;

/** Display source columns unambiguously; exported headers are never renamed. */
export function browserCsvColumnLabel(headers: string[], column: number): string {
  const label = headers[column].trim() || `Column ${column + 1}`;
  const ambiguous = headers.some((header, index) => index !== column && (header.trim() || `Column ${index + 1}`) === label);
  return ambiguous ? `${label} (column ${column + 1})` : label;
}

/** Keep source cells as strings. Column indices also support repeated header names. */
export function parseBrowserCsv(text: string): BrowserCsv {
  if (new TextEncoder().encode(text).byteLength > BROWSER_CSV_MAX_BYTES) {
    throw new Error('Choose a CSV of 10 MiB or smaller.');
  }
  const records = parseRecords(text.replace(/^\uFEFF/, ''));
  if (records.length < 2) throw new Error('The CSV needs a header row and at least one data row.');
  const [headers, ...data] = records;
  const mapping = suggestCsvMapping(headers);
  const emailHeader = mapping.rawEmail ?? mapping.normalizedEmail;
  const emailColumn = emailHeader === undefined ? null : headers.indexOf(emailHeader);
  const trimColumns = headers.flatMap((header, index) => {
    const fields = suggestCsvMapping([header]);
    return ['fullName', 'firstName', 'lastName', 'company', 'jobTitle', 'rawEmail', 'normalizedEmail']
      .some((field) => Object.hasOwn(fields, field)) ? [index] : [];
  });
  return {
    headers,
    rows: data.map((values, id) => ({ id, original: [...values], values, excluded: false })),
    emailColumn,
    trimColumns,
  };
}

export function cleanupProposals(document: BrowserCsv): BrowserCsvCleanupProposal[] {
  const trimColumns = new Set(document.trimColumns);
  return document.rows.flatMap((row) => row.excluded ? [] : row.values.flatMap((before, column) => {
    const isEmail = column === document.emailColumn;
    let after = trimColumns.has(column) || isEmail ? before.trim() : before;
    const normalized = isEmail ? normalizedEmail(after) : null;
    const domainChanged = normalized !== null && normalized !== after;
    if (normalized !== null) after = normalized;
    if (after === before) return [];
    const trimmed = before !== before.trim();
    return [{
      rowId: row.id,
      column,
      before,
      after,
      reason: domainChanged
        ? (trimmed ? 'Trim outer whitespace and normalize email domain' : 'Normalize email domain')
        : 'Trim outer whitespace',
    }];
  }));
}

export function applyBrowserCleanup(document: BrowserCsv): BrowserCsv {
  const proposals = cleanupProposals(document);
  if (!proposals.length) return document;
  const byRow = new Map<number, BrowserCsvCleanupProposal[]>();
  for (const proposal of proposals) {
    const group = byRow.get(proposal.rowId) ?? [];
    group.push(proposal);
    byRow.set(proposal.rowId, group);
  }
  return {
    ...document,
    rows: document.rows.map((row) => {
      const edits = byRow.get(row.id);
      if (!edits) return row;
      const values = [...row.values];
      for (const edit of edits) values[edit.column] = edit.after;
      return { ...row, values };
    }),
  };
}

export function updateBrowserCell(document: BrowserCsv, rowId: number, column: number, value: string): BrowserCsv {
  if (!Number.isInteger(column) || column < 0 || column >= document.headers.length) {
    throw new Error('Choose an existing column to edit.');
  }
  if (!document.rows.some((row) => row.id === rowId)) throw new Error('Choose an existing row to edit.');
  return {
    ...document,
    rows: document.rows.map((row) => row.id === rowId
      ? { ...row, values: row.values.map((cell, index) => index === column ? value : cell) }
      : row),
  };
}

export function toggleBrowserRow(document: BrowserCsv, rowId: number): BrowserCsv {
  if (!document.rows.some((row) => row.id === rowId)) throw new Error('Choose an existing row to exclude or restore.');
  return {
    ...document,
    rows: document.rows.map((row) => row.id === rowId ? { ...row, excluded: !row.excluded } : row),
  };
}

/** Review notes and related-row groups come from the same comparisons. */
export function browserCsvReview(document: BrowserCsv): BrowserCsvReview {
  const issues = new Map<number, string[]>();
  const groups: BrowserCsvReviewGroup[] = [];
  const addIssue = (id: number, issue: string) => issues.set(id, [...(issues.get(id) ?? []), issue]);
  const activeRows = document.rows.filter((row) => !row.excluded);
  const repeatedRows = new Map<string, number[]>();
  for (const row of activeRows) {
    if (row.values.every((value) => !value.trim())) {
      addIssue(row.id, 'Empty row: review before excluding');
      continue;
    }
    const key = JSON.stringify(row.values);
    const group = repeatedRows.get(key) ?? [];
    group.push(row.id);
    repeatedRows.set(key, group);
  }
  for (const group of repeatedRows.values()) {
    if (group.length < 2) continue;
    groups.push({ kind: 'repeated-row', rowIds: group });
    for (const id of group) addIssue(id, 'Repeated row: all column values match; review before excluding');
  }
  if (document.emailColumn === null) return { issues, groups };
  const emailGroups = new Map<string, number[]>();
  for (const row of activeRows) {
    const raw = row.values[document.emailColumn] ?? '';
    const email = normalizedEmail(raw);
    if (!raw.trim()) addIssue(row.id, 'Missing email');
    else if (!email) addIssue(row.id, 'Check email format');
    else {
      const group = emailGroups.get(email) ?? [];
      group.push(row.id);
      emailGroups.set(email, group);
    }
  }
  for (const group of emailGroups.values()) {
    if (group.length < 2) continue;
    groups.push({ kind: 'repeated-email', rowIds: group });
    for (const id of group) addIssue(id, 'Repeated email: review these rows before removing any');
  }
  return { issues, groups };
}

/** Empty rows and repeated values are review hints, never instructions to remove rows. */
export function browserCsvIssues(document: BrowserCsv): Map<number, string[]> {
  return browserCsvReview(document).issues;
}

export function exportBrowserCsv(document: BrowserCsv): { csv: string; escapedCells: number; rowCount: number } {
  const activeRows = document.rows.filter((row) => !row.excluded);
  let escapedCells = 0;
  const csv = [document.headers, ...activeRows.map((row) => row.values)].map((row) => row.map((source) => {
    // CSV quoting alone does not stop spreadsheet formulas. Prefix the original,
    // including its whitespace, so source cells are never silently trimmed here.
    const formulaLike = /^\s*[=+\-@]/u.test(source);
    if (formulaLike) escapedCells += 1;
    const value = formulaLike ? `'${source}` : source;
    // An unquoted empty value at the end of a one-column file looks like a
    // trailing line separator, so quote it to retain the final source row.
    const needsQuotes = (row.length === 1 && value === '') || /[",\r\n]/u.test(value);
    return needsQuotes ? `"${value.replaceAll('"', '""')}"` : value;
  }).join(',')).join('\r\n');
  return { csv, escapedCells, rowCount: activeRows.length };
}

/** Only change the domain. Case, dots and plus suffixes in the local part survive. */
function normalizedEmail(source: string): string | null {
  const value = source.trim();
  const match = /^([^@\s]+)@([^@\s]+)$/u.exec(value);
  if (!match || value.length > 254) return null;
  const [, local, domain] = match;
  if (local.length > 64 || !/^[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~.]+$/u.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  // Prevent URL syntax from being interpreted as a valid email domain.
  if (!/^[\p{L}\p{M}\p{N}.\-\u3002\uFF0E\uFF61]+$/u.test(domain)) return null;
  try {
    const ascii = new URL(`https://${domain}`).hostname.toLowerCase();
    const labels = ascii.split('.');
    if (ascii.length > 253 || labels.length < 2
      || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
      || !/[a-z]/u.test(labels.at(-1) ?? '')) return null;
    return `${local}@${ascii}`;
  } catch {
    return null;
  }
}

function parseRecords(input: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let state: 'start' | 'unquoted' | 'quoted' | 'closed' = 'start';
  let recordStarted = false;
  const finishCell = () => {
    row.push(cell);
    cell = '';
    state = 'start';
  };
  const finishRecord = () => {
    finishCell();
    if (records.length && row.length !== records[0].length) {
      throw new Error(`CSV row ${records.length + 1} has ${row.length} columns; the header has ${records[0].length}. Quote values containing commas or line breaks, and retain empty columns with commas.`);
    }
    if (records.length > BROWSER_CSV_MAX_ROWS) throw new Error('Choose a CSV with 10,000 data rows or fewer.');
    records.push(row);
    row = [];
    recordStarted = false;
  };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (state === 'quoted') {
      if (char === '"') {
        if (input[index + 1] === '"') { cell += '"'; index += 1; }
        else state = 'closed';
      } else cell += char;
      continue;
    }
    if (char === ',') { finishCell(); recordStarted = true; }
    else if (char === '\r' || char === '\n') {
      finishRecord();
      if (char === '\r' && input[index + 1] === '\n') index += 1;
    } else if (char === '"' && state === 'start') {
      state = 'quoted';
      recordStarted = true;
    } else if (char === '"' || state === 'closed') {
      throw new Error(`CSV row ${records.length + 1} has invalid quoting. Enclose the whole value in quotes and double any quote inside it.`);
    } else {
      cell += char;
      state = 'unquoted';
      recordStarted = true;
    }
  }
  if (state === 'quoted') throw new Error(`CSV row ${records.length + 1} has an unmatched quote.`);
  if (recordStarted) finishRecord();
  return records;
}
