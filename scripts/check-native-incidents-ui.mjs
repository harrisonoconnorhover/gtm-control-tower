import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Real local application and saved native evidence. This script never replaces API responses.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL ?? 'http://127.0.0.1:3197');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && ['http:', 'https:'].includes(base.protocol)
  && !base.username && !base.password && !base.search && !base.hash, 'Use an isolated local application URL.');
const provider = process.env.CONTROL_TOWER_NATIVE_PROVIDER;
assert(['hubspot', 'salesforce'].includes(provider), 'Choose CONTROL_TOWER_NATIVE_PROVIDER.');
const operatorKey = process.env.CONTROL_TOWER_SYNC_KEY;
assert(operatorKey?.trim(), 'Provide the isolated application operator access key.');
const configuredDirectory = process.env.CONTROL_TOWER_NATIVE_OUTPUT_DIR;
assert(configuredDirectory && isAbsolute(configuredDirectory), 'Use an absolute CONTROL_TOWER_NATIVE_OUTPUT_DIR containing the native manifest.');
const directory = resolve(configuredDirectory); mkdirSync(directory, { recursive: true, mode: 0o700 });
const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
assert.equal(manifest.provider, provider, 'The native manifest belongs to a different provider.');
assert(manifest.accountId && Object.keys(manifest.records ?? {}).length > 100, 'A seeded native qualification manifest is required.');
const runId = process.env.CONTROL_TOWER_NATIVE_RUN_ID ?? manifest.runId ?? basename(dirname(directory));
assert.equal(manifest.runId, runId, 'The native manifest belongs to another run.');
const ownedRecords = new Set(Object.values(manifest.records).map(record => `${record.objectType}:${record.nativeId}`));
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to the available Chromium executable.');
const scrub = value => String(value).replaceAll(operatorKey, '[redacted]');
const save = (name, value) => writeFileSync(resolve(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const checks = [], pageErrors = [], consoleErrors = [], networkFailures = [], blockedRequests = [], apiRequests = [];
const report = { version: 1, runId, provider, providers: [provider], evidenceSource: 'native-qualification-sqlite',
  startedAt: new Date().toISOString(), finishedAt: null, passed: false, realApplication: true, apiMocked: false,
  nativeCrmWrites: false, checks, artifacts: [],
  limitations: ['Local browser used saved native qualification SQLite; no hosted deployment or new browser-triggered CRM writes.'],
};
let initialAuthorizationChallenges = 0;
function check(name, actual, expected) {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ name, provider, passed, expected, actual });
  assert(passed, `${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
}
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 1050 } });
const page = await context.newPage(); page.setDefaultTimeout(30_000);
page.on('pageerror', error => pageErrors.push(scrub(error.message)));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(scrub(message.text())); });
page.on('requestfailed', request => {
  // React intentionally aborts superseded refreshes; these do not represent application failures.
  const error = request.failure()?.errorText ?? 'Unknown request failure';
  if (error !== 'net::ERR_ABORTED') networkFailures.push({ path: new URL(request.url()).pathname, error: scrub(error) });
});
page.on('response', response => {
  const request = response.request(), url = new URL(response.url());
  if (!url.pathname.startsWith('/api/')) return;
  const unauthenticated = !request.headers()['x-control-tower-key'];
  if (response.status() === 401 && unauthenticated) initialAuthorizationChallenges++;
  apiRequests.push({ path: url.pathname, method: request.method(), status: response.status(), unauthenticated,
    action: request.method() === 'POST' ? request.postDataJSON()?.action ?? null : null });
});
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { blockedRequests.push({ origin: url.origin, path: url.pathname }); return route.abort('blockedbyclient'); }
  if (url.pathname.startsWith('/api/') && request.method() !== 'GET') {
    const body = request.postDataJSON();
    if (url.pathname !== '/api/control-tower/incidents' || request.method() !== 'POST'
      || !['investigate', 'triage'].includes(body?.action) || body?.useModel === true) {
      blockedRequests.push({ origin: url.origin, path: url.pathname, action: body?.action ?? null }); return route.abort('blockedbyclient');
    }
  }
  return route.continue();
});
function waitForIncidentResponse({ method = 'GET', action, incident } = {}) {
  return page.waitForResponse(response => {
    const request = response.request(), url = new URL(response.url());
    return url.pathname === '/api/control-tower/incidents' && request.method() === method && response.ok()
      && request.headers()['x-control-tower-key'] === operatorKey
      && (!action || request.postDataJSON()?.action === action) && (!incident || url.searchParams.get('incident') === incident);
  });
}
function validateSavedEvidence(value, selected) {
  assert.equal(value.incident?.id, selected.id, 'Evidence export does not match the selected native incident.');
  assert.equal(value.incident.kind, 'mass_field_clearing');
  assert.equal(value.incident.affectedRecords, selected.affectedRecords);
  assert(Array.isArray(value.incident.records) && value.incident.records.length > 0, 'Affected native record keys must be retained.');
  assert(Array.isArray(value.incident.observations) && value.incident.observations.length > 0, 'Native observations must be retained.');
  const changes = value.incident.observations.filter(observation => observation.changes.some(change => change.field === selected.field && String(change.before ?? '').trim() && !String(change.after ?? '').trim()));
  assert(changes.length >= 2, 'A bulk-clear export must contain multiple actual populated-to-empty observations.');
  for (const observation of value.incident.observations) assert(ownedRecords.has(`${observation.objectType}:${observation.recordId}`), 'Exported observation is outside the seeded native manifest.');
  const snapshots = value.evidence?.records ?? [];
  assert(snapshots.length > 0, 'Exported native record snapshots are missing.');
  for (const item of snapshots) assert(ownedRecords.has(`${item.record.objectType}:${item.record.id}`), 'Exported snapshot is outside the seeded native manifest.');
  assert(value.investigation?.facts?.length > 0, 'The saved investigation must contain evidence-based facts.');
  return { file: 'ui-evidence.json', records: value.incident.records.length, snapshots: snapshots.length,
    observations: value.incident.observations.length, clearedObservations: changes.length };
}

try {
  await page.goto(`${base.origin}/app/incidents?provider=${provider}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Understand what changed.', exact: true }).waitFor();
  // Enter through the visible form; no storage injection or authenticated API shortcut.
  await page.getByLabel('Operator access key', { exact: true }).fill(operatorKey);
  const refreshed = waitForIncidentResponse();
  await page.getByRole('button', { name: 'Refresh evidence', exact: true }).click();
  const loaded = await (await refreshed).json();
  check('The visible operator form authenticates against the real application', loaded.role, 'operator');
  check('The saved account matches the seeded native manifest', loaded.accounts?.find(account => account.scope === loaded.scope)?.accountId, manifest.accountId);
  check('The selected CRM matches the requested native provider', await page.getByLabel('CRM', { exact: true }).inputValue(), provider);
  check('A model is not configured for this local native-evidence test', loaded.model?.modelConfigured, false);
  const selected = loaded.overview?.incidents?.find(incident => incident.kind === 'mass_field_clearing' && incident.status !== 'resolved');
  assert(selected && selected.affectedRecords >= 10, 'A retained native bulk-clear incident is required before browser qualification.');
  report.incident = { id: selected.id, kind: selected.kind, title: selected.title, objectType: selected.objectType, field: selected.field, affectedRecords: selected.affectedRecords };
  const selection = waitForIncidentResponse({ incident: selected.id });
  await page.locator('aside').getByRole('button').filter({ hasText: selected.title }).filter({ hasText: `${selected.affectedRecords} records · ${selected.objectType}` }).first().click();
  const selectedResponse = await (await selection).json();
  check('The selected list item loads the real retained incident', selectedResponse.detail?.id, selected.id);
  await page.getByRole('heading', { name: selected.title, exact: true }).waitFor();
  check('The unsupported model action is disabled', await page.getByRole('button', { name: 'Investigate with configured model', exact: true }).isDisabled(), true);

  const investigationResponse = waitForIncidentResponse({ method: 'POST', action: 'investigate' });
  await page.getByRole('button', { name: 'Prepare investigation', exact: true }).click();
  const investigated = await (await investigationResponse).json();
  await page.getByRole('heading', { name: 'Saved investigation', exact: true }).waitFor();
  check('Investigation uses retained evidence without a model call', investigated.investigation?.mode, 'evidence');
  check('The investigation remains attached to the selected native incident', investigated.investigation?.incidentId, selected.id);
  report.investigation = { mode: investigated.investigation.mode, evidenceVersion: investigated.investigation.evidenceVersion };

  const assignee = 'Native browser reviewer';
  const note = `Synthetic native ${provider === 'hubspot' ? 'HubSpot' : 'Salesforce'} qualification evidence reviewed in the local browser. Investigate the deliberate bulk clear; no restoration or CRM write is approved by this triage.`;
  await page.getByLabel('Assignee', { exact: true }).fill(assignee);
  await page.getByLabel('Status', { exact: true }).selectOption('investigating');
  await page.getByLabel('Evidence and next step', { exact: true }).fill(note);
  const triageResponse = waitForIncidentResponse({ method: 'POST', action: 'triage' });
  await page.getByRole('button', { name: 'Save decision', exact: true }).click();
  const triaged = await (await triageResponse).json();
  check('Human triage saves through the authenticated browser route', [triaged.detail?.status, triaged.detail?.assignee, triaged.detail?.note], ['investigating', assignee, note]);
  await page.getByRole('status').filter({ hasText: 'Incident decision saved.' }).waitFor();

  const reloadResponse = waitForIncidentResponse({ incident: selected.id });
  await page.reload({ waitUntil: 'networkidle' });
  const reloaded = await (await reloadResponse).json();
  check('Native-evidence triage persists after a full page reload', [reloaded.detail?.status, reloaded.detail?.assignee, reloaded.detail?.note], ['investigating', assignee, note]);
  check('The persisted assignee appears in the actual form', await page.getByLabel('Assignee', { exact: true }).inputValue(), assignee);
  check('The persisted status appears in the actual form', await page.getByLabel('Status', { exact: true }).inputValue(), 'investigating');
  report.triage = { status: 'investigating', assignee, note, persisted: true };

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download evidence', exact: true }).click();
  const download = await downloading; await download.saveAs(resolve(directory, 'ui-evidence.json'));
  report.evidence = validateSavedEvidence(JSON.parse(readFileSync(resolve(directory, 'ui-evidence.json'), 'utf8')), selected);
  check('Downloaded bulk evidence contains actual native record snapshots and changes', report.evidence.snapshots > 0 && report.evidence.clearedObservations >= 2, true);

  await page.evaluate(() => window.scrollTo(0, 0));
  check('Desktop layout has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await page.screenshot({ path: resolve(directory, 'ui-desktop.png'), fullPage: true });
  report.artifacts.push({ label: 'Desktop incident evidence', path: 'ui-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('heading', { name: selected.title, exact: true }).waitFor();
  check('Mobile layout has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await page.screenshot({ path: resolve(directory, 'ui-mobile.png'), fullPage: true });
  report.artifacts.push({ label: 'Mobile incident evidence', path: 'ui-mobile.png' });
  await page.getByRole('heading', { name: selected.title, exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(directory, 'ui-mobile-detail.png'), fullPage: false });
  report.artifacts.push({ label: 'Mobile selected incident detail', path: 'ui-mobile-detail.png' }, { label: 'Downloaded native incident evidence', path: 'ui-evidence.json' });

  const expectedAuthConsole = consoleErrors.filter(message => /Failed to load resource.*401/.test(message));
  const unexpectedConsole = consoleErrors.filter(message => !/Failed to load resource.*401/.test(message));
  check('Initial unauthenticated resource errors are explained by operator-key challenges', expectedAuthConsole.length <= initialAuthorizationChallenges, true);
  check('The application has no browser exceptions', pageErrors, []);
  check('The application has no unexpected console errors', unexpectedConsole, []);
  check('The browser has no unexpected failed network requests', networkFailures, []);
  check('The browser sends no external or unsupported action requests', blockedRequests, []);
  check('Authenticated application API responses succeed', apiRequests.filter(request => !request.unauthenticated && request.status >= 400), []);
  check('The only browser mutations are investigation and human triage', apiRequests.filter(request => request.method === 'POST').map(request => request.action), ['investigate', 'triage']);
  report.browserErrors = pageErrors; report.externalRequests = blockedRequests.length; report.initialAuthorizationChallenges = initialAuthorizationChallenges; report.apiRequests = apiRequests;
  report.passed = true;
} catch (error) {
  report.failure = scrub(error instanceof Error ? error.message : error);
  report.browserErrors = pageErrors; report.consoleErrors = consoleErrors; report.apiRequests = apiRequests;
  await page.screenshot({ path: resolve(directory, 'ui-failure.png'), fullPage: true }).catch(() => {});
  report.artifacts.push({ label: 'Failed browser check', path: 'ui-failure.png' });
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString(); save('ui-result.json', report);
  await browser.close();
}
console.log(JSON.stringify({ provider, passed: report.passed, checks: checks.length, failed: checks.filter(check => !check.passed).length,
  result: resolve(directory, 'ui-result.json'), ...(report.failure ? { failure: report.failure } : {}) }));
