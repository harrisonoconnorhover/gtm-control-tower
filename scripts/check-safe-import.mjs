import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

// Whole-review and CRM outcomes are UI fixtures. Real local workspace persistence
// verifies settings, file identity, invalidation, and reload. Route tests exercise
// actual matching and execution against a mock provider, rather than a live CRM.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3021');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a disposable local server.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
const provider = process.env.SAFE_IMPORT_PROVIDER === 'salesforce' ? 'salesforce' : 'hubspot';
const providerLabel = provider === 'salesforce' ? 'Salesforce' : 'HubSpot';
const approvalLabel = `Approve 57 ${provider === 'salesforce' ? 'record' : 'contact'} updates`;
const fields = ['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website'];
const policy = { mode: 'fill-empty', fields, clearBlanks: false };
const csv = 'contact_id,first_name,last_name,email,company,phone,state,region,segment,owner_id,job_title,website\n'
  + Array.from({ length: 103 }, (_, index) => `ROW-${index},Contact,${index},contact${index}@example.com,Example Inc,212-555-${String(index).padStart(4, '0')},NY,East,SMB,fixture-owner,${index === 0 ? '=1+1' : 'Operations Director'},\n`).join('');
const fileHash = createHash('sha256').update(csv).digest('hex');
const scan = { id: 'safe-import-contact-snapshot', connectorId: provider, status: 'complete', complete: true, sourceComplete: true, recordsScanned: 1, pagesScanned: 1, analysisWarnings: [], startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
const errors = [], saves = [], requests = [];
let savedReview = null, execution = null, approvals = 0, reconciliations = 0, preparations = 0;
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on('pageerror', (error) => errors.push(error.message));

function makeReview(workspace) {
  const rows = workspace.state.contacts.map((contact, index) => {
    const status = contact.importExclusion ? 'skipped' : index < 57 ? 'proposed-update' : index < 80 ? 'unchanged'
      : index < 92 ? 'held' : index < 100 ? 'unmatched' : preparations === 1 ? 'unresolved' : 'held';
    const objectType = provider === 'salesforce' && index % 2 === 1 ? 'lead' : 'contact';
    const matched = status === 'proposed-update' || status === 'unchanged';
    const before = { firstName: 'Contact', lastName: String(index), company: 'Example Inc', phone: status === 'proposed-update' ? null : contact.phone,
      jobTitle: 'Head of Operations', website: 'example.com' };
    const incoming = { firstName: 'Contact', lastName: String(index), company: contact.company, phone: contact.phone, jobTitle: contact.jobTitle, website: null };
    const after = { ...before, ...(status === 'proposed-update' ? { phone: contact.phone } : {}) };
    const fieldDecisions = fields.map((field) => ({ field, importedValue: incoming[field], currentValue: matched ? before[field] : null,
      proposedValue: matched ? after[field] : null, action: !matched ? 'review' : provider === 'salesforce' && objectType === 'contact' && ['company', 'website'].includes(field) ? 'preserve' : field === 'phone' && status === 'proposed-update' ? 'fill'
        : before[field] === incoming[field] ? 'unchanged' : 'preserve', reasonCode: !matched ? 'record-held' : provider === 'salesforce' && objectType === 'contact' && ['company', 'website'].includes(field) ? 'salesforce-contact-account-field-protected'
          : field === 'phone' && status === 'proposed-update' ? 'fill-empty-field' : before[field] === incoming[field] ? 'same-value'
            : incoming[field] === null ? 'blank-import-preserved' : 'populated-crm-value-preserved' }));
    const reason = status === 'held' ? 'Company and phone suggest an existing person, but the email differs. No update is scheduled.'
      : status === 'unmatched' ? `No confirmed existing ${providerLabel} record. No record will be created.`
        : status === 'unresolved' ? 'The CRM lookup did not complete. This is not proof the person is absent.' : contact.importExclusion?.reason ?? null;
    return { contactId: contact.contactId, email: contact.rawEmail, status, reason, record: {
      contactId: contact.contactId, email: contact.rawEmail, nativeId: matched ? `native-${index}` : null,
      operation: status === 'proposed-update' ? 'update' : status === 'unchanged' ? 'unchanged' : 'hold', matches: matched
        ? [{ nativeId: `native-${index}`, objectType, email: contact.rawEmail }] : [],
      before: matched ? before : null, after, fieldDecisions, changes: status === 'proposed-update'
        ? [{ field: 'phone', before: null, after: contact.phone }] : [], reason,
    } };
  });
  const counts = { 'proposed-update': 0, unchanged: 0, held: 0, unmatched: 0, skipped: 0, unresolved: 0 };
  rows.forEach((row) => counts[row.status]++);
  return { id: randomUUID(), workspaceId: workspace.id, workspaceRevision: workspace.revision, connectorId: provider,
    account: { connectorId: provider, accountId: 'fictional-safe-import-account' }, sourceFile: workspace.state.fileName,
    sourceFileHash: workspace.state.sourceFileHash, workspaceFingerprint: 'ui-fixture', mapping: workspace.state.mapping,
    recordMode: 'update-existing', updatePolicy: policy, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 900_000).toISOString(), complete: counts.unresolved === 0, plans: [], rows, counts };
}

await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { errors.push(`Blocked external request: ${url.origin}`); return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const endpoint = url.pathname.replace('/api/control-tower/', '');
  if (endpoint === 'workspace') {
    if (request.method() === 'POST') saves.push(request.postDataJSON());
    return route.continue();
  }
  if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: false,
    connectors: ['csv', 'hubspot', 'salesforce'].map((id) => ({ id, label: id, configured: true, directions: ['source', 'destination'], phases: [],
      mode: 'direct', features: ['safe-writeback', 'account-scan'] })) } });
  if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from Safe Import UI regression.' } });
  if (endpoint === 'duplicate-scan' && request.method() === 'GET') return route.fulfill({ json: { scan: provider === 'salesforce' ? scan : null } });
  if (endpoint === 'import-matches' && provider === 'salesforce') {
    const body = request.postDataJSON(), input = body.contacts[0];
    assert.equal(body.connectorId, 'salesforce');
    const identity = { recordKey: 'salesforce:contact:003SAFEIMPORT80', connectorId: provider, objectType: 'contact', nativeId: '003SAFEIMPORT80', firstName: 'Contact', lastName: '80', fullName: 'Contact 80', email: 'contact80-other@example.com', company: 'Example Inc', phone: input.phone, state: 'NY', jobTitle: '', website: '', createdAt: null, updatedAt: null };
    return route.fulfill({ json: { scan, report: { ruleVersion: 'safe-import-ui-fixture', fields: body.fields, warnings: [], rows: [{ contactId: input.contactId, input, candidateCount: 1, warnings: [], candidates: [{ record: identity, score: 80, evidence: [{ key: 'phone', label: 'Same phone', weight: 44, tone: 'strong' }], comparisons: [{ field: 'email', imported: input.email, existing: identity.email, status: 'conflict' }] }] }] } } });
  }
  try {
    assert.equal(endpoint, 'safe-import', `Unexpected endpoint: ${endpoint}`);
    const body = request.postDataJSON(); requests.push(body);
    assert.deepEqual(Object.keys(body).sort(), body.action === 'prepare' || (body.action === 'load' && !body.reviewId) ? ['action', 'workspaceId'] : ['action', 'reviewId', 'workspaceId'], 'The browser must submit ids rather than replacement plans or contacts.');
    if (body.action === 'load' && !savedReview) return route.fulfill({ json: { review: null, execution: null } });
    if (body.action === 'prepare') {
      preparations++;
      const response = await page.request.get(new URL(`/api/control-tower/workspace?id=${encodeURIComponent(body.workspaceId)}`, base).href);
      assert(response.ok());
      const { workspace } = await response.json();
      assert.equal(workspace.state.importRecipe, 'safe-update-contacts');
      assert.equal(workspace.state.importRecordMode, 'update-existing');
      assert.equal(workspace.state.destinationType, provider);
      assert.equal(workspace.state.sourceFileHash, fileHash);
      assert.deepEqual(workspace.state.crmUpdatePolicy, policy);
      savedReview = makeReview(workspace); execution = null;
    } else {
      if (body.reviewId) assert.equal(body.reviewId, savedReview.id);
      if (body.action === 'approve') {
        approvals++;
        assert.equal(approvals, 1, 'Interrupted approval must never be sent twice by the UI.');
        execution = { id: randomUUID(), executionKey: randomUUID(), reviewId: savedReview.id, workspaceId: savedReview.workspaceId,
          account: savedReview.account, approvedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(), status: 'reconciliation-required', records: savedReview.rows.filter((row) => row.status === 'proposed-update').map((row, index) => ({
            contactId: row.contactId, nativeId: row.record.nativeId, status: index === 56 ? 'unknown' : 'accepted', error: index === 56 ? 'Response interrupted after sending the update.' : null,
            ...(index < 55 ? { verification: { status: 'verified', checkedAt: new Date().toISOString(), expected: { email: row.email, fields: row.record.after }, actual: { email: row.email, fields: row.record.after }, error: null } } : {}),
          })) };
        return route.abort('failed'); // Simulate a lost HTTP response after durable execution creation.
      }
      if (body.action === 'recover') {
        assert(execution); execution.status = 'reconciliation-required'; reconciliations++;
        execution.records.forEach((record, index) => {
          record.status = index === 56 ? 'unknown' : 'accepted'; record.error = index === 56 ? 'Response interrupted after sending the update.' : null;
          const status = index < 55 ? 'verified' : index === 55 ? 'different' : reconciliations === 1 ? 'unavailable' : 'verified';
          record.verification = { status, checkedAt: new Date().toISOString(),
            expected: { email: 'fixture@example.com', fields: {} }, actual: status === 'unavailable' ? null : { email: 'fixture@example.com', fields: {} }, error: status === 'unavailable' ? 'Native record could not be read.' : null };
        });
      }
    }
    return route.fulfill({ json: { review: savedReview, ...(execution ? { execution } : {}) } });
  } catch (error) { errors.push(error.message); return route.fulfill({ status: 400, json: { error: error.message } }); }
});

try {
  await page.goto(new URL('/app/lab', base).href);
  await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
  if (provider === 'salesforce') await page.getByRole('combobox', { name: 'Where should clean records go?', exact: true }).selectOption('salesforce');
  await page.locator('summary').filter({ hasText: 'Describe the import you want' }).click();
  await page.getByLabel('Your request', { exact: true }).fill('Update existing contacts without wiping out good information, flag questionable matches, and show me exactly what will happen.');
  await page.getByRole('button', { name: 'Interpret request', exact: true }).click();
  await page.getByText('Proposed import rules', { exact: true }).waitFor();
  assert.equal(saves.filter((body) => body.reason === 'import_recipe_changed').length, 0, 'Interpretation must not adopt settings or write to the CRM.');
  await page.getByRole('button', { name: 'Adopt Safe Import rules', exact: true }).click();
  await page.getByText(`Selected · ${provider === 'salesforce' ? 'Salesforce Leads and Contacts' : 'HubSpot Contacts'}`, { exact: true }).waitFor();
  await page.locator('input[type=file]').first().setInputFiles({ name: 'safe-import-103.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
  const review = () => page.getByRole('region', { name: 'Safe Import review', exact: true });
  await review().getByRole('button', { name: 'Prepare review', exact: true }).click();
  await review().getByRole('button', { name: approvalLabel, exact: true }).waitFor();
  assert(await review().getByRole('button', { name: approvalLabel, exact: true }).isDisabled(), 'Incomplete whole-file lookups cannot be approved.');
  await review().getByText('This file is not fully checked. Unchecked rows cannot be approved.', { exact: true }).waitFor();
  assert.equal(approvals, 0, 'Preparing a review must not approve writes.');
  assert.equal(await page.getByRole('button', { name: /^Compare \d+ with CRM$/ }).count(), 0, 'Old batch comparison must be hidden.');
  const first = review().locator('details').filter({ has: page.locator('summary').filter({ hasText: 'ROW-0 · Proposed update' }) });
  await first.locator('summary').click();
  await first.getByRole('cell', { name: 'Fill the empty field fill', exact: true }).waitFor();
  await first.getByRole('cell', { name: 'Preserve the CRM value; incoming value differs preserve', exact: true }).waitFor();
  if (provider === 'salesforce') {
    await first.getByText(/Existing Salesforce Contact native-0/).waitFor();
    await first.getByRole('cell', { name: 'Preserve the Contact account relationship; company and website are outside this recipe preserve', exact: true }).first().waitFor();
  } else await first.getByRole('cell', { name: 'Preserve the CRM value; imported cell is empty preserve', exact: true }).waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), review().getByRole('button', { name: 'Download whole review (JSON)', exact: true }).click()]);
  const stream = await download.createReadStream(); const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(evidence.review.connectorId, provider);
  if (provider === 'salesforce') {
    assert.equal(evidence.review.rows[0].record.matches[0].objectType, 'contact');
    assert.equal(evidence.review.rows[1].record.matches[0].objectType, 'lead');
  }
  assert.equal(evidence.review.rows.length, 103); assert.equal(evidence.review.sourceFileHash, fileHash);
  assert.equal(evidence.review.rows[0].record.fieldDecisions.length, 6);
  assert.equal(evidence.review.rows[0].record.fieldDecisions.find((decision) => decision.field === 'jobTitle').importedValue, '=1+1', 'JSON preserves exact incoming evidence.');
  const [csvDownload] = await Promise.all([page.waitForEvent('download'), review().getByRole('button', { name: 'Download field decisions (CSV)', exact: true }).click()]);
  const csvStream = await csvDownload.createReadStream(); const csvChunks = []; for await (const chunk of csvStream) csvChunks.push(chunk);
  const decisionsCsv = Buffer.concat(csvChunks).toString('utf8');
  assert(decisionsCsv.includes('"\'=1+1"'), 'Spreadsheet exports neutralize formula cells with an apostrophe.');
  await review().getByLabel('Find reviewed row', { exact: true }).fill('ROW-80');
  const held = review().locator('details').filter({ has: page.locator('summary').filter({ hasText: 'ROW-80 · Identity review' }) });
  await held.locator('summary').first().click();
  await held.getByRole('heading', { name: 'Find possible CRM matches', exact: true }).waitFor();
  if (provider === 'salesforce') {
    await held.getByRole('button', { name: 'Find suggestions for these rows', exact: true }).click();
    await held.getByLabel('Reason for matching ROW-80 to 003SAFEIMPORT80', { exact: true }).fill('Confirm the Contact identity before preparing a fresh review.');
    assert(await held.getByRole('button', { name: 'Use this existing record', exact: true }).isEnabled(), 'Safe Import can confirm a Salesforce Contact, without granting legacy Lead flows this capability.');
    assert.equal(approvals, 0, 'Investigating a Contact must not authorize any CRM write.');
  }
  await held.getByLabel('Reason to skip this row', { exact: true }).fill('Attendee identity needs further confirmation.');
  await held.getByRole('button', { name: 'Skip this row', exact: true }).click();
  await review().getByRole('button', { name: 'Prepare review', exact: true }).waitFor();
  assert.equal(await review().getByRole('button', { name: approvalLabel, exact: true }).count(), 0, 'Saved row changes invalidate approval.');
  await review().getByRole('button', { name: 'Prepare review', exact: true }).click();
  await review().getByRole('button', { name: approvalLabel, exact: true }).waitFor();
  assert.equal(savedReview.counts.skipped, 1);
  assert.equal(savedReview.counts.unresolved, 0);
  assert(await review().getByRole('button', { name: approvalLabel, exact: true }).isEnabled(), 'A fresh complete read can be approved.');
  await review().screenshot({ path: `/tmp/gtm-${provider}-safe-import-desktop.png` });
  await review().getByRole('heading', { name: 'Inspect every row before approving updates', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/gtm-${provider}-safe-import-desktop-viewport.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Safe Import must fit mobile width.');
  await review().screenshot({ path: `/tmp/gtm-${provider}-safe-import-mobile.png` });
  await review().getByRole('heading', { name: 'Inspect every row before approving updates', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/tmp/gtm-${provider}-safe-import-mobile-viewport.png` });
  await review().getByRole('button', { name: approvalLabel, exact: true }).click();
  await review().getByText(/Saved work remains queued or needs reconciliation/).waitFor();
  assert(await review().getByRole('button', { name: approvalLabel, exact: true }).isDisabled());
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('gtm-control-tower-safe-import')) localStorage.removeItem(key); });
  await page.reload();
  await review().getByText(/Execution: 56 updates accepted/).waitFor();
  assert.equal(approvals, 1);
  await review().getByRole('button', { name: 'Reconcile and verify (read-only)', exact: true }).click();
  await review().getByText('Verification: 55 verified · 1 differ from the approved result · 1 could not be read', { exact: true }).waitFor();
  assert.equal(approvals, 1, 'Recovery makes no second approval request.');
  assert(await review().getByRole('button', { name: approvalLabel, exact: true }).isDisabled());
  assert(await review().getByRole('button', { name: 'Prepare new review', exact: true }).isEnabled(), 'Reconciled unknown outcomes can lead to a deliberate new proposal without replaying prior writes.');
  await review().screenshot({ path: `/tmp/gtm-${provider}-safe-import-execution-mobile.png` });
  await review().getByRole('button', { name: 'Reconcile and verify (read-only)', exact: true }).click();
  await review().getByText('Verification: 56 values match · 1 differ from the approved result · 0 could not be read', { exact: true }).waitFor();
  await review().getByText(/ROW-56 · unknown · Observed approved values; acceptance unknown/).waitFor();
  assert.equal(approvals, 1, 'Observed matching values cannot authorize replay or prove write acceptance.');
  await review().screenshot({ path: `/tmp/gtm-${provider}-safe-import-observed-unknown-mobile.png` });
  const savesBeforeDeepLink = saves.length;
  await page.evaluate(() => localStorage.removeItem('gtm-control-tower-workspace-id'));
  await page.goto(new URL(`/app/lab?workspaceId=${encodeURIComponent(savedReview.workspaceId)}&reviewId=${encodeURIComponent(savedReview.id)}`, base).href);
  await review().getByText(/Execution: 56 updates accepted/).waitFor();
  assert.equal(requests.at(-1).reviewId, savedReview.id, 'Inbox deep links load the exact saved review.');
  assert.equal(saves.length, savesBeforeDeepLink, 'Opening the inbox review link must not create or save a workspace.');
  assert.equal(approvals, 1, 'Inbox navigation must not repeat approval.');
  assert(saves.some((body) => body.reason === 'import_recipe_changed' && body.state.destinationType === provider && body.state.importRecordMode === 'update-existing'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, provider, sourceRows: 103, reviewRequests: requests.map((body) => body.action), approvals,
    checks: ['saved recipe and SHA256', 'whole-file review across batch boundary', 'all field decisions', 'JSON evidence', 'held-row identity review and skip', 'fresh approval after row change', 'lost-response reload and read-only recovery', 'separate execution and verification', 'no AI model or legacy sync', 'desktop/mobile layout', 'exact inbox workspace and review deep link'] }, null, 2));
} finally { await context.close(); await browser.close(); }
