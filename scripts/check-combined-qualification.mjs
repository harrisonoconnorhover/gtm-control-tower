import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Run the real combined-import UI against in-memory API responses only. All API
// and external requests are intercepted; the local server serves static UI code.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3100');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a local app.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
const output = resolve('outputs/combined-qualification');
mkdirSync(output, { recursive: true });
const at = '2026-10-16T14:00:00.000Z';
const key = 'combined-qualification-ui-fixture-key';
const criteria = 'Companies selling CRM or revenue-operations software.';
const contacts = Array.from({ length: 140 }, (_, index) => {
  const suffix = String(index + 1).padStart(3, '0');
  const shared = index < 2;
  return {
    importObject: 'contact_company', contactId: `COMBINED-${suffix}`,
    fullName: index === 0 ? 'Alex Chen' : index === 1 ? 'Jordan Patel' : `Synthetic Person ${suffix}`,
    rawEmail: `person-${suffix}@contacts.test`, normalizedEmail: `person-${suffix}@contacts.test`,
    company: 'Contact context must not be qualified', website: 'https://contact-context.test/',
    associatedCompany: { recordId: shared ? 'shared-company' : `company-${suffix}`,
      name: shared ? 'Shared CRM Company' : `Associated Company ${suffix}`,
      website: shared ? 'https://shared-company.test/' : `https://company-${suffix}.test/`, phone: '', state: '' },
    region: 'Northeast', segment: 'Enterprise', lifecycleStage: 'lead', expectedLifecycleStage: 'lead',
    ownerId: 'FIXTURE-OWNER', canonicalContactId: null, recordStatus: 'active',
    lastAction: 'Imported fixture', qualityFlags: [], updatedAt: at,
  };
});
const workspace = {
  id: 'combined-qualification-ui-fixture', name: 'Combined qualification fixture', revision: 1,
  createdAt: at, updatedAt: at, presets: [], state: {
    importObject: 'contact_company', contacts, originalContacts: structuredClone(contacts),
    repairHistory: [], correctionHistory: [], receipts: [], mapping: {}, fileName: 'combined-fixture.csv',
    sourceType: 'csv', destinationType: 'csv',
  },
};
const websites = [...new Set(contacts.map((row) => row.associatedCompany.website))];
const requests = [], failures = [], starts = [];
let qualification = null;
let lastPreview = null;
let allowCompletion = false;
const check = (assessment = null) => ({ state: assessment ? 'complete' : 'not_run', assessment,
  explanation: assessment ? 'Synthetic saved evidence. No provider was called.' : 'Not checked in this fixture yet.',
  sources: [], checkedAt: assessment ? at : null, provider: assessment ? 'Fixture provider' : null,
  receiptId: assessment ? 'synthetic-receipt' : null });
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
await context.addInitScript((value) => sessionStorage.setItem('gtm-control-tower-operator-key', value), key);
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on('pageerror', (error) => failures.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) {
    failures.push(`Blocked external request: ${url.origin}`);
    return route.abort();
  }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const endpoint = url.pathname.replace('/api/control-tower/', '');
  const body = request.method() === 'POST' ? request.postDataJSON() : null;
  requests.push({ endpoint, method: request.method(), body });
  try {
    if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: true,
      connectors: [
        { id: 'csv', label: 'CSV', configured: true, directions: ['source', 'destination'], phases: [] },
        ...['hubspot', 'salesforce'].map((id) => ({ id, label: id, configured: true, mode: 'direct',
          directions: ['source', 'destination'], phases: [], features: ['safe-writeback', 'write', 'preview'] })),
      ] } });
    if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from this regression.' } });
    if (endpoint === 'workspace') {
      assert.equal(request.method(), 'GET', 'The saved fixture must not be rewritten.');
      return route.fulfill({ json: { workspace } });
    }
    if (endpoint === 'suppressions') {
      assert.equal(request.method(), 'GET');
      return route.fulfill({ json: { rules: [] } });
    }
    if (endpoint === 'local-matches') {
      assert.equal(request.method(), 'GET');
      return route.fulfill({ json: { workspaceId: workspace.id, workspaceRevision: 1,
        importObject: 'contact_company', ruleVersion: 'combined-ui-fixture', findings: [], warnings: [], snapshots: [],
        coverage: { importRows: 140, crmRecords: 0, suppressionRules: 0, comparedPairs: 0 },
        rarity: { sampleSize: 140, available: false }, counts: { pending: 0, confirmed: 0, dismissed: 0 },
        total: 0, offset: 0, limit: 50, nextOffset: null } });
    }
    if (endpoint === 'website-checks') {
      assert.equal(request.method(), 'GET', 'This test uses saved website observations.');
      return route.fulfill({ json: { checks: websites.map((url) => ({ url, finalUrl: url, status: 'reachable',
        method: 'http', httpStatus: 200, title: 'Synthetic associated company',
        detail: 'Synthetic saved website observation.', checkedAt: at })) } });
    }
    assert.equal(endpoint, 'pomade-qualification', `Unexpected API request: ${endpoint}`);
    assert.equal(request.headers()['x-control-tower-key'], key);
    if (body) {
      assert.equal(body.workspaceId, workspace.id);
      if (body.action === 'send') {
        assert.deepEqual(body, { action: 'send', workspaceId: workspace.id, icpCriteria: criteria });
        assert.equal(starts.length, 0, 'Sending the list must not start checks.');
        qualification = { qualificationId: 'combined-fixture-qualification', requestDigest: 'combined-fixture-digest',
          tableId: 'combined-fixture-table', tableUrl: 'http://localhost:8798/?table=combined-fixture-table',
          sourceRevision: 1, icpCriteria: criteria, sentAt: at, refreshedAt: null, stale: false,
          rows: contacts.map((row) => ({ sourceRowId: row.contactId, pomadeRowId: `pomade-${row.contactId}`,
            inputs: { company: row.associatedCompany.name, website: row.associatedCompany.website, email: row.normalizedEmail },
            identity: check(), icp: check(), email: check() })) };
      } else if (body.action === 'preview') {
        assert.equal(body.confirmExternalRequests, undefined, 'Preview must not approve provider credits.');
        assert(body.sourceRowIds.length > 0 && body.sourceRowIds.length <= 100);
        const maximumSubmissions = body.sourceRowIds.length * body.checks.length;
        lastPreview = { qualificationId: qualification.qualificationId,
          previewHash: `combined-preview-${requests.length}`, sourceRowIds: body.sourceRowIds, checks: body.checks,
          rowCount: body.sourceRowIds.length, maximumSubmissions, backgroundAllowed: maximumSubmissions <= 50,
          backgroundIssue: maximumSubmissions > 50 ? 'Choose fewer rows to stay within 50 provider submissions.' : '',
          warnings: ['Existing provider credits may be used.'], entries: body.sourceRowIds.flatMap((rowId) =>
            body.checks.map((kind) => ({ rowId, rowLabel: rowId, columnId: kind, columnLabel: kind,
              state: 'ready', details: ['Synthetic fixture inputs are ready.'], steps: ['Fixture provider'], maximum: 1 }))) };
        return route.fulfill({ json: { configured: true, qualification, preview: lastPreview } });
      } else if (body.action === 'start') {
        assert.equal(body.confirmExternalRequests, true);
        assert.equal(body.previewHash, lastPreview.previewHash);
        assert.deepEqual(body.sourceRowIds, lastPreview.sourceRowIds);
        assert.deepEqual(body.checks, lastPreview.checks);
        assert(lastPreview.backgroundAllowed);
        starts.push(body);
        qualification.execution = { requestId: body.requestId, previewHash: body.previewHash,
          sourceRowIds: body.sourceRowIds, checks: body.checks, requestedAt: at, updatedAt: at,
          status: 'queued', error: null, job: { id: body.requestId, status: 'queued', cursor: 0,
            totalRows: body.sourceRowIds.length, completedCount: 0, skippedCount: 0, error: null, waitingMessage: null } };
      } else if (body.action === 'status') {
        assert.deepEqual(body, { action: 'status', workspaceId: workspace.id });
        if (allowCompletion) {
          const execution = qualification.execution;
          execution.status = 'completed';
          execution.job = { ...execution.job, status: 'completed', cursor: execution.sourceRowIds.length,
            completedCount: execution.sourceRowIds.length * execution.checks.length };
          qualification.refreshedAt = at;
          qualification.rows = qualification.rows.map((row) => execution.sourceRowIds.includes(row.sourceRowId)
            ? { ...row, identity: check('Match'), icp: check('Fit'), email: check(row.sourceRowId === 'COMBINED-002' ? 'invalid' : 'valid') } : row);
        }
      } else {
        assert.deepEqual(body, { action: 'refresh', workspaceId: workspace.id }, 'Refresh must not run new checks.');
        qualification.refreshedAt = at;
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
const results = () => panel.locator('table').last();
const consent = () => runner.getByLabel('I approve these provider requests and any credits they use.', { exact: true });
async function assertResults() {
  for (const [id, name, emailStatus] of [['COMBINED-001', 'Alex Chen', 'valid'], ['COMBINED-002', 'Jordan Patel', 'invalid']]) {
    const row = results().locator('tbody tr').filter({ hasText: `Row ${id}` });
    await row.getByText(name, { exact: true }).waitFor();
    await row.getByText('Associated company: Shared CRM Company', { exact: true }).waitFor();
    await row.getByText('Match', { exact: true }).waitFor();
    await row.getByText('Fit', { exact: true }).waitFor();
    await row.getByText(emailStatus, { exact: true }).waitFor();
  }
  await readiness.getByText('0 ready to import · 140 need review · 0 excluded', { exact: true }).waitFor();
  assert.equal(await readiness.getByRole('cell', { name: 'Ready to import', exact: true }).count(), 0);
  assert.equal(await panel.getByText('Stale result', { exact: true }).count(), 0);
}
try {
  await page.goto(new URL(`/app/lab?workspaceId=${workspace.id}`, base).href);
  await page.getByText('SQLite r1 · saved', { exact: true }).waitFor({ timeout: 45_000 });
  await panel.getByText('140 included rows · 0 missing a company, website, or email. Skipped, suppressed and merged rows are excluded.', { exact: true }).waitFor();
  const websitePanel = page.getByRole('region', { name: 'Company website checks', exact: true });
  await websitePanel.getByText(/139 distinct websites · 139 checked · 139 with content/u).waitFor();
  await websitePanel.getByText('Shared CRM Company', { exact: true }).waitFor();
  assert.equal(await websitePanel.getByText('Contact context must not be qualified', { exact: true }).count(), 0);
  assert.equal(await websitePanel.getByText('https://contact-context.test/', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /Sync to HubSpot|Sync to Salesforce|Compare with HubSpot|Compare with Salesforce|Approve.*CRM/u }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Prepare CRM cohort', exact: true }).count(), 0);
  await panel.getByLabel('ICP criteria', { exact: true }).fill(criteria);
  await panel.getByRole('button', { name: 'Send to Pomade', exact: true }).click();
  await runner.getByText('Choose rows · 0 of 140 selected', { exact: true }).waitFor();
  assert(await runner.getByRole('button', { name: 'Preview checks', exact: true }).isDisabled());
  assert.equal(starts.length, 0);
  assert.equal(await results().getByText('Not checked', { exact: true }).count(), 30);
  await runner.locator('summary').filter({ hasText: /^Choose rows ·/u }).click();
  await runner.getByRole('button', { name: 'Select all rows', exact: true }).click();
  await runner.getByText('Choose rows · 140 of 140 selected', { exact: true }).waitFor();
  assert(await runner.getByRole('button', { name: 'Preview checks', exact: true }).isDisabled());
  assert.equal(requests.filter((request) => request.body?.action === 'preview').length, 0);
  await runner.getByRole('button', { name: 'Select first 16 rows', exact: true }).click();
  await runner.getByRole('button', { name: 'Preview checks', exact: true }).click();
  await runPreview.getByText('16 selected rows · up to 48 provider submissions', { exact: true }).waitFor();
  assert(await runner.getByRole('button', { name: 'Run checks', exact: true }).isDisabled());
  await consent().check();
  await runner.getByLabel('ICP fit', { exact: true }).uncheck();
  assert.equal(await runPreview.count(), 0, 'Changing check scope must discard consent and preview.');
  await runner.getByLabel('ICP fit', { exact: true }).check();
  await runner.getByRole('button', { name: 'Preview checks', exact: true }).click();
  await runPreview.getByText('16 selected rows · up to 48 provider submissions', { exact: true }).waitFor();
  assert(!(await consent().isChecked()), 'Changed scope must require fresh credit consent.');
  assert(await runner.getByRole('button', { name: 'Run checks', exact: true }).isDisabled());
  await runner.screenshot({ path: resolve(output, 'combined-run-preview.png') });
  await consent().check();
  await runner.getByRole('button', { name: 'Run checks', exact: true }).click();
  await runner.getByText('Run queued', { exact: true }).waitFor();
  assert.equal(starts.length, 1);
  allowCompletion = true;
  await runner.getByText('Run completed', { exact: true }).waitFor();
  await assertResults();
  assert(requests.some((request) => request.body?.action === 'status'), 'Completion must arrive from automatic polling.');
  assert.equal(requests.filter((request) => request.body?.action === 'refresh').length, 0);
  assert.equal(qualification.rows.filter((row) => row.identity.state === 'complete').length, 16, 'Unselected rows must remain unchecked.');
  await results().screenshot({ path: resolve(output, 'combined-results.png') });
  await page.reload();
  await assertResults();
  assert.equal(starts.length, 1, 'Reload must use cached results without starting another run.');
  await panel.getByRole('button', { name: 'Refresh Pomade results', exact: true }).click();
  await panel.getByText('Saved Pomade results refreshed. No checks were rerun.', { exact: true }).waitFor();
  assert.equal(starts.length, 1, 'Manual refresh must not start another run.');
  await readiness.screenshot({ path: resolve(output, 'combined-readiness.png') });
  assert.deepEqual(failures, []);
  const result = { passed: true, rows: 140, associatedWebsites: websites.length, mockedStarts: starts.length,
    selectedRows: starts[0].sourceRowIds.length, maximumProviderSubmissions: lastPreview.maximumSubmissions,
    realApiRequests: 0, providerCalls: 0, crmWrites: 0, screenshots: output,
    verified: ['associated company projection', 'distinct contacts at shared company', 'explicit large-list selection',
      '100 row run cap', '48 submission preview', 'credit consent', 'changed scope clears consent',
      'automatic result retrieval', 'saved result reload', 'refresh without rerun', 'CRM controls absent', 'combined rows held for review'] };
  writeFileSync(resolve(output, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
