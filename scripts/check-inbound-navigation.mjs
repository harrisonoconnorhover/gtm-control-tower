import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Preserve a failed practice request's pending correction across public views.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:4175');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a local public-site preview.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
const output = resolve('outputs/inbound-navigation');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const errors = [], apiRequests = [];

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', (route) => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET' || url.origin !== base.origin) {
      errors.push(`Unexpected request: ${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname);
    return route.continue();
  });
  return { context, page };
}

try {
  const { context, page } = await newPage();
  await page.goto(new URL('/#clean-csv', base).href);
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#intake-title').count(), 0, 'The cleaner must not initialize the separate inbound lab.');
  assert.deepEqual(await page.evaluate(() => ({ ...localStorage })), {});
  await page.getByRole('link', { name: /Back to overview/ }).click();
  await page.getByRole('link', { name: 'Inbound routing lab', exact: true }).waitFor();
  assert.equal(await page.locator('#intake-title').count(), 0);
  assert.deepEqual(apiRequests, [], 'Neither initial cleaner nor overview should start the inbound connection check.');
  await page.getByRole('link', { name: 'Inbound routing lab', exact: true }).click();
  await page.waitForFunction(() => localStorage.getItem('gtm-inbound-practice-v1') !== null);
  await page.getByLabel('First name', { exact: true }).fill('Probe');
  await page.getByLabel('Last name', { exact: true }).fill('Tester');
  await page.getByLabel('Business email', { exact: true }).fill('route-probe@amberfox.example');
  await page.getByLabel('Company name', { exact: true }).fill('Amber Fox Studio');
  await page.getByLabel(/^CRM response/).selectOption('before-write');
  await page.getByRole('button', { name: 'Submit test request', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'req-033: Simulated CRM outage before the write' }).waitFor();
  await page.getByRole('button', { name: 'Correct source fields', exact: true }).click();
  await page.getByLabel('First name', { exact: true }).fill('Preserved correction');
  await page.getByLabel('Company name', { exact: true }).fill('Edited Amber Fox Studio');
  await page.getByLabel(/^Region/).selectOption('West');
  await page.getByLabel('Monthly media budget ($)', { exact: true }).fill('42000');

  await page.getByRole('link', { name: /GTM Control Tower.*Inbound lab/ }).click();
  await page.getByRole('link', { name: 'Clean your CSV', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'Inbound Routing Lab', exact: true }).count(), 0, 'The retained lab must stay hidden outside its route.');
  await page.getByRole('link', { name: /Back to overview/ }).click();
  await page.getByRole('link', { name: 'Inbound routing lab', exact: true }).click();
  await page.getByRole('heading', { name: 'Correct req-033', exact: true }).waitFor();
  assert.equal(await page.getByLabel('First name', { exact: true }).inputValue(), 'Preserved correction');
  assert.equal(await page.getByLabel('Company name', { exact: true }).inputValue(), 'Edited Amber Fox Studio');
  assert.equal(await page.getByLabel(/^Region/).inputValue(), 'West');
  assert.equal(await page.getByLabel('Monthly media budget ($)', { exact: true }).inputValue(), '42000');
  await page.locator('section[aria-labelledby="intake-title"]').screenshot({ path: resolve(output, 'retained-correction.png') });
  assert.deepEqual(apiRequests, ['/api/control-tower/demo-intake'], 'Returning to the retained lab must not initialize it again.');
  await page.getByRole('button', { name: 'Restore healthy settings', exact: true }).click();
  await page.getByRole('button', { name: 'Save correction & retry', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /req-033: .*handoff is complete/ }).waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export session', exact: true }).click()]);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const session = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const run = session.runs.find((item) => item.id === 'req-033');
  assert.equal(session.runs.length, 33, 'Correction should retry the same request.');
  assert.equal(run.status, 'routed');
  assert.equal(run.input.firstName, 'Preserved correction');
  assert.equal(run.input.company, 'Edited Amber Fox Studio');
  assert.equal(run.context.region, 'West');
  assert.equal(run.context.monthlySpend, 42000);
  assert.equal(run.attempts.length, 2);
  assert.equal(run.attempts[0].payload['wpforms[fields][10]'], 'Probe', 'The original failed attempt should remain intact.');
  assert.equal(session.leads.filter((lead) => lead.email === 'route-probe@amberfox.example').length, 1);
  await context.close();

  const direct = await newPage();
  await direct.page.goto(new URL('/#inbound-lab', base).href);
  await direct.page.getByRole('heading', { name: 'Inbound Routing Lab', exact: true }).waitFor();
  await direct.page.waitForFunction(() => localStorage.getItem('gtm-inbound-practice-v1') !== null);
  assert.equal(await direct.page.evaluate(() => JSON.parse(localStorage.getItem('gtm-inbound-practice-v1')).runs.length), 32, 'A direct first visit should initialize the usual sample session.');
  await direct.page.waitForLoadState('networkidle');
  assert.deepEqual(apiRequests, ['/api/control-tower/demo-intake', '/api/control-tower/demo-intake']);
  assert.deepEqual(errors, []);
  await direct.context.close();
  console.log(JSON.stringify({ status: 'passed', checks: ['No lab initialization before first visit.', 'Failed-request correction and enrichment retained across overview and CSV navigation.', 'Retry uses edited values on the same request and retains the original attempt.', 'Direct inbound entry initializes normally; no writes, external requests or page errors.'], screenshots: output }, null, 2));
} finally {
  await browser.close();
}
