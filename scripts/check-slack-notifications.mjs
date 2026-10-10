import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Browser qualification only. Every API is mocked and all external requests
// are blocked, including Slack and both CRM providers.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3197');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a disposable local server.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
const output = resolve('.runtime/slack-ui');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1100 } });
await context.addInitScript(() => sessionStorage.setItem('gtm-control-tower-operator-key', 'fictional-slack-key'));
const page = await context.newPage();
page.setDefaultTimeout(15_000);
await page.clock.install();
const errors = [], actions = [], readKeys = [];
let external = 0, mode = 'unconfigured', expectedKey = 'fictional-slack-key';
const at = '2026-10-10T14:00:00.000Z';
let status = { configured: false, enabled: false, error: null, pending: 0, sending: 0, delivered: 0, failed: 0, unknown: 0, nextAttemptAt: null, lastDelivery: null };
const inbox = { items: [{ id: 'fictional-work', kind: 'import', provider: 'salesforce', title: 'Fictional conference attendees.csv', source: 'CSV upload', status: 'ready', summary: '37 proposed updates and 4 held identities.', assignee: 'RevOps', note: '', accountId: 'fictional-account', updatedAt: at, href: '/app/lab?workspaceId=fictional' }], connections: [], coverage: 'Fictional UI fixture; no live Slack or CRM operations.' };
page.on('pageerror', (error) => errors.push(error.message));

await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { external++; return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  try {
    assert.equal(request.headers()['x-control-tower-key'], expectedKey);
    assert(!url.search.includes(expectedKey), 'Credentials cannot appear in the URL.');
    if (url.pathname === '/api/control-tower/work') { assert.equal(request.method(), 'GET'); return route.fulfill({ json: inbox }); }
    assert.equal(url.pathname, '/api/control-tower/notifications/slack');
    if (request.method() === 'GET') {
      readKeys.push(request.headers()['x-control-tower-key']);
      if (mode === 'unavailable') return route.fulfill({ status: 503, json: { error: 'Fictional Slack status is temporarily unavailable.' } });
      return route.fulfill({ json: { slack: status } });
    }
    const body = request.postDataJSON();
    assert.deepEqual(Object.keys(body), ['action'], 'The browser cannot choose a message, webhook, or channel.');
    assert(['test', 'deliver'].includes(body.action));
    actions.push(body.action);
    if (mode === 'rate_limited') {
      status = { ...status, pending: 1, nextAttemptAt: '2099-01-01T00:00:00.000Z', lastDelivery: { state: 'rate_limited', eventCount: 1, startedAt: at, finishedAt: at, error: 'Slack returned HTTP 429.' } };
    } else if (mode === 'unknown') {
      status = { ...status, pending: 0, unknown: 1, nextAttemptAt: null, lastDelivery: { state: 'unknown', eventCount: 1, startedAt: at, finishedAt: at, error: 'The delivery response was interrupted.' } };
    } else if (mode === 'failed') {
      status = { ...status, pending: 0, failed: 1, nextAttemptAt: null, lastDelivery: { state: 'failed', eventCount: 1, startedAt: at, finishedAt: at, error: 'Slack rejected the webhook.' } };
    } else {
      status = { ...status, pending: 0, delivered: status.delivered + 1, nextAttemptAt: null, lastDelivery: { state: 'delivered', eventCount: 1, startedAt: at, finishedAt: at, error: null } };
    }
    return route.fulfill({ json: { slack: status, outcome: mode === 'ready' ? 'delivered' : mode } });
  } catch (error) { errors.push(error.message); return route.fulfill({ status: 400, json: { error: error.message } }); }
});

function response(method = 'GET') { return page.waitForResponse((result) => new URL(result.url()).pathname === '/api/control-tower/notifications/slack' && result.request().method() === method); }
async function poll() { await Promise.all([response(), page.clock.fastForward(31_000)]); }
const card = page.getByRole('region', { name: 'Slack notifications', exact: true });
try {
  await page.goto(new URL('/app/work', base).href);
  await card.getByText('Not connected', { exact: true }).waitFor();
  assert(await card.getByRole('button', { name: 'Send test message', exact: true }).isDisabled());
  assert(await card.getByRole('button', { name: 'Send queued', exact: true }).isDisabled());
  assert.deepEqual(actions, [], 'Opening the inbox cannot send a message.');
  await card.getByText('Connect your operations channel', { exact: true }).click();
  await card.getByText('CONTROL_TOWER_SLACK_WEBHOOK_URL', { exact: true }).waitFor();

  mode = 'ready'; status = { ...status, configured: true, enabled: true, pending: 3 };
  await poll();
  await card.getByText('Notifications enabled', { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Send test message', exact: true }).click();
  await card.getByRole('status').filter({ hasText: 'Slack confirmed the test message was sent.' }).waitFor();

  mode = 'rate_limited';
  await card.getByRole('button', { name: 'Send test message', exact: true }).click();
  await card.getByRole('status').filter({ hasText: 'message remains queued' }).waitFor();
  await card.getByText(/Next delivery can run after/).waitFor();
  assert.equal(await card.getByText('Slack confirmed the test message was sent.', { exact: true }).count(), 0, 'A prior success must not label a rate-limited test sent.');
  const actionsAfterRateLimit = actions.length;
  await poll(); assert.equal(actions.length, actionsAfterRateLimit, 'The UI poll cannot resend messages.');

  mode = 'unknown';
  await card.getByRole('button', { name: 'Send queued', exact: true }).click();
  await card.getByRole('status').filter({ hasText: 'Delivery is unconfirmed.' }).waitFor();
  await card.getByText(/unconfirmed deliveries are not automatically resent/).waitFor();
  assert(await card.getByRole('button', { name: 'Send queued', exact: true }).isDisabled());

  mode = 'failed';
  await card.getByRole('button', { name: 'Send test message', exact: true }).click();
  await card.getByRole('status').filter({ hasText: 'Slack did not accept this delivery.' }).waitFor();

  mode = 'unavailable'; await poll();
  await card.getByRole('alert').filter({ hasText: 'temporarily unavailable' }).waitFor();
  await page.getByRole('heading', { name: 'Fictional conference attendees.csv', exact: true }).waitFor();

  mode = 'ready';
  await page.getByLabel('Operator access key', { exact: true }).fill('fictional-replacement-key');
  const draftReads = readKeys.length;
  await poll();
  assert.equal(readKeys.at(-1), 'fictional-slack-key', 'Draft keys must not affect an active session.');
  assert(readKeys.length > draftReads);
  expectedKey = 'fictional-replacement-key';
  await Promise.all([response(), page.getByRole('button', { name: 'Load inbox', exact: true }).click()]);
  await card.getByText('Notifications enabled', { exact: true }).waitFor();
  assert.equal(readKeys.at(-1), expectedKey);
  assert.equal(await card.getByRole('alert').count(), 0, 'The new session must not inherit a stale request error.');

  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.runFor(250);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'mobile.png') });
  assert.deepEqual(errors, []); assert.equal(external, 0); assert.deepEqual(actions, ['test', 'test', 'deliver', 'test']);
  console.log(JSON.stringify({ passed: true, viewports: ['desktop', 'mobile'], states: ['unconfigured', 'delivered', 'rate_limited', 'unknown', 'failed', 'unavailable', 'changed-key'], fictionalActions: actions, externalRequests: external, output }));
} finally { await browser.close(); }
