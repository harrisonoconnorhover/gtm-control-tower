import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

// CRM plans/receipts are deliberate UI fixtures. Real local workspace and run
// persistence exercise reloads; unit/route tests exercise server matching/policy.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a disposable local app with persistence enabled.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an installed Chrome or Chromium executable.');
const fields = ['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website'];
const defaultPolicy = { mode: 'fill-empty', fields, clearBlanks: false };
const finalPolicy = { mode: 'replace', fields: ['jobTitle', 'website'], clearBlanks: true };
const csv = 'contact_id,first_name,last_name,email,company,phone,state,region,segment,owner_id,job_title,website\n'
  + 'IMPORT-PRIYA-1,Priya,Nair,priya.nair@salesforce.example.com,Salesforce,415-555-0142,CA,West,Enterprise,fixture-owner,Director,\n'
  + 'IMPORT-PRIYA-2,Priya,Nair,p.nair@salesforce.example.com,Salesforce,415-555-0142,CA,West,Enterprise,fixture-owner,Director,\n'
  + 'IMPORT-MARCUS,Marcus,Bell,marcus.bell@adobe.example.com,Adobe,408-555-0134,CA,West,Enterprise,fixture-owner,VP of Operations,\n';
const skippedId = 'IMPORT-PRIYA-2';
const skipReason = 'Same fictional person appears under an event alias; retain the primary row.';

function parseCsv(text) {
  const records = [];
  let row = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\r' && text[index + 1] === '\n' && !quoted) { records.push([...row, cell]); row = []; cell = ''; index++; }
    else cell += char;
  }
  assert(!quoted, 'CSV quotes must close');
  const [header, ...data] = records;
  header[0] = header[0].replace(/^\uFEFF/u, '');
  return data.map((cells) => {
    assert.equal(cells.length, header.length, 'Every CSV row must match its header');
    return Object.fromEntries(header.map((column, index) => [column, cells[index]]));
  });
}

async function downloadCsv(page, button) {
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  assert(download.suggestedFilename().includes('current-batch'), 'The download filename must identify batch scope');
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return parseCsv(Buffer.concat(chunks).toString('utf8'));
}

const browser = await chromium.launch({ executablePath, headless: true });
const outcomes = [];
try {
  for (const provider of ['hubspot', 'salesforce']) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const tag = `import-controls-${provider}-${randomUUID()}`;
    const errors = [], previews = [], executed = [], workspaceSaves = [];
    let rejectNextSkip = true, releasePreview, firstPreviewStarted;
    const firstPreview = new Promise((resolve) => { firstPreviewStarted = resolve; });
    const previewGate = new Promise((resolve) => { releasePreview = resolve; });
    let crmRequests = 0, writeback = null;
    page.on('pageerror', (error) => errors.push(error.message));
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base.origin) { errors.push(`Blocked external request: ${url.origin}`); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const endpoint = url.pathname.replace('/api/control-tower/', '');
      if (endpoint === 'workspace') {
        if (request.method() === 'POST') {
          const body = request.postDataJSON();
          workspaceSaves.push(body);
          if (body.reason === 'import_row_skipped' && rejectNextSkip) {
            rejectNextSkip = false;
            return route.fulfill({ status: 500, json: { error: 'Intentional save failure for browser regression.' } });
          }
        }
        return route.continue();
      }
      if (endpoint === 'runs') return route.continue();
      if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: false,
        connectors: ['csv', 'hubspot', 'salesforce'].map((id) => ({ id, label: id, configured: true,
          directions: ['source', 'destination'], phases: [], mode: 'direct', features: ['safe-writeback', 'account-scan'] })) } });
      if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from import-controls regression.' } });
      if (endpoint === 'duplicate-scan' && request.method() === 'GET') return route.fulfill({ json: { scan: null } });
      try {
        assert.equal(endpoint, 'crm-writeback', `Unhandled private endpoint: ${endpoint}`);
        crmRequests++;
        const body = request.postDataJSON();
        assert.equal(body.connectorId, provider);
        assert(['preview', 'execute'].includes(body.action));
        const at = new Date().toISOString();
        if (body.action === 'preview') {
          previews.push(body);
          if (previews.length === 1) { firstPreviewStarted(); await previewGate; }
          const duplicateRows = body.contacts.filter((contact) => contact.contactId.startsWith('IMPORT-PRIYA-'));
          const records = body.contacts.map((contact) => {
            const marcus = contact.contactId === 'IMPORT-MARCUS';
            const held = !marcus && duplicateRows.length === 2;
            const after = Object.fromEntries(fields.map((field) => [field, contact[field] ?? null]));
            const before = marcus ? { ...after, jobTitle: null, website: 'https://www.adobe.com' } : null;
            const changes = marcus ? [{ field: 'jobTitle', before: null, after: after.jobTitle }] : [];
            if (marcus) {
              if (body.updatePolicy.clearBlanks) changes.push({ field: 'website', before: before.website, after: null });
              else after.website = before.website;
            }
            return { contactId: contact.contactId, email: contact.email, nativeId: marcus ? `${provider}-native-marcus` : null,
              operation: marcus ? 'update' : held ? 'hold' : 'create',
              matches: marcus ? [{ nativeId: `${provider}-native-marcus`, objectType: provider === 'hubspot' ? 'contact' : 'lead', email: contact.email }] : [],
              before, after, changes,
              reason: held ? 'Possible duplicate in the saved import. Review both rows before creating a contact.' : null,
              possibleMatches: [], possibleImportMatches: held ? duplicateRows.filter((other) => other.contactId !== contact.contactId)
                .map((other) => ({ contactId: other.contactId, email: other.email, fullName: 'Priya Nair', score: 72,
                  evidence: [{ key: 'phone', label: 'Same normalized phone', weight: 44, tone: 'strong' }] })) : [],
              createReview: marcus ? undefined : { status: held ? 'held' : 'clear', scanId: `${tag}-scan`, startedAt: at,
                ruleVersion: 'browser-fixture', candidateCount: 0, importCandidateCount: held ? 1 : 0, warnings: [] } };
          });
          return route.fulfill({ json: { planId: `${tag}-plan-${previews.length}`, fingerprint: 'fictional-plan', connectorId: provider,
            updatePolicy: body.updatePolicy, sourceFile: body.sourceFile, createdAt: at, expiresAt: new Date(Date.now() + 900_000).toISOString(),
            requested: records.length, creates: records.filter((record) => record.operation === 'create').length,
            updates: records.filter((record) => record.operation === 'update').length, unchanged: 0,
            held: records.filter((record) => record.operation === 'hold').length, records } });
        }
        executed.push(body);
        assert.equal(executed.length, 1);
        assert.deepEqual(body.contacts.map((contact) => contact.contactId), ['IMPORT-PRIYA-1', 'IMPORT-MARCUS']);
        assert.deepEqual(body.updatePolicy, finalPolicy);
        assert.deepEqual(body.plan.updatePolicy, finalPolicy);
        writeback = { accepted: true, status: 'executed', runId: `${tag}-write`, connectorId: provider, planId: body.plan.planId,
          requested: 2, created: 1, updated: 1, unchanged: 0, held: 0, failed: 0, completedAt: at,
          // Deliberately reverse receipt order: CSV must join by contact ID.
          records: [...body.plan.records].reverse().map((record) => ({ contactId: record.contactId, email: record.email,
            nativeId: record.nativeId ?? `${provider}-native-priya`, status: record.operation === 'update' ? 'updated' : 'created', error: null })), rollback: null };
        return route.fulfill({ status: 202, json: writeback });
      } catch (error) { errors.push(error.message); return route.fulfill({ status: 400, json: { error: error.message } }); }
    });
    try {
      await page.goto(new URL('/app/lab', base).href);
      await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
      await page.getByLabel('Where should clean records go?').selectOption(provider);
      await page.locator('input[type=file]').setInputFiles({ name: 'import-controls.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
      await page.locator('summary').filter({ hasText: /^Choose rows to import ·/u }).click();
      const selection = page.getByRole('region', { name: 'Import row decisions', exact: true });
      const skipButton = () => selection.getByRole('button', { name: `Skip row ${skippedId}`, exact: true });
      const mode = () => page.getByRole('combobox', { name: /^Update existing CRM records/u });
      const compare = (count) => page.getByRole('button', { name: `Compare ${count} with CRM`, exact: true });
      const previewButton = () => page.getByRole('button', { name: 'Download comparison CSV', exact: true });
      const saveChange = async (action) => {
        const [response] = await Promise.all([page.waitForResponse((response) => new URL(response.url()).pathname === '/api/control-tower/workspace'
          && response.request().method() === 'POST' && response.request().postDataJSON().action === 'save'), action()]);
        assert.equal(response.status(), 200, 'Workspace change must save successfully');
        await page.getByText(/SQLite r\d+ · saved/, { exact: true }).waitFor();
      };
      await compare(3).click();
      await firstPreview;
      assert(await skipButton().isDisabled(), 'Row decisions must be disabled during a CRM request');
      assert(await mode().isDisabled(), 'Update policy must be disabled during a CRM request');
      releasePreview();
      await page.getByRole('button', { name: 'Execute 1 approved changes', exact: true }).waitFor();
      assert.deepEqual(previews[0].updatePolicy, defaultPolicy);
      const initialCount = crmRequests;
      const heldCsv = await downloadCsv(page, previewButton());
      assert.deepEqual(heldCsv.map((row) => row.planned_action), ['hold', 'hold', 'update']);
      assert(heldCsv.every((row) => row.outcome === '' && row.report_scope === 'current_batch'));
      assert.equal(JSON.parse(heldCsv[0].import_candidates)[0].contactId, skippedId);
      assert.equal(crmRequests, initialCount, 'A comparison download must never call the CRM');
      await selection.getByLabel(`Reason for skipping ${skippedId}`, { exact: true }).fill(skipReason);
      await skipButton().click();
      await selection.getByRole('alert').filter({ hasText: 'No selection changed' }).waitFor();
      assert(await skipButton().isVisible());
      assert(await page.getByRole('button', { name: 'Execute 1 approved changes', exact: true }).isVisible(), 'Failed save must preserve the old comparison');
      await selection.getByText(/^3 included · 0 skipped\./u).waitFor();
      await saveChange(() => skipButton().click());
      await compare(2).waitFor();
      assert.equal(await previewButton().count(), 0, 'Saved row decision invalidates the comparison');
      await page.reload();
      await page.locator('summary').filter({ hasText: /^Choose rows to import ·/u }).click();
      await selection.getByText(`Skipped: ${skipReason}`, { exact: true }).waitFor();
      await compare(2).waitFor();
      await saveChange(() => selection.getByRole('button', { name: `Restore row ${skippedId}`, exact: true }).click());
      await compare(3).waitFor();
      await selection.getByLabel(`Reason for skipping ${skippedId}`, { exact: true }).fill(skipReason);
      await saveChange(() => skipButton().click());
      await compare(2).click();
      await page.getByRole('button', { name: 'Execute 2 approved changes', exact: true }).waitFor();
      await saveChange(() => mode().selectOption('replace'));
      assert.equal(await previewButton().count(), 0, 'Changing policy invalidates the comparison');
      await compare(2).waitFor();
      for (const field of ['first name', 'last name', 'company', 'phone']) {
        await saveChange(() => page.getByRole('checkbox', { name: `Update ${field}`, exact: true }).click());
        assert(!await page.getByRole('checkbox', { name: `Update ${field}`, exact: true }).isChecked());
      }
      await saveChange(() => page.getByRole('checkbox', { name: 'Allow blank values to clear selected fields', exact: true }).click());
      await page.reload();
      await compare(2).waitFor();
      assert.equal(await mode().inputValue(), 'replace');
      for (const field of ['first name', 'last name', 'company', 'phone']) assert(!await page.getByRole('checkbox', { name: `Update ${field}`, exact: true }).isChecked());
      for (const field of ['job title', 'website']) assert(await page.getByRole('checkbox', { name: `Update ${field}`, exact: true }).isChecked());
      assert(await page.getByRole('checkbox', { name: 'Allow blank values to clear selected fields', exact: true }).isChecked());
      await compare(2).click();
      await page.getByRole('button', { name: 'Execute 2 approved changes', exact: true }).waitFor();
      assert.deepEqual(previews.at(-1).updatePolicy, finalPolicy);
      for (const preview of previews.slice(1)) assert(!preview.contacts.some((contact) => contact.contactId === skippedId), 'Skipped contact must not be compared or written');
      const beforeDownloads = crmRequests;
      const comparisonCsv = await downloadCsv(page, previewButton());
      assert.deepEqual(comparisonCsv.map((row) => [row.contact_id, row.planned_action, row.outcome]), [['IMPORT-PRIYA-1', 'create', ''], ['IMPORT-MARCUS', 'update', '']]);
      assert.deepEqual(JSON.parse(comparisonCsv[0].update_policy), finalPolicy);
      assert.deepEqual(JSON.parse(comparisonCsv[1].field_changes), [
        { field: 'jobTitle', before: null, after: 'VP of Operations' },
        { field: 'website', before: 'https://www.adobe.com', after: null },
      ]);
      assert.equal(crmRequests, beforeDownloads);
      await mode().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/gtm-import-controls-${provider}-desktop.png` });
      await page.getByRole('group', { name: 'Existing CRM records', exact: true }).locator('..')
        .screenshot({ path: `/tmp/gtm-import-controls-${provider}-policy.png` });
      const decisions = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Choose rows to import ·/u }) });
      if (!await decisions.evaluate((element) => element.open)) await decisions.locator('summary').click();
      await selection.getByLabel('Find import row', { exact: true }).fill(skippedId);
      await selection.getByText(`Skipped: ${skipReason}`, { exact: true }).waitFor();
      await decisions.screenshot({ path: `/tmp/gtm-import-controls-${provider}-selection.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await previewButton().scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Import controls must not overflow mobile width');
      const [savedReceipt] = await Promise.all([page.waitForResponse((response) => new URL(response.url()).pathname === '/api/control-tower/runs' && response.request().method() === 'POST'),
        page.getByRole('button', { name: 'Execute 2 approved changes', exact: true }).click()]);
      assert.equal(savedReceipt.status(), 201, 'Actual receipt must reach local durable history');
      await page.goto(new URL('/runs', base).href);
      await page.getByRole('button', { name: 'Download results CSV', exact: true }).waitFor();
      await page.reload();
      const resultButton = page.getByRole('button', { name: 'Download results CSV', exact: true });
      await resultButton.waitFor();
      const requestsBeforeResult = crmRequests;
      const resultsCsv = await downloadCsv(page, resultButton);
      assert.equal(crmRequests, requestsBeforeResult, 'A persisted results download must never call the CRM');
      assert.deepEqual(resultsCsv.map((row) => [row.contact_id, row.outcome, row.native_id]), [
        ['IMPORT-PRIYA-1', 'created', `${provider}-native-priya`], ['IMPORT-MARCUS', 'updated', `${provider}-native-marcus`],
      ]);
      assert(resultsCsv.every((row) => row.source_file === 'import-controls.csv' && row.run_id === writeback.runId && row.report_kind === 'results'));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Saved results controls must fit mobile width');
      await page.screenshot({ path: `/tmp/gtm-import-controls-${provider}-mobile.png` });
      assert.equal(workspaceSaves.filter((body) => body.reason === 'import_row_skipped').length, 3, 'One failed skip, a successful retry, and a post-restore skip were attempted');
      assert.deepEqual(errors, []);
      outcomes.push({ provider, passed: true, savedSkipAndRestore: true, failedSavePreservedComparison: true,
        savedPolicy: finalPolicy, csvPreviewAndPersistedResults: true, mobileWidth: 390 });
    } catch (error) { outcomes.push({ provider, passed: false, error: error.message, errors, previews: previews.length, executions: executed.length }); }
    finally { releasePreview(); await context.close(); }
  }
  console.log(JSON.stringify({ outcomes, liveCrmRequests: 0, crmResponses: 'simulated; local workspace and run persistence are real' }));
  assert(outcomes.every((outcome) => outcome.passed), 'Import-controls browser regression failed');
} finally { await browser.close(); }
