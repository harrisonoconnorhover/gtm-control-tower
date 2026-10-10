import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3197');
assert(['localhost', '127.0.0.1'].includes(base.hostname), 'Use a disposable local server.');
const output = resolve('.runtime/operations-inbox-ui');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1100 } });
await context.addInitScript(() => sessionStorage.setItem('gtm-control-tower-operator-key', 'fictional-key'));
const page = await context.newPage();
const errors = []; const actions = []; let external = 0;
page.on('pageerror', (error) => errors.push(error.message));
const common = { updatedAt: new Date().toISOString(), assignee: 'RevOps', note: '', accountId: 'fictional-account' };
const inbox = { items: [
  { ...common, id: 'import-1', kind: 'import', provider: 'salesforce', title: 'Conference attendees.csv', source: 'CSV upload', status: 'ready', summary: '37 proposed · 4 held · 0 unmatched · 0 unresolved', counts: { 'proposed-update': 37, held: 4, unmatched: 0, unresolved: 0, skipped: 1, unchanged: 3 }, href: '/app/lab?workspaceId=fixture&reviewId=saved-review' },
  { ...common, id: 'hs-finding', kind: 'finding', provider: 'hubspot', title: 'This contact has no email.', source: 'Contact · Fictional person', status: 'needs_review', summary: 'Confirm the address with the owner.', href: '/app/watchdog?provider=hubspot&finding=missing-email' },
  { ...common, id: 'sf-finding', kind: 'finding', provider: 'salesforce', title: 'Contact title repair needs verification.', source: 'Contact · Fictional contact', status: 'reconcile', summary: 'The response was interrupted. Check the outcome.', href: '/app/watchdog?provider=salesforce&finding=uncertain' },
  { ...common, id: 'done', kind: 'finding', provider: 'hubspot', title: 'Whitespace repaired and verified.', source: 'Contact · Fictional record', status: 'completed', summary: 'Readback matched.', href: '/app/watchdog?provider=hubspot&finding=done' },
], connections: [{ provider: 'hubspot', accountId: 'fictional-hs' }, { provider: 'salesforce', accountId: 'fictional-sf' }], coverage: 'Fictional UI fixture; no live CRM records or changes.' };
await context.route('**/*', async (route) => {
  const request = route.request(); const url = new URL(request.url());
  if (url.origin !== base.origin) { external++; return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  if (url.pathname === '/api/control-tower/notifications/slack' && request.method() === 'GET') return route.fulfill({ json: { slack: { configured: false, enabled: false, error: null, pending: 0, sending: 0, delivered: 0, failed: 0, unknown: 0, nextAttemptAt: null, lastDelivery: null } } });
  assert.equal(url.pathname, '/api/control-tower/work');
  assert.equal(request.headers()['x-control-tower-key'], 'fictional-key');
  if (request.method() === 'GET') return route.fulfill({ json: inbox });
  const body = request.postDataJSON(); actions.push(body.action);
  if (body.action === 'assign') { inbox.items[0].assignee = body.assignee; inbox.items[0].note = body.note; return route.fulfill({ json: { saved: true } }); }
  assert.equal(body.action, 'receive'); assert.equal(body.provider, 'salesforce'); assert(body.csv.includes('person@example.com'));
  return route.fulfill({ json: { id: 'received', workspaceId: 'new-workspace' } });
});
try {
  await page.goto(new URL('/app/work', base).href);
  await page.getByRole('heading', { name: 'Conference attendees.csv' }).waitFor();
  assert.equal(await page.locator('article').count(), 3);
  assert.equal(await page.getByRole('link', { name: 'Open review workspace' }).getAttribute('href'), '/app/lab?workspaceId=fixture&reviewId=saved-review');
  await page.getByLabel('Show CRM').selectOption('salesforce'); assert.equal(await page.locator('article').count(), 2);
  await page.getByText('Assignment and notes', { exact: true }).click();
  await page.getByLabel('Assignee', { exact: true }).fill('Harrison'); await page.getByLabel('Note', { exact: true }).fill('Verify four held identities.');
  await page.getByRole('button', { name: 'Save assignment' }).click(); await page.getByRole('status').filter({ hasText: 'Assignment saved' }).waitFor();
  await page.getByLabel('Destination').selectOption('salesforce');
  await page.getByLabel('CSV file').setInputFiles({ name: 'incoming.csv', mimeType: 'text/csv', buffer: Buffer.from('Email\nperson@example.com\n') });
  await page.getByRole('button', { name: 'Add to inbox' }).click();
  await page.getByRole('link', { name: 'Open saved workspace' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open saved workspace' }).getAttribute('href'), '/app/lab?workspaceId=new-workspace');
  await page.getByLabel('Show CRM').selectOption('all'); await page.getByLabel('Include completed').check(); assert.equal(await page.locator('article').count(), 4);
  await page.screenshot({ path: resolve(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: resolve(output, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.equal(external, 0); assert.deepEqual(actions, ['assign', 'receive']);
  console.log(JSON.stringify({ passed: true, viewports: ['desktop', 'mobile'], fictionalActions: actions, externalRequests: external, output }));
} finally { await browser.close(); }
