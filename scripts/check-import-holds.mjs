import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

// Use a disposable local app with real workspace/run persistence. This checks
// presentation and batch progress; server tests exercise the actual matching rule.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a disposable local app with persistence enabled.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an installed Chrome or Chromium executable.');
const rows = [
  { contactId: 'IMPORT-PRIYA-1', fullName: 'Priya Nair', email: 'priya.nair@salesforce.example.com' },
  { contactId: 'IMPORT-PRIYA-2', fullName: 'Priya Nair', email: 'p.nair@salesforce.example.com' },
  { contactId: 'IMPORT-NINA', fullName: 'Nina Alvarez', email: 'nina.alvarez@servicenow.example.com' },
];
const csv = 'contact_id,first_name,last_name,email,company,phone,state,region,segment,owner_id\n'
  + 'IMPORT-PRIYA-1,Priya,Nair,priya.nair@salesforce.example.com,Salesforce,415-555-0142,CA,West,Enterprise,fixture-owner\n'
  + 'IMPORT-PRIYA-2,Priya,Nair,p.nair@salesforce.example.com,Salesforce,415-555-0142,CA,West,Enterprise,fixture-owner\n'
  + 'IMPORT-NINA,Nina,Alvarez,nina.alvarez@servicenow.example.com,ServiceNow,212-555-0187,NY,East,Enterprise,fixture-owner\n';
const browser = await chromium.launch({ executablePath, headless: true });
const outcomes = [];

try {
  for (const provider of ['hubspot', 'salesforce']) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const tag = `import-holds-${provider}-${randomUUID()}`;
    const errors = [], previews = [], executedCreates = [], savedRuns = [];
    let executions = 0, writeback = null;
    page.on('pageerror', (error) => errors.push(error.message));
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base.origin) { errors.push(`Blocked external request: ${url.origin}`); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const endpoint = url.pathname.replace('/api/control-tower/', '');
      if (endpoint === 'workspace') return route.continue();
      if (endpoint === 'runs') {
        if (request.method() === 'POST') savedRuns.push(request.postDataJSON().run);
        return route.continue();
      }
      if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: false,
        connectors: ['csv', 'hubspot', 'salesforce'].map((id) => ({ id, label: id, configured: true,
          directions: ['source', 'destination'], phases: [], mode: 'direct', features: ['safe-writeback', 'account-scan'] })) } });
      if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from import-hold regression.' } });
      if (endpoint === 'duplicate-scan' && request.method() === 'GET') return route.fulfill({ json: { scan: null } });
      try {
        assert.equal(endpoint, 'crm-writeback', `Unhandled private endpoint: ${endpoint}`);
        const body = request.postDataJSON();
        assert.equal(body.connectorId, provider);
        assert(['preview', 'execute'].includes(body.action));
        const at = new Date().toISOString();
        if (body.action === 'preview') {
          previews.push(body.contacts.map((contact) => contact.contactId));
          const records = body.contacts.map((contact) => {
            const held = contact.contactId.startsWith('IMPORT-PRIYA-');
            const other = rows.find((row) => row.contactId.startsWith('IMPORT-PRIYA-') && row.contactId !== contact.contactId);
            return { contactId: contact.contactId, email: contact.email, nativeId: null, operation: held ? 'hold' : 'create',
              matches: [], before: null,
              after: Object.fromEntries(['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website'].map((field) => [field, contact[field] ?? null])),
              changes: [], reason: held ? 'Possible duplicate in the saved import. Review both rows before creating a contact.' : null,
              possibleMatches: [], possibleImportMatches: held ? [{ ...other, score: 72, evidence: [
                { key: 'name', label: 'Exact normalized full name', weight: 32, tone: 'supporting' },
                { key: 'phone', label: 'Normalized phone on 1 other import row(s)', weight: 44, tone: 'strong' },
                { key: 'company', label: 'Same normalized company', weight: 12, tone: 'supporting' },
                { key: 'state', label: 'Same normalized state or region', weight: 6, tone: 'supporting' },
                { key: 'email_conflict', label: 'Different email identities', weight: -22, tone: 'conflict' },
              ] }] : [],
              createReview: { status: held ? 'held' : 'clear', scanId: `${tag}-scan`, startedAt: at,
                ruleVersion: 'browser-fixture', candidateCount: 0, importCandidateCount: held ? 1 : 0, warnings: [] } };
          });
          return route.fulfill({ json: { planId: `${tag}-plan-${previews.length}`, fingerprint: 'fictional-plan', connectorId: provider,
            sourceFile: body.sourceFile, createdAt: at, expiresAt: new Date(Date.now() + 900_000).toISOString(), requested: records.length,
            creates: records.filter((record) => record.operation === 'create').length, updates: 0, unchanged: 0,
            held: records.filter((record) => record.operation === 'hold').length, records } });
        }
        executions++;
        assert.equal(executions, 1, 'The scenario must execute only once');
        assert.equal(body.plan.creates, 1);
        assert.equal(body.plan.held, 2);
        const approved = body.plan.records.filter((record) => record.operation === 'create');
        assert.deepEqual(approved.map((record) => record.contactId), ['IMPORT-NINA'], 'Only the unrelated row is approved to create');
        executedCreates.push(...approved.map((record) => record.contactId));
        writeback = { accepted: true, status: 'partial', runId: `${tag}-write`, connectorId: provider,
          planId: body.plan.planId, requested: 3, created: 1, updated: 0, unchanged: 0, held: 2, failed: 0, completedAt: at,
          records: body.plan.records.map((record) => ({ contactId: record.contactId, email: record.email,
            nativeId: record.operation === 'create' ? `${tag}-native-nina` : null,
            status: record.operation === 'create' ? 'created' : 'held', error: record.operation === 'hold' ? record.reason : null })), rollback: null };
        return route.fulfill({ status: 202, json: writeback });
      } catch (error) {
        errors.push(error.message);
        return route.fulfill({ status: 400, json: { error: error.message } });
      }
    });

    try {
      await page.goto(new URL('/app/lab', base).href);
      await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
      const workspaceId = await page.evaluate(() => localStorage.getItem('gtm-control-tower-workspace-id'));
      assert(workspaceId, 'The scenario must use a persisted workspace');
      await page.getByLabel('Where should clean records go?').selectOption(provider);
      await page.locator('input[type=file]').setInputFiles({ name: 'import-holds.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
      await page.getByRole('button', { name: 'Compare 3 with CRM', exact: true }).click();
      await page.getByRole('button', { name: 'Execute 1 approved changes', exact: true }).waitFor();
      const comparison = page.getByLabel('CRM comparison records', { exact: true });
      for (const row of rows.slice(0, 2)) {
        const other = rows.find((candidate) => candidate.contactId.startsWith('IMPORT-PRIYA-') && candidate.contactId !== row.contactId);
        const detail = comparison.locator('details').filter({ has: page.locator('summary').filter({ hasText: row.contactId }) });
        await detail.locator('summary').click();
        await detail.getByText('Possible match in this import: Priya Nair · 72/100', { exact: true }).waitFor();
        await detail.getByText(`Import row ${other.contactId} · ${other.email}`, { exact: true }).waitFor();
        const text = await detail.innerText();
        assert(text.includes('scores rank evidence, not identity probability'), 'Scores must not be presented as identity probability');
        assert(text.includes('No row is automatically chosen to create'), 'Neither possible duplicate should be chosen automatically');
        assert(!/Possible match:|Matched CRM records:|(?:lead|contact) IMPORT-/i.test(text), 'Import evidence must not be labelled as a native CRM record');
      }
      await page.setViewportSize({ width: 390, height: 844 });
      for (const candidate of rows.slice(0, 2)) {
        const label = comparison.getByText(`Import row ${candidate.contactId} · ${candidate.email}`, { exact: true });
        await label.scrollIntoViewIfNeeded();
        assert(await label.isVisible(), 'Hold evidence must remain visible at mobile width');
        const box = await label.boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= 390, 'Import identifiers must fit the mobile viewport');
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No mobile horizontal overflow');
      const [saved] = await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === '/api/control-tower/runs' && response.request().method() === 'POST'),
        page.getByRole('button', { name: 'Execute 1 approved changes', exact: true }).click(),
      ]);
      assert.equal(saved.status(), 201, 'The execution receipt must reach real local persistence');
      await page.getByRole('button', { name: 'Compare 2 with CRM', exact: true }).waitFor();
      const receipt = await page.getByText(`${provider === 'hubspot' ? 'HubSpot' : 'Salesforce'} receipt:`, { exact: true }).locator('..').innerText();
      for (const text of ['1 created', '0 updated', '2 held', '0 failed', '2 pending']) assert(receipt.includes(text), receipt);
      assert.equal(savedRuns.length, 1);
      assert.deepEqual(savedRuns[0].details.writeback, writeback);
      const history = await page.evaluate(async (id) => {
        const response = await fetch(`/api/control-tower/runs?workspaceId=${encodeURIComponent(id)}&limit=100`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Run-history read failed: ${response.status}`);
        return (await response.json()).runs;
      }, workspaceId);
      assert.deepEqual(history.find((run) => run.id === writeback.runId)?.details.writeback, writeback, 'The durable receipt must retain both holds');
      await page.getByRole('button', { name: 'Compare 2 with CRM', exact: true }).click();
      await page.getByRole('button', { name: 'Record comparison result', exact: true }).waitFor();
      assert.deepEqual(previews, [rows.map((row) => row.contactId), rows.slice(0, 2).map((row) => row.contactId)], 'Only held rows should remain in the next comparison');
      assert.equal(await page.getByRole('button', { name: /^Execute \d+ approved changes$/ }).count(), 0, 'Unresolved import holds must offer no approved writes');
      assert.deepEqual(executedCreates, ['IMPORT-NINA']);
      assert.deepEqual(errors, []);
      outcomes.push({ provider, passed: true, approvedCreates: 1, held: 2, pending: 2, persistedReceipt: true, mobileWidth: 390 });
    } catch (error) {
      outcomes.push({ provider, passed: false, error: error.message, errors, previews, executions });
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ outcomes, liveCrmRequests: 0, crmResponses: 'simulated; local workspace and run persistence are real' }));
  assert(outcomes.every((outcome) => outcome.passed), 'Import-hold browser regression failed');
} finally { await browser.close(); }
