import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Real CSV upload, related-row comparison and download against a local public build.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:4175');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a local public-site preview.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an installed Chrome or Chromium executable.');
const output = resolve('outputs/browser-csv-related');
await mkdir(output, { recursive: true });

const headers = ['Record ID', 'Email', 'Name', 'Company', 'Stage', 'Custom notes', 'Custom notes', ''];
const values = Array.from({ length: 64 }, (_, index) => [
  String(index + 1).padStart(5, '0'), `person${index + 1}@example.com`, `Person ${index + 1}`,
  `Company ${index + 1}`, 'Lead', `Note ${index + 1}`, 'Keep this custom column', '',
]);
values[0] = ['00123', 'shared@example.com', 'Alex Reed', 'West', 'Customer', '  Current account  ', 'Custom detail', 'Extra source value'];
values[44] = ['00045', 'shared@example.com', 'Alex Reed', 'East', 'Lead', 'Old trade-show list\nSecond line', 'Other detail', ''];
values[63] = [...values[0]];
const encode = (rows) => rows.map((row) => row.map((value) => /[",\r\n]/.test(value)
  ? `"${value.replaceAll('"', '""')}"` : value).join(',')).join('\r\n');
const csv = encode([headers, ...values]);
const browser = await chromium.launch({ executablePath, headless: true });
const checks = [];

async function download(page, filename) {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV', exact: true }).first().click(),
  ]);
  assert.equal(await file.failure(), null);
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  await file.saveAs(resolve(output, filename));
  const bytes = Buffer.concat(chunks);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Downloads should identify UTF-8 for spreadsheet readers.');
  return bytes.subarray(3).toString('utf8');
}

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, isMobile: width === 390, hasTouch: width === 390, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base.origin || url.pathname.startsWith('/api/')) {
        errors.push(`Unexpected request: ${url.origin}${url.pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(new URL('/#clean-csv', base).href);
    await page.getByLabel('Choose a CSV file', { exact: true }).setInputFiles({ name: 'distant-related-rows.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByRole('heading', { name: 'distant-related-rows.csv', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Review row 45', exact: true }).count(), 0, 'The related record should begin outside the first page.');
    const review = page.getByRole('button', { name: 'Review row 1', exact: true });
    const actionBox = await review.boundingBox();
    assert(actionBox && actionBox.x >= 0 && actionBox.x + actionBox.width <= width, 'Review must be horizontally reachable without swiping the table.');
    await review.click();
    if (width === 390) {
      const editorHeading = await page.getByRole('heading', { name: 'Review row 1', exact: true }).boundingBox();
      assert(editorHeading && editorHeading.y >= -1 && editorHeading.y < 80, 'Opening a mobile row should bring its editor to the top.');
    }
    const comparison = () => page.getByRole('region', { name: 'Compare related rows for row 1', exact: true });
    await comparison().waitFor();
    assert.equal(await comparison().getByRole('combobox').locator('option').count(), 2, 'An exact-row and email match must not list the same peer twice.');
    assert.equal(await comparison().getByRole('heading', { name: 'Email', exact: true }).count(), 0, 'Matching values should start collapsed.');
    await comparison().getByRole('heading', { name: 'Stage', exact: true }).waitFor();
    await comparison().getByRole('heading', { name: 'Custom notes (column 6)', exact: true }).waitFor();
    await comparison().getByRole('heading', { name: 'Custom notes (column 7)', exact: true }).waitFor();
    await comparison().getByRole('heading', { name: 'Column 8', exact: true }).waitFor();
    assert((await comparison().innerText()).includes('"  Current account  "'));
    assert((await comparison().innerText()).includes('"Old trade-show list\\nSecond line"'));
    await comparison().getByRole('button', { name: 'Show all 8 columns', exact: true }).click();
    await comparison().getByRole('heading', { name: 'Email', exact: true }).waitFor();
    await comparison().getByRole('combobox').selectOption('63');
    await comparison().getByText('All 8 column values match exactly.', { exact: false }).waitFor();
    await comparison().getByRole('button', { name: 'Show differences only', exact: true }).click();
    await comparison().getByText('There are no differing values.', { exact: false }).waitFor();
    await comparison().getByRole('combobox').selectOption('44');

    await comparison().getByRole('button', { name: 'Open row 45 to edit', exact: true }).click();
    await page.getByRole('heading', { name: 'Review row 45', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Company — row 45', { exact: true }).inputValue(), 'East');
    await page.getByRole('button', { name: 'Open row 1 to edit', exact: true }).click();
    await comparison().getByRole('combobox').selectOption('63');
    await comparison().getByRole('button', { name: 'Show all 8 columns', exact: true }).click();
    await page.getByLabel('Company — row 1', { exact: true }).fill('West updated');
    await comparison().waitFor({ state: 'hidden' });
    await page.getByText('Save row to refresh the formatting preview, search results, review notes, and related-row comparisons.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save row', exact: true }).click();
    await comparison().waitFor();
    assert.equal(await comparison().getByRole('combobox').inputValue(), '63', 'Saving must preserve the selected nonfirst peer.');
    assert.equal(await comparison().getByRole('button', { name: 'Show differences only', exact: true }).getAttribute('aria-pressed'), 'true', 'Saving must preserve the choice to show all columns.');
    await comparison().getByRole('heading', { name: 'Email', exact: true }).waitFor();
    assert((await comparison().innerText()).includes('"West updated"'), 'Saved edits must enter the comparison.');
    await page.getByRole('complementary', { name: 'Edit row 1', exact: true }).screenshot({ path: resolve(output, `related-${width}.png`) });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Related values must not overflow the page.');

    await comparison().getByRole('combobox').selectOption('44');
    await comparison().getByRole('button', { name: 'Exclude row 45', exact: true }).click();
    const edited = values.map((row) => [...row]);
    edited[0][3] = 'West updated';
    assert.equal(await download(page, `excluded-${width}.csv`), encode([headers, ...edited.filter((_, index) => index !== 44)]), 'Peer exclusion must omit only that record and preserve source/custom values.');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await comparison().getByRole('button', { name: 'Exclude row 45', exact: true }).waitFor();
    assert.equal(await download(page, `restored-${width}.csv`), encode([headers, ...edited]), 'Undo must restore the excluded peer without losing the saved edit.');

    await page.getByRole('link', { name: /Back to overview/ }).click();
    await page.getByRole('link', { name: 'Clean your CSV', exact: true }).click();
    await page.getByRole('heading', { name: 'distant-related-rows.csv', exact: true }).waitFor();
    await comparison().waitFor();
    assert.equal(await page.getByLabel('Company — row 1', { exact: true }).inputValue(), 'West updated', 'Overview navigation must preserve the current comparison and edits.');
    await page.getByLabel('Email — row 1', { exact: true }).fill('person2@example.com');
    await page.getByRole('button', { name: 'Save row', exact: true }).click();
    await comparison().getByRole('button', { name: 'Open row 2 to edit', exact: true }).waitFor();
    assert.equal(await comparison().getByRole('button', { name: 'Open row 45 to edit', exact: true }).count(), 0, 'Leaving a group must fall back to a current peer rather than the previous choice.');
    await page.getByLabel('Email — row 1', { exact: true }).fill('unique@example.com');
    await page.getByRole('button', { name: 'Save row', exact: true }).click();
    await comparison().waitFor({ state: 'hidden' });
    assert.equal(await page.getByLabel('Email — row 1', { exact: true }).inputValue(), 'unique@example.com', 'Leaving every group must remove the comparison without losing the edit.');
    assert.deepEqual(errors, [], 'Comparison must not cause page errors, external requests or operator API calls.');
    checks.push(`${width}px: off-page peer access, overlapping groups, different/all fields, duplicate/blank headers, quoted whitespace, draft/save preserves peer and all-column choice, changed-group fallback, explicit exclusion/Undo, exact download bytes and overview navigation.`);
    await context.close();
  }
  console.log(JSON.stringify({ status: 'passed', checks, screenshots: output }, null, 2));
} finally {
  await browser.close();
}
