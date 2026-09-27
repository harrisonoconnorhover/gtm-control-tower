import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a disposable local app with persistence enabled.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an installed Chrome or Chromium executable.');
const csv = (count) => 'contact_id,full_name,email,company,region,segment,owner_id\n'
  + Array.from({ length: count }, (_, i) => `ROW-${i + 1},Person Example,person${i + 1}@example.com,Example Co,Northeast,Enterprise,NE-ENT`).join('\n');
const browser = await chromium.launch({ executablePath, headless: true });
const outcomes = [];
try {
  for (const provider of ['hubspot', 'salesforce']) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [], batches = [], savedRuns = [];
    let executions = 0, failPreview = false;
    const gates = new Map();
    function holdResponse(kind) {
      let release, arrived;
      const wait = new Promise((resolve) => { release = resolve; });
      const seen = new Promise((resolve) => { arrived = resolve; });
      const gate = { wait, seen, release, arrived };
      gates.set(kind, gate);
      return gate;
    }
    async function pauseResponse(kind) {
      const gate = gates.get(kind);
      if (gate) { gate.arrived(); await gate.wait; gates.delete(kind); }
    }
    const operation = (id) => {
      const number = Number(id.split('-')[1]);
      return number === 105 ? 'hold' : number === 2 ? 'update'
        : number === 1 || number >= 101 || (number === 100 && executions === 0) ? 'create' : 'unchanged';
    };
    page.on('pageerror', (error) => errors.push(error.message));
    // Private CRM responses are always stubs. Only local workspace/run storage reaches the app.
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base.origin) { errors.push(`Blocked external request: ${url.origin}`); return route.abort(); }
      const endpoint = url.pathname.replace('/api/control-tower/', '');
      if (!url.pathname.startsWith('/api/') || endpoint === 'workspace') return route.continue();
      if (endpoint === 'runs') {
        if (request.method() === 'POST') savedRuns.push(request.postDataJSON().run);
        await pauseResponse('history');
        return route.continue();
      }
      if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: false,
        connectors: ['csv', 'hubspot', 'salesforce'].map((id) => ({ id, label: id, configured: true,
          directions: ['source', 'destination'], phases: [], mode: 'direct', features: ['safe-writeback', 'account-scan'] })) } });
      if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from this regression.' } });
      if (endpoint === 'duplicate-scan' && request.method() === 'GET') return route.fulfill({ json: { scan: null } });
      try {
        assert.equal(endpoint, 'crm-writeback', `Unhandled private endpoint: ${endpoint}`);
        const body = request.postDataJSON();
        assert.equal(body.connectorId, provider);
        assert(['preview', 'execute'].includes(body.action));
        await pauseResponse(body.action);
        if (body.action === 'preview' && failPreview) return route.fulfill({ status: 502, json: { error: 'Fictional comparison failure.' } });
        const at = new Date().toISOString();
        if (body.action === 'preview') {
          batches.push(body.contacts.map((contact) => contact.contactId));
          const records = body.contacts.map((contact) => {
            const action = operation(contact.contactId);
            const fields = Object.fromEntries(['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website'].map((field) => [field, contact[field] ?? null]));
            return { contactId: contact.contactId, email: contact.email, nativeId: action === 'create' ? null : `fictional-${contact.contactId}`,
              operation: action, matches: [], before: action === 'create' ? null : fields, after: fields,
              changes: [], reason: action === 'hold' ? 'Fictional ambiguous match; review required.' : null };
          });
          return route.fulfill({ json: { planId: `fixture-${provider}-${executions}`, fingerprint: 'fixture', connectorId: provider,
            sourceFile: body.sourceFile, createdAt: at, expiresAt: new Date(Date.now() + 900_000).toISOString(), requested: records.length,
            creates: records.filter((r) => r.operation === 'create').length, updates: records.filter((r) => r.operation === 'update').length,
            unchanged: records.filter((r) => r.operation === 'unchanged').length, held: records.filter((r) => r.operation === 'hold').length, records } });
        }
        const records = body.plan.records.map((record) => ({ contactId: record.contactId, email: record.email,
          nativeId: `fictional-${record.contactId}`, status: record.contactId === 'ROW-100' && executions === 0 ? 'failed'
            : ({ create: 'created', update: 'updated', hold: 'held', unchanged: 'unchanged' })[record.operation],
          error: record.operation === 'hold' ? record.reason : record.contactId === 'ROW-100' && executions === 0 ? 'Fictional retryable rejection.' : null }));
        const count = (status) => records.filter((r) => r.status === status).length;
        executions++;
        return route.fulfill({ status: 202, json: { accepted: true, status: count('failed') || count('held') ? 'partial' : 'executed',
          runId: `fixture-${provider}-${executions}`, connectorId: provider, planId: body.plan.planId, requested: records.length,
          created: count('created'), updated: count('updated'), unchanged: count('unchanged'), held: count('held'), failed: count('failed'),
          completedAt: at, records, rollback: null } });
      } catch (error) {
        errors.push(error.message);
        return route.fulfill({ status: 400, json: { error: error.message } });
      }
    });
    async function importRows(count) {
      await page.locator('input[type=file]').setInputFiles({ name: 'batch-regression.csv', mimeType: 'text/csv', buffer: Buffer.from(csv(count)) });
      await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
      await page.getByRole('button', { name: `Compare ${Math.min(100, count)} with CRM`, exact: true }).waitFor();
    }
    async function assertWorkspaceLocked(phase) {
      for (const control of [
        page.locator('input[type=file]'),
        page.getByRole('button', { name: 'Reset imported file', exact: true }),
        page.getByRole('button', { name: 'Undo saved change', exact: true }),
        page.getByLabel('Where is your data?'),
        page.getByLabel('Where should clean records go?'),
      ]) assert(await control.isDisabled(), `${phase}: input changes must wait for the current CRM operation`);
      const refresh = page.getByRole('button', { name: 'Refresh comparison', exact: true });
      if (await refresh.count()) assert(await refresh.isDisabled(), `${phase}: another comparison must not overlap`);
    }
    async function processBatch(count, checkPending = false) {
      const previewGate = checkPending ? holdResponse('preview') : null;
      await page.getByRole('button', { name: `Compare ${count} with CRM`, exact: true }).click();
      if (previewGate) { await previewGate.seen; await assertWorkspaceLocked('Preview'); previewGate.release(); }
      const executeGate = checkPending ? holdResponse('execute') : null;
      const historyGate = checkPending ? holdResponse('history') : null;
      await page.getByRole('button', { name: /^Execute \d+ approved changes$/ }).click();
      if (executeGate) { await executeGate.seen; await assertWorkspaceLocked('Execution'); executeGate.release(); }
      if (historyGate) { await historyGate.seen; await assertWorkspaceLocked('Saving receipt'); historyGate.release(); }
      await page.getByRole('button', { name: /^Compare \d+ with CRM$/ }).waitFor();
      assert.equal(await page.locator('input[type=file]').isDisabled(), false, 'Input controls unlock after receipt storage');
    }
    try {
      await page.goto(new URL('/app/lab', base).href);
      await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
      await page.getByLabel('Where should clean records go?').selectOption(provider);
      await importRows(105);
      await processBatch(100, true);
      assert.equal(await page.getByRole('button', { name: /^Compare \d+ with CRM$/ }).innerText(), 'Compare 6 with CRM');
      await processBatch(6);
      assert.deepEqual(batches.map((batch) => batch.length), [100, 6]);
      assert.deepEqual(batches[1], Array.from({ length: 6 }, (_, i) => `ROW-${100 + i}`));
      assert.equal(await page.getByRole('button', { name: /^Compare \d+ with CRM$/ }).innerText(), 'Compare 1 with CRM', 'Completed first-batch rows must stay out of subsequent batches');
      const receipt = await page.getByText(`${provider === 'hubspot' ? 'HubSpot' : 'Salesforce'} receipt:`, { exact: true }).locator('..').innerText();
      for (const text of ['5 created', '1 updated', '98 unchanged', '1 held', '0 failed']) assert(receipt.includes(text), receipt);
      assert.equal(savedRuns.length, 2);
      assert.deepEqual(savedRuns.map((run) => run.details.writeback.requested), [100, 6]);
      await page.setViewportSize({ width: 390, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No mobile horizontal overflow');
      await importRows(1);
      assert.equal(await page.getByText(`${provider === 'hubspot' ? 'HubSpot' : 'Salesforce'} receipt:`, { exact: true }).count(), 0, 'A replacement import clears previous progress');
      failPreview = true;
      await page.getByRole('button', { name: 'Compare 1 with CRM', exact: true }).click();
      await page.getByText('Fictional comparison failure. No unreceipted batch is shown as complete.', { exact: true }).waitFor();
      assert.equal(await page.locator('input[type=file]').isDisabled(), false, 'A failed comparison releases the workspace');
      assert.deepEqual(errors, []);
      outcomes.push({ provider, passed: true, batches: [100, 6], pending: 1, created: 5, updated: 1, unchanged: 98, held: 1, failed: 0, pendingOperationChecks: ['preview', 'execute', 'receipt storage', 'failure recovery'] });
    } catch (error) {
      outcomes.push({ provider, passed: false, error: error.message, batches: batches.map((batch) => batch.length), errors });
    } finally {
      for (const gate of gates.values()) gate.release();
      await context.close();
    }
  }
  console.log(JSON.stringify({ outcomes, liveCrmRequests: 0 }));
  assert(outcomes.every((outcome) => outcome.passed), 'CRM batch browser regression failed');
} finally {
  await browser.close();
}
