import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3197');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use an isolated local application.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chromium.');
const directory = resolve('.runtime/incidents-ui'); mkdirSync(directory, { recursive: true });
const policy = { version: 1, windowMinutes: 30, minimumRecords: 10, clearingFraction: 0.2, reversalsBeforePause: 3, repairLimitPerHour: 50, repairsPerRecordPerDay: 2, retentionDays: 30, maxObservations: 50000, disallowNegativeAmounts: false, expectations: [], relationships: [], plannedChanges: [], activity: { enabled: false, minimumPreviousRecords: 20, quietMinutes: 60 } };
const at = '2026-10-10T14:00:00.000Z';
const observation = { id: 'observation-1', recordKey: 'Contact:100', objectType: 'Contact', recordId: '100', observedAt: at, providerUpdatedAt: at, phase: 'changes', changes: [{ field: 'jobtitle', before: 'Director', after: '' }], source: { kind: 'poll' }, suppressed: [] };
const incident = { id: 'fixture-bulk-clear', accountId: 'fixture-account', kind: 'mass_field_clearing', objectType: 'Contact', field: 'jobtitle', title: 'Job titles cleared across a connected cohort', severity: 'critical', status: 'open', firstSeenAt: at, lastSeenAt: at, affectedRecords: 120, policyVersion: 1, version: 1, assignee: 'Revenue Operations', note: '', resolution: null, resolvedAt: null, evidence: { cleared: 120, denominator: 600 }, timeline: [{ at, event: 'detected', detail: '120 previously populated fields became empty.' }], observations: [observation], records: ['100'] };
const evidence = { incident, policy, records: [], relatedRecords: [], limitations: [], priorResolutions: [], nativeEvents: [{id: 'native-event-1', scope: 'fixture-account', provider: 'hubspot', objectType: 'Contact', recordId: '100', kind: 'refresh', occurredAt: at, receivedAt: at, processedAt: at, source: {kind: 'hubspot_webhook', eventId: '101', actorId: 'reported-user-7', attribution: 'refresh_trigger_only', reportedValues: {jobtitle: 'Manager'}}}] };
let investigation = null;
const coverage = { status: 'degraded', phase: 'changes', lastCheckedAt: at, lastSuccessAt: at, staleAfterSeconds: 900, lastChangedAt: at, scanned: 50, error: 'One queued native read needs review.', objectTypes: ['Contact', 'Company', 'Deal'], limitations: ['Fictional UI fixture. Evidence history is bounded.'] };
const events = { pending: 1, held: 1, oldestPendingAt: at, needsReconciliation: false, streams: [] };
const actions = [], errors = []; let externalRequests = 0, downloads = 0;
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 1050 } });
await context.addInitScript(() => sessionStorage.setItem('gtm-control-tower-operator-key', 'fictional-operator'));
const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', (error) => errors.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { externalRequests++; return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  try {
    assert.equal(url.pathname, '/api/control-tower/incidents');
    assert.equal(request.headers()['x-control-tower-key'], 'fictional-operator');
    const provider = url.searchParams.get('provider') ?? 'hubspot';
    let id = url.searchParams.get('incident');
    if (request.method() === 'POST') {
      const body = request.postDataJSON(); actions.push(body); id = body.id ?? id;
      assert.equal(body.provider, provider);
      if (body.action === 'investigate') investigation = { id: 'investigation-1', incidentId: incident.id, createdAt: at, evidenceVersion: incident.version, mode: 'evidence', facts: [{ text: '120 records are linked to this incident.', evidenceIds: [`incident:${incident.id}`] }], hypotheses: [{ text: 'A shared source change is possible; its origin is not established.', evidenceIds: [observation.id] }], unknowns: ['The originating integration is unknown.'], nextSteps: ['Inspect the upstream change history.'], ruleSuggestion: null };
      else if (body.action === 'triage') Object.assign(incident, { status: body.status, assignee: body.assignee, note: body.note, resolution: body.resolution, version: incident.version + 1 });
      else if (body.action === 'policy') Object.assign(policy, body.policy, { version: policy.version + 1 });
      else if (body.action === 'retry_events') events.held = 0;
      else assert.equal(body.action, 'resume_repairs');
    }
    return route.fulfill({ json: { scope: 'fixture-account', accounts: [{ scope: 'fixture-account', accountId: 'fixture-account', provider }], role: 'operator', model: { modelConfigured: false, model: null }, events,
      overview: { policy, incidents: [incident], totals: {open: 1, investigating: 0, resolved: 0}, truncated: false, coverage, repairControl: { paused: false, pausedAt: null, reason: null } }, detail: id ? incident : null, evidence: id ? evidence : null, investigation: id ? investigation : null } });
  } catch (error) { errors.push(error.message); return route.fulfill({ status: 500, json: { error: error.message } }); }
});

try {
  await page.goto(`${base.origin}/app/incidents`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Understand what changed.' }).waitFor();
  await page.getByRole('button', { name: /Job titles cleared across a connected cohort/ }).click();
  await page.getByRole('heading', { name: 'Job titles cleared across a connected cohort', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Prepare investigation', exact: true }).click();
  await page.getByRole('heading', { name: 'Saved investigation' }).waitFor();
  await page.getByRole('heading', { name: 'Provider-reported events' }).waitFor();
  assert.equal(await page.getByText(/Actor: reported-user-7/).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Investigate with configured model' }).isDisabled(), true);
  await page.screenshot({ path: resolve(directory, 'desktop.png'), fullPage: true });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download evidence' }).click();
  const file = await download; await file.saveAs(resolve(directory, 'evidence.json')); downloads++;
  await page.getByLabel('Assignee', { exact: true }).fill('Data Operations');
  await page.getByLabel('Status', { exact: true }).selectOption('investigating');
  await page.getByLabel('Evidence and next step').fill('Compare the source change history before proposing any update.');
  await page.getByRole('button', { name: 'Save decision' }).click();
  await page.getByRole('status').filter({ hasText: 'Incident decision saved' }).waitFor();
  await page.getByText('Detection and response policy · version 1', { exact: true }).click();
  await page.getByLabel('Minimum affected records', { exact: true }).fill('15');
  await page.getByRole('button', { name: 'Save policy version', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'New policy version saved' }).waitFor();
  assert.equal(policy.minimumRecords, 15);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(directory, 'mobile.png'), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile must not overflow horizontally.');
  await page.getByLabel('CRM', { exact: true }).selectOption('salesforce');
  await page.getByRole('button', { name: /Job titles cleared across a connected cohort/ }).waitFor();
  await page.screenshot({ path: resolve(directory, 'salesforce-mobile.png'), fullPage: true });
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(externalRequests, 0);
  const report = { passed: true, fictional: true, externalRequests, downloads, actions: actions.map((action) => action.action), screenshots: ['desktop.png', 'mobile.png', 'salesforce-mobile.png'] };
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
} finally { await browser.close(); }
