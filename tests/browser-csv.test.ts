import { describe, expect, it } from 'vitest';
import {
  applyBrowserCleanup,
  BROWSER_CSV_MAX_BYTES,
  BROWSER_CSV_MAX_ROWS,
  browserCsvIssues,
  browserCsvSample,
  cleanupProposals,
  exportBrowserCsv,
  parseBrowserCsv,
  toggleBrowserRow,
  updateBrowserCell,
} from '../lib/browser-csv';

describe('browser CSV workspace', () => {
  it('preserves exact headers, all source fields, Unicode and quoted line breaks', () => {
    const csv = '\uFEFF Record ID ,Email,Notes,Custom,Custom\r\n00123,Ada@EXAMPLE.COM,"Hello, José\r\nSaid ""hi""",  untouched  ,00042\r\n';
    const document = parseBrowserCsv(csv);
    expect(document.headers).toEqual([' Record ID ', 'Email', 'Notes', 'Custom', 'Custom']);
    expect(document.rows[0].values).toEqual(['00123', 'Ada@EXAMPLE.COM', 'Hello, José\r\nSaid "hi"', '  untouched  ', '00042']);
    expect(document.emailColumn).toBe(1);
    const exported = exportBrowserCsv(document);
    expect(exported.escapedCells).toBe(0);
    expect(parseBrowserCsv(exported.csv)).toEqual(document);
  });

  it.each([
    ['', 'header row'],
    ['email\n', 'at least one data row'],
    ['email\n"unfinished', 'unmatched quote'],
    ['email\nA"da@example.com', 'invalid quoting'],
    ['email\n"Ada"oops', 'invalid quoting'],
    ['email,name\nada@example.com', '1 columns'],
    ['email,name\nada@example.com,Ada,extra', '3 columns'],
    ['email,name\n\n', '1 columns'],
  ])('rejects malformed or empty CSV: %j', (csv, message) => {
    expect(() => parseBrowserCsv(csv)).toThrow(message);
  });

  it('retains explicitly empty records instead of silently deleting rows', () => {
    expect(parseBrowserCsv('name,note\n,\n,').rows.map((row) => row.values)).toEqual([['', ''], ['', '']]);
    expect(parseBrowserCsv('note\n\n').rows[0].values).toEqual(['']);
    expect(parseBrowserCsv('note\n""').rows[0].values).toEqual(['']);
  });

  it('limits record count and actual UTF-8 file bytes', () => {
    expect(parseBrowserCsv(`id\n${'1\n'.repeat(BROWSER_CSV_MAX_ROWS)}`).rows).toHaveLength(BROWSER_CSV_MAX_ROWS);
    expect(() => parseBrowserCsv(`id\n${'1\n'.repeat(BROWSER_CSV_MAX_ROWS + 1)}`)).toThrow('10,000');
    expect(() => parseBrowserCsv(`note\n${'é'.repeat(BROWSER_CSV_MAX_BYTES / 2)}`)).toThrow('10 MiB');
  });

  it('only proposes conservative selected cleanup and never invents business fields', () => {
    const document = parseBrowserCsv('ID,Name,Email,Company,Phone,Notes,Owner,Stage\n00123, Ada , Ada.Lovelace+event@MAÑANA.EXAMPLE , Northstar , +44 123 ,  keep  ,,');
    expect(document.trimColumns).toEqual([1, 2, 3]);
    expect(cleanupProposals(document).map(({ column }) => column)).toEqual([1, 2, 3]);
    const cleaned = applyBrowserCleanup(document);
    expect(cleaned.rows[0].values).toEqual(['00123', 'Ada', 'Ada.Lovelace+event@xn--maana-pta.example', 'Northstar', ' +44 123 ', '  keep  ', '', '']);
    expect(document.rows[0].values[1]).toBe(' Ada ');
    expect(cleaned.rows[0].original).toEqual(document.rows[0].values);
    expect(cleanupProposals(cleaned)).toEqual([]);
    const unselected = applyBrowserCleanup({ ...document, trimColumns: [] });
    expect(unselected.rows[0].values[1]).toBe(' Ada ');
    expect(unselected.rows[0].values[2]).toBe('Ada.Lovelace+event@xn--maana-pta.example');
  });

  it('supports arbitrary CSV and selected columns without an email requirement', () => {
    const document = parseBrowserCsv('SKU,Description,Description\n00123, Keep me , Trim me ');
    expect(document.emailColumn).toBeNull();
    expect(document.trimColumns).toEqual([]);
    expect(browserCsvIssues(document).size).toBe(0);
    const cleaned = applyBrowserCleanup({ ...document, trimColumns: [2] });
    expect(cleaned.rows[0].values).toEqual(['00123', ' Keep me ', 'Trim me']);
    expect(exportBrowserCsv(cleaned).csv).toBe('SKU,Description,Description\r\n00123, Keep me ,Trim me');
  });

  it('marks all repeated emails without merging local-part case, dots or plus aliases', () => {
    const document = parseBrowserCsv('Email\nAda+event@EXAMPLE.COM\n Ada+event@example.com \nada+event@example.com\nAda@example.com\nA.da+event@example.com\nAda+event@mañana.example\nAda+event@xn--maana-pta.example');
    expect([...browserCsvIssues(document).keys()]).toEqual([0, 1, 5, 6]);
    expect(applyBrowserCleanup(document).rows).toHaveLength(7);
    expect(applyBrowserCleanup(document).rows.every((row) => !row.excluded)).toBe(true);
  });

  it('recomputes missing, invalid and repeated warnings after explicit edits, exclusions and restores', () => {
    const document = parseBrowserCsv('Email,Note\nAda@EXAMPLE.COM,first\nAda@example.com,second\n,missing\ninvalid,broken');
    expect(browserCsvIssues(document).get(2)).toEqual(['Missing email']);
    expect(browserCsvIssues(document).get(3)).toEqual(['Check email format']);
    const excluded = toggleBrowserRow(document, 1);
    expect(browserCsvIssues(excluded).has(0)).toBe(false);
    expect(browserCsvIssues(excluded).has(1)).toBe(false);
    expect(exportBrowserCsv(excluded).rowCount).toBe(3);
    expect(browserCsvIssues(toggleBrowserRow(excluded, 1)).has(0)).toBe(true);
    const corrected = updateBrowserCell(excluded, 3, 0, 'Fixed@example.com');
    expect(browserCsvIssues(corrected).has(3)).toBe(false);
    expect(corrected.rows[3].original[0]).toBe('invalid');
    expect(document.rows[1].excluded).toBe(false);
    expect(document.rows[3].values[0]).toBe('invalid');
  });

  it('does not reinterpret malformed email domains as URLs', () => {
    const values = ['a@example.com:443', 'a@example.com/path', 'a@exam%70le.com', 'a@example..com', 'a@-example.com', 'a@127.0.0.1', 'a..b@example.com'];
    const document = parseBrowserCsv(`Email\n${values.join('\n')}`);
    expect(browserCsvIssues(document).size).toBe(values.length);
    expect(cleanupProposals(document)).toEqual([]);
  });

  it('escapes spreadsheet formula-like cells and headers while preserving the source and CSV quoting', () => {
    const document = parseBrowserCsv('=Header,ID,Phone,Note\n=1+1,00123,+44 123,"\t =SUM(1,2)"\nordinary,00042,-123,"\r\n@command"\n@x,9,0,"hello\n=ordinary text"');
    const result = exportBrowserCsv(document);
    expect(result.escapedCells).toBe(7);
    const reimported = parseBrowserCsv(result.csv);
    expect(reimported.headers[0]).toBe("'=Header");
    expect(reimported.rows[0].values).toEqual(["'=1+1", '00123', "'+44 123", "'\t =SUM(1,2)"]);
    expect(reimported.rows[1].values[3]).toBe("'\r\n@command");
    expect(reimported.rows[2].values[3]).toBe('hello\n=ordinary text');
    expect(document.rows[0].values[0]).toBe('=1+1');
  });

  it('ships sample data exercising cleanup, review and an unchanged identifier', () => {
    const sample = parseBrowserCsv(browserCsvSample);
    expect(cleanupProposals(sample).length).toBeGreaterThan(0);
    expect(browserCsvIssues(sample).size).toBe(4);
    expect(applyBrowserCleanup(sample).rows[0].values[0]).toBe('00123');
  });
});
