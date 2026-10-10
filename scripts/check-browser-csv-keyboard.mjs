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

try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(new URL('/#clean-csv', base).href);
    await page.getByLabel('Choose a CSV file', { exact: true }).setInputFiles({ name: 'keyboard-rows.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
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
    await context.close();
  }
  console.log(JSON.stringify({ status: 'passed', checks, screenshots: output }, null, 2));
} finally {
  await browser.close();
}
