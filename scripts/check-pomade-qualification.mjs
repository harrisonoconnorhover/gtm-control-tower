import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Exercise the real app UI with an entirely in-memory workspace and API fixtures.
// Every API request is intercepted; no provider, CRM or saved workspace is touched.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a local app.');
const key = 'qualification-ui-fixture-key';
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
const output = resolve('outputs/qualification-handoff');
mkdirSync(output, { recursive: true });
const criteria = 'Companies selling CRM or revenue-operations software; exclude nonprofits.';
const at = '2026-10-16T14:00:00.000Z';
const header = 'contact_id,full_name,email,company,region,segment,owner_id,website\n';
const csv = header + [
  'QUAL-1,Alex Example,alex@crm.example,Fixture CRM,Northeast,Enterprise,NE-ENT,https://crm.example/',
  'QUAL-2,Sam Example,sam@other.example,Wrong Company,Northeast,Enterprise,NE-ENT,https://other.example/',
  'QUAL-3,Pat Example,pat@nonprofit.example,Fixture Nonprofit,Northeast,Enterprise,NE-ENT,https://nonprofit.example/',
].join('\n');
let workspace = { id: 'qualification-ui-fixture', name: 'Qualification UI fixture', revision: 0,
  createdAt: at, updatedAt: at, presets: [], state: { contacts: [], originalContacts: [], repairHistory: [],
    correctionHistory: [], receipts: [], mapping: {}, fileName: null, sourceType: 'csv', destinationType: 'csv' } };
let qualification = null, missingProvider = true, preview = false;
let invalidRunPreview = false, runOutcome = 'hold', loseStart = false;
let failWebsiteLoad = false, websiteGate = null, releaseWebsiteLoad;
const starts = [];
const requests = [], failures = [];
const check = (assessment = null, explanation = 'Run this check in Pomade, then refresh saved results.') => ({
  state: assessment ? assessment === 'Review' ? 'review' : 'complete' : 'not_run', assessment, explanation,
  sources: assessment ? [{ url: 'https://crm.example/about', title: 'Fixture company evidence', excerpt: 'A synthetic CRM product description.' }] : [],
  checkedAt: assessment ? at : null, provider: assessment ? 'Fixture provider' : null, receiptId: assessment ? 'fixture-receipt' : null,
});
function completeResults() {
  qualification = { ...qualification, refreshedAt: at, rows: qualification.rows.map((row, index) => ({ ...row,
    identity: check(['Match', 'Mismatch', 'Match'][index], 'Saved company identity evidence.'),
    icp: check(['Fit', 'Review', 'Not a fit'][index], 'Saved assessment against the explicit demo criteria.'),
    email: { ...check(['valid', 'invalid', 'Review'][index], 'Saved email-provider observation; no message was sent.'), sources: [] },
  })) };
}
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
await context.addInitScript((accessKey) => sessionStorage.setItem('gtm-control-tower-operator-key', accessKey), key);
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on('pageerror', (error) => failures.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { failures.push(`Blocked external request: ${url.origin}`); return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const endpoint = url.pathname.replace('/api/control-tower/', '');
  const body = request.method() === 'POST' ? request.postDataJSON() : null;
  requests.push({ endpoint, method: request.method(), body });
  try {
    if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: !preview, accessKeyRequired: true,
      connectors: [{ id: 'csv', label: 'CSV', configured: true, directions: ['source', 'destination'], phases: [] }] } });
    if (endpoint === 'suppressions') {
      assert.equal(request.method(), 'GET', 'Qualification fixture must not edit suppressions.');
      return route.fulfill({ json: { rules: [] } });
    }
    if (endpoint === 'local-matches') {
      assert.equal(request.method(), 'GET', 'Qualification fixture must not save matching decisions.');
      return route.fulfill({ json: { workspaceId: workspace.id, workspaceRevision: workspace.revision,
        ruleVersion: 'local-match-fixture', findings: [], warnings: [], snapshots: [],
        coverage: { importRows: workspace.state.contacts.length, crmRecords: 0, suppressionRules: 0, comparedPairs: 0 },
        rarity: { sampleSize: workspace.state.contacts.length, available: false }, counts: { pending: 0, confirmed: 0, dismissed: 0 },
        total: 0, offset: 0, limit: 50, nextOffset: null } });
    }
    if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from this UI regression.' } });
    if (endpoint === 'workspace') {
      assert(!preview, 'Preview must not persist a workspace.');
      if (body) {
        assert(['create', 'save'].includes(body.action), 'Unexpected workspace action.');
        if (body.action === 'save') workspace = { ...workspace, state: body.state, revision: workspace.revision + 1 };
      }
      return route.fulfill({ json: { workspace } });
    }
    if (endpoint === 'website-checks') {
      if (websiteGate) await websiteGate;
      if (failWebsiteLoad) return route.fulfill({ status: 503, json: { error: 'Fixture website results unavailable.' } });
      const websites = ['https://crm.example/', 'https://other.example/', 'https://nonprofit.example/'];
      if (body) assert(body.urls.every((url) => websites.includes(url)), 'Only synthetic website checks are allowed.');
      return route.fulfill({ json: { checks: websites.map((url) => ({ url, finalUrl: url, status: 'reachable', method: 'http',
        httpStatus: 200, title: 'Fixture website', detail: 'Synthetic saved observation.', checkedAt: at })) } });
    }
    assert.equal(endpoint, 'pomade-qualification', `Unexpected API request: ${endpoint}`);
    assert(!preview, 'Preview must not request Pomade qualification.');
    assert.equal(request.headers()['x-control-tower-key'], key);
    if (body) {
      assert.equal(body.workspaceId, workspace.id);
      if (body.action === 'send') {
        assert.deepEqual(body, { action: 'send', workspaceId: workspace.id, icpCriteria: criteria }, 'Send only the saved workspace and explicit ICP criteria.');
        if (missingProvider) return route.fulfill({ status: 503, json: { error: 'Fixture: connect the Hunter email provider in Pomade, then retry.' } });
        qualification = { qualificationId: 'fixture-qualification', requestDigest: 'fixture-digest', tableId: 'fixture-table',
          tableUrl: 'http://localhost:8798/?table=fixture-table', sourceRevision: workspace.revision, icpCriteria: body.icpCriteria,
          sentAt: at, refreshedAt: null, stale: false, rows: workspace.state.contacts.map((row) => ({ sourceRowId: row.contactId,
            pomadeRowId: `pomade-${row.contactId}`, inputs: { company: row.company, website: row.website, email: row.normalizedEmail || row.rawEmail },
            identity: check(), icp: check(), email: check() })) };
      } else if (body.action === 'preview') {
        assert(body.sourceRowIds.length && body.checks.length);
        assert.equal(body.confirmExternalRequests, undefined, 'Preview must not approve provider requests.');
        const maximumSubmissions = body.sourceRowIds.length * body.checks.length;
        const runPreview = { qualificationId: qualification.qualificationId, previewHash: 'fixture-preview-hash',
          sourceRowIds: body.sourceRowIds, checks: body.checks, rowCount: body.sourceRowIds.length,
          maximumSubmissions, backgroundAllowed: !invalidRunPreview,
          backgroundIssue: invalidRunPreview ? 'Fixture submission limit exceeded. Choose fewer rows and preview again.' : '',
          warnings: ['Existing provider credits may be used.'], entries: body.sourceRowIds.flatMap((rowId) => body.checks.map((kind) => ({
            rowId, rowLabel: rowId, columnId: kind, columnLabel: kind, state: 'ready', details: ['Inputs are ready.'],
            steps: [kind === 'email' ? 'Hunter' : 'Codex research'], maximum: 1,
          }))) };
        return route.fulfill({ json: { configured: true, qualification, preview: runPreview } });
      } else if (body.action === 'start') {
        assert.equal(body.confirmExternalRequests, true);
        assert.equal(body.previewHash, 'fixture-preview-hash');
        assert.match(body.requestId, /^[0-9a-f-]{36}$/u);
        starts.push(body);
        const status = loseStart ? 'unknown' : 'queued';
        qualification.execution = { requestId: body.requestId, previewHash: body.previewHash, sourceRowIds: body.sourceRowIds, checks: body.checks,
          requestedAt: at, updatedAt: at, status, error: null, job: status === 'unknown' ? null : { id: body.requestId, status,
            cursor: 0, totalRows: body.sourceRowIds.length, completedCount: 0, skippedCount: 0, error: null, waitingMessage: null } };
        if (loseStart) { loseStart = false; return route.abort(); }
      } else if (body.action === 'status' || body.action === 'cancel') {
        assert.deepEqual(body, { action: body.action, workspaceId: workspace.id }, 'Status and cancellation use only the saved job.');
        const execution = qualification.execution;
        if (body.action === 'cancel') {
          execution.status = 'cancelled';
          if (execution.job) execution.job.status = 'cancelled';
        } else if (execution.status !== 'unknown' && ['queued', 'running'].includes(execution.status) && runOutcome !== 'hold') {
          execution.status = runOutcome;
          execution.job.status = runOutcome;
          if (runOutcome === 'completed') {
            execution.job.cursor = execution.job.totalRows;
            execution.job.completedCount = execution.job.totalRows * execution.checks.length;
            completeResults();
          } else if (runOutcome === 'failed') execution.job.error = 'Fixture provider failure. Check saved results before another run.';
        }
      } else {
        assert.deepEqual(body, { action: 'refresh', workspaceId: workspace.id }, 'Refresh must not authorize or trigger provider runs.');
        assert(qualification);
        completeResults();
      }
    }
    return route.fulfill({ json: { configured: true, qualification } });
  } catch (error) {
    failures.push(error.message);
    return route.fulfill({ status: 400, json: { error: error.message } });
  }
});
const panel = page.getByRole('region', { name: 'Pomade qualification', exact: true });
const runner = panel.getByRole('region', { name: 'Run Pomade checks', exact: true });
const readiness = panel.getByRole('region', { name: 'Import readiness', exact: true });
const runPreview = runner.getByRole('region', { name: 'Pomade run preview', exact: true });
const consent = () => runner.getByLabel('I approve these provider requests and any credits they use.', { exact: true });
async function previewAndApprove() {
  await runner.getByRole('button', { name: 'Preview checks', exact: true }).click();
  await consent().check();
}
async function importCsv(content, name, persisted = true) {
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content) });
  await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
  if (persisted) await page.getByText(/SQLite r\d+ · saved/u, { exact: true }).waitFor();
}
async function assertCurrent() {
  for (const label of ['Match', 'Mismatch', 'Fit', 'Review', 'Not a fit', 'valid', 'invalid']) {
    await panel.getByText(label, { exact: true }).first().waitFor();
  }
  assert.equal(await panel.getByText('Stale result', { exact: true }).count(), 0);
}
async function assertStale() {
  await panel.getByRole('status').filter({ hasText: 'The included rows or ICP criteria have changed.' }).waitFor();
  assert.equal(await panel.getByText('Stale result', { exact: true }).count(), 9);
  for (const label of ['Match', 'Fit', 'valid']) assert.equal(await panel.getByText(label, { exact: true }).count(), 0);
  assert(await panel.getByRole('button', { name: 'Refresh Pomade results', exact: true }).isDisabled());
  await panel.getByRole('button', { name: 'Send updated list to Pomade', exact: true }).waitFor();
  await readiness.getByText('0 ready to import · 3 need review · 0 excluded', { exact: true }).waitFor();
}
try {
  await page.goto(new URL('/app/lab', base).href);
  await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
  await importCsv(csv, 'qualification-fixture.csv');
  await panel.getByText('3 included rows · 0 missing a company, website, or email. Skipped, suppressed and merged rows are excluded.', { exact: true }).waitFor();
  await readiness.getByText('0 ready to import · 3 need review · 0 excluded', { exact: true }).waitFor();
  await readiness.getByText('Company identity, ICP fit and email verification have not been checked with Pomade.', { exact: true }).first().waitFor();
  assert(await panel.getByRole('button', { name: 'Send to Pomade', exact: true }).isDisabled(), 'Require explicit ICP criteria.');
  await panel.getByLabel('ICP criteria', { exact: true }).fill(`  ${criteria}  `);
  await panel.getByRole('button', { name: 'Send to Pomade', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'connect the Hunter email provider' }).waitFor();
  assert.equal(qualification, null, 'Missing provider must not fabricate a saved table.');
  missingProvider = false;
  await panel.getByRole('button', { name: 'Reload saved qualification', exact: true }).click();
  await panel.getByRole('alert').waitFor({ state: 'hidden' });
  await panel.getByLabel('ICP criteria', { exact: true }).fill(criteria);
  await panel.getByRole('button', { name: 'Send to Pomade', exact: true }).click();
  await panel.getByText('Results have not been refreshed yet', { exact: false }).waitFor();
  assert.equal(await panel.getByText('Not checked', { exact: true }).count(), 9);
  assert.equal(await panel.getByRole('link', { name: 'Open in Pomade', exact: true }).getAttribute('href'), qualification.tableUrl);
  await runner.getByRole('button', { name: 'Preview checks', exact: true }).click();
  await runPreview.getByText('3 selected rows · up to 9 provider submissions', { exact: true }).waitFor();
  assert(await runner.getByRole('button', { name: 'Run checks', exact: true }).isDisabled(), 'Require explicit provider-credit approval.');
  await consent().check();
  await runner.getByLabel('ICP fit', { exact: true }).uncheck();
  assert.equal(await runPreview.count(), 0, 'Changing checks must discard the approved preview.');
  await runner.getByLabel('ICP fit', { exact: true }).check();
  invalidRunPreview = true;
  await runner.getByRole('button', { name: 'Preview checks', exact: true }).click();
  await runPreview.getByRole('alert').filter({ hasText: 'submission limit exceeded' }).waitFor();
  assert(await consent().isDisabled());
  invalidRunPreview = false;
  await runner.locator('summary').filter({ hasText: /^Choose rows ·/u }).click();
  await runner.getByRole('button', { name: 'Select first 16 rows', exact: true }).click();
  assert.equal(await runPreview.count(), 0, 'Reselecting rows must discard the invalid preview.');
  await previewAndApprove();
  await runner.getByRole('button', { name: 'Run checks', exact: true }).click();
  await runner.getByText('Run queued', { exact: true }).waitFor();
  assert.equal(starts.length, 1);
  await page.reload();
  await runner.getByText('Run queued', { exact: true }).waitFor();
  assert.equal(starts.length, 1, 'Reload must resume status polling without starting another job.');
  runOutcome = 'completed';
  await runner.getByText('Run completed', { exact: true }).waitFor();
  await assertCurrent();
  await readiness.getByText('1 ready to import · 2 need review · 0 excluded', { exact: true }).waitFor();
  await readiness.getByLabel('Filter readiness', { exact: true }).selectOption('ready');
  assert.equal(await readiness.locator('tbody tr').count(), 1);
  await readiness.getByRole('cell', { name: 'Ready to import', exact: true }).waitFor();
  await readiness.getByLabel('Filter readiness', { exact: true }).selectOption('needs_review');
  assert.equal(await readiness.locator('tbody tr').count(), 2);
  await readiness.getByText(/Company identity does not match the intended company/u).waitFor();
  await readiness.getByText(/The company does not meet the selected ICP/u).waitFor();
  await readiness.getByLabel('Filter readiness', { exact: true }).selectOption('all');
  assert.equal(requests.filter((request) => request.body?.action === 'refresh').length, 0, 'Status must return results automatically.');
  const evidence = panel.locator('tbody details').first();
  await evidence.locator('summary').click();
  await evidence.getByText('Saved company identity evidence.', { exact: true }).waitFor();
  await evidence.getByText(/Checked .+ · Fixture provider/u).waitFor();
  assert.equal(await evidence.getByRole('link', { name: 'Fixture company evidence', exact: true }).getAttribute('href'), 'https://crm.example/about');
  await panel.screenshot({ path: resolve(output, 'qualification-review-desktop.png') });
  await page.reload();
  await assertCurrent();
  assert.equal(starts.length, 1, 'Completed runs must not restart on reload.');
  runOutcome = 'hold';
  await previewAndApprove();
  await runner.getByRole('button', { name: 'Run checks', exact: true }).click();
  await runner.getByText('Run queued', { exact: true }).waitFor();
  await runner.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await runner.getByText('Run cancelled', { exact: true }).waitFor();
  runOutcome = 'failed';
  await previewAndApprove();
  await runner.getByRole('button', { name: 'Run checks', exact: true }).click();
  await runner.getByText('Run failed', { exact: true }).waitFor();
  await runner.getByText('Fixture provider failure. Check saved results before another run.', { exact: true }).waitFor();
  assert.equal(starts.length, 3, 'Failure must not start a retry.');
  loseStart = true;
  await previewAndApprove();
  await runner.getByRole('button', { name: 'Run checks', exact: true }).click();
  await runner.getByRole('alert').filter({ hasText: 'start response was not confirmed' }).waitFor();
  assert(await panel.getByRole('button', { name: 'Send to Pomade', exact: true }).isDisabled(), 'Reconcile an uncertain start before replacing its source list.');
  await readiness.getByText('0 ready to import · 3 need review · 0 excluded', { exact: true }).waitFor();
  const uncertainId = starts.at(-1).requestId;
  await page.reload();
  await runner.getByRole('button', { name: 'Retry same request', exact: true }).waitFor();
  assert.equal(starts.length, 4, 'Uncertain starts must not retry automatically after reload.');
  await runner.getByRole('button', { name: 'Check run status', exact: true }).click();
  await runner.getByText('Run unknown', { exact: true }).waitFor();
  runOutcome = 'completed';
  await runner.getByRole('button', { name: 'Retry same request', exact: true }).click();
  await runner.getByText('Run completed', { exact: true }).waitFor();
  assert.equal(starts.length, 5);
  assert.equal(starts.at(-1).requestId, uncertainId, 'Retry must use the original request ID.');
  assert.equal(new Set(starts.map((entry) => entry.requestId)).size, 4);
  await readiness.getByText('1 ready to import · 2 need review · 0 excluded', { exact: true }).waitFor();
  const websites = page.getByRole('region', { name: 'Company website checks', exact: true });
  failWebsiteLoad = true;
  await websites.getByRole('button', { name: 'Recheck all websites', exact: true }).click();
  await websites.getByRole('alert').filter({ hasText: 'Fixture website results unavailable.' }).waitFor();
  await readiness.getByText('0 ready to import · 3 need review · 0 excluded', { exact: true }).waitFor();
  await readiness.getByText('Website results could not be loaded.', { exact: true }).first().waitFor();
  failWebsiteLoad = false;
  websiteGate = new Promise((resolve) => { releaseWebsiteLoad = resolve; });
  await websites.getByRole('button', { name: 'Reload saved website results', exact: true }).click();
  await readiness.getByText('Website results are still loading.', { exact: true }).first().waitFor();
  assert.equal(await readiness.getByRole('cell', { name: 'Ready to import', exact: true }).count(), 0);
  releaseWebsiteLoad();
  websiteGate = null;
  await readiness.getByText('1 ready to import · 2 need review · 0 excluded', { exact: true }).waitFor();
  await page.locator('summary').filter({ hasText: /^Choose rows to import ·/u }).click();
  const decisions = page.getByRole('region', { name: 'Import row decisions', exact: true });
  await decisions.getByLabel('Reason for skipping QUAL-3', { exact: true }).fill('Not for this campaign.');
  await decisions.getByRole('button', { name: 'Skip row QUAL-3', exact: true }).click();
  await readiness.getByText('0 ready to import · 2 need review · 1 excluded', { exact: true }).waitFor();
  await readiness.getByLabel('Filter readiness', { exact: true }).selectOption('excluded');
  await readiness.getByText('Excluded from import: Not for this campaign.', { exact: true }).waitFor();
  assert.equal(await readiness.locator('tbody tr').count(), 1);
  await readiness.getByLabel('Filter readiness', { exact: true }).selectOption('all');
  await decisions.getByRole('button', { name: 'Restore row QUAL-3', exact: true }).click();
  await readiness.getByText('1 ready to import · 2 need review · 0 excluded', { exact: true }).waitFor();
  await importCsv(csv.replace(',NE-ENT,https://crm.example/', ',,https://crm.example/'), 'missing-owner-fixture.csv');
  await readiness.getByText('0 ready to import · 3 need review · 0 excluded', { exact: true }).waitFor();
  await readiness.getByText('An owner needs to be assigned.', { exact: true }).waitFor();
  await importCsv(csv, 'restored-owner-fixture.csv');
  await readiness.getByText('1 ready to import · 2 need review · 0 excluded', { exact: true }).waitFor();
  await panel.getByLabel('ICP criteria', { exact: true }).fill(`${criteria} Require an enterprise plan.`);
  await assertStale();
  await panel.getByLabel('ICP criteria', { exact: true }).fill(criteria);
  await assertCurrent();
  await importCsv(csv.replace('Fixture CRM', 'Changed Company'), 'changed-qualification-fixture.csv');
  await assertStale();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Review must fit the mobile viewport.');
  await panel.screenshot({ path: resolve(output, 'qualification-review-mobile.png') });
  preview = true;
  const beforePreview = requests.length;
  await page.reload();
  await page.getByText('Session only', { exact: true }).waitFor();
  await importCsv(csv, 'preview-qualification-fixture.csv', false);
  await page.locator('summary').filter({ hasText: /^Choose rows to import ·/u }).waitFor();
  assert.equal(await panel.count(), 0, 'Persistence-disabled browser preview must not show qualification.');
  assert(!requests.slice(beforePreview).some((request) => ['workspace', 'pomade-qualification'].includes(request.endpoint)));
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ passed: true, mockedQualificationRequests: requests.filter((request) => request.endpoint === 'pomade-qualification').length,
    realApiRequests: 0, providerCalls: 0, crmWrites: 0, screenshots: output,
    verified: ['explicit ICP', 'provider connection recovery', 'pending table link', 'preview scope and limits', 'explicit credit consent', 'automatic results', 'reload resumes polling', 'cancel', 'failed run', 'uncertain start same-ID retry', 'readiness counts and filters', 'missing checks', 'website error and reload', 'excluded row', 'owner hold', 'saved evidence', 'stale criteria', 'changed company', 'mobile layout', 'persistence-disabled preview'] }));
} finally {
  releaseWebsiteLoad?.();
  await browser.close();
}
