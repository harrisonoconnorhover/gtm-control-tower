import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

// Run against a disposable local app. CRM responses are fixtures; workspace/run
// persistence stays real. The test never permits a private CRM endpoint through.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a disposable local app with persistence enabled.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an installed Chrome or Chromium executable.');
const csv = 'contact_id,first_name,last_name,email,company,job_title,region,segment,owner_id\n'
  + 'REC-UPDATE,Marcus,Bell,marcus.bell@adobe.example.com,Adobe,Director Revenue Operations,West,Enterprise,fixture-owner\n'
  + 'REC-CREATE,Nina,Alvarez,nina.alvarez@servicenow.example.com,ServiceNow,Revenue Enablement Manager,East,Enterprise,fixture-owner\n';
const browser = await chromium.launch({ executablePath, headless: true });
const outcomes = [];

async function fixtureContext(provider, failWorkspaceSummary = false) {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const tag = `receipt-recovery-${provider}-${randomUUID()}`;
  const state = { context, page, provider, errors: [], apiCalls: [], crmActions: [], saveAttempts: [],
    failures: { receipt: failWorkspaceSummary ? [] : ['500', 'abort'], undo: ['500'] },
    workspaceFailures: failWorkspaceSummary ? 1 : 0, workspaceFailureCount: 0,
    writeback: null, rollback: null, workspaceId: null };
  page.on('pageerror', (error) => state.errors.push(error.message));
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base.origin) {
      state.errors.push(`Blocked external request: ${url.origin}`);
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const endpoint = url.pathname.replace('/api/control-tower/', '');
    const body = request.method() === 'POST' ? request.postDataJSON() : null;
    state.apiCalls.push({ endpoint, method: request.method() });
    if (endpoint === 'workspace') {
      if (body?.action === 'save' && body.reason === 'connector_receipt' && state.workspaceFailures) {
        state.workspaceFailures--;
        state.workspaceFailureCount++;
        return route.fulfill({ status: 500, json: { error: 'Fictional workspace summary storage failure.' } });
      }
      return route.continue();
    }
    if (endpoint === 'runs') {
      if (body) {
        state.saveAttempts.push(body);
        const failure = state.failures[body.run.receipt.phase]?.shift();
        if (failure === '500') return route.fulfill({ status: 500, json: { error: 'Fictional run-history storage failure.' } });
        if (failure === 'abort') return route.abort('failed');
      }
      return route.continue();
    }
    if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: false,
      connectors: ['csv', 'hubspot', 'salesforce'].map((id) => ({ id, label: id, configured: true,
        directions: ['source', 'destination'], phases: [], mode: 'direct', features: ['safe-writeback', 'account-scan'] })) } });
    if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from receipt regression.' } });
    if (endpoint === 'duplicate-scan' && request.method() === 'GET') return route.fulfill({ json: { scan: null } });
    try {
      assert.equal(endpoint, 'crm-writeback', `Unhandled private endpoint: ${endpoint}`);
      assert.equal(body.connectorId, provider);
      assert(['preview', 'execute', 'rollback'].includes(body.action));
      state.crmActions.push(body.action);
      const at = new Date().toISOString();
      if (body.action === 'preview') {
        assert.deepEqual(body.contacts.map((contact) => contact.contactId), ['REC-UPDATE', 'REC-CREATE']);
        const records = body.contacts.map((contact) => {
          const update = contact.contactId === 'REC-UPDATE';
          const after = Object.fromEntries(['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website'].map((field) => [field, contact[field] ?? null]));
          const before = update ? { ...after, jobTitle: 'Manager Revenue Operations' } : null;
          return { contactId: contact.contactId, email: contact.email, nativeId: update ? `fictional-${provider}-marcus` : null,
            operation: update ? 'update' : 'create', matches: [], before, after,
            changes: update ? [{ field: 'jobTitle', before: before.jobTitle, after: after.jobTitle }] : [], reason: null };
        });
        return route.fulfill({ json: { planId: `${tag}-plan`, fingerprint: 'fictional-plan', connectorId: provider,
          sourceFile: body.sourceFile, createdAt: at, expiresAt: new Date(Date.now() + 900_000).toISOString(),
          requested: 2, creates: 1, updates: 1, unchanged: 0, held: 0, records } });
      }
      if (body.action === 'execute') {
        assert.equal(state.crmActions.filter((action) => action === 'execute').length, 1, 'Receipt recovery must not repeat CRM execution');
        const update = body.plan.records.find((record) => record.operation === 'update');
        const rollback = { rollbackId: `${tag}-backup`, connectorId: provider, sourcePlanId: body.plan.planId, createdAt: at,
          records: [{ contactId: update.contactId, email: update.email, nativeId: update.nativeId,
            before: update.before, after: update.after, changedFields: ['jobTitle'] }], createdRecordsSkipped: 1 };
        state.writeback = { accepted: true, status: 'executed', runId: `${tag}-write`, connectorId: provider,
          planId: body.plan.planId, requested: 2, created: 1, updated: 1, unchanged: 0, held: 0, failed: 0,
          completedAt: at, records: body.plan.records.map((record) => ({ contactId: record.contactId, email: record.email,
            nativeId: record.nativeId || `fictional-${provider}-nina`, status: record.operation === 'update' ? 'updated' : 'created', error: null })), rollback };
        return route.fulfill({ status: 202, json: state.writeback });
      }
      assert.equal(state.crmActions.filter((action) => action === 'rollback').length, 1, 'Receipt recovery must not repeat CRM rollback');
      assert.deepEqual(body.rollback, state.writeback.rollback, 'Rollback must retain the original field backup');
      state.rollback = { accepted: true, status: 'undone', runId: `${tag}-undo`, connectorId: provider,
        planId: body.rollback.sourcePlanId, requested: 1, created: 0, updated: 1, unchanged: 0, held: 0, failed: 0,
        completedAt: at, records: body.rollback.records.map((record) => ({ contactId: record.contactId, email: record.email,
          nativeId: record.nativeId, status: 'rolled_back', error: null })), rollback: null };
      return route.fulfill({ status: 202, json: state.rollback });
    } catch (error) {
      state.errors.push(error.message);
      return route.fulfill({ status: 400, json: { error: error.message } });
    }
  });
  return state;
}

const recoveryAlert = (page) => page.getByRole('alert').filter({ hasText: 'CRM completed; receipt not saved' });

async function importAndExecute(state, expectSaved = false) {
  const { page, provider } = state;
  await page.goto(new URL('/app/lab', base).href);
  await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
  state.workspaceId = await page.evaluate(() => localStorage.getItem('gtm-control-tower-workspace-id'));
  assert(state.workspaceId, 'The scenario needs a real persisted workspace');
  await page.getByLabel('Where should clean records go?').selectOption(provider);
  await page.locator('input[type=file]').setInputFiles({ name: 'receipt-recovery.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
  await page.getByRole('button', { name: 'Compare 2 with CRM', exact: true }).click();
  if (expectSaved) {
    const [response] = await Promise.all([
      page.waitForResponse((result) => new URL(result.url()).pathname === '/api/control-tower/runs' && result.request().method() === 'POST'),
      page.getByRole('button', { name: 'Execute 2 approved changes', exact: true }).click(),
    ]);
    assert.equal(response.status(), 201);
  } else await page.getByRole('button', { name: 'Execute 2 approved changes', exact: true }).click();
}

async function assertProcessed(state) {
  const { page, provider } = state;
  const completed = page.getByRole('button', { name: provider === 'hubspot' ? 'All clean contacts processed' : 'All clean Leads processed', exact: true });
  await completed.waitFor();
  assert(await completed.isDisabled(), 'Completed rows must not offer another CRM write');
  const receipt = await page.getByText(`${provider === 'hubspot' ? 'HubSpot' : 'Salesforce'} receipt:`, { exact: true }).locator('..').innerText();
  for (const text of ['1 created', '1 updated', '0 failed', '0 pending']) assert(receipt.includes(text), receipt);
  assert.equal(await page.getByRole('button', { name: /^Execute \d+ approved changes$/ }).count(), 0);
}

async function readHistory(state) {
  return state.page.evaluate(async (workspaceId) => {
    const response = await fetch(`/api/control-tower/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Real history read failed: ${response.status}`);
    return (await response.json()).runs;
  }, state.workspaceId);
}

async function assertDownload(state, expected) {
  const before = state.apiCalls.length;
  const downloadPromise = state.page.waitForEvent('download');
  await recoveryAlert(state.page).getByRole('button', { name: 'Download receipt', exact: true }).click();
  const download = await downloadPromise, chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), expected, 'Download must preserve workspace, original receipt, writeback, and rollback backup');
  assert.equal(state.apiCalls.length, before, 'Downloading a retained receipt must be local');
}

async function retrySave(state, abort = false) {
  const before = state.apiCalls.length;
  const done = abort
    ? state.page.waitForEvent('requestfailed', { predicate: (request) => new URL(request.url()).pathname === '/api/control-tower/runs' })
    : state.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/control-tower/runs' && response.request().method() === 'POST');
  await recoveryAlert(state.page).getByRole('button', { name: 'Retry receipt save', exact: true }).click();
  const result = await done;
  if (abort) {
    await state.page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent === 'Retry receipt save' && !button.disabled));
    await recoveryAlert(state.page).waitFor();
  } else {
    assert.equal(result.status(), 201, 'Receipt retry must reach real persistence');
    await recoveryAlert(state.page).waitFor({ state: 'hidden' });
  }
  const calls = state.apiCalls.slice(before);
  assert(calls.length > 0 && calls.every((call) => call.endpoint === 'runs'), 'Receipt retry must only access run storage');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
}

async function checkReceiptAndRollback(provider) {
  const state = await fixtureContext(provider);
  try {
    await importAndExecute(state);
    await recoveryAlert(state.page).waitFor();
    await assertProcessed(state);
    const original = state.saveAttempts[0];
    assert.equal(original.workspaceId, state.workspaceId);
    assert.equal(original.run.receipt.id, state.writeback.runId);
    assert.deepEqual(original.run.details.writeback, state.writeback);
    assert.deepEqual(original.run.undo, state.writeback.rollback);
    assert.equal((await readHistory(state)).some((run) => run.id === state.writeback.runId), false, 'A failed save must not appear durable');
    await assertDownload(state, original);
    await retrySave(state, true);
    await assertProcessed(state);
    await assertDownload(state, original);
    await retrySave(state);
    assert.equal(state.saveAttempts.length, 3);
    for (const attempt of state.saveAttempts) assert.deepEqual(attempt, original, 'Retries must reuse the original payload and run ID');
    const saved = (await readHistory(state)).filter((run) => run.id === state.writeback.runId);
    assert.equal(saved.length, 1, 'The original run must appear once');
    assert.deepEqual(saved[0].details.writeback, state.writeback);
    assert.deepEqual(saved[0].undo, state.writeback.rollback);

    await state.page.goto(new URL('/runs', base).href);
    const source = state.page.locator('article').filter({ hasText: state.writeback.runId });
    await source.getByRole('button', { name: 'Roll back 1 updates', exact: true }).click();
    await recoveryAlert(state.page).waitFor();
    assert(await source.getByRole('button', { name: 'Rollback completed', exact: true }).isDisabled(), 'Completed native rollback must be disabled before history storage succeeds');
    const undoPayload = state.saveAttempts.at(-1);
    assert.equal(undoPayload.run.receipt.id, state.rollback.runId);
    assert.deepEqual(undoPayload.run.details.writeback, state.rollback);
    assert.equal(undoPayload.run.undo ?? null, null, 'An undo receipt must not itself become rollback-ready');
    await assertDownload(state, undoPayload);
    assert.equal((await readHistory(state)).some((run) => run.id === state.rollback.runId), false);
    await retrySave(state);
    assert.deepEqual(state.saveAttempts.at(-1), undoPayload);
    const history = await readHistory(state);
    const savedUndo = history.filter((run) => run.id === state.rollback.runId);
    assert.equal(savedUndo.length, 1);
    assert.deepEqual(savedUndo[0].details.writeback, state.rollback);
    assert.equal(savedUndo[0].undo, null);
    assert.deepEqual(history.find((run) => run.id === state.writeback.runId).undo, state.writeback.rollback, 'The original source run must retain its rollback backup');
    await state.page.reload();
    await source.getByRole('button', { name: 'Rollback completed', exact: true }).waitFor();
    assert(await source.getByRole('button', { name: 'Rollback completed', exact: true }).isDisabled());
    assert.deepEqual(state.crmActions, ['preview', 'execute', 'rollback']);
    assert.deepEqual(state.errors, []);
    return { provider, scenario: 'run storage failure and rollback recovery', passed: true,
      receiptFailures: ['HTTP 500', 'network abort'], rollbackFailures: ['HTTP 500'], stableRunIds: true };
  } finally { await state.context.close(); }
}

async function checkWorkspaceSummary(provider) {
  const state = await fixtureContext(provider, true);
  try {
    await importAndExecute(state, true);
    await assertProcessed(state);
    const warning = state.page.getByRole('alert').filter({ hasText: /workspace summary/i });
    await warning.waitFor();
    assert.match(await warning.innerText(), /not saved|could not|failed/i, 'Workspace summary failure must be visible independently of CRM success');
    assert.equal(state.workspaceFailureCount, 1);
    assert.equal(await recoveryAlert(state.page).count(), 0, 'A persisted detailed run must not be reported as unsaved');
    const runs = (await readHistory(state)).filter((run) => run.id === state.writeback.runId);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].details.writeback, state.writeback);
    assert.deepEqual(runs[0].undo, state.writeback.rollback);
    assert.deepEqual(state.crmActions, ['preview', 'execute']);
    assert.deepEqual(state.errors, []);
    return { provider, scenario: 'workspace summary failure', passed: true, detailedRunSaved: true, crmOutcomeRetained: true };
  } finally { await state.context.close(); }
}

try {
  for (const provider of ['hubspot', 'salesforce']) {
    for (const check of [checkReceiptAndRollback, checkWorkspaceSummary]) {
      try { outcomes.push(await check(provider)); }
      catch (error) { outcomes.push({ provider, scenario: check.name, passed: false, error: error.message }); }
    }
  }
  console.log(JSON.stringify({ outcomes, liveCrmRequests: 0 }, null, 2));
  assert(outcomes.every((outcome) => outcome.passed), 'Receipt recovery browser regression failed');
} finally { await browser.close(); }
