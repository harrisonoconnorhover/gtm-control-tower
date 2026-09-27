import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a local disposable app with persistence enabled.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an installed Chromium or Chrome executable.');
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const failures = [], calls = [];
let expectedKey = '';
const storageKey = 'gtm-control-tower-operator-key';
const csv = 'contact_id,full_name,email,company,region,segment,owner_id\nKEY-001,Avery Example,avery@example.com,Example Co,Northeast,Enterprise,NE-ENT';
const at = new Date().toISOString();
const scan = { id: 'key-regression', status: 'complete', complete: true, cursor: null,
  recordsScanned: 1, pagesScanned: 1, sourceComplete: true, analysisWarnings: [], startedAt: at, completedAt: at };
page.on('pageerror', (error) => failures.push(error.message));
// Only workspace CRUD and local assets reach the app. Every private API is mocked or blocked.
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { failures.push(`Blocked external request: ${url.origin}`); return route.abort(); }
  const endpoint = url.pathname.replace('/api/control-tower/', '');
  if (!url.pathname.startsWith('/api/') || endpoint === 'workspace') return route.continue();
  if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: true,
    connectors: ['csv', 'hubspot', 'salesforce'].map((id) => ({ id, label: id, configured: true,
      directions: ['source', 'destination'], phases: [], mode: 'direct', features: ['safe-writeback', 'account-scan'] })) } });
  if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from browser regression.' } });
  try {
    assert(['duplicate-scan', 'import-matches', 'crm-writeback', 'crm-source'].includes(endpoint), `Unhandled private endpoint: ${endpoint}`);
    assert.equal(request.headers()['x-control-tower-key'] || '', expectedKey, `${endpoint} must use the current operator key`);
    const body = request.method() === 'POST' ? request.postDataJSON() : {};
    calls.push({ endpoint, method: request.method(), key: expectedKey });
    if (endpoint === 'duplicate-scan') {
      assert(request.method() === 'GET' || ['start', 'restart', 'step'].includes(body.action));
      return route.fulfill({ json: { scan: { ...scan, connectorId: body.connectorId || url.searchParams.get('connectorId') } } });
    }
    if (endpoint === 'import-matches') return route.fulfill({ json: { scan, report: {
      ruleVersion: 'test', fields: body.fields, warnings: [], rows: body.contacts.map((input) => ({
        contactId: input.contactId, input, candidates: [], candidateCount: 0, warnings: [],
      })),
    } } });
    if (endpoint === 'crm-source') return route.fulfill({ json: { csv, contacts: [{}], sourceLabel: 'fictional contacts', readAt: at, truncated: false } });
    assert.equal(body.action, 'preview', 'Write execution is forbidden in this regression');
    return route.fulfill({ status: 409, json: { error: 'Regression preview stub received the operator key.' } });
  } catch (error) {
    failures.push(error.message);
    return route.fulfill({ status: 403, json: { error: error.message } });
  }
});
async function checkKey(value) {
  assert.deepEqual(await page.locator('input[type=password]').evaluateAll((inputs) => inputs.map((input) => input.value)), [value, value]);
  assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), value || null);
}
async function clickRequest(endpoint, button) {
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/control-tower/${endpoint}` && response.request().method() === 'POST');
  await button.click();
  await response;
  assert.deepEqual(failures, []);
}
try {
  await page.goto(new URL('/app/lab', base).href);
  await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
  await page.locator('input[type=file]').setInputFiles({ name: 'operator-key-regression.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
  await page.getByText('SQLite r1 · saved', { exact: true }).waitFor();
  const top = page.getByLabel('Operator access key', { exact: true });
  const destination = page.getByLabel('Access key · if configured', { exact: true });
  const panel = page.getByRole('region', { name: 'Approximate CRM matches' });
  for (const provider of ['hubspot', 'salesforce']) {
    expectedKey = `test-${provider}-top`;
    await top.fill(expectedKey);
    await page.getByLabel('Where should clean records go?').selectOption(provider);
    await panel.getByText('1 records · 1 pages · Provider pagination complete', { exact: true }).waitFor();
    await checkKey(expectedKey);
    await clickRequest('duplicate-scan', panel.getByRole('button', { name: 'Read fresh snapshot', exact: true }));
    await clickRequest('import-matches', panel.getByRole('button', { name: 'Find suggestions for these rows', exact: true }));
    await panel.getByRole('status').filter({ hasText: 'Review ready for 1 imported records.' }).waitFor();
    await clickRequest('crm-writeback', page.getByRole('button', { name: 'Compare 1 with CRM', exact: true }));
    expectedKey = `test-${provider}-destination`;
    await destination.fill(expectedKey);
    await checkKey(expectedKey);
    await page.getByLabel('Where is your data?').selectOption(provider);
    await clickRequest('crm-source', page.getByRole('button', { name: `Read from ${provider === 'hubspot' ? 'HubSpot' : 'Salesforce'}`, exact: true }));
    await page.reload();
    await destination.waitFor();
    await checkKey(expectedKey);
    expectedKey = '';
    await destination.fill('');
    await checkKey('');
    await clickRequest('crm-source', page.getByRole('button', { name: `Read from ${provider === 'hubspot' ? 'HubSpot' : 'Salesforce'}`, exact: true }));
    await page.reload();
    await destination.waitFor();
    await checkKey('');
  }
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ passed: true, providers: ['hubspot', 'salesforce'], mockedPrivateRequests: calls.length, liveCrmRequests: 0 }));
} finally {
  await browser.close();
}
