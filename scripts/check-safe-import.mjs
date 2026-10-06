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
const fields = ['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website'];
const policy = { mode: 'fill-empty', fields, clearBlanks: false };
const csv = 'contact_id,first_name,last_name,email,company,phone,state,region,segment,owner_id,job_title,website\n'
  + Array.from({ length: 103 }, (_, index) => `ROW-${index},Contact,${index},contact${index}@example.com,Example Inc,212-555-${String(index).padStart(4, '0')},NY,East,SMB,fixture-owner,${index === 0 ? '=1+1' : 'Operations Director'},\n`).join('');
const fileHash = createHash('sha256').update(csv).digest('hex');
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
    const matched = status === 'proposed-update' || status === 'unchanged';
    const before = { firstName: 'Contact', lastName: String(index), company: 'Example Inc', phone: status === 'proposed-update' ? null : contact.phone,
      jobTitle: 'Head of Operations', website: 'example.com' };
    const incoming = { firstName: 'Contact', lastName: String(index), company: contact.company, phone: contact.phone, jobTitle: contact.jobTitle, website: null };
    const after = { ...before, ...(status === 'proposed-update' ? { phone: contact.phone } : {}) };
    const fieldDecisions = fields.map((field) => ({ field, importedValue: incoming[field], currentValue: matched ? before[field] : null,
      proposedValue: matched ? after[field] : null, action: !matched ? 'review' : field === 'phone' && status === 'proposed-update' ? 'fill'
        : before[field] === incoming[field] ? 'unchanged' : 'preserve', reasonCode: !matched ? 'record-held'
          : field === 'phone' && status === 'proposed-update' ? 'fill-empty-field' : before[field] === incoming[field] ? 'same-value'
            : incoming[field] === null ? 'blank-import-preserved' : 'populated-crm-value-preserved' }));
    const reason = status === 'held' ? 'Company and phone suggest an existing person, but the email differs. No update is scheduled.'
      : status === 'unmatched' ? 'No confirmed existing HubSpot Contact. No contact will be created.'
        : status === 'unresolved' ? 'The CRM lookup did not complete. This is not proof the person is absent.' : contact.importExclusion?.reason ?? null;
    return { contactId: contact.contactId, email: contact.rawEmail, status, reason, record: {
      contactId: contact.contactId, email: contact.rawEmail, nativeId: matched ? `native-${index}` : null,
      operation: status === 'proposed-update' ? 'update' : status === 'unchanged' ? 'unchanged' : 'hold', matches: matched
        ? [{ nativeId: `native-${index}`, objectType: 'contact', email: contact.rawEmail }] : [],
      before: matched ? before : null, after, fieldDecisions, changes: status === 'proposed-update'
        ? [{ field: 'phone', before: null, after: contact.phone }] : [], reason,
    } };
  });
  const counts = { 'proposed-update': 0, unchanged: 0, held: 0, unmatched: 0, skipped: 0, unresolved: 0 };
  rows.forEach((row) => counts[row.status]++);
  return { id: randomUUID(), workspaceId: workspace.id, workspaceRevision: workspace.revision, connectorId: 'hubspot',
    account: { connectorId: 'hubspot', accountId: 'fictional-safe-import-account' }, sourceFile: workspace.state.fileName,
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
    connectors: ['csv', 'hubspot'].map((id) => ({ id, label: id, configured: true, directions: ['source', 'destination'], phases: [],
      mode: 'direct', features: ['safe-writeback', 'account-scan'] })) } });
  if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from Safe Import UI regression.' } });
  if (endpoint === 'duplicate-scan' && request.method() === 'GET') return route.fulfill({ json: { scan: null } });
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
      assert.equal(workspace.state.destinationType, 'hubspot');
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
  await page.locator('summary').filter({ hasText: 'Describe the import you want' }).click();
  await page.getByLabel('Your request', { exact: true }).fill('Update existing contacts without wiping out good information, flag questionable matches, and show me exactly what will happen.');
  await page.getByRole('button', { name: 'Interpret request', exact: true }).click();
  await page.getByText('Proposed import rules', { exact: true }).waitFor();
  assert.equal(saves.filter((body) => body.reason === 'import_recipe_changed').length, 0, 'Interpretation must not adopt settings or write to the CRM.');
  await page.getByRole('button', { name: 'Adopt Safe Import rules', exact: true }).click();
  await page.getByText('Selected · HubSpot Contacts', { exact: true }).waitFor();
  await page.locator('input[type=file]').first().setInputFiles({ name: 'safe-import-103.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
  const review = () => page.getByRole('region', { name: 'Safe Import review', exact: true });
  await review().getByRole('button', { name: 'Prepare review', exact: true }).click();
  await review().getByRole('button', { name: 'Approve 57 contact updates', exact: true }).waitFor();
  assert(await review().getByRole('button', { name: 'Approve 57 contact updates', exact: true }).isDisabled(), 'Incomplete whole-file lookups cannot be approved.');
  await review().getByText('This file is not fully checked. Unchecked rows cannot be approved.', { exact: true }).waitFor();
  assert.equal(approvals, 0, 'Preparing a review must not approve writes.');
  assert.equal(await page.getByRole('button', { name: /^Compare \d+ with CRM$/ }).count(), 0, 'Old batch comparison must be hidden.');
  const first = review().locator('details').filter({ has: page.locator('summary').filter({ hasText: 'ROW-0 · Proposed update' }) });
  await first.locator('summary').click();
  await first.getByRole('cell', { name: 'Fill the empty field fill', exact: true }).waitFor();
  await first.getByRole('cell', { name: 'Preserve the CRM value; incoming value differs preserve', exact: true }).waitFor();
  await first.getByRole('cell', { name: 'Preserve the CRM value; imported cell is empty preserve', exact: true }).waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), review().getByRole('button', { name: 'Download whole review (JSON)', exact: true }).click()]);
  const stream = await download.createReadStream(); const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const evidence = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
  await held.getByLabel('Reason to skip this row', { exact: true }).fill('Attendee identity needs further confirmation.');
  await held.getByRole('button', { name: 'Skip this row', exact: true }).click();
  await review().getByRole('button', { name: 'Prepare review', exact: true }).waitFor();
  assert.equal(await review().getByRole('button', { name: 'Approve 57 contact updates', exact: true }).count(), 0, 'Saved row changes invalidate approval.');
  await review().getByRole('button', { name: 'Prepare review', exact: true }).click();
  await review().getByRole('button', { name: 'Approve 57 contact updates', exact: true }).waitFor();
  assert.equal(savedReview.counts.skipped, 1);
  assert.equal(savedReview.counts.unresolved, 0);
  assert(await review().getByRole('button', { name: 'Approve 57 contact updates', exact: true }).isEnabled(), 'A fresh complete read can be approved.');
  await review().screenshot({ path: '/tmp/gtm-safe-import-desktop.png' });
  await review().getByRole('heading', { name: 'Inspect every row before approving updates', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/gtm-safe-import-desktop-viewport.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Safe Import must fit mobile width.');
  await review().screenshot({ path: '/tmp/gtm-safe-import-mobile.png' });
  await review().getByRole('heading', { name: 'Inspect every row before approving updates', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/gtm-safe-import-mobile-viewport.png' });
  await review().getByRole('button', { name: 'Approve 57 contact updates', exact: true }).click();
  await review().getByText(/The execution outcome is unknown or incomplete/).waitFor();
  assert(await review().getByRole('button', { name: 'Approve 57 contact updates', exact: true }).isDisabled());
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('gtm-control-tower-safe-import')) localStorage.removeItem(key); });
  await page.reload();
  await review().getByText(/Execution: 56 updates accepted/).waitFor();
  assert.equal(approvals, 1);
  await review().getByRole('button', { name: 'Reconcile and verify (read-only)', exact: true }).click();
  await review().getByText('Verification: 55 verified · 1 differ from the approved result · 1 could not be read', { exact: true }).waitFor();
  assert.equal(approvals, 1, 'Recovery makes no second approval request.');
  assert(await review().getByRole('button', { name: 'Approve 57 contact updates', exact: true }).isDisabled());
  assert(await review().getByRole('button', { name: 'Prepare new review', exact: true }).isEnabled(), 'Reconciled unknown outcomes can lead to a deliberate new proposal without replaying prior writes.');
  await review().screenshot({ path: '/tmp/gtm-safe-import-execution-mobile.png' });
  await review().getByRole('button', { name: 'Reconcile and verify (read-only)', exact: true }).click();
  await review().getByText('Verification: 56 values match · 1 differ from the approved result · 0 could not be read', { exact: true }).waitFor();
  await review().getByText(/ROW-56 · unknown · Observed approved values; acceptance unknown/).waitFor();
  assert.equal(approvals, 1, 'Observed matching values cannot authorize replay or prove write acceptance.');
  await review().screenshot({ path: '/tmp/gtm-safe-import-observed-unknown-mobile.png' });
  assert(saves.some((body) => body.reason === 'import_recipe_changed' && body.state.destinationType === 'hubspot' && body.state.importRecordMode === 'update-existing'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, sourceRows: 103, reviewRequests: requests.map((body) => body.action), approvals,
    checks: ['saved recipe and SHA256', 'whole-file review across batch boundary', 'all field decisions', 'JSON evidence', 'held-row identity review and skip', 'fresh approval after row change', 'lost-response reload and read-only recovery', 'separate execution and verification', 'no AI model or legacy sync', 'desktop/mobile layout'] }, null, 2));
} finally { await context.close(); await browser.close(); }
