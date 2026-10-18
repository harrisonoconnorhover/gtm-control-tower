import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

// This probe uses real, separately seeded development CRM records and a real
// Pomade job. Only the two explicitly labelled transient responses are injected.
// Runtime files contain local access credentials and must remain private.
const output = resolve(process.env.CRM_NATIVE_OUTPUT || 'outputs/crm-cohort-native-2026-10-15');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fixture = readJson(process.env.CRM_NATIVE_FIXTURE_MANIFEST || join(output, 'fixture-manifest.json'));
const towerRuntime = readJson(process.env.CONTROL_TOWER_RUNTIME_JSON || join(output, 'tower-runtime.json'));
const pomadeRuntime = readJson(process.env.POMADE_RUNTIME_JSON || join(output, 'pomade-runtime.json'));
const tower = new URL(towerRuntime.origin);
const pomade = new URL(pomadeRuntime.appURL);
for (const base of [tower, pomade]) assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use isolated local apps.');
assert.notEqual(tower.origin, pomade.origin);
assert.equal(String(fixture.portalId), '246915016', 'Only the approved development portal is allowed.');
assert.equal(fixture.contacts.length, 3, 'Seed exactly three separate test contacts before this probe.');
const expectedIds = fixture.contacts.map((contact) => String(contact.contactId)).sort();
assert.equal(new Set(expectedIds).size, 3);
const fixtureDate = fixture.closeDate || fixture.date || '2026-10-15';
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1360, height: 960 } });
const errors = [], forbidden = [], statusJobIds = new Set();
const counts = { metadataReads: 0, previewAttempts: 0, nativePreviewAttempts: 0, rechecks: 0,
  workspaceCreates: 0, workspaceSaves: 0, extractionSubmissions: 0, statusChecks: 0,
  injectedPreview503: 0, injectedStatus429: 0 };
let originalJobId = null;
let ct, pm;
const recordProgress = (stage, data = {}) => {
  writeFileSync(join(output, 'browser-progress.json'), JSON.stringify({ stage, at: new Date().toISOString(), ...data }, null, 2));
  console.log(JSON.stringify({ stage, ...data }));
};
await context.addInitScript(({ origin, key }) => {
  if (location.origin === origin && key) sessionStorage.setItem('gtm-control-tower-operator-key', key);
}, { origin: tower.origin, key: towerRuntime.operatorKey });
context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (![tower.origin, pomade.origin].includes(url.origin)) {
    forbidden.push(`${request.method()} ${url.origin}${url.pathname}`);
    return route.abort();
  }
  const continueRequest = () => route.continue({ headers: { ...request.headers(),
    ...(url.origin === pomade.origin && pomadeRuntime.ownerToken ? { 'x-pomade-owner-key': pomadeRuntime.ownerToken } : {}) } });
  if (!url.pathname.startsWith('/api/')) return continueRequest();
  if (url.origin === tower.origin) {
    if (url.pathname === '/api/control-tower/crm-cohort') {
      if (request.method() === 'GET') { counts.metadataReads++; return continueRequest(); }
      const body = request.postDataJSON();
      assert(['preview', 'recheck'].includes(body.action), 'Only CRM read actions are allowed.');
      assert.equal(String(body.definition.portalId), String(fixture.portalId));
      assert.equal(body.definition.pipelineId, fixture.pipelineId);
      assert.deepEqual(body.definition.lostStageIds, [fixture.lostStageId]);
      assert.equal(body.definition.dateFrom.slice(0, 10), fixtureDate);
      assert.equal(body.definition.dateTo.slice(0, 10), fixtureDate);
      assert.equal(body.definition.inactivity.confirmed, false);
      if (body.action === 'preview') {
        counts.previewAttempts++;
        if (!counts.injectedPreview503) {
          counts.injectedPreview503++;
          return route.fulfill({ status: 503, headers: { 'retry-after': '1' }, json: {
            error: 'Injected local test interruption before the native CRM read.', retryable: true,
            retryAt: new Date(Date.now() + 1_000).toISOString() } });
        }
        counts.nativePreviewAttempts++;
      } else {
        counts.rechecks++;
        assert.deepEqual(body.contacts.map((contact) => contact.contactId).sort(), expectedIds);
      }
      return continueRequest();
    }
    if (url.pathname === '/api/control-tower/workspace') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        assert(['create', 'save'].includes(body.action), 'This probe may only create/save its local review.');
        if (body.action === 'create') counts.workspaceCreates++;
        else counts.workspaceSaves++;
      }
      return continueRequest();
    }
  } else {
    if (url.pathname === '/api/control-tower/evidence' && request.method() === 'POST') {
      const body = request.postDataJSON();
      assert.equal(String(body.request.portalId), String(fixture.portalId));
      assert.deepEqual([...body.contactIds].sort(), expectedIds);
      if (body.action === 'status') {
        counts.statusChecks++;
        assert(originalJobId, 'A persisted original job handle must precede status checks.');
        assert.equal(body.jobId, originalJobId);
        statusJobIds.add(body.jobId);
        if (!counts.injectedStatus429) {
          counts.injectedStatus429++;
          return route.fulfill({ status: 429, headers: { 'retry-after': '1' }, json: { error: 'Injected local status throttle; original extraction continues.' } });
        }
      } else {
        assert.equal(body.confirmAnalysis, true);
        counts.extractionSubmissions++;
        assert.equal(counts.extractionSubmissions, 1, 'Never resubmit extraction during retry or reload.');
      }
      return continueRequest();
    }
    if (request.method() === 'GET' || (url.pathname === '/api/tables' && request.method() === 'POST')
      || (url.pathname === '/api/workspace' && request.method() === 'PUT')) return continueRequest();
  }
  forbidden.push(`${request.method()} ${url.pathname}`);
  return route.fulfill({ status: 403, json: { error: 'This test permits CRM reads and local review persistence only; sending and CRM mutation are forbidden.' } });
});
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
  const response = await context.request.get(new URL(`/api/workspace?workspaceId=${id}`, pomade).href,
    { headers: pomadeRuntime.ownerToken ? { 'x-pomade-owner-key': pomadeRuntime.ownerToken } : {} });
  assert.equal(response.status(), 200);
  return (await response.json()).workspace;
}
async function jsonDownload(page, name, filename) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name, exact: true }).click()]);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  writeFileSync(join(output, filename), bytes);
  return { value: JSON.parse(bytes.toString('utf8')), bytes };
}
const upload = (bytes, name) => ({ name, mimeType: 'application/json', buffer: bytes });
try {
  ct = await context.newPage();
  ct.setDefaultTimeout(45_000);
  await ct.goto(new URL('/app/cohort', tower).href);
  await ct.getByRole('button', { name: 'Load HubSpot definitions', exact: true }).click();
  await ct.getByText('HubSpot definitions loaded. Choose the pipeline, field meanings and exclusions before previewing.', { exact: true }).waitFor();
  await ct.getByLabel('Cohort name', { exact: true }).fill(`TEST ONLY · Native roundtrip ${fixtureDate}`);
  await ct.getByLabel(/^Pipeline/).selectOption(fixture.pipelineId);
  const lostStages = ct.getByRole('group', { name: 'Lost stages to include', exact: true });
  await lostStages.getByLabel(fixture.lostStageLabel || 'Closed Lost', { exact: true }).check();
  await ct.getByLabel('Closed from', { exact: true }).fill(fixtureDate);
  await ct.getByLabel('Closed through', { exact: true }).fill(fixtureDate);
  await ct.getByLabel('Last meaningful contact property', { exact: true }).fill('notes_last_contacted');
  await ct.getByLabel('What updates this date?', { exact: true }).fill('Unconfirmed; test extraction only');
  if (fixture.lossReasonProperty) await ct.getByLabel('Deal loss reason property', { exact: true }).fill(fixture.lossReasonProperty);
  await ct.getByRole('button', { name: 'Preview and save new cohort', exact: true }).click();
  await ct.getByRole('button', { name: 'Stop waiting', exact: true }).waitFor();
  await ct.getByRole('region', { name: 'CRM cohort selection', exact: true }).waitFor({ timeout: 120_000 });
  const initialCohort = await savedCohort(ct);
  const cohort = initialCohort.state.crmCohort;
  assert.equal(cohort.mode, 'hubspot');
  assert.deepEqual(cohort.contacts.map((contact) => contact.contactId).sort(), expectedIds);
  assert.equal(cohort.nextCursor, null, 'The narrow fixture cohort must fit one complete native page.');
  assert.equal(counts.workspaceCreates, 1, 'A preview retry creates only one saved workspace.');
  assert.equal(counts.workspaceSaves, 1, 'A preview retry saves only the successful cohort.');
  assert.equal(counts.previewAttempts, 2);
  assert.equal(counts.nativePreviewAttempts, 1, 'Injected failure precedes the real request.');
  const request = await jsonDownload(ct, 'Save and download evidence request', 'native-request.json');
  assert.equal(request.value.contacts.length, 3);
  assert(request.value.contacts.every((contact) => contact.existingValues.jobTitle === null));
  assert(request.value.contacts.every((contact) => contact.assessments.state === 'held'), 'Fixture evidence does not establish outreach eligibility.');
  assert(request.value.contacts.every((contact) => contact.evidence.some((source) => source.objectType === 'note')), 'Each native contact must bring actual linked notes.');
  await ct.getByRole('region', { name: 'CRM cohort selection', exact: true }).screenshot({ path: join(output, 'native-control-tower-selection.png') });
  await ct.reload();
  await ct.getByRole('button', { name: 'Download saved request again', exact: true }).waitFor();
  assert.deepEqual((await savedCohort(ct)).state.crmCohort.request, request.value);
  recordProgress('native-cohort-exported', { contacts: 3, previewAttempts: counts.previewAttempts, workspaceCreates: counts.workspaceCreates });

  pm = await context.newPage();
  pm.setDefaultTimeout(45_000);
  await pm.goto(pomade.href);
  await pm.getByRole('button', { name: 'Import CRM evidence request', exact: true }).click();
  await pm.getByLabel('CRM evidence JSON', { exact: true }).setInputFiles(upload(request.bytes, 'native-request.json'));
  await pm.getByRole('button', { name: 'Create CRM review table', exact: true }).click();
  const pmReview = pm.getByRole('region', { name: 'CRM evidence review', exact: true });
  await pmReview.waitFor();
  const initialTable = await savedTable(pm);
  assert.deepEqual(initialTable.crmEvidenceReview.request, request.value);
  await pm.getByRole('button', { name: 'Select first 3 with gaps', exact: true }).click();
  const pendingResponse = pm.waitForResponse((response) => new URL(response.url()).pathname === '/api/control-tower/evidence'
    && response.request().method() === 'POST' && response.request().postDataJSON()?.action !== 'status');
  const pendingSaved = pm.waitForResponse((response) => new URL(response.url()).pathname === '/api/workspace'
    && response.request().method() === 'PUT' && /^[a-f0-9]{64}$/.test(response.request().postDataJSON()?.workspace?.crmEvidenceReview?.pending?.jobId || ''));
  await pm.getByRole('button', { name: 'Extract from supplied CRM evidence', exact: true }).click();
  const submitted = await pendingResponse;
  assert.equal(submitted.status(), 202, 'The isolated hosted queue should retain an original job for recovery testing.');
  const pending = await submitted.json();
  originalJobId = pending.jobId;
  assert.match(originalJobId, /^[a-f0-9]{64}$/);
  assert.equal((await pendingSaved).status(), 200);
  await pm.reload();
  await pmReview.waitFor();
  await pm.getByRole('button', { name: 'Stop waiting', exact: true }).click();
  await pm.getByRole('button', { name: 'Resume checking saved job', exact: true }).waitFor();
  const paused = await savedTable(pm);
  assert.equal(paused.crmEvidenceReview.pending.jobId, originalJobId);
  assert.equal(paused.crmEvidenceReview.pending.state, 'paused');
  await pm.getByRole('button', { name: 'Resume checking saved job', exact: true }).click();
  recordProgress('extraction-job-ready', { jobId: originalJobId, tableId: new URL(pm.url()).searchParams.get('table') });
  await pm.getByText('Proposed outcomes received. Review their meaning and source dates before returning them to Control Tower.', { exact: true }).waitFor({ timeout: 480_000 });
  const returned = await jsonDownload(pm, 'Download CRM evidence result', 'native-result.json');
  assert.equal(counts.extractionSubmissions, 1);
  assert.equal(counts.injectedStatus429, 1);
  assert(counts.statusChecks >= 2);
  assert.deepEqual([...statusJobIds], [originalJobId]);
  assert.equal(returned.value.requestDigest, request.value.contentDigest);
  assert.deepEqual(returned.value.contacts.map((contact) => contact.contactId).sort(), expectedIds);
  for (const expected of fixture.contacts) {
    const field = returned.value.contacts.find((contact) => contact.contactId === String(expected.contactId)).fields.find((item) => item.field === 'jobTitle');
    assert.equal(field.status, expected.expectedStatus, `Native evidence outcome for ${expected.contactId}`);
    if (expected.expectedValue) assert.equal(field.value, expected.expectedValue);
  }
  await pmReview.screenshot({ path: join(output, 'native-pomade-evidence.png') });
  await pm.reload();
  await pmReview.waitFor();
  const table = await savedTable(pm);
  assert.deepEqual(table.crmEvidenceReview.result, returned.value, 'Actual extracted outcomes survive reload.');
  assert.deepEqual(table.rows, initialTable.rows, 'Proposals do not overwrite the imported CRM values.');
  recordProgress('native-extraction-complete', { extractionSubmissions: counts.extractionSubmissions, statusChecks: counts.statusChecks });

  const resultInput = ct.getByLabel('CRM evidence result file', { exact: true });
  await resultInput.setInputFiles(upload(returned.bytes, 'native-result.json'));
  await ct.getByText('Result saved after a fresh HubSpot comparison. Review each proposed fact.', { exact: true }).waitFor({ timeout: 120_000 });
  assert.equal(counts.rechecks, 1);
  const report = await jsonDownload(ct, 'Download cohort review', 'native-review.json');
  assert.equal(report.value.approvalToSend, false);
  assert.equal(report.value.crmWrites, false);
  assert.equal(report.value.rows.length, 3);
  assert(report.value.rows.every((row) => row.state === 'held'));
  const beforeRepeat = await savedCohort(ct);
  const savesBeforeRepeat = counts.workspaceSaves;
  await resultInput.setInputFiles(upload(returned.bytes, 'native-result-again.json'));
  await ct.getByText('This unchanged result is already saved. No duplicate review was created.', { exact: true }).waitFor();
  const afterRepeat = await savedCohort(ct);
  assert.equal(afterRepeat.revision, beforeRepeat.revision);
  assert.deepEqual(afterRepeat.state.crmCohort.reviews, beforeRepeat.state.crmCohort.reviews);
  assert.equal(counts.workspaceSaves, savesBeforeRepeat);
  assert.equal(counts.rechecks, 1, 'A repeated unchanged result performs no additional comparison.');
  assert.equal(afterRepeat.state.crmCohort.reviews.length, 1);
  assert(afterRepeat.state.crmCohort.contacts.every((contact) => contact.existingValues.jobTitle === null));
  await ct.reload();
  await ct.getByRole('button', { name: 'Download cohort review', exact: true }).waitFor();
  await ct.getByRole('region', { name: 'Pomade result review', exact: true }).screenshot({ path: join(output, 'native-control-tower-reviewed.png') });
  for (const page of [ct, pm]) {
    await page.setViewportSize({ width: 390, height: 844 });
    const region = page === ct ? page.getByRole('region', { name: 'Pomade result review', exact: true }) : pmReview;
    await region.scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile page must not overflow.');
    await page.screenshot({ path: join(output, page === ct ? 'native-control-tower-mobile.png' : 'native-pomade-mobile.png') });
  }
  assert.deepEqual(forbidden, []);
  assert.deepEqual(errors, []);
  const result = { passed: true, portalId: String(fixture.portalId), contacts: 3, ...counts,
    uniqueExtractionJobs: statusJobIds.size, repeatedReturnAddedReviews: 0, repeatedReturnAddedSaves: 0,
    held: 3, sends: 0, crmWritesFromRoundtrip: 0, note: 'One local preview 503 and one status 429 were deliberately injected; all successful CRM and extraction data were native.', output };
  writeFileSync(join(output, 'browser-report.json'), JSON.stringify(result, null, 2));
  recordProgress('passed', result);
} catch (error) {
  writeFileSync(join(output, 'browser-failure.json'), JSON.stringify({ error: error.message, counts, errors, forbidden }, null, 2));
  if (ct) await ct.screenshot({ path: join(output, 'native-tower-failure.png'), fullPage: true }).catch(() => {});
  if (pm) await pm.screenshot({ path: join(output, 'native-pomade-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
}
