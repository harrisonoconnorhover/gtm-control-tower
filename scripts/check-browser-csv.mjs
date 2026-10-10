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

async function workspace(viewport, anchor = '#clean-csv') {
  const context = await browser.newContext({ viewport, acceptDownloads: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [], processingRequests = [];
  let processing = false;
  let expectedStorage = { local: {}, session: {} };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    const inboundPracticeRead = !processing && page.url().endsWith('#inbound-lab')
      && url.origin === base.origin && url.pathname === '/api/control-tower/demo-intake'
      && !url.search && request.method() === 'GET' && request.postData() === null;
    if (inboundPracticeRead) return route.continue();
    if (url.origin !== base.origin || url.pathname.startsWith('/api/') || request.method() !== 'GET') {
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
    else await page.goto(new URL(`/${anchor}`, base).href);
    await page.getByRole('heading', { name: 'A cleaner CSV. Zero setup.', exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    assert.deepEqual(await storage(), expectedStorage, 'Opening the cleaner must not create browser storage.');
  }
  async function assertPrivate() {
    assert.deepEqual(await storage(), expectedStorage, 'CSV state must stay out of persistent browser storage.');
    assert.deepEqual(processingRequests, [], 'Reading, editing and downloading a local file must not make HTTP requests.');
    assert.deepEqual(errors, [], 'The browser should not report script errors, API calls or external requests.');
  }
  async function captureInboundPracticeStorage() {
    await page.waitForFunction(() => localStorage.getItem('gtm-inbound-practice-v1') !== null);
    const snapshot = await storage();
    assert.deepEqual(Object.keys(snapshot.local), ['gtm-inbound-practice-v1'], 'Only the existing inbound practice storage is expected after visiting its view.');
    assert.deepEqual(snapshot.session, {});
    const serialized = JSON.stringify(snapshot);
    for (const marker of ['Kept across views', 'draft-undo.csv', 'Typed before download', '00123']) {
      assert(!serialized.includes(marker), `The inbound demo must not store the CSV marker ${marker}.`);
    }
    expectedStorage = snapshot;
  }
  await open();
  return { context, page, open, assertPrivate, captureInboundPracticeStorage, startProcessing: () => { processing = true; }, pauseProcessing: () => { processing = false; } };
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
  const bytes = Buffer.concat(chunks);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Downloads should identify UTF-8 for spreadsheet readers.');
  return { name: download.suggestedFilename(), text: bytes.subarray(3).toString('utf8'), bytes };
}

async function reviewCount(page, count) {
  assert.equal(await page.getByText('Need your review', { exact: true }).locator('..').locator('p').first().innerText(), String(count));
}

async function noPageOverflow(page) {
  const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  assert(sizes.content <= sizes.viewport + 1, `The page overflows horizontally: ${JSON.stringify(sizes)}`);
}

async function downloadClarity(page, viewport) {
  const source = 'ID,Name,Email\n00123, Ada ,Ada@EXAMPLE.COM\n00124,Bea,not-an-email';
  await upload(page, 'unformatted.csv', source);
  const overview = page.getByRole('region', { name: 'File overview', exact: true });
  const warning = overview.getByText('2 suggested formatting changes have not been applied. Download keeps your current values; apply formatting changes below to include them.', { exact: true });
  await warning.waitFor();
  const warningBox = await warning.boundingBox();
  const buttonBox = await overview.getByRole('button', { name: 'Download CSV', exact: true }).boundingBox();
  assert(warningBox && buttonBox && warningBox.y >= buttonBox.y + buttonBox.height && warningBox.y - buttonBox.y - buttonBox.height <= 20,
    'The unapplied-formatting warning should sit directly below the top download actions.');
  const downloaded = await downloadCsv(page, `${viewport}-unformatted.csv`);
  assert.equal(downloaded.name, 'unformatted-cleaned.csv');
  assert.equal(downloaded.text, source.replaceAll('\n', '\r\n'), 'Download must not apply suggested formatting silently.');
  const status = page.getByRole('status').filter({ hasText: 'Download prepared:' });
  await status.filter({ hasText: "unformatted-cleaned.csv. Find it in your browser's Downloads. 2 rows, all 3 original columns, 1 row with review notes. 2 suggested formatting changes remain unapplied" }).waitFor();
  await noPageOverflow(page);
  await page.screenshot({ path: resolve(output, `${viewport}-download-notice.png`), fullPage: true });

  await page.getByRole('button', { name: 'Review row 1', exact: true }).click();
  await page.getByLabel('Name — row 1', { exact: true }).fill('Ada');
  const withDraft = await downloadCsv(page, `${viewport}-download-with-draft.csv`);
  assert.equal(withDraft.name, 'unformatted-cleaned.csv');
  assert.equal(withDraft.text, source.replace(' Ada ', 'Ada').replaceAll('\n', '\r\n'));
  await status.filter({ hasText: '1 suggested formatting change remains unapplied' }).waitFor();
  assert(!(await status.innerText()).includes('2 suggested formatting changes'), 'Download status must count suggestions after including pending row edits.');
  await noPageOverflow(page);
}

async function replacementPreview(page) {
  const source = 'Name,Email\n' + Array.from({ length: 8 }, (_, index) => ` Person ${index + 1} ,person${index + 1}@EXAMPLE.COM`).join('\n');
  await upload(page, 'first-preview.csv', source);
  await page.getByRole('button', { name: 'More changes', exact: true }).click();
  await page.getByText('Changes 6–10 of 16', { exact: true }).waitFor();
  await upload(page, 'replacement-preview.csv', source);
  await page.getByText('Changes 1–5 of 16', { exact: true }).waitFor();
}

async function emailFormattingRules(page, viewport) {
  await upload(page, 'email-rules.csv', 'Name,Email,Mailbox\nAda, Ada@EXAMPLE.COM , Other@EXAMPLE.COM ');
  await page.getByText('Choose columns & formatting rules', { exact: true }).click();
  const mapping = page.getByLabel('Email column', { exact: true });
  const email = page.getByRole('checkbox', { name: /^Email\b/ });
  const mailbox = page.getByRole('checkbox', { name: /^Mailbox\b/ });
  assert(await email.isChecked() && await email.isDisabled(), 'Selected email trimming is included in email formatting, not an editable preference.');
  await page.getByText('Included in email formatting', { exact: true }).waitFor();
  await mapping.selectOption('2');
  assert(await email.isChecked() && await email.isEnabled(), 'Changing email mapping must retain a previously selected trim preference.');
  assert(await mailbox.isChecked() && await mailbox.isDisabled());
  await mapping.selectOption('');
  assert(!(await mailbox.isChecked()) && await mailbox.isEnabled(), 'Changing email mapping must not overwrite a previously unselected trim preference.');
  await email.uncheck();
  await mapping.selectOption('1');
  assert(await email.isChecked() && await email.isDisabled());
  await noPageOverflow(page);
  await page.getByRole('region', { name: 'Suggested cleanup', exact: true }).screenshot({ path: resolve(output, `${viewport}-email-rules.png`) });
  await page.getByRole('button', { name: 'Apply formatting changes', exact: true }).click();
  assert.equal((await downloadCsv(page, `${viewport}-email-rules.csv`)).text, 'Name,Email,Mailbox\r\nAda,Ada@example.com, Other@EXAMPLE.COM ', 'Only the selected email is trimmed and normalized; the other column keeps its spacing.');
  await mapping.selectOption('');
  assert(!(await email.isChecked()) && await email.isEnabled(), 'The prior unchecked trim preference must survive email formatting.');
}

async function withoutIdentity(page, kind, source, lastColumn) {
  await upload(page, `${kind}.csv`, source);
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByLabel('Review coverage').filter({ hasText: 'No email column is selected' }).waitFor();
  await reviewCount(page, 3);
  assert.equal((await downloadCsv(page, `${kind}-unchanged.csv`)).text, source.replaceAll('\n', '\r\n'), 'No identity column or review finding may prevent a complete download.');
  await page.getByRole('button', { name: 'Review row 2', exact: true }).click();
  await page.getByLabel(`${lastColumn} — row 2`, { exact: true }).fill('Distinct row');
  await page.getByRole('button', { name: 'Save row', exact: true }).click();
  await reviewCount(page, 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await reviewCount(page, 3);
  await page.getByRole('button', { name: 'Exclude row', exact: true }).click();
  await reviewCount(page, 1);
  await page.getByRole('button', { name: 'Restore row', exact: true }).click();
  await reviewCount(page, 3);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Needs review', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /^Review row / }).count(), 3);
  await noPageOverflow(page);
  await page.screenshot({ path: resolve(output, `${kind}-no-identity.png`), fullPage: true });
}

async function draftLifecycle(session) {
  const { page } = session;
  await upload(page, 'draft-download.csv', 'ID,Name,Email\n00123,Original,ada@example.com\n00124,Other,blair@example.com');
  await page.getByRole('button', { name: 'Review row 1', exact: true }).click();
  await page.getByLabel('Name — row 1', { exact: true }).fill('Typed before download');
  assert.equal((await downloadCsv(page, 'draft-without-save.csv')).text,
    'ID,Name,Email\r\n00123,Typed before download,ada@example.com\r\n00124,Other,blair@example.com',
    'Download must include pending row edits without a separate Save click.');
  await page.getByLabel('Name — row 1', { exact: true }).fill('Kept on switch');
  await page.getByRole('button', { name: 'Review row 2', exact: true }).click();
  await page.getByRole('cell', { name: 'Kept on switch', exact: true }).waitFor();
  await page.getByLabel('Name — row 2', { exact: true }).fill('Kept on close');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('cell', { name: 'Kept on close', exact: true }).waitFor();
  assert.equal((await downloadCsv(page, 'draft-switch-close.csv')).text,
    'ID,Name,Email\r\n00123,Kept on switch,ada@example.com\r\n00124,Kept on close,blair@example.com');

  await upload(page, 'draft-actions.csv', 'ID,Name,Email,Alternate email,Notes\n00123, Ada ,Ada@EXAMPLE.COM,Alternate@EXAMPLE.COM,initial\n00124,Blair,Blair@example.com,Other@example.com,untouched');
  await page.getByRole('button', { name: 'Review row 1', exact: true }).click();
  await page.getByLabel('Notes — row 1', { exact: true }).fill('Before formatting');
  await page.getByRole('button', { name: 'Apply formatting changes', exact: true }).click();
  assert.equal(await page.getByLabel('Notes — row 1', { exact: true }).inputValue(), 'Before formatting');
  assert.equal(await page.getByLabel('Name — row 1', { exact: true }).inputValue(), 'Ada');
  await page.getByLabel('Notes — row 1', { exact: true }).fill('Before mapping');
  await page.getByText('Choose columns & formatting rules', { exact: true }).click();
  await page.getByLabel('Email column', { exact: true }).selectOption('3');
  assert.equal(await page.getByLabel('Notes — row 1', { exact: true }).inputValue(), 'Before mapping');
  await page.getByLabel('Notes — row 1', { exact: true }).fill('Before excluding');
  await page.getByRole('button', { name: 'Exclude row', exact: true }).click();
  await page.getByRole('button', { name: 'Restore row', exact: true }).click();
  assert.equal((await downloadCsv(page, 'draft-actions.csv')).text,
    'ID,Name,Email,Alternate email,Notes\r\n00123,Ada,Ada@example.com,Alternate@EXAMPLE.COM,Before excluding\r\n00124,Blair,Blair@example.com,Other@example.com,untouched',
    'Formatting, mapping and exclusion must retain manual edits.');

  await upload(page, 'draft-undo.csv', 'Name,Email\nOriginal,ada@example.com');
  await page.getByRole('button', { name: 'Review row 1', exact: true }).click();
  await page.getByLabel('Name — row 1', { exact: true }).fill('Saved');
  await page.getByRole('button', { name: 'Save row', exact: true }).click();
  await page.getByLabel('Name — row 1', { exact: true }).fill('Pending');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await page.getByLabel('Name — row 1', { exact: true }).inputValue(), 'Saved', 'First Undo should discard pending edits only.');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await page.getByLabel('Name — row 1', { exact: true }).inputValue(), 'Original', 'Second Undo should revert the previous saved action.');
  assert.equal((await downloadCsv(page, 'draft-undo.csv')).text, 'Name,Email\r\nOriginal,ada@example.com');

  await page.getByLabel('Name — row 1', { exact: true }).fill('Kept across views');
  await session.assertPrivate();
  // Other public views load their own static assets; CSV actions remain offline.
  session.pauseProcessing();
  await page.getByRole('link', { name: /Back to overview/ }).click();
  await page.getByRole('link', { name: 'Clean your CSV', exact: true }).click();
  await page.getByRole('heading', { name: 'draft-undo.csv', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Name — row 1', { exact: true }).inputValue(), 'Kept across views');
  await page.getByRole('link', { name: /Back to overview/ }).click();
  await page.getByRole('link', { name: 'Inbound routing lab', exact: true }).click();
  await page.getByRole('heading', { name: 'Inbound Routing Lab', exact: true }).waitFor();
  await session.captureInboundPracticeStorage();
  await page.goto(new URL('/#clean-csv', base).href);
  await page.getByRole('heading', { name: 'draft-undo.csv', exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  session.startProcessing();
  assert.equal((await downloadCsv(page, 'draft-navigation.csv')).text, 'Name,Email\r\nKept across views,ada@example.com',
    'Navigating within the public site must retain the working file and pending edits.');
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
  await replacementPreview(page);
  await downloadClarity(page, 'desktop');
  await emailFormattingRules(page, 'desktop');
  await withoutIdentity(page, 'companies', 'Company,Domain,Notes\nAcme,acme.example,Keep this\nAcme,acme.example,Keep this\n,,', 'Notes');
  await draftLifecycle(desktop);
  await desktop.assertPrivate();
  await desktop.open(true);
  await page.getByRole('button', { name: 'Choose CSV file', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Download CSV', exact: true }).count(), 0, 'Reloading should start an empty workspace.');
  await desktop.assertPrivate();
  await desktop.context.close();
  outcomes.push('Desktop: upload, preview, cleanup, manual correction, exclusion/restore, Undo, column mapping, exact download bytes, malformed/invalid UTF-8 file recovery and refresh reset.');
  outcomes.push('Drafts: download/switch/Close/formatting/mapping/exclusion keep edits; Undo separates pending and saved work; overview/inbound navigation retains the working CSV.');

  const mobile = await workspace({ width: 390, height: 844 }, '#audit');
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
  assert(sample.text.includes('00125,José,Rivera,jose@xn--maana-pta.example,Sol,'), 'Accented names must survive the downloaded UTF-8 bytes.');
  assert(sample.text.includes("'+44 20 7946 0123"));
  const reviewButton = mobile.page.getByRole('button', { name: 'Review row 4', exact: true });
  await reviewButton.evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - 180));
  const reviewPosition = await reviewButton.evaluate((element) => ({
    left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
    scrollLeft: element.closest('.overflow-x-auto')?.scrollLeft ?? 0,
  }));
  assert(reviewPosition.left >= 0 && reviewPosition.right <= 390 && reviewPosition.scrollLeft === 0,
    `Mobile Review must be reachable without horizontal scrolling: ${JSON.stringify(reviewPosition)}`);
  await reviewButton.click();
  await mobile.page.getByLabel('Email — row 4', { exact: true }).waitFor();
  await mobile.page.waitForFunction(() => {
    const heading = document.querySelector('aside[aria-label="Edit row 4"] h2');
    const top = heading?.getBoundingClientRect().top;
    return top !== undefined && top >= 0 && top <= 150;
  });
  await noPageOverflow(mobile.page);
  await mobile.page.screenshot({ path: resolve(output, 'mobile-cleaned.png'), fullPage: true });
  await mobile.page.getByLabel('Choose a CSV file', { exact: true }).setInputFiles({ name: 'sample-roundtrip.csv', mimeType: 'text/csv', buffer: sample.bytes });
  await mobile.page.getByRole('heading', { name: 'sample-roundtrip.csv', exact: true }).waitFor();
  await mobile.page.getByRole('button', { name: 'Review row 3', exact: true }).click();
  assert.equal(await mobile.page.getByLabel('Record ID — row 3', { exact: true }).inputValue(), '00125', 'Reopening the download must remove the encoding marker from the first header.');
  assert.equal(await mobile.page.getByLabel('First name — row 3', { exact: true }).inputValue(), 'José');
  await downloadClarity(mobile.page, 'mobile');
  await emailFormattingRules(mobile.page, 'mobile');
  await withoutIdentity(mobile.page, 'deals', 'Deal ID,Amount,Pipeline,Details\n00123,500,New,Keep this\n00123,500,New,Keep this\n,,,', 'Details');
  await mobile.assertPrivate();
  await mobile.context.close();
  outcomes.push('Mobile 390px: sample, cleanup, actual download and row editor; page width stays within viewport.');
  outcomes.push('Downloads: UTF-8 BOM bytes verified; accented names and exact CSV content preserved; reopening a downloaded sample retains the original first header.');
  outcomes.push('Download clarity: desktop/mobile top warning, actual filename, browser Downloads guidance, row/column/review counts and pending formatting count include current drafts; replacement files restart formatting preview at change 1.');
  outcomes.push('Email rules: selected email trimming is visibly included and disabled; mapping changes retain prior checked/unchecked trim preferences; only the selected email is normalized in the download.');
  outcomes.push('No email/name: company and deal files open, empty/repeated rows appear in review, edits/exclusion/restore/Undo recalculate findings, and every source cell downloads; legacy #audit link works.');
  outcomes.push('Both sessions: no page errors, external requests, CSV API/processing requests or CSV browser storage; visiting the separate inbound lab permits only its existing empty GET to demo-intake and its own fictional practice storage.');
  console.log(JSON.stringify({ status: 'passed', outcomes, screenshots: output }, null, 2));
} finally {
  await browser.close();
}
