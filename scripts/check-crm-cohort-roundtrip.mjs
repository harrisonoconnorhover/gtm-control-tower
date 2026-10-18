import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

// Run against disposable local instances. Both apps and their persistence are
// real; CRM read and context-only extraction responses are fictional and intercepted.
const tower = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3217');
const pomade = new URL(process.env.POMADE_BROWSER_BASE_URL || 'http://127.0.0.1:8896');
for (const base of [tower, pomade]) assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use disposable local apps.');
assert.notEqual(tower.origin, pomade.origin);
const output = process.env.CRM_ROUNDTRIP_OUTPUT || '/tmp/crm-cohort-roundtrip';
mkdirSync(output, { recursive: true });
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1360, height: 960 } });
const errors = [], forbidden = [];
let extractionCalls = 0, statusChecks = 0, failSave = false;
const jobId = 'f'.repeat(64);
let cohortReadFixture, cohortMetadata, initialPageCalls = 0, nextPageCalls = 0;
context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (![tower.origin, pomade.origin].includes(url.origin)) {
    forbidden.push(`${request.method()} ${url.origin}${url.pathname}`);
    return route.abort();
  }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  if (url.origin === tower.origin) {
    if (url.pathname === '/api/control-tower/crm-cohort' && cohortReadFixture) {
      if (request.method() === 'GET') return route.fulfill({ json: { metadata: cohortMetadata } });
      const body = request.postDataJSON();
      assert.equal(body.action, 'preview', 'This browser fixture only reads selected pages.');
      if (!body.after) {
        initialPageCalls++;
        if (initialPageCalls === 1) return route.fulfill({ status: 503, json: { error: 'Fictional CRM is temporarily busy.', retryable: true, retryAt: new Date(Date.now() + 1_000).toISOString() } });
        return route.fulfill({ json: { portalId: 'fictional-portal', contacts: cohortReadFixture.contacts,
          coverage: { complete: true, missing: [], omittedSourceIds: [] }, nextCursor: '20', totalDeals: 21, scannedDealIds: [] } });
      }
      assert.equal(body.after, '20', 'A retry must retain the saved page cursor.');
      nextPageCalls++;
      if (nextPageCalls === 1) return route.fulfill({ status: 503, headers: { 'retry-after': '60' }, json: { error: 'Fictional cooldown on next page.', retryable: true } });
      return route.fulfill({ json: { portalId: 'fictional-portal', contacts: [],
        coverage: { complete: true, missing: [], omittedSourceIds: [] }, nextCursor: null, totalDeals: 21, scannedDealIds: [] } });
    }
    if (url.pathname !== '/api/control-tower/workspace') {
      forbidden.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 403, json: { error: 'This regression uses fictional CRM records only.' } });
    }
    if (request.method() === 'POST' && request.postDataJSON()?.reason === 'crm_evidence_result_reviewed' && failSave) {
      failSave = false;
      return route.fulfill({ status: 503, json: { error: 'Fictional storage failure; retry preserves the prior review.' } });
    }
    return route.continue();
  }
  if (url.pathname === '/api/control-tower/evidence') {
    const body = request.postDataJSON();
    assert.equal(body.request.portalId, 'fictional-portal');
    assert(body.contactIds.length > 0 && body.contactIds.length <= 10);
    if (body.action !== 'status') {
      extractionCalls++;
      assert.equal(body.confirmAnalysis, true);
      return route.fulfill({ status: 202, json: { pending: true, jobId, retryAt: new Date(Date.now() + 2_000).toISOString() } });
    }
    statusChecks++;
    assert.equal(body.jobId, jobId, 'Status reads must reference the original hosted job.');
    if (statusChecks === 1) return route.fulfill({ status: 429, headers: { 'retry-after': '1' }, json: { error: 'Fictional status throttle' } });
    if (statusChecks === 2) return route.fulfill({ status: 202, json: { pending: true, jobId, retryAt: new Date(Date.now() + 500).toISOString() } });
    const contacts = body.contactIds.map((contactId) => {
      const source = body.request.contacts.find((contact) => contact.contactId === contactId);
      return { contactId, fields: source.requestedFields.map((field) => {
        assert.equal(field, 'jobTitle');
        if (contactId === '101' || contactId === '107') {
          const title = contactId === '101' ? 'Revenue Operations Director' : 'Operations Manager';
          return { field, status: 'supported', value: title, rationale: 'The attributed fictional CRM note states this title; its age needs human review.',
            evidence: [{ sourceId: `note-${contactId}`, quote: source.evidence.find((item) => item.id === `note-${contactId}`).text.split('. ')[0].replace(/\.$/u, '') + '.' }] };
        }
        if (contactId === '102') return { field, status: 'conflicting', value: null, rationale: 'Two attributed notes state different titles without enough timing context.',
          evidence: source.evidence.map((item) => ({ sourceId: item.id, quote: item.text })) };
        return { field, status: 'not_found', value: null, rationale: 'No supplied person-attributed evidence establishes the requested title.', evidence: [] };
      }) };
    });
    return route.fulfill({ json: { contacts, model: 'Fictional browser fixture (no model call)' } });
  }
  if (request.method() === 'GET' || (url.pathname === '/api/tables' && request.method() === 'POST') || (url.pathname === '/api/workspace' && request.method() === 'PUT')) return route.continue();
  forbidden.push(`${request.method()} ${url.pathname}`);
  return route.fulfill({ status: 403, json: { error: 'External research, jobs, CRM writes and sending are outside this regression.' } });
});

async function jsonDownload(page, buttonName, filename) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: buttonName, exact: true }).click()]);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  writeFileSync(join(output, filename), bytes);
  return { value: JSON.parse(bytes.toString('utf8')), bytes };
}
async function savedCohort(page) {
  const id = await page.evaluate(() => localStorage.getItem('gtm-control-tower-cohort-workspace-id'));
  assert(id);
  const response = await context.request.get(new URL(`/api/control-tower/workspace?id=${id}`, tower).href);
  assert.equal(response.status(), 200);
  return (await response.json()).workspace;
}
async function savedTable(page) {
  const id = new URL(page.url()).searchParams.get('table');
  assert(id);
  const response = await context.request.get(new URL(`/api/workspace?workspaceId=${id}`, pomade).href);
  assert.equal(response.status(), 200);
  return (await response.json()).workspace;
}
const upload = (bytes, name = 'result.json') => ({ name, mimeType: 'application/json', buffer: Buffer.isBuffer(bytes) ? bytes : Buffer.from(JSON.stringify(bytes)) });
try {
  const ct = await context.newPage();
  ct.setDefaultTimeout(20_000);
  await ct.goto(new URL('/app/cohort', tower).href);
  await ct.getByRole('button', { name: 'Try fictional cohort', exact: true }).click();
  await ct.getByText('Fictional CRM cohort saved. No connected CRM or model was called.', { exact: true }).waitFor();
  assert(await ct.getByLabel('Select Jordan Reed', { exact: true }).isDisabled());
  const cohort = await savedCohort(ct);
  assert.equal(cohort.state.crmCohort.contacts.length, 7, 'Repeated native IDs collapse once.');
  assert.equal(cohort.state.crmCohort.selectedContactIds.length, 6);
  assert.deepEqual(cohort.state.crmCohort.contacts.find((c) => c.contactId === '101').dealIds.sort(), ['deal-101', 'deal-101-b']);
  const request = await jsonDownload(ct, 'Save and download evidence request', 'request.json');
  assert.equal(request.value.contacts.length, 6);
  assert(!request.value.contacts.some((c) => c.contactId === '103'));
  assert(request.value.contacts.every((c) => c.existingValues.jobTitle === null));
  assert(request.value.contacts.filter((c) => ['104', '105'].includes(c.contactId)).every((c) => c.assessments.state === 'held'));
  await ct.getByRole('region', { name: 'CRM cohort selection' }).screenshot({ path: join(output, 'control-tower-selection.png') });
  await ct.reload();
  await ct.getByRole('button', { name: 'Download saved request again', exact: true }).waitFor();
  assert.deepEqual((await savedCohort(ct)).state.crmCohort.request, request.value);

  const pm = await context.newPage();
  pm.setDefaultTimeout(30_000);
  await pm.goto(pomade.href);
  await pm.getByRole('button', { name: 'Import CRM evidence request', exact: true }).click();
  await pm.getByLabel('CRM evidence JSON', { exact: true }).setInputFiles(upload(request.bytes, 'request.json'));
  await pm.getByRole('button', { name: 'Create CRM review table', exact: true }).click();
  const pmReview = pm.getByRole('region', { name: 'CRM evidence review', exact: true });
  await pmReview.waitFor();
  const initialTable = await savedTable(pm);
  assert.deepEqual(initialTable.crmEvidenceReview.request, request.value);
  assert(initialTable.crmEvidenceReview.result.contacts.every((c) => c.fields.every((f) => f.status === 'not_run')));
  await pm.getByRole('button', { name: 'Select first 6 with gaps', exact: true }).click();
  const pendingSaved = pm.waitForResponse((response) => new URL(response.url()).pathname === '/api/workspace'
    && response.request().method() === 'PUT' && response.request().postDataJSON()?.workspace?.crmEvidenceReview?.pending?.jobId === jobId);
  await pm.getByRole('button', { name: 'Extract from supplied CRM evidence', exact: true }).click();
  assert.equal((await pendingSaved).status(), 200);
  await pm.reload();
  await pmReview.waitFor();
  await pm.getByText('Proposed outcomes received. Review their meaning and source dates before returning them to Control Tower.', { exact: true }).waitFor();
  const returned = await jsonDownload(pm, 'Download CRM evidence result', 'result.json');
  assert.equal(extractionCalls, 1);
  assert.equal(statusChecks, 3, 'Reload and throttle recovery check status without resubmitting extraction.');
  assert.equal(returned.value.requestDigest, request.value.contentDigest);
  assert.equal(returned.value.contacts.length, request.value.contacts.length);
  assert.equal(returned.value.contacts.find((c) => c.contactId === '106').fields[0].status, 'not_found');
  await pm.locator('summary').filter({ hasText: 'Review Maya Stone · 101' }).click();
  await pmReview.screenshot({ path: join(output, 'pomade-evidence.png') });
  await pm.reload();
  await pmReview.waitFor();
  const table = await savedTable(pm);
  assert.deepEqual(table.crmEvidenceReview.result, returned.value, 'Evidence survives actual saved table reload.');
  assert.deepEqual(table.rows, initialTable.rows, 'Proposals never overwrite imported CRM values.');

  const resultInput = ct.getByLabel('CRM evidence result file', { exact: true });
  await resultInput.setInputFiles(upload({ ...returned.value, portalId: 'wrong-portal' }));
  await ct.getByRole('alert').waitFor();
  assert.equal((await savedCohort(ct)).state.crmCohort.reviews.length, 0, 'Wrong portal cannot alter the review.');
  failSave = true;
  await resultInput.setInputFiles(upload(returned.bytes));
  await ct.getByText('Fictional storage failure; retry preserves the prior review.', { exact: true }).waitFor();
  assert.equal((await savedCohort(ct)).state.crmCohort.reviews.length, 0);
  await resultInput.setInputFiles(upload(returned.bytes));
  await ct.getByText('Fictional result saved against the supplied fictional CRM snapshot. Review each proposed fact.', { exact: true }).waitFor();
  const maya = ct.getByRole('article', { name: 'Review Maya Stone', exact: true });
  await maya.getByRole('heading', { name: 'Maya Stone · held', exact: true }).waitFor();
  await maya.getByRole('button', { name: 'Accept jobTitle for review', exact: true }).click();
  await maya.getByRole('heading', { name: 'Maya Stone · ready for review', exact: true }).waitFor();
  await ct.getByText('Review decision saved. No CRM value changed and no message was sent.', { exact: true }).waitFor();
  const report = await jsonDownload(ct, 'Download cohort review', 'review.json');
  assert.equal(report.value.approvalToSend, false);
  assert.equal(report.value.crmWrites, false);
  assert.equal(report.value.rows.find((c) => c.contactId === '101').state, 'ready_for_review');
  for (const id of ['102', '104', '105', '106', '107']) assert.equal(report.value.rows.find((c) => c.contactId === id).state, 'held');
  assert(report.value.unselectedContactIds.includes('103'));
  assert(report.value.populationCoverage.complete);
  const beforeRepeat = await savedCohort(ct);
  await resultInput.setInputFiles(upload(returned.bytes));
  await ct.getByText('This unchanged result is already saved. No duplicate review was created.', { exact: true }).waitFor();
  assert.equal((await savedCohort(ct)).revision, beforeRepeat.revision);
  await ct.reload();
  await maya.getByRole('heading', { name: 'Maya Stone · ready for review', exact: true }).waitFor();
  await maya.screenshot({ path: join(output, 'control-tower-reviewed.png') });
  assert((await savedCohort(ct)).state.crmCohort.contacts.every((c) => c.existingValues.jobTitle === null));

  // A separate page uses the real cohort UI and persistence with fictional native
  // responses. Cancellation and reload retain the last successful page cursor.
  cohortReadFixture = cohort.state.crmCohort;
  cohortMetadata = { portalId: 'fictional-portal', warnings: [], properties: { contact: [], company: [], deal: [] },
    pipelines: [{ id: 'sales', label: 'Fictional sales', stages: [{ id: 'lost', label: 'Fictional lost', closed: true, won: false }] }] };
  const recovery = await context.newPage();
  recovery.setDefaultTimeout(20_000);
  await recovery.goto(new URL('/app/cohort', tower).href);
  await recovery.getByRole('button', { name: 'Load HubSpot definitions', exact: true }).click();
  await recovery.getByRole('button', { name: 'Preview and save new cohort', exact: true }).click();
  await recovery.getByRole('button', { name: 'Stop waiting', exact: true }).waitFor();
  await recovery.getByRole('button', { name: 'Read next deal page', exact: true }).waitFor();
  assert.equal(initialPageCalls, 2);
  const firstPage = await savedCohort(recovery);
  assert.equal(firstPage.state.crmCohort.nextCursor, '20');
  await recovery.getByRole('button', { name: 'Read next deal page', exact: true }).click();
  await recovery.getByRole('button', { name: 'Stop waiting', exact: true }).click();
  await recovery.getByText('CRM read stopped. The saved cohort and page position are unchanged; retry when ready.', { exact: true }).waitFor();
  assert.equal((await savedCohort(recovery)).revision, firstPage.revision);
  await recovery.reload();
  await recovery.getByRole('button', { name: 'Read next deal page', exact: true }).click();
  await recovery.getByText('Configured population read completed.', { exact: false }).waitFor();
  assert.equal(nextPageCalls, 2);
  assert.equal((await savedCohort(recovery)).state.crmCohort.nextCursor, null);
  await recovery.screenshot({ path: join(output, 'crm-read-recovered.png') });
  await recovery.close();
  for (const page of [ct, pm]) {
    await page.setViewportSize({ width: 390, height: 844 });
    if (page === ct) await maya.scrollIntoViewIfNeeded();
    else await pmReview.scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${page.url()} must not overflow the mobile viewport.`);
    await page.screenshot({ path: join(output, page === ct ? 'control-tower-mobile.png' : 'pomade-mobile.png') });
  }
  assert.deepEqual(forbidden, [], 'No external, enrichment, sending or CRM write requests.');
  assert.deepEqual(errors, [], 'No browser runtime errors.');
  console.log(JSON.stringify({ passed: true, contacts: 7, requested: 6, extractionCalls, statusChecks, initialPageCalls, nextPageCalls, realModelCalls: 0,
    realCrmCalls: 0, accepted: 1, held: 5, excluded: 1, output }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
