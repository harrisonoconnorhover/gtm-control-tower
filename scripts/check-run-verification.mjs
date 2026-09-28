import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

// CRM verification responses are simulated. Workspace and run saves/reloads use
// the real disposable local app. No provider read or write can leave this test.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a disposable local app with persistence enabled.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an installed Chrome or Chromium executable.');
const operatorKey = 'browser-verification-fixture-key';

function parseCsv(text) {
  const rows = [];
  let cells = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { cells.push(cell); cell = ''; }
    else if (char === '\r' && text[index + 1] === '\n' && !quoted) { rows.push([...cells, cell]); cells = []; cell = ''; index++; }
    else cell += char;
  }
  assert(!quoted, 'CSV quotes must close.');
  if (cell || cells.length) rows.push([...cells, cell]);
  const [header, ...data] = rows;
  header[0] = header[0].replace(/^\uFEFF/u, '');
  return data.map((row) => {
    assert.equal(row.length, header.length);
    return Object.fromEntries(header.map((column, index) => [column, row[index]]));
  });
}

async function downloadText(page, button) {
  const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function saveRun(context, workspaceId, run) {
  const response = await context.request.post(new URL('/api/control-tower/runs', base).href, { data: { workspaceId, run } });
  assert.equal(response.status(), 201, `Real run save failed: ${await response.text()}`);
}

async function readRuns(context, workspaceId) {
  const response = await context.request.get(new URL(`/api/control-tower/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`, base).href);
  assert.equal(response.status(), 200);
  return (await response.json()).runs;
}

function fixtureRun(provider, tag) {
  const at = new Date(Date.now() - 60_000).toISOString();
  const objectType = provider === 'hubspot' ? 'contact' : 'lead';
  const ids = provider === 'hubspot' ? ['992001', '992002', '992003', '992004']
    : ['00Q000000000001AAA', '00Q000000000002AAA', '00Q000000000003AAA', '00Q000000000004AAA'];
  const people = [
    ['VERIFY-CREATED', 'Nina', 'Alvarez', 'nina.alvarez@servicenow.example.com', 'ServiceNow', 'Revenue Enablement Manager'],
    ['VERIFY-DIFFERENT', 'Marcus', 'Bell', 'marcus.bell@adobe.example.com', 'Adobe', 'Director Revenue Operations'],
    ['VERIFY-UNAVAILABLE', 'Priya', 'Nair', 'p.nair@salesforce.example.com', 'Salesforce', 'Director Sales Strategy'],
    ['VERIFY-UNCHANGED', 'Sam', 'Reed', 'sam.reed@cisco.example.com', 'Cisco', 'Sales Manager'],
    ['VERIFY-HELD', 'Jordan', 'Kim', 'jordan.kim@oracle.example.com', 'Oracle', 'Account Manager'],
    ['VERIFY-FAILED', 'Alex', 'Rivera', 'alex.rivera@adobe.example.com', 'Adobe', 'Sales Operations Analyst'],
  ];
  const records = people.map(([contactId, firstName, lastName, email, company, jobTitle], index) => {
    const after = { firstName, lastName, company, phone: null, jobTitle, website: null };
    const operation = ['create', 'update', 'update', 'unchanged', 'hold', 'create'][index];
    const nativeId = ['update', 'unchanged'].includes(operation) ? ids[index] : null;
    const before = nativeId ? { ...after, jobTitle: operation === 'update' ? 'Manager' : jobTitle } : null;
    return { contactId, email, nativeId, operation, matches: nativeId ? [{ nativeId, objectType, email }] : [],
      before, after, changes: operation === 'update' ? [{ field: 'jobTitle', before: 'Manager', after: jobTitle }] : [],
      reason: operation === 'hold' ? 'Possible duplicate needs review.' : null };
  });
  const plan = { planId: `${tag}-plan`, fingerprint: 'simulated-verification-plan', connectorId: provider,
    sourceFile: 'run-verification-fictional.csv', createdAt: at, expiresAt: new Date(Date.now() + 900_000).toISOString(),
    requested: records.length, creates: 2, updates: 2, unchanged: 1, held: 1, records };
  const rollback = { rollbackId: `${tag}-backup`, connectorId: provider, sourcePlanId: plan.planId,
    createdAt: at, createdRecordsSkipped: 1, records: records.filter((record) => record.operation === 'update').map((record) => ({
      contactId: record.contactId, email: record.email, nativeId: record.nativeId,
      before: record.before, after: record.after, changedFields: ['jobTitle'],
    })) };
  const writeback = { accepted: true, status: 'partial', runId: `${tag}-write`, connectorId: provider, planId: plan.planId,
    requested: records.length, created: 1, updated: 2, unchanged: 1, held: 1, failed: 1, completedAt: at,
    records: records.map((record, index) => ({ contactId: record.contactId, email: record.email, nativeId: ids[index] ?? null,
      status: ['created', 'updated', 'updated', 'unchanged', 'held', 'failed'][index],
      error: index === 5 ? 'Simulated provider validation failure.' : null })), rollback };
  const receipt = { id: writeback.runId, connectorId: provider, phase: 'receipt', status: 'partial',
    summary: 'Fictional browser fixture: 1 created, 2 updated, 1 unchanged, 1 held, 1 failed.',
    recordsWritten: 3, recordsFailed: 1, createdAt: at, undoAvailable: true, nativeReceiptId: writeback.runId };
  return { receipt, details: { plan, writeback }, undo: rollback };
}

function verificationFor(run, provider, attempt) {
  const checkedAt = new Date(Date.now() + attempt * 1000).toISOString();
  const records = run.details.plan.records.slice(0, 3).map((record, index) => {
    const expected = { email: record.email, ...record.after };
    const status = attempt === 1 ? ['verified', 'different', 'unavailable'][index] : 'verified';
    const actual = status === 'unavailable' ? null : status === 'different' ? { ...expected, jobTitle: 'VP Revenue Operations' } : { ...expected };
    return { contactId: record.contactId, nativeId: run.details.writeback.records[index].nativeId, status, checkedAt,
      expected, actual, differences: status === 'different' ? [{ field: 'jobTitle', expected: expected.jobTitle, actual: actual.jobTitle }] : [],
      error: status === 'unavailable' ? 'Simulated CRM read timed out. The original write receipt is unchanged.' : null };
  });
  return { runId: run.receipt.id, planId: run.details.plan.planId, connectorId: provider, checkedAt,
    verified: records.filter((record) => record.status === 'verified').length,
    different: records.filter((record) => record.status === 'different').length,
    unavailable: records.filter((record) => record.status === 'unavailable').length, records };
}

const browser = await chromium.launch({ executablePath, headless: true });
const outcomes = [];
try {
  for (const provider of ['hubspot', 'salesforce']) {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [], apiCalls = [], tag = `run-verification-${provider}-${randomUUID()}`;
    const original = fixtureRun(provider, tag);
    let checks = 0, savedVerification = null, failNext = false;
    try {
      const response = await context.request.post(new URL('/api/control-tower/workspace', base).href, { data: { action: 'create', name: tag } });
      assert.equal(response.status(), 201, `Real workspace creation failed: ${await response.text()}`);
      const { workspace } = await response.json();
      await saveRun(context, workspace.id, original);
      await context.addInitScript(({ origin, workspaceId }) => {
        if (location.origin === origin) localStorage.setItem('gtm-control-tower-workspace-id', workspaceId);
      }, { origin: base.origin, workspaceId: workspace.id });
      page.on('pageerror', (error) => errors.push(error.message));
      await context.route('**/*', async (route) => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== base.origin) { errors.push(`Blocked external request: ${url.origin}`); return route.abort(); }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const endpoint = url.pathname.replace('/api/control-tower/', '');
        apiCalls.push({ endpoint, method: request.method() });
        if (endpoint === 'runs' && request.method() === 'GET') return route.continue();
        try {
          assert.equal(endpoint, 'runs/verify', `Unexpected endpoint: ${endpoint}. Verification must not repeat CRM writes.`);
          assert.equal(request.method(), 'POST');
          assert.deepEqual(request.postDataJSON(), { workspaceId: workspace.id, runId: original.receipt.id });
          assert.equal(request.headers()['x-control-tower-key'], operatorKey, 'Verification carries the operator key.');
          checks++;
          if (failNext) {
            failNext = false;
            return route.fulfill({ status: 500, json: { error: 'Simulated verification storage failure; the previous saved result is unchanged.' } });
          }
          const verification = verificationFor(original, provider, checks);
          await saveRun(context, workspace.id, { ...original, details: { ...original.details, verification } });
          savedVerification = verification;
          return route.fulfill({ json: { verification } });
        } catch (error) { errors.push(error.message); return route.fulfill({ status: 400, json: { error: error.message } }); }
      });
      await page.goto(new URL('/runs', base).href);
      const card = page.locator('article').filter({ hasText: original.receipt.id });
      const verify = () => card.getByRole('button', { name: 'Verify CRM results', exact: true });
      const recheck = () => card.getByRole('button', { name: 'Recheck CRM results', exact: true });
      const region = () => card.getByRole('region', { name: 'CRM result verification', exact: true });
      const resultsCsv = () => card.getByRole('button', { name: 'Download results CSV', exact: true });
      await verify().waitFor({ timeout: 45_000 });
      await page.getByLabel('Operator access key for rollback', { exact: true }).fill(operatorKey);
      const unchecked = parseCsv(await downloadText(page, resultsCsv()));
      assert(unchecked.every((row) => row.verification_status === ''), 'Saved write receipts must not imply verification.');
      await verify().click();
      await recheck().waitFor();
      await region().getByText('1 verified · 1 values differ · 1 couldn’t verify', { exact: true }).waitFor();
      for (const status of ['Verified', 'Values differ', 'Couldn’t verify']) await region().getByText(status, { exact: true }).waitFor();
      await region().getByText('Director Revenue Operations', { exact: true }).waitFor();
      await region().getByText('VP Revenue Operations', { exact: true }).waitFor();
      await region().getByText('Simulated CRM read timed out. The original write receipt is unchanged.', { exact: true }).waitFor();
      await region().getByText(/Checked .* · saved with this run/u).waitFor();
      const csvRows = parseCsv(await downloadText(page, resultsCsv()));
      assert.equal(csvRows.length, original.details.plan.records.length);
      for (const row of csvRows) {
        assert.equal(row.outcome, original.details.writeback.records.find((record) => record.contactId === row.contact_id).status);
        const verification = savedVerification.records.find((record) => record.contactId === row.contact_id);
        assert.equal(row.verification_status, verification?.status ?? '');
        assert.equal(row.verification_checked_at, verification?.checkedAt ?? '');
        if (verification) {
          assert.deepEqual(JSON.parse(row.verification_expected), verification.expected);
          assert.deepEqual(row.verification_actual ? JSON.parse(row.verification_actual) : null, verification.actual);
          assert.equal(row.verification_error, verification.error ?? '');
        }
      }
      const different = csvRows.find((row) => row.contact_id === 'VERIFY-DIFFERENT');
      assert.deepEqual(JSON.parse(different.verification_differences), savedVerification.records[1].differences);
      const firstVerification = structuredClone(savedVerification);
      let [stored] = await readRuns(context, workspace.id);
      assert.deepEqual(stored.details.verification, firstVerification, 'The simulated check must be saved through real run persistence.');
      assert.deepEqual(stored.details.writeback, original.details.writeback);
      assert.deepEqual(stored.receipt, original.receipt);
      assert.deepEqual(stored.undo, original.undo);
      const evidence = JSON.parse(await downloadText(page, page.getByRole('button', { name: 'Export evidence', exact: true })));
      assert.deepEqual(evidence.runs[0].details.verification, firstVerification);
      await region().screenshot({ path: `/tmp/gtm-run-verification-${provider}-results.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await region().scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Field differences must fit a mobile viewport.');
      await region().screenshot({ path: `/tmp/gtm-run-verification-${provider}-differences-mobile.png` });
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.reload();
      await region().getByText('1 verified · 1 values differ · 1 couldn’t verify', { exact: true }).waitFor();
      assert.equal(checks, 1, 'Reload must display the saved check without making another CRM request.');
      assert.equal(await page.getByLabel('Operator access key for rollback', { exact: true }).inputValue(), operatorKey);
      failNext = true;
      await recheck().click();
      await card.getByRole('alert').filter({ hasText: 'Simulated verification storage failure' }).waitFor();
      assert(await region().getByText('1 verified · 1 values differ · 1 couldn’t verify', { exact: true }).isVisible());
      [stored] = await readRuns(context, workspace.id);
      assert.deepEqual(stored.details.verification, firstVerification, 'A failed recheck must retain the prior saved check.');
      assert.deepEqual(stored.details.writeback, original.details.writeback, 'Verification failure cannot change the native write outcome.');
      await recheck().click();
      await region().getByText('3 verified · 0 values differ · 0 couldn’t verify', { exact: true }).waitFor();
      assert.equal(await card.getByRole('alert').count(), 0, 'A successful recheck clears the previous error.');
      assert.equal(await region().getByText('Verified', { exact: true }).count(), 3, 'Recheck replaces the prior check instead of appending duplicate rows.');
      assert.notEqual(savedVerification.checkedAt, firstVerification.checkedAt);
      await page.reload();
      await region().getByText('3 verified · 0 values differ · 0 couldn’t verify', { exact: true }).waitFor();
      [stored] = await readRuns(context, workspace.id);
      assert.deepEqual(stored.details.verification, savedVerification);
      assert.deepEqual(stored.details.plan, original.details.plan);
      assert.deepEqual(stored.details.writeback, original.details.writeback);
      assert.deepEqual(stored.receipt, original.receipt);
      assert.deepEqual(stored.undo, original.undo);
      assert.equal(stored.status, 'partial', 'A verified readback must not rewrite original partial write status.');
      await page.setViewportSize({ width: 390, height: 844 });
      await region().scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Verification results must fit a mobile viewport.');
      await region().screenshot({ path: `/tmp/gtm-run-verification-${provider}-mobile.png` });
      assert.equal(checks, 3);
      assert(apiCalls.every((call) => (call.endpoint === 'runs' && call.method === 'GET') || call.endpoint === 'runs/verify'));
      assert.deepEqual(errors, []);
      outcomes.push({ provider, passed: true, checks, realRunPersistence: true, savedCheckReloaded: true,
        resultCsvAndJson: true, failedRecheckPreservedPreviousResult: true, originalReceiptPreserved: true, mobileWidth: 390 });
    } catch (error) { outcomes.push({ provider, passed: false, error: error.message, errors, checks }); }
    finally { await context.close(); }
  }
  console.log(JSON.stringify({ outcomes, liveCrmRequests: 0, crmWrites: 0,
    crmResponses: 'simulated; workspace and run persistence is real' }));
  assert(outcomes.every((outcome) => outcome.passed), 'Run-verification browser regression failed.');
} finally { await browser.close(); }
