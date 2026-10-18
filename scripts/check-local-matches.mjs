import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Exercise the real UI with intercepted local APIs. No saved workspace, provider,
// CRM or paid check is touched by this fixture.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://localhost:3104');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a local app.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
const output = resolve('outputs/local-match-review'); mkdirSync(output, { recursive: true });
const at = '2026-10-16T14:00:00.000Z', key = 'local-match-ui-fixture-key';
const csv = 'contact_id,full_name,email,company,region,segment,owner_id,website\n'
  + 'LOCAL-1,Alex Example,alex@microsoft.example,Microsfot,Northeast,Enterprise,NE-ENT,https://microsoft.example/\n'
  + 'LOCAL-2,Alex Example,alex.other@microsoft.example,Microsoft,Northeast,Enterprise,NE-ENT,https://microsoft.example/\n';
let workspace = { id: 'local-match-ui-fixture', name: 'Local match UI fixture', revision: 0,
  createdAt: at, updatedAt: at, presets: [], state: { contacts: [], originalContacts: [], repairHistory: [],
    correctionHistory: [], receipts: [], mapping: {}, fileName: null, sourceType: 'csv', destinationType: 'csv' } };
const record = (id, company = 'Microsoft') => ({ id, source: 'import', name: 'Alex Example', email: `${id.toLowerCase()}@microsoft.example`, company, website: 'https://microsoft.example/', phone: '', state: 'NY' });
const findings = [
  { id: 'company', kind: 'company_variant', title: 'Microsfot may be Microsoft', priority: 'high',
    reasons: [{ code: 'company_typo', message: 'The company names differ by a transposed letter.', tone: 'supporting' },
      { code: 'website_agrees', message: 'Both rows use the same company website.', tone: 'supporting' }] },
  { id: 'person', kind: 'possible_duplicate', title: 'Alex Example may appear more than once', priority: 'low',
    reasons: [{ code: 'same_name', message: 'The full names match.', tone: 'supporting' },
      { code: 'different_email', message: 'Email addresses differ. These may be different people.', tone: 'conflict' },
      { code: 'rarity_unavailable', message: 'The sample is too small to estimate name rarity.', tone: 'caution' }] },
  { id: 'suppression', kind: 'possible_suppression', title: 'Microsfot resembles a suppressed company', priority: 'medium',
    reasons: [{ code: 'suppression_similar', message: 'Similar company name to a saved vendor suppression rule.', tone: 'supporting' }] },
].map((finding) => ({ ...finding, key: finding.id, fingerprint: `fingerprint-${finding.id}`, contactId: 'LOCAL-1', score: 0.8,
  input: record('LOCAL-1', 'Microsfot'), candidate: record('LOCAL-2'), decision: null }));
let staleNext = false, failNext = false, preview = false;
let gate = null, releaseGate;
const failures = [], actions = [];
function report(url) {
  const status = url.searchParams.get('status') || 'all', kind = url.searchParams.get('kind') || 'all';
  const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 50);
  const selected = findings.filter((finding) => (status === 'all' || (finding.decision?.status || 'pending') === status) && (kind === 'all' || finding.kind === kind));
  return { ruleVersion: 'fixture-1', workspaceId: workspace.id, workspaceRevision: workspace.revision,
    findings: selected.slice(offset, offset + limit), total: selected.length, offset, limit,
    nextOffset: offset + limit < selected.length ? offset + limit : null,
    warnings: ['Synthetic fixture: names alone are not identity proof.'], coverage: { importRows: 2, crmRecords: 0, suppressionRules: 1, comparedPairs: 3 },
    rarity: { sampleSize: 2, available: false }, snapshots: [], counts: {
      pending: findings.filter((finding) => !finding.decision).length,
      confirmed: findings.filter((finding) => finding.decision?.status === 'confirmed').length,
      dismissed: findings.filter((finding) => finding.decision?.status === 'dismissed').length,
    } };
}
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
await context.addInitScript((accessKey) => sessionStorage.setItem('gtm-control-tower-operator-key', accessKey), key);
const page = await context.newPage(); page.setDefaultTimeout(15_000);
page.on('pageerror', (error) => failures.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { failures.push(`Blocked external request: ${url.origin}`); return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const endpoint = url.pathname.replace('/api/control-tower/', '');
  const body = request.method() === 'POST' ? request.postDataJSON() : null;
  try {
    if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: !preview, accessKeyRequired: true,
      connectors: [{ id: 'csv', label: 'CSV', configured: true, directions: ['source', 'destination'], phases: [] }] } });
    if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from this fixture.' } });
    if (endpoint === 'suppressions') { assert.equal(request.method(), 'GET'); return route.fulfill({ json: { rules: [] } }); }
    if (endpoint === 'workspace') {
      assert(!preview);
      if (body) { assert(['create', 'save'].includes(body.action)); if (body.action === 'save') workspace = { ...workspace, state: body.state, revision: workspace.revision + 1 }; }
      return route.fulfill({ json: { workspace } });
    }
    if (endpoint === 'website-checks') { assert.equal(request.method(), 'GET'); return route.fulfill({ json: { checks: [] } }); }
    if (endpoint === 'pomade-qualification') { assert.equal(request.method(), 'GET'); return route.fulfill({ json: { configured: false, qualification: null } }); }
    assert.equal(endpoint, 'local-matches', `Unexpected API request: ${endpoint}`);
    assert(!preview, 'Local matching must stay hidden in public preview.');
    assert.equal(request.headers()['x-control-tower-key'], key);
    if (body) {
      assert.deepEqual(Object.keys(body).sort(), ['action', 'fingerprint', 'id', 'workspaceId']);
      assert.equal(body.workspaceId, workspace.id);
      actions.push(body.action);
      if (staleNext) { staleNext = false; return route.fulfill({ status: 409, json: { error: 'This suggestion changed. Reload before deciding.' } }); }
      const finding = findings.find((item) => item.id === body.id); assert(finding); assert.equal(body.fingerprint, finding.fingerprint);
      finding.decision = body.action === 'clear' ? null : { status: body.action === 'confirm' ? 'confirmed' : 'dismissed', decidedAt: at };
    } else {
      if (gate) await gate;
      if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { error: 'Fixture local review is unavailable.' } }); }
    }
    return route.fulfill({ json: report(url) });
  } catch (error) { failures.push(error.message); return route.fulfill({ status: 400, json: { error: error.message } }); }
});
const panel = page.getByRole('region', { name: 'Local matching suggestions', exact: true });
const finding = (id) => panel.getByRole('article', { name: `Local suggestion ${id}`, exact: true });
try {
  await page.goto(new URL('/app/lab', base).href);
  await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name: 'local-match-fixture.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
  await panel.getByText('3 pending · 0 confirmed · 0 dismissed', { exact: true }).waitFor();
  await finding('company').getByRole('button', { name: 'Confirm', exact: true }).click();
  await panel.getByText('2 pending · 1 confirmed · 0 dismissed', { exact: true }).waitFor();
  assert.equal(await finding('company').count(), 0, 'Confirmed findings leave the pending filter.');
  await page.reload();
  await panel.getByText('2 pending · 1 confirmed · 0 dismissed', { exact: true }).waitFor();
  await panel.getByLabel('Assessment status', { exact: true }).selectOption('confirmed');
  await finding('company').getByRole('button', { name: 'Undo assessment', exact: true }).click();
  await panel.getByText('3 pending · 0 confirmed · 0 dismissed', { exact: true }).waitFor();
  await panel.getByLabel('Assessment status', { exact: true }).selectOption('pending');
  await finding('person').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await panel.getByText('2 pending · 0 confirmed · 1 dismissed', { exact: true }).waitFor();
  await panel.getByLabel('Assessment status', { exact: true }).selectOption('all');
  await panel.getByLabel('Suggestion type', { exact: true }).selectOption('possible_duplicate');
  await finding('person').waitFor(); assert.equal(await panel.getByRole('article').count(), 1);
  await finding('person').getByRole('button', { name: 'Undo assessment', exact: true }).click();
  await panel.getByText('3 pending · 0 confirmed · 0 dismissed', { exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export this page (JSON)', exact: true }).click();
  const download = await downloadPromise; assert.equal(download.suggestedFilename(), 'local-match-review-page-1.json');
  await download.saveAs(resolve(output, download.suggestedFilename()));
  const exported = JSON.parse(readFileSync(resolve(output, download.suggestedFilename()), 'utf8'));
  assert.equal(exported.scope, 'Current filtered page only'); assert.equal(exported.findings.length, 1);
  staleNext = true;
  await finding('person').getByRole('button', { name: 'Confirm', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'This suggestion changed.' }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Confirm', exact: true }).count(), 0);
  await panel.getByRole('button', { name: 'Reload local suggestions', exact: true }).click();
  await finding('person').waitFor();
  failNext = true;
  await panel.getByRole('button', { name: 'Reload local suggestions', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'Fixture local review is unavailable.' }).waitFor();
  gate = new Promise((resolveGate) => { releaseGate = resolveGate; });
  await panel.getByRole('button', { name: 'Reload local suggestions', exact: true }).click();
  await panel.getByText('Comparing saved evidence locally…', { exact: true }).waitFor();
  assert(await panel.getByRole('button', { name: 'Reload local suggestions', exact: true }).isDisabled());
  releaseGate(); gate = null;
  await finding('person').waitFor();
  await panel.getByLabel('Suggestion type', { exact: true }).selectOption('all');
  await finding('company').waitFor();
  await panel.getByText('Evidence coverage and matching limits', { exact: true }).click();
  await panel.getByText(/There is not enough data to estimate name rarity/u).waitFor();
  await finding('company').getByText('Compare fields and sources', { exact: true }).click();
  await panel.screenshot({ path: resolve(output, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  assert(sizes.content <= sizes.viewport + 1, `Mobile page overflow: ${JSON.stringify(sizes)}`);
  await panel.screenshot({ path: resolve(output, 'mobile.png') });
  findings.push(...Array.from({ length: 52 }, (_, index) => ({ ...findings[1], id: `extra-${index}`, key: `extra-${index}` })));
  await panel.getByRole('button', { name: 'Reload local suggestions', exact: true }).click();
  await panel.getByText('1–50 of 55 suggestions', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Next suggestions', exact: true }).click();
  await panel.getByText('51–55 of 55 suggestions', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Previous suggestions', exact: true }).click();
  await panel.getByText('1–50 of 55 suggestions', { exact: true }).waitFor();
  preview = true;
  await page.reload();
  await page.getByText('Session only', { exact: true }).waitFor();
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name: 'preview-local-match-fixture.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^Choose rows to import ·/u }).waitFor();
  assert.equal(await panel.count(), 0);
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ passed: true, actions, desktop: true, mobile: true, previewHidden: true, paidChecks: 0, crmWrites: 0, output }));
} finally { releaseGate?.(); await browser.close(); }
