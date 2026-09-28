import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

// CRM reads, confirmation validation, and plans are deliberate browser fixtures.
// Workspace saves/reloads use the real local app. Route tests cover native reads,
// signed confirmations, stale checks, and writes; this test makes no CRM calls.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a disposable local app with persistence enabled.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an installed Chrome or Chromium executable.');
const contactId = 'IMPORT-PRIYA';
const importedEmail = 'priya.nair@salesforce.example.com';
const nativeEmail = 'p.nair@salesforce.example.com';
const reason = 'Same full name, direct phone, company and state; event registration used an alternate email.';
const csv = 'contact_id,first_name,last_name,email,company,phone,state,region,segment,owner_id,job_title,website\n'
  + `${contactId},Priya,Nair,${importedEmail},Salesforce,415-555-0142,CA,West,Enterprise,fixture-owner,Director,\n`;
const matchFields = ['name', 'email', 'phone', 'state', 'company'];
const portableFields = ['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website'];

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
  assert(!quoted, 'CSV quotes must close.');
  const [header, ...data] = records;
  header[0] = header[0].replace(/^\uFEFF/u, '');
  return data.map((cells) => {
    assert.equal(cells.length, header.length);
    return Object.fromEntries(header.map((column, index) => [column, cells[index]]));
  });
}

async function workspaceRead(context, workspaceId) {
  const response = await context.request.get(new URL(`/api/control-tower/workspace?id=${encodeURIComponent(workspaceId)}`, base).href);
  assert.equal(response.status(), 200);
  return (await response.json()).workspace;
}

async function workspaceSave(context, workspace, saveReason) {
  const response = await context.request.post(new URL('/api/control-tower/workspace', base).href, {
    data: { action: 'save', id: workspace.id, state: workspace.state, reason: saveReason },
  });
  assert.equal(response.status(), 200, `Real workspace save failed: ${await response.text()}`);
  return response.json();
}

const browser = await chromium.launch({ executablePath, headless: true });
const outcomes = [];
try {
  for (const provider of ['hubspot', 'salesforce']) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const nativeId = provider === 'hubspot' ? '991001' : '00Q000000000001AAA';
    const objectType = provider === 'hubspot' ? 'contact' : 'lead';
    const tag = `match-decision-${provider}-${randomUUID()}`;
    const at = new Date().toISOString();
    const nativeFields = { firstName: 'Priya', lastName: 'Nair', company: 'Salesforce', phone: '415-555-0142', jobTitle: null, website: null };
    const target = { nativeId, objectType, ...(provider === 'salesforce' ? { isConverted: false } : {}), email: nativeEmail, fields: nativeFields };
    const identity = { recordKey: `${provider}:${objectType}:${nativeId}`, connectorId: provider, objectType, nativeId,
      firstName: 'Priya', lastName: 'Nair', fullName: 'Priya Nair', email: nativeEmail, company: 'Salesforce', phone: '415-555-0142',
      state: 'CA', jobTitle: '', website: '', createdAt: null, updatedAt: null };
    const scan = { id: `${tag}-scan`, connectorId: provider, status: 'complete', complete: true, sourceComplete: true,
      recordsScanned: provider === 'hubspot' ? 1 : 2, pagesScanned: 1, analysisWarnings: [], startedAt: at, completedAt: at };
    const errors = [], actions = [];
    let rejectNextConfirmation = true, matchingRequests = 0, previews = 0, workspaceId;
    page.on('pageerror', (error) => errors.push(error.message));
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base.origin) { errors.push(`Blocked external request: ${url.origin}`); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const endpoint = url.pathname.replace('/api/control-tower/', '');
      if (endpoint === 'workspace') return route.continue();
      if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: false,
        connectors: ['csv', 'hubspot', 'salesforce'].map((id) => ({ id, label: id, configured: true,
          directions: ['source', 'destination'], phases: [], mode: 'direct', features: ['safe-writeback', 'account-scan'] })) } });
      if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from this regression.' } });
      if (endpoint === 'duplicate-scan' && request.method() === 'GET') return route.fulfill({ json: { scan } });
      try {
        const body = request.postDataJSON();
        assert.equal(body.connectorId, provider);
        workspaceId = body.workspaceId;
        if (endpoint === 'import-matches') {
          matchingRequests++;
          assert.equal(body.contacts.length, 1);
          const input = body.contacts[0];
          const candidate = { record: identity, score: 82, evidence: [{ key: 'phone', label: 'Same normalized phone', weight: 44, tone: 'strong' }],
            comparisons: matchFields.map((field) => ({ field, imported: field === 'name' ? input.fullName : input[field],
              existing: field === 'name' ? 'Priya Nair' : field === 'email' ? nativeEmail : identity[field], status: field === 'email' ? 'conflict' : 'match' })) };
          const candidates = [candidate];
          if (provider === 'salesforce') candidates.push({ ...candidate, record: { ...identity, recordKey: 'salesforce:contact:003000000000001AAA', objectType: 'contact', nativeId: '003000000000001AAA' } });
          return route.fulfill({ json: { scan, report: { ruleVersion: 'browser-fixture', fields: body.fields, warnings: [],
            rows: [{ contactId, input, candidates, candidateCount: candidates.length, warnings: [] }] } } });
        }
        if (endpoint === 'import-match-decision') {
          actions.push(body);
          if (body.action === 'confirm' && rejectNextConfirmation) {
            rejectNextConfirmation = false;
            return route.fulfill({ status: 500, json: { error: 'Intentional confirmation save failure; your previous selection is unchanged.' } });
          }
          const workspace = await workspaceRead(context, workspaceId);
          assert.equal(body.revision, workspace.revision, 'Decision request must carry the current saved revision.');
          const contact = workspace.state.contacts.find((row) => row.contactId === contactId);
          if (body.action === 'confirm') {
            assert.equal(body.nativeId, nativeId);
            assert.equal(body.objectType, objectType);
            assert.equal(body.scanId, scan.id);
            assert.equal(body.reason, reason);
            assert(body.fields.includes('phone') && body.fields.length > 0, 'Confirmation must include the viewed matching fields.');
            contact.crmMatchDecisions = { [provider]: { connectorId: provider, scanId: scan.id, sourceKey: body.sourceKey,
              target, reason: body.reason, confirmedAt: at, signature: 'a'.repeat(64) } };
          } else {
            assert.equal(body.action, 'clear');
            delete contact.crmMatchDecisions[provider];
          }
          return route.fulfill({ json: await workspaceSave(context, workspace, 'browser_match_decision_fixture') });
        }
        assert.equal(endpoint, 'crm-writeback', `Unhandled private endpoint: ${endpoint}`);
        assert.equal(body.action, 'preview', 'Browser regression must never execute a CRM write.');
        previews++;
        const workspace = await workspaceRead(context, workspaceId);
        const decision = workspace.state.contacts[0].crmMatchDecisions?.[provider];
        const input = body.contacts[0];
        const matchDecision = decision ? { nativeId, email: nativeEmail, reason: decision.reason, confirmedAt: decision.confirmedAt } : undefined;
        const record = { contactId, email: importedEmail, nativeId: decision ? nativeId : null, operation: decision ? 'update' : 'hold',
          matches: decision ? [{ nativeId, objectType, email: nativeEmail }] : [], before: decision ? nativeFields : null,
          after: Object.fromEntries(portableFields.map((field) => [field, input[field] ?? null])),
          changes: decision ? [{ field: 'jobTitle', before: null, after: 'Director' }] : [],
          reason: decision ? null : 'Possible existing person; review and confirm the matching record.', ...(matchDecision ? { matchDecision } : {}) };
        return route.fulfill({ json: { planId: `${tag}-plan-${previews}`, fingerprint: 'fictional-plan', connectorId: provider,
          sourceFile: body.sourceFile, updatePolicy: body.updatePolicy, createdAt: at, expiresAt: new Date(Date.now() + 900_000).toISOString(),
          requested: 1, creates: 0, updates: decision ? 1 : 0, unchanged: 0, held: decision ? 0 : 1, records: [record] } });
      } catch (error) { errors.push(error.message); return route.fulfill({ status: 400, json: { error: error.message } }); }
    });
    try {
      await page.goto(new URL('/app/lab', base).href);
      await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
      await page.getByLabel('Where should clean records go?').selectOption(provider);
      await page.locator('input[type=file]').setInputFiles({ name: 'match-decision.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
      const review = page.getByRole('region', { name: 'Approximate CRM matches', exact: true });
      const saved = page.getByRole('region', { name: 'Confirmed CRM matches', exact: true });
      const compare = () => page.getByRole('button', { name: 'Compare 1 with CRM', exact: true });
      const download = () => page.getByRole('button', { name: 'Download comparison CSV', exact: true });
      const findSuggestions = () => review.getByRole('button', { name: 'Find suggestions for these rows', exact: true });
      await compare().click();
      await download().waitFor();
      await findSuggestions().click();
      const reasonInput = review.getByRole('textbox', { name: `Reason for matching ${contactId} to ${nativeId}`, exact: true });
      const confirm = review.getByRole('button', { name: 'Use this existing record', exact: true });
      await reasonInput.waitFor();
      assert.equal(await confirm.count(), 1, 'Only a supported CRM object has a confirmation button.');
      assert(await confirm.isDisabled(), 'A reason is required before confirmation.');
      if (provider === 'salesforce') await review.getByText(/It cannot be selected as an update target\./u).waitFor();
      await reasonInput.fill('   ');
      assert(await confirm.isDisabled(), 'Whitespace cannot satisfy the reason requirement.');
      await reasonInput.fill(reason);
      await confirm.click();
      await review.getByRole('alert').filter({ hasText: 'Intentional confirmation save failure' }).waitFor();
      assert.equal(await reasonInput.inputValue(), reason, 'A failed confirmation must preserve the reason.');
      assert(await download().isVisible(), 'A failed confirmation must preserve the prior preview.');
      assert.equal(await saved.count(), 0);
      await confirm.click();
      await saved.getByText(`Reason: ${reason}`, { exact: true }).waitFor();
      await compare().waitFor();
      assert.equal(await download().count(), 0, 'A saved confirmation invalidates the previous preview.');
      const persisted = await workspaceRead(context, workspaceId);
      const decision = persisted.state.contacts[0].crmMatchDecisions[provider];
      assert.equal(decision.target.email, nativeEmail);
      assert.equal(decision.target.nativeId, nativeId);
      assert.equal(decision.reason, reason);
      const beforeReloadMatches = matchingRequests;
      await page.reload();
      await saved.getByText(`Reason: ${reason}`, { exact: true }).waitFor();
      await saved.getByText(`Preserved CRM email: ${nativeEmail}`, { exact: true }).waitFor();
      assert.equal(matchingRequests, beforeReloadMatches, 'Saved decision appears without rerunning suggestions.');
      assert.equal(await reasonInput.count(), 0, 'Reload should not fabricate a suggestion report.');
      await compare().click();
      const planRow = page.locator('[aria-label="CRM comparison records"] details');
      await planRow.locator('summary').click();
      await planRow.getByText(`Human-confirmed existing record · ${nativeId}`, { exact: true }).waitFor();
      await planRow.getByText(`Existing CRM email preserved: ${nativeEmail}`, { exact: true }).waitFor();
      await planRow.getByText(`Reason: ${reason}`, { exact: true }).waitFor();
      assert.equal(await planRow.getByText('No exact email match returned by the completed lookup.', { exact: true }).count(), 0);
      const [file] = await Promise.all([page.waitForEvent('download'), download().click()]);
      const stream = await file.createReadStream(), chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const [csvRow] = parseCsv(Buffer.concat(chunks).toString('utf8'));
      assert.equal(csvRow.match_basis, 'human_confirmed');
      assert.equal(csvRow.matched_native_email, nativeEmail);
      assert.equal(csvRow.match_confirmation_reason, reason);
      assert.equal(csvRow.match_confirmed_at, at);
      assert.equal(csvRow.email, importedEmail);
      assert.equal(csvRow.exact_matches, '');
      assert.equal(csvRow.exact_match_count, '');
      assert.equal(csvRow.outcome, '', 'A comparison download must not invent a CRM outcome.');
      await saved.screenshot({ path: `/tmp/gtm-import-match-${provider}-saved.png` });
      await planRow.screenshot({ path: `/tmp/gtm-import-match-${provider}-plan.png` });
      const changed = await workspaceRead(context, workspaceId);
      changed.state.contacts[0].jobTitle = 'Senior Director';
      await workspaceSave(context, changed, 'browser_source_change_fixture');
      await page.reload();
      await saved.getByText(/Its saved match is stale/u).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await saved.scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Saved decisions must fit a mobile viewport.');
      await saved.screenshot({ path: `/tmp/gtm-import-match-${provider}-mobile.png` });
      await saved.getByRole('button', { name: `Clear confirmed match for ${contactId}`, exact: true }).click();
      await saved.waitFor({ state: 'detached' });
      await page.reload();
      await compare().waitFor();
      assert.equal(await saved.count(), 0, 'Clearing a confirmed match persists after reload.');
      assert.equal((await workspaceRead(context, workspaceId)).state.contacts[0].crmMatchDecisions?.[provider], undefined);
      assert.deepEqual(actions.map((action) => action.action), ['confirm', 'confirm', 'clear']);
      assert.deepEqual(errors, []);
      outcomes.push({ provider, passed: true, failedSavePreservedReasonAndPlan: true, savedConfirmationReloaded: true,
        sourceChangeMarkedStale: true, clearPersisted: true, humanConfirmedPlanAndCsv: true, mobileWidth: 390 });
    } catch (error) { outcomes.push({ provider, passed: false, error: error.message, errors, actions: actions.length, previews }); }
    finally { await context.close(); }
  }
  console.log(JSON.stringify({ outcomes, liveCrmRequests: 0, crmResponses: 'simulated; local workspace persistence is real' }));
  assert(outcomes.every((outcome) => outcome.passed), 'Import-match-decision browser regression failed.');
} finally { await browser.close(); }
