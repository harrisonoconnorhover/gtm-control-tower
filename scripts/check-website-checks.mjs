import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

// Website responses are fixtures. Workspace save/reload reaches the disposable
// local app; checker and API tests exercise actual validation and persistence.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a disposable local app with persistence enabled.');
const key = process.env.CONTROL_TOWER_BROWSER_ACCESS_KEY || 'website-test-key';
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an installed Chrome or Chromium executable.');
const header = 'contact_id,full_name,email,company,region,segment,owner_id,website\n';
const csv = header + [
  ['WEB-1', 'example.com'], ['WEB-2', 'https://example.com/#about'], ['WEB-3', 'js.example'],
  ['WEB-4', 'blocked.example'], ['WEB-5', 'timeout.example'], ['WEB-6', 'skipped.example'],
  ['WEB-7', ''], ['WEB-8', 'ftp://invalid.example'],
].map(([id, website]) => `${id},Person ${id},${id.toLowerCase()}@example.com,Website Company,Northeast,Enterprise,NE-ENT,${website}`).join('\n');
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
await context.addInitScript((accessKey) => sessionStorage.setItem('gtm-control-tower-operator-key', accessKey), key);
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const failures = [], requests = [], saved = new Map();
let failLoad = true, failRecheck = false, firstBatchStarted, releaseFirstBatch;
const firstBatch = new Promise((resolve) => { firstBatchStarted = resolve; });
const firstBatchGate = new Promise((resolve) => { releaseFirstBatch = resolve; });
page.on('pageerror', (error) => failures.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { failures.push(`Blocked external request: ${url.origin}`); return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const endpoint = url.pathname.replace('/api/control-tower/', '');
  if (endpoint === 'workspace') return route.continue();
  if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: true,
    connectors: [{ id: 'csv', label: 'CSV', configured: true, directions: ['source', 'destination'], phases: [] }] } });
  if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from website UI regression.' } });
  try {
    assert.equal(endpoint, 'website-checks', `Unexpected endpoint: ${endpoint}`);
    assert.equal(request.headers()['x-control-tower-key'], key, 'Website requests must use the current operator key');
    if (request.method() === 'GET') {
      if (failLoad) return route.fulfill({ status: 503, json: { error: 'Fixture saved results could not load.' } });
      return route.fulfill({ json: { checks: [...saved.values()] } });
    }
    const body = request.postDataJSON();
    assert(body.workspaceId, 'Checks must reference a saved workspace');
    assert(body.urls.length <= 3 && body.urls.length > 0, 'Requests must be bounded batches');
    assert.equal(body.urls.length, new Set(body.urls).size, 'Websites must be deduplicated');
    assert(!body.urls.includes('https://skipped.example/'), 'Skipped rows must not be checked');
    requests.push(body);
    if (requests.length === 1) { firstBatchStarted(); await firstBatchGate; }
    if (failRecheck) { failRecheck = false; return route.fulfill({ status: 500, json: { error: 'Fixture website result save failed.' } }); }
    const checks = body.urls.map((website) => {
      const browserFallback = website.includes('js.example');
      return { url: website, finalUrl: browserFallback ? `${website}welcome` : website,
        status: website.includes('blocked') ? 'blocked' : website.includes('timeout') ? 'timed_out' : 'reachable',
        method: browserFallback ? 'browser' : 'http', httpStatus: website.includes('blocked') ? 403 : website.includes('timeout') ? null : 200,
        title: browserFallback ? 'JavaScript company page' : 'Company page',
        detail: body.recheck ? 'Fixture recheck saved.' : 'Fixture website observation saved.', checkedAt: '2026-10-16T14:00:00.000Z' };
    });
    for (const check of checks) saved.set(check.url, check);
    return route.fulfill({ json: { checks } });
  } catch (error) {
    failures.push(error.message);
    return route.fulfill({ status: 400, json: { error: error.message } });
  }
});
const panel = page.getByRole('region', { name: 'Company website checks', exact: true });
async function importCsv(content, name) {
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content) });
  await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
  await page.getByText(/SQLite r\d+ · saved/u, { exact: true }).waitFor();
}
try {
  await page.goto(new URL('/app/lab', base).href);
  await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
  await importCsv(csv, 'website-checks.csv');
  await panel.getByRole('alert').filter({ hasText: 'Fixture saved results could not load.' }).waitFor();
  assert(await panel.getByRole('button', { name: 'Check company websites', exact: true }).isDisabled());
  failLoad = false;
  await panel.getByRole('button', { name: 'Reload saved website results', exact: true }).click();
  await panel.getByText('Not checked', { exact: true }).first().waitFor();
  await page.locator('summary').filter({ hasText: /^Choose rows to import ·/u }).click();
  const selection = page.getByRole('region', { name: 'Import row decisions', exact: true });
  await selection.getByLabel('Reason for skipping WEB-6', { exact: true }).fill('Fixture excluded company.');
  await selection.getByRole('button', { name: 'Skip row WEB-6', exact: true }).click();
  await selection.getByText('Skipped: Fixture excluded company.', { exact: true }).waitFor();
  await panel.getByText(/^4 distinct websites · 0 checked/u).waitFor();
  await panel.getByRole('button', { name: 'Check company websites', exact: true }).click();
  await firstBatch;
  await panel.getByRole('button', { name: 'Stop after current batch', exact: true }).click();
  releaseFirstBatch();
  await panel.getByRole('status').filter({ hasText: 'Stopped after 3 of 4 websites.' }).waitFor();
  assert.equal(requests.length, 1, 'Stop must prevent the next batch');
  assert.deepEqual(requests[0].urls, ['https://example.com/', 'https://js.example/', 'https://blocked.example/']);
  const example = panel.getByRole('article', { name: 'Website https://example.com/', exact: true });
  await example.getByText('2 included rows', { exact: true }).waitFor();
  await example.getByText(/HTTP GET · HTTP 200 · Checked/u).waitFor();
  const rendered = panel.getByRole('article', { name: 'Website https://js.example/', exact: true });
  await rendered.getByText('Page title: JavaScript company page', { exact: true }).waitFor();
  await rendered.getByText('Final URL: https://js.example/welcome', { exact: true }).waitFor();
  await rendered.getByText(/Browser fallback · HTTP 200 · Checked/u).waitFor();
  await panel.getByText('Blocked by website', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Check unchecked websites', exact: true }).click();
  await panel.getByRole('status').filter({ hasText: 'Checked and saved 1 of 1 websites.' }).waitFor();
  assert.deepEqual(requests[1].urls, ['https://timeout.example/']);
  await panel.getByText('Timed out', { exact: true }).waitFor();
  failRecheck = true;
  await panel.getByRole('button', { name: 'Recheck all websites', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'Fixture website result save failed.' }).waitFor();
  assert.equal(await panel.getByText('Content retrieved', { exact: true }).count(), 2, 'Save failure must preserve previous observations');
  assert(await panel.getByRole('button', { name: 'Recheck all websites', exact: true }).isDisabled(), 'Reconcile saved results before retrying an uncertain batch');
  await panel.getByRole('button', { name: 'Reload saved website results', exact: true }).click();
  await panel.getByRole('button', { name: 'Recheck all websites', exact: true }).click();
  await panel.getByRole('status').filter({ hasText: 'Checked and saved 4 of 4 websites.' }).waitFor();
  assert(requests.slice(2).every((body) => body.recheck === true));
  await page.reload();
  await panel.getByText(/^4 distinct websites · 4 checked · 2 with content/u).waitFor();
  assert.equal(await panel.getByText('Fixture recheck saved.', { exact: true }).count(), 4, 'Reload must restore saved observations');
  await panel.screenshot({ path: '/tmp/gtm-website-checks-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Website review must fit a mobile viewport');
  await panel.screenshot({ path: '/tmp/gtm-website-checks-mobile.png' });
  await importCsv(header + 'WEB-NEW,New Person,new@example.com,New Company,Northeast,Enterprise,NE-ENT,new.example', 'new-websites.csv');
  await panel.getByText(/^1 distinct websites · 0 checked/u).waitFor();
  await panel.getByText('Not checked', { exact: true }).waitFor();
  assert.equal(await panel.getByText('Fixture recheck saved.', { exact: true }).count(), 0, 'Changed URLs must not inherit previous observations');
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ passed: true, mockedWebsiteBatches: requests.length, externalRequests: 0,
    verified: ['deduplication', 'skip exclusion', 'saved-result reload', 'batch stop and resume', 'browser-fallback details', 'save failure', 'recheck', 'changed URL', 'mobile layout'] }));
} finally {
  releaseFirstBatch();
  await browser.close();
}
