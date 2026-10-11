import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Focused regressions for keyboard return paths and ambiguous source-column labels.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:4175');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a local public-site preview.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an installed Chrome or Chromium executable.');
const output = resolve('outputs/browser-csv-keyboard');
await mkdir(output, { recursive: true });
const headers = ['Record ID', 'Email', 'Name', 'Company', 'Stage', 'Custom notes', 'Custom notes', '', 'Column 8'];
const expectedLabels = ['Record ID', 'Email', 'Name', 'Company', 'Stage', 'Custom notes (column 6)', 'Custom notes (column 7)', 'Column 8 (column 8)', 'Column 8 (column 9)'];
const rows = Array.from({ length: 41 }, (_, index) => [
  String(index + 1).padStart(5, '0'), `person${index + 1}@example.com`, `Person ${index + 1}`,
  `Company ${index + 1}`, 'Lead', `First note ${index + 1}`, `Second note ${index + 1}`,
  `Unnamed value ${index + 1}`, `Named value ${index + 1}`,
]);
rows[0][1] = 'shared@example.com';
rows[40][1] = 'shared@example.com';
rows[1][1] = 'bad-email';
const csv = [headers, ...rows].map((row) => row.join(',')).join('\r\n');
const browser = await chromium.launch({ executablePath, headless: true });
const checks = [];

async function activate(page, locator) {
  await locator.focus();
  await page.keyboard.press('Enter');
}

async function expectFocus(page, locator, message) {
  await page.waitForFunction((element) => element === document.activeElement, await locator.elementHandle());
  assert(await locator.evaluate((element) => element === document.activeElement), message);
}

async function closeWithKeyboard(page, fromEditorHeading = false) {
  const close = page.getByRole('button', { name: 'Close', exact: true });
  if (fromEditorHeading) {
    await page.keyboard.press('Tab');
  } else {
    // The email field is near the start of the editor; traverse back to Close.
    for (let count = 0; count < 12 && !await close.evaluate((element) => element === document.activeElement); count++) {
      await page.keyboard.press('Shift+Tab');
    }
  }
  assert(await close.evaluate((element) => element === document.activeElement), 'Close should be reachable with Tab keys.');
  await page.keyboard.press('Enter');
}

async function wideColumnReview(page, width) {
  const columnCount = 100;
  const sourceHeaders = ['Record ID', 'Email', 'Name', 'Queue', ...Array.from({ length: columnCount - 5 }, (_, index) => `Custom property ${index + 5}`), 'Renewal notes'];
  sourceHeaders[10] = '2026';
  sourceHeaders[89] = 'Handoff notes';
  const sourceRows = Array.from({ length: 6 }, (_, index) => [
    String(index + 1).padStart(5, '0'), index % 2 === 0 ? `invalid-${index + 1}` : `person${index + 1}@example.com`,
    `Person ${index + 1}`, index === 0 || index === 4 ? 'Priority' : 'Standard',
    ...Array.from({ length: columnCount - 5 }, (_, column) => `Value ${index + 1}:${column + 5}`), `Original late ${index + 1}`,
  ]);
  sourceRows[0][89] = 'Amber-Fox-731';
  const encode = () => [sourceHeaders, ...sourceRows].map((row) => row.join(',')).join('\r\n');
  await page.getByLabel('Choose a CSV file', { exact: true }).setInputFiles({ name: `wide-${columnCount}.csv`, mimeType: 'text/csv', buffer: Buffer.from(encode()) });
  await page.getByRole('heading', { name: `wide-${columnCount}.csv`, exact: true }).waitFor();
  await activate(page, page.getByRole('button', { name: 'Needs review', exact: true }));
  await activate(page, page.getByRole('button', { name: 'Review row 1', exact: true }));
  const findColumn = page.getByRole('searchbox', { name: 'Find a column', exact: true });
  const rowSearch = page.getByLabel('Search rows', { exact: true });
  const matchingFields = page.getByRole('group', { name: 'Fields matching row search', exact: true });
  await rowSearch.fill('aMbEr-FoX-731');
  assert.equal(await matchingFields.getByRole('button').count(), 1, 'The cue should use the row search case-insensitive literal match.');
  await activate(page, matchingFields.getByRole('button', { name: 'Show Handoff notes, column 90', exact: true }));
  await expectFocus(page, findColumn, 'Choosing a matching field should focus the existing column search.');
  assert.equal(await findColumn.inputValue(), 'column 90');
  const matchedField = page.getByLabel('Handoff notes — row 1', { exact: true });
  assert.equal(await matchedField.inputValue(), 'Amber-Fox-731');
  await page.getByRole('complementary', { name: 'Edit row 1', exact: true }).screenshot({ path: resolve(output, `search-match-${width}.png`) });
  await matchedField.fill('Edited Amber-Fox-731');
  sourceRows[0][89] = 'Edited Amber-Fox-731';
  await rowSearch.fill('Value 1:');
  assert.equal(await matchingFields.getByRole('button').count(), sourceRows[0].filter((value) => value.toLocaleLowerCase().includes('value 1:')).length);
  const matchList = matchingFields.locator('.overflow-y-auto');
  const matchListSize = await matchList.evaluate((element) => ({ height: element.getBoundingClientRect().height, scrollHeight: element.scrollHeight }));
  assert(matchListSize.height <= 113 && matchListSize.scrollHeight > matchListSize.height, 'Many matching fields should stay in a compact scrolling list.');
  await activate(page, matchingFields.getByRole('button', { name: 'Show Custom property 5, column 5', exact: true }));
  await findColumn.fill('90');
  assert.equal(await matchedField.inputValue(), sourceRows[0][89], 'Following another search match must keep the pending late-column edit.');
  await rowSearch.fill('');
  assert.equal(await matchingFields.count(), 0, 'Clearing row search should remove its field cues.');
  await findColumn.fill('Renewal');
  const editor = () => page.getByRole('complementary', { name: /^Edit row / });
  assert.equal(await editor().locator('textarea').count(), 1);
  await editor().getByText(`1 of ${columnCount} columns`, { exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'Previous row', exact: true }).isDisabled());
  await page.getByLabel('Renewal notes — row 1', { exact: true }).fill('Updated late 1');
  sourceRows[0][columnCount - 1] = 'Updated late 1';
  await activate(page, page.getByRole('button', { name: 'Next row', exact: true }));
  await expectFocus(page, page.getByRole('heading', { name: 'Review row 3', exact: true }), 'Next row should follow Needs review order and focus the next editor.');
  assert.equal(await findColumn.inputValue(), 'Renewal', 'Column search should persist across rows.');
  assert.equal(await page.getByLabel('Renewal notes — row 3', { exact: true }).inputValue(), 'Original late 3');
  await activate(page, page.getByRole('button', { name: 'Previous row', exact: true }));
  assert.equal(await page.getByLabel('Renewal notes — row 1', { exact: true }).inputValue(), 'Updated late 1', 'Stepping away must preserve pending edits at the original source column index.');

  await page.getByLabel('Search rows', { exact: true }).fill('Priority');
  await activate(page, page.getByRole('button', { name: 'Next row', exact: true }));
  await page.getByRole('heading', { name: 'Review row 5', exact: true }).waitFor();
  await editor().getByText('2 of 2 rows in this view', { exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'Next row', exact: true }).isDisabled(), 'The row stepper must respect both the filter and row search.');
  await page.getByLabel('Renewal notes — row 5', { exact: true }).fill('Updated late 5');
  sourceRows[4][columnCount - 1] = 'Updated late 5';
  await activate(page, page.getByRole('button', { name: 'Previous row', exact: true }));
  await findColumn.fill('not-a-source-column');
  assert.equal(await editor().locator('textarea').count(), 0);
  await editor().getByText(/No columns match/).waitFor();
  await activate(page, page.getByRole('button', { name: 'Clear column search', exact: true }));
  await expectFocus(page, findColumn, 'Clearing the column search should return focus to the search field.');
  assert.equal(await editor().locator('textarea').count(), columnCount);
  await findColumn.fill(String(columnCount));
  assert.equal(await editor().locator('textarea').count(), 1);
  assert.equal(await page.getByLabel('Renewal notes — row 1', { exact: true }).inputValue(), 'Updated late 1');
  await findColumn.fill(`column ${columnCount - 1}`);
  assert.equal(await page.getByLabel(`Custom property ${columnCount - 1} — row 1`, { exact: true }).inputValue(), `Value 1:${columnCount - 1}`);
  await findColumn.fill('2026');
  assert.equal(await editor().locator('textarea').count(), 1);
  assert.equal(await page.getByLabel('2026 — row 1', { exact: true }).inputValue(), 'Value 1:11', 'Numeric headers must match by name even when the number is not a column position.');

  await findColumn.fill('Renewal');
  await page.getByLabel('Search rows', { exact: true }).fill('Standard');
  await editor().getByText('This row is outside the current view.', { exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'Previous row', exact: true }).isDisabled());
  assert(await page.getByRole('button', { name: 'Next row', exact: true }).isDisabled());
  await page.getByLabel('Renewal notes — row 1', { exact: true }).fill('Still editable off view');
  sourceRows[0][columnCount - 1] = 'Still editable off view';
  await editor().screenshot({ path: resolve(output, `wide-${columnCount}-${width}.png`) });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV', exact: true }).first().click()]);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.subarray(3).toString('utf8'), encode(), 'Column filtering and row navigation must not edit any other source cell.');
  await download.saveAs(resolve(output, `wide-${columnCount}-${width}.csv`));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Wide source columns must not overflow the page.');
  checks.push(`${width}px: ${columnCount}-column file searched by label/position; row-search cues reveal the unique column90 match and keep multiple matches compact; cue navigation and row stepping retain drafts; filter/search boundaries, off-view editing and exact downloaded cells verified.`);
}

async function bulkColumnFormatting(page, width) {
  const columnCount = 100;
  const sourceHeaders = Array.from({ length: columnCount }, (_, index) => `Field ${index + 1}`);
  const values = sourceHeaders.map((_, index) => index === 0 ? ' Ada@EXAMPLE.COM ' : ` Value ${index + 1} `);
  await page.getByLabel('Choose a CSV file', { exact: true }).setInputFiles({ name: 'generic-wide.csv', mimeType: 'text/csv', buffer: Buffer.from([sourceHeaders, values].map((row) => row.join(',')).join('\r\n')) });
  const rules = page.getByRole('group', { name: 'Trim outer spaces in these columns', exact: true });
  const count = (included) => rules.getByText(`${included} of ${columnCount} columns included`, { exact: true }).waitFor();
  const formattingSearch = rules.getByRole('searchbox', { name: 'Find a formatting column', exact: true });
  const clearSearch = async () => {
    await activate(page, rules.getByRole('button', { name: 'Clear formatting column search', exact: true }));
    await expectFocus(page, formattingSearch, 'Clearing formatting search should return focus to its input.');
  };
  const checkDownload = async (expectedValues, filename) => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV', exact: true }).first().click()]);
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(bytes.subarray(3).toString('utf8'), [sourceHeaders, expectedValues].map((row) => row.join(',')).join('\r\n'), 'Search and selection must keep every source column at its original index.');
    await download.saveAs(resolve(output, filename));
  };
  await count(0);
  assert(await rules.getByRole('button', { name: 'Clear all', exact: true }).isDisabled());
  await activate(page, page.getByRole('button', { name: 'Review row 1', exact: true }));
  const lastField = page.getByLabel(`Field ${columnCount} — row 1`, { exact: true });
  await lastField.fill(' Draft last ');
  values[columnCount - 1] = ' Draft last ';
  await formattingSearch.fill('column 90');
  assert.equal(await rules.getByRole('checkbox').count(), 1);
  await rules.getByRole('checkbox', { name: 'Field 90', exact: true }).check();
  await count(1);
  await formattingSearch.fill('unmatched_custom_crm_property_'.repeat(5).slice(0, 120));
  await rules.getByText(/No columns match/).waitFor();
  await count(1);
  const searchSize = await rules.evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, right: element.getBoundingClientRect().right }));
  assert(searchSize.scrollWidth <= searchSize.width + 1 && searchSize.right <= width, 'A long unmatched property name must wrap without widening or clipping the formatting panel.');
  await clearSearch();
  assert(await rules.getByRole('checkbox', { name: 'Field 90', exact: true }).isChecked(), 'Hiding a column must retain its selection.');
  const mapping = page.getByLabel('Email column', { exact: true });
  await mapping.selectOption('0');
  await formattingSearch.fill('column 1');
  const emailChoice = rules.getByRole('checkbox', { name: /^Field 1\b/ });
  assert(await emailChoice.isChecked() && await emailChoice.isDisabled(), 'A searched email column must remain included in email formatting.');
  await count(2);
  await formattingSearch.fill('90');
  await rules.screenshot({ path: resolve(output, `formatting-search-${width}.png`) });
  await activate(page, page.getByRole('button', { name: 'Apply formatting changes', exact: true }));
  await checkDownload(values.map((value, column) => column === 0 ? 'Ada@example.com' : column === 89 ? value.trim() : value), `formatting-search-${width}.csv`);
  for (const included of [2, 1, 0]) {
    await activate(page, page.getByRole('button', { name: 'Undo', exact: true }));
    await count(included);
  }
  assert.equal(await lastField.inputValue(), values[columnCount - 1], 'Undoing formatting choices must retain the earlier manual draft.');
  await rules.getByText('Select all and Clear all also affect columns hidden by this search.', { exact: true }).waitFor();
  await activate(page, rules.getByRole('button', { name: 'Select all columns', exact: true }));
  await count(columnCount);
  await clearSearch();
  assert(await rules.getByRole('button', { name: 'Select all', exact: true }).isDisabled());
  assert.equal(await rules.locator('input:checked').count(), columnCount);
  assert.equal(await lastField.inputValue(), ' Draft last ', 'Bulk selection must retain the draft without applying formatting.');
  await formattingSearch.fill('90');
  await activate(page, rules.getByRole('button', { name: 'Clear all columns', exact: true }));
  await count(0);
  await activate(page, page.getByRole('button', { name: 'Undo', exact: true }));
  await count(columnCount);
  await clearSearch();
  assert.equal(await page.getByLabel('Field 1 — row 1', { exact: true }).inputValue(), values[0]);
  assert.equal(await lastField.inputValue(), values[columnCount - 1]);
  await rules.screenshot({ path: resolve(output, `bulk-formatting-${width}.png`) });
  await activate(page, page.getByRole('button', { name: 'Apply formatting changes', exact: true }));
  await checkDownload(values.map((value) => value.trim()), `bulk-formatting-${width}.csv`);

  await mapping.selectOption('0');
  await formattingSearch.fill('90');
  await activate(page, rules.getByRole('button', { name: 'Clear all other columns', exact: true }));
  await count(1);
  await clearSearch();
  assert(await rules.getByRole('checkbox', { name: /^Field 1\b/ }).isDisabled());
  await mapping.selectOption('');
  await count(1); // The selected email's earlier checked trim preference survives.
  await activate(page, rules.getByRole('button', { name: 'Clear all', exact: true }));
  await mapping.selectOption('0');
  await activate(page, rules.getByRole('button', { name: 'Select all', exact: true }));
  await activate(page, rules.getByRole('button', { name: 'Clear other columns', exact: true }));
  await count(1);
  assert(await rules.getByRole('button', { name: 'Clear other columns', exact: true }).isDisabled());
  await mapping.selectOption('');
  await count(0); // The selected email's earlier unchecked trim preference survives too.
  await formattingSearch.fill('90');
  await page.getByLabel('Choose a CSV file', { exact: true }).setInputFiles({ name: 'replacement-wide.csv', mimeType: 'text/csv', buffer: Buffer.from([sourceHeaders, values].map((row) => row.join(',')).join('\r\n')) });
  await page.getByRole('heading', { name: 'replacement-wide.csv', exact: true }).waitFor();
  assert.equal(await formattingSearch.inputValue(), '', 'A replacement file should reset the formatting search.');
  assert.equal(await rules.getByRole('checkbox').count(), columnCount);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Bulk formatting controls must fit the viewport.');
  checks.push(`${width}px: formatting search selects column90 without changing hidden choices; clear/miss, mapped email, global bulk labels, draft/Undo, replacement reset and exact selective/all-column downloads verified.`);
}

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 } });
    const page = await context.newPage();
    page.on('dialog', (dialog) => dialog.accept());
    page.setDefaultTimeout(15_000);
    await page.goto(new URL('/#clean-csv', base).href);
    for (const [button, filename] of [['Choose CSV file', 'keyboard-picker.csv'], ['Open another CSV', 'keyboard-rows.csv']]) {
      const picker = page.getByRole('button', { name: button, exact: true });
      // Register interception before keyboard setup; Playwright enables it asynchronously.
      const choosing = page.waitForEvent('filechooser');
      await picker.waitFor();
      await page.getByRole('link', { name: /Back to overview/ }).focus();
      await page.keyboard.press('Tab');
      await expectFocus(page, picker, 'Tab should reach the visible picker button without stopping on the hidden file input.');
      await page.keyboard.press('Enter');
      await (await choosing).setFiles({ name: filename, mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await page.getByRole('heading', { name: filename, exact: true }).waitFor();
    }
    checks.push(`${width}px: initial and loaded Tab sequences skip the hidden file input; Enter on each visible picker button opens the file chooser and loads the chosen file.`);
    const reviewFirst = page.getByRole('button', { name: 'Review row 1', exact: true });
    const rowsHeading = page.getByRole('heading', { name: 'Your rows', exact: true });

    await activate(page, reviewFirst);
    await expectFocus(page, page.getByRole('heading', { name: 'Review row 1', exact: true }), 'Opening a row should focus its editor heading.');
    await closeWithKeyboard(page, true);
    await expectFocus(page, reviewFirst, 'Close should return focus to the row action.');

    for (const [direction, firstRow] of [['Next', 21], ['Previous', 1]]) {
      await activate(page, page.getByRole('button', { name: direction, exact: true }));
      await expectFocus(page, rowsHeading, 'Pagination should focus the top of the current rows.');
      await page.getByRole('button', { name: `Review row ${firstRow}`, exact: true }).waitFor();
      const box = await rowsHeading.boundingBox();
      assert(box && box.y >= -1 && box.y < 80, `${direction} should scroll to the rows heading, not leave the user below the new rows.`);
    }

    await activate(page, page.getByRole('button', { name: 'Needs review', exact: true }));
    await activate(page, page.getByRole('button', { name: 'Review row 2', exact: true }));
    await page.getByLabel('Email — row 2', { exact: true }).fill('person2@example.com');
    await closeWithKeyboard(page);
    await expectFocus(page, rowsHeading, 'If saving removes the row from Needs review, Close should return focus to Your rows.');
    assert.equal(await page.getByRole('button', { name: 'Review row 2', exact: true }).count(), 0);

    await activate(page, reviewFirst);
    const editor = page.getByRole('complementary', { name: 'Edit row 1', exact: true });
    const labels = await editor.locator('textarea').evaluateAll((fields) => fields.map((field) => field.getAttribute('aria-label')?.replace(' — row 1', '')));
    assert.deepEqual(labels, expectedLabels, 'Duplicate and generated-name collisions need distinct field labels.');
    assert.equal(new Set(labels).size, headers.length);
    const comparison = page.getByRole('region', { name: 'Compare related rows for row 1', exact: true });
    await activate(page, comparison.getByRole('button', { name: 'Show all 9 columns', exact: true }));
    assert.deepEqual(await comparison.getByRole('heading', { level: 4 }).allTextContents(), labels, 'Editor labels must identify the same columns shown in comparison.');
    await editor.screenshot({ path: resolve(output, `labels-${width}.png`) });
    checks.push(`${width}px: Enter opens a row; Tab/Enter closes to its action; Next/Previous focus and scroll to Your rows; closing a corrected filtered row uses the heading fallback; duplicate and blank/header label collisions match comparison.`);
    await wideColumnReview(page, width);
    await bulkColumnFormatting(page, width);
    await context.close();
  }
  console.log(JSON.stringify({ status: 'passed', checks, screenshots: output }, null, 2));
} finally {
  await browser.close();
}
