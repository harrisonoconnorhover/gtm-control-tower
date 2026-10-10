import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Exercise the public site with fictional file bytes and actual browser downloads.
// Start it with: npm run preview:public -- --port 4175
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:4175');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a local public-site preview.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
const output = resolve('outputs/browser-csv');
await mkdir(output, { recursive: true });

const csv = 'Record ID,Name,Email,Custom note,Phone,Expression\r\n'
  + '00123, Ada , Ada+event@EXAMPLE.COM ,"Follow up, José\nSecond line  ",+44 20 7946 0123,=1+1\r\n'
  + '00124,Ada,Ada+event@example.com,  untouched  ,,\r\n'
  + '00125, Mina ,invalid,Keep custom spacing  ,,\r\n'
  + '00126,Sam,,An email is optional for downloading,,\r\n';
const expectedDownload = 'Record ID,Name,Email,Custom note,Phone,Expression\r\n'
  + '00123,Ada,Ada+event@example.com,"Follow up, José\nSecond line  ",\'+44 20 7946 0123,\'=1+1\r\n'
  + '00125,Mina,Mina@example.com,Keep custom spacing  ,,\r\n'
  + '00126,Sam,,An email is optional for downloading,,';
const browser = await chromium.launch({ executablePath, headless: true });
const outcomes = [];

async function workspace(viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [], processingRequests = [];
  let processing = false;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base.origin || url.pathname.startsWith('/api/')) {
      errors.push(`Unexpected network request: ${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (processing) processingRequests.push(`${request.method()} ${url.pathname}`);
    return route.continue();
  });
  const storage = () => page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
  async function open(reload = false) {
    processing = false;
    if (reload) await page.reload();
    else await page.goto(new URL('/#clean-csv', base).href);
    await page.getByRole('heading', { name: 'A cleaner CSV. Zero setup.', exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    assert.deepEqual(await storage(), { local: {}, session: {} }, 'Opening the cleaner must not create browser storage.');
  }
  async function assertPrivate() {
    assert.deepEqual(await storage(), { local: {}, session: {} }, 'CSV state must stay out of persistent browser storage.');
    assert.deepEqual(processingRequests, [], 'Reading, editing and downloading a local file must not make HTTP requests.');
    assert.deepEqual(errors, [], 'The browser should not report script errors, API calls or external requests.');
  }
  await open();
  return { context, page, open, assertPrivate, startProcessing: () => { processing = true; } };
}

async function upload(page, name, text) {
  await page.getByLabel('Choose a CSV file', { exact: true }).setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
  await page.getByRole('heading', { name, exact: true }).waitFor();
}

async function downloadCsv(page, artifactName) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV', exact: true }).first().click(),
  ]);
  assert.equal(await download.failure(), null);
  const stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  await download.saveAs(resolve(output, artifactName));
  return { name: download.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') };
}

async function reviewCount(page, count) {
  assert.equal(await page.getByText('Need your review', { exact: true }).locator('..').locator('p').first().innerText(), String(count));
}

async function noPageOverflow(page) {
  const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  assert(sizes.content <= sizes.viewport + 1, `The page overflows horizontally: ${JSON.stringify(sizes)}`);
}

try {
  const desktop = await workspace({ width: 1440, height: 1050 });
  const { page } = desktop;
  await page.screenshot({ path: resolve(output, 'desktop-start.png'), fullPage: true });
  desktop.startProcessing();
  await upload(page, 'fictional-contacts.csv', csv);
  await page.getByText('Preview before applying', { exact: true }).waitFor();
  await reviewCount(page, 4);
  await page.getByRole('button', { name: 'Review row 1', exact: true }).click();
  assert.equal(await page.getByLabel('Name — row 1', { exact: true }).inputValue(), ' Ada ', 'Suggested changes must not apply before approval.');
  assert.equal(await page.getByLabel('Custom note — row 1', { exact: true }).inputValue(), 'Follow up, José\nSecond line  ');
  await page.getByRole('button', { name: 'Apply formatting changes', exact: true }).click();
  await page.getByRole('heading', { name: 'No formatting changes to apply', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Name — row 1', { exact: true }).inputValue(), 'Ada');
  assert.equal(await page.getByLabel('Email — row 1', { exact: true }).inputValue(), 'Ada+event@example.com');
  assert.equal(await page.getByLabel('Record ID — row 1', { exact: true }).inputValue(), '00123');
  assert.equal(await page.getByLabel('Custom note — row 1', { exact: true }).inputValue(), 'Follow up, José\nSecond line  ');

  await page.getByRole('button', { name: 'Review row 3', exact: true }).click();
  await page.getByLabel('Email — row 3', { exact: true }).fill('Mina@example.com');
  await page.getByRole('button', { name: 'Save row', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Saved row 3.' }).waitFor();
  await reviewCount(page, 3);
  await page.getByRole('button', { name: 'Review row 2', exact: true }).click();
  await page.getByRole('button', { name: 'Exclude row', exact: true }).click();
  await reviewCount(page, 1);
  await page.getByRole('button', { name: 'Restore row', exact: true }).click();
  await reviewCount(page, 3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await reviewCount(page, 1);
  await page.getByRole('button', { name: 'Restore row', exact: true }).waitFor();
  await page.getByText(/2 formula-like cells will receive a leading apostrophe/).waitFor();
  const downloaded = await downloadCsv(page, 'desktop-cleaned.csv');
  assert.equal(downloaded.name, 'fictional-contacts-cleaned.csv');
  assert.equal(downloaded.text, expectedDownload, 'Downloaded bytes must preserve source columns, custom text and row decisions.');
  await noPageOverflow(page);
  await page.screenshot({ path: resolve(output, 'desktop-cleaned.png'), fullPage: true });

  await upload(page, 'custom-columns.csv', 'SKU,Name,Contact mailbox,Details\n00123, Ada ,Ada@EXAMPLE.COM, Keep me \n00124,Ada,Ada@example.com,Other');
  await reviewCount(page, 0);
  await page.getByText('Choose columns & formatting rules', { exact: true }).click();
  await page.getByLabel('Email column', { exact: true }).selectOption('2');
  await reviewCount(page, 2);
  await page.getByRole('button', { name: 'Apply formatting changes', exact: true }).click();
  const custom = await downloadCsv(page, 'custom-cleaned.csv');
  assert.equal(custom.text, 'SKU,Name,Contact mailbox,Details\r\n00123,Ada,Ada@example.com, Keep me \r\n00124,Ada,Ada@example.com,Other');

  await page.getByLabel('Choose a CSV file', { exact: true }).setInputFiles({ name: 'broken.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,Email\n"unclosed,email') });
  await page.getByRole('alert').filter({ hasText: 'unmatched quote' }).waitFor();
  await page.getByRole('heading', { name: 'custom-columns.csv', exact: true }).waitFor();
  await page.getByLabel('Choose a CSV file', { exact: true }).setInputFiles({ name: 'wrong-encoding.csv', mimeType: 'text/csv', buffer: Buffer.from([0xff, 0xfe, 0x41]) });
  await page.getByRole('alert').filter({ hasText: 'could not be read as UTF-8' }).waitFor();
  await upload(page, 'recovered.csv', 'SKU,Details\n00123,Still here');
  assert.equal(await page.getByRole('alert').count(), 0, 'A valid file should clear a previous parsing error.');
  await desktop.assertPrivate();
  await desktop.open(true);
  await page.getByRole('button', { name: 'Choose CSV file', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Download CSV', exact: true }).count(), 0, 'Reloading should start an empty workspace.');
  await desktop.assertPrivate();
  await desktop.context.close();
  outcomes.push('Desktop: upload, preview, cleanup, manual correction, exclusion/restore, Undo, column mapping, exact download bytes, malformed/invalid UTF-8 file recovery and refresh reset.');

  const mobile = await workspace({ width: 390, height: 844 });
  await noPageOverflow(mobile.page);
  await mobile.page.screenshot({ path: resolve(output, 'mobile-start.png'), fullPage: true });
  mobile.startProcessing();
  await mobile.page.getByRole('button', { name: 'Try sample CSV →', exact: true }).click();
  await mobile.page.getByRole('heading', { name: 'practice-contacts.csv', exact: true }).waitFor();
  await noPageOverflow(mobile.page);
  await mobile.page.getByRole('button', { name: 'Apply formatting changes', exact: true }).click();
  const sample = await downloadCsv(mobile.page, 'mobile-sample-cleaned.csv');
  assert.equal(sample.name, 'practice-contacts-cleaned.csv');
  assert(sample.text.includes('00123,Ada,Lovelace,Ada+event@example.com,Northstar,'));
  assert(sample.text.includes("'+44 20 7946 0123"));
  await mobile.page.getByRole('button', { name: 'Review row 4', exact: true }).click();
  await mobile.page.getByLabel('Email — row 4', { exact: true }).waitFor();
  await noPageOverflow(mobile.page);
  await mobile.page.screenshot({ path: resolve(output, 'mobile-cleaned.png'), fullPage: true });
  await mobile.assertPrivate();
  await mobile.context.close();
  outcomes.push('Mobile 390px: sample, cleanup, actual download and row editor; page width stays within viewport.');
  outcomes.push('Both sessions: no page errors, no API/external requests, no HTTP requests while processing CSV, and no local/session storage.');
  console.log(JSON.stringify({ status: 'passed', outcomes, screenshots: output }, null, 2));
} finally {
  await browser.close();
}
