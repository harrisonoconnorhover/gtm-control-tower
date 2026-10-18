import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { parseHandoffManifest, parseDestinationEvidence, reconcileHandoff } from '../lib/handoff-audit.ts';

// Browser-only synthetic API fixture. This never opens a CRM connection or writes production data.
// The actual React UI and reconciliation engine run; API persistence is mocked and tested separately.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL ?? 'http://127.0.0.1:3198');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && ['http:', 'https:'].includes(base.protocol)
  && !base.username && !base.password && !base.search && !base.hash, 'Use an isolated local application URL.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an available Chromium executable.');
const directory = resolve(process.env.CONTROL_TOWER_HANDOFF_UI_OUTPUT_DIR ?? '.runtime/handoff-audit-ui');
mkdirSync(directory, { recursive: true });
const accounts = [{ scope: 'fixture-hubspot', provider: 'hubspot', accountId: 'fixture-hubspot' }, { scope: 'salesforce_fixture-org', provider: 'salesforce', accountId: 'fixture-org' }];
const saved = new Map(), actions = [], pageErrors = [], blockedRequests = [], checks = [];
let snapshotForMonitor = null;
const report = { passed: false, fictional: true, apiMocked: true, realReconciliationEngine: true, crmReads: false, crmWrites: false, checks, actions, screenshots: [] };
function check(name, actual, expected) { const passed = JSON.stringify(actual) === JSON.stringify(expected); checks.push({ name, passed, actual, expected }); assert(passed, `${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`); }
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 1050 } });
await context.addInitScript(() => sessionStorage.setItem('gtm-control-tower-operator-key', 'synthetic-operator'));
const page = await context.newPage(); page.setDefaultTimeout(20_000);
page.on('pageerror', error => pageErrors.push(error.message));
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { blockedRequests.push({ origin: url.origin, path: url.pathname }); return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  try {
    assert.equal(url.pathname, '/api/control-tower/handoff-audits', 'No other app API is permitted in this fixture.');
    assert.equal(request.headers()['x-control-tower-key'], 'synthetic-operator');
    let id = url.searchParams.get('id');
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      assert(['create', 'reconcile'].includes(body.action), 'Only local audit actions are permitted.');
      actions.push(body.action);
      if (body.action === 'create') {
        const manifest = parseHandoffManifest(body.manifest); id = `synthetic-audit-${saved.size + 1}`;
        const mode = body.evidence ? 'snapshot' : 'monitor';
        const evidence = parseDestinationEvidence(body.evidence ?? { ...snapshotForMonitor, accountId: manifest.destinationAccount });
        const at = new Date().toISOString();
        const evaluated = reconcileHandoff(manifest, evidence, at);
        const value = { id, name: manifest.name, createdAt: at, sourceAccount: manifest.sourceAccount, destinationAccount: manifest.destinationAccount, mode, manifest, evidence, report: evaluated, reportId: `${id}-report-1`, history: [{ id: `${id}-report-1`, evaluatedAt: at }], relatedIncidents: [] };
        saved.set(id, value); snapshotForMonitor = evidence;
      } else {
        id = body.id;
        const previous = saved.get(id); assert(previous, 'A saved audit is required.');
        const evidence = body.evidence ? parseDestinationEvidence(body.evidence) : previous.evidence;
        const before = (next, prior) => next !== null && prior !== null && Date.parse(next) < Date.parse(prior);
        if (before(evidence.observedAt, previous.evidence.observedAt) || before(evidence.completeThrough, previous.evidence.completeThrough)) {
          return route.fulfill({ status: 400, json: { error: 'Replacement evidence predates the latest saved snapshot. Import older evidence as a separate audit to preserve the latest known handoff state.' } });
        }
        const at = new Date().toISOString(), reportId = `${id}-report-${previous.history.length + 1}`;
        saved.set(id, { ...previous, evidence, report: reconcileHandoff(previous.manifest, evidence, at), reportId, history: [...previous.history, { id: reportId, evaluatedAt: at }] });
      }
    } else assert.equal(request.method(), 'GET');
    const audits = Array.from(saved.values()).map(({ id, name, createdAt, sourceAccount, destinationAccount, mode }) => ({ id, name, createdAt, sourceAccount, destinationAccount, mode }));
    return route.fulfill({ json: { accounts, audits, selected: saved.get(id) ?? null } });
  } catch (error) { pageErrors.push(error.message); return route.fulfill({ status: 500, json: { error: error.message } }); }
});
const rows = () => page.getByRole('region', { name: 'Source row accounting', exact: true });
async function exportFile(buttonName, filename) { const waiting = page.waitForEvent('download'); await page.getByRole('button', { name: buttonName, exact: true }).click(); const download = await waiting; await download.saveAs(resolve(directory, filename)); return readFileSync(resolve(directory, filename), 'utf8'); }
function uploadObject(value, name) { return { name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) }; }
try {
  await page.goto(`${base.origin}/app/handoff-audits`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Follow every handoff.', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load synthetic example', exact: true }).click();
  await page.getByText('Synthetic example · no live connection', { exact: true }).waitFor();
  check('Synthetic example preserves all twelve source rows', await rows().locator('details[data-row-id]').count(), 12);
  check('Client preview has not saved or reconciled automatically', actions.length, 0);
  check('Fresh preview desktop does not overflow horizontally', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({ path: resolve(directory, 'fresh-preview-desktop.png'), fullPage: true }); report.screenshots.push('fresh-preview-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  check('Fresh preview mobile does not overflow horizontally', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({ path: resolve(directory, 'fresh-preview-mobile.png'), fullPage: true }); report.screenshots.push('fresh-preview-mobile.png');
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByLabel('Arrival status', { exact: true }).selectOption('unknown');
  check('Unknown identity, eligibility, and stale evidence remain visible', await rows().locator('details[data-row-id]').count(), 5);
  await rows().locator('details[data-row-id="cohort-7"] summary').click();
  check('Missing stable ID is explicitly visible', await rows().getByText('Row cohort-7 · HubSpot ID unknown', { exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByLabel('Routing status', { exact: true }).selectOption('unrouted');
  check('Arrived-but-unrouted has its own filter', await rows().locator('details[data-row-id]').count(), 1);
  check('The unrouted record remains present in Salesforce', await rows().locator('details[data-row-id]').getByText('Present in Salesforce', { exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByLabel('Arrival status', { exact: true }).selectOption('excluded');
  check('Valid exclusion is separate from missing', await rows().locator('details[data-row-id]').count(), 1);
  await page.getByLabel('Arrival status', { exact: true }).selectOption('failed');
  check('Explicit partial failure is separate from missing', await rows().locator('details[data-row-id]').count(), 1);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();

  const exported = JSON.parse(await exportFile('Export JSON', 'initial-snapshot.json'));
  check('Evidence export retains the full cohort and snapshot', [exported.manifest.rows.length, exported.evidence.records.length, exported.synthetic], [12, 7, true]);
  exported.manifest.rows[0].label = '=SUM(1,2)';
  await page.getByLabel('Import audit JSON file', { exact: true }).setInputFiles(uploadObject(exported, 'synthetic-roundtrip.json'));
  await page.getByRole('status').filter({ hasText: 'Loaded synthetic-roundtrip.json' }).waitFor();
  check('Imported JSON preserves stable source row identities', await rows().locator('details[data-row-id]').count(), 12);
  const csv = await exportFile('Export CSV', 'source-accounting.csv');
  check('CSV export neutralizes spreadsheet formulas', csv.includes('"\'=SUM(1,2)"'), true);
  check('CSV export includes routing independently', csv.split('\r\n')[0].includes('"routing_status"'), true);
  await page.getByText('Advanced: manifest and destination evidence JSON', { exact: true }).click();
  await page.getByLabel('Manifest JSON', { exact: true }).fill('{');
  check('Unvalidated JSON cannot be saved', await page.getByRole('button', { name: 'Save read-only audit', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Validate JSON and preview', exact: true }).click();
  check('Invalid JSON produces a visible error', await page.getByRole('alert').count(), 1);
  await page.getByLabel('Manifest JSON', { exact: true }).fill(JSON.stringify(exported.manifest));
  await page.getByRole('button', { name: 'Validate JSON and preview', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'JSON validated' }).waitFor();
  await page.getByText('Advanced: manifest and destination evidence JSON', { exact: true }).click();
  await page.getByLabel('Sync deadline (minutes)', { exact: true }).fill('45');
  await page.getByLabel('Sync deadline (minutes)', { exact: true }).fill('30');
  await page.getByRole('button', { name: 'Save read-only audit', exact: true }).click();
  await page.getByRole('heading', { name: 'Handoff report', exact: true }).waitFor();
  check('Saving creates one local audit action', actions, ['create']);
  check('Saved policy is not editable in place', await page.getByLabel('Sync deadline (minutes)', { exact: true }).count(), 0);
  check('Saved manifest preserves the original cohort', saved.get('synthetic-audit-1').manifest.rows.length, 12);
  const originalManifest = structuredClone(saved.get('synthetic-audit-1').manifest);
  const beforeReloadActions = actions.length;
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Handoff report', exact: true }).waitFor();
  check('Reload reads saved audit without automatic reconciliation', actions.length, beforeReloadActions);

  const replacement = structuredClone(exported.evidence);
  const now = new Date().toISOString(); replacement.observedAt = now; replacement.completeThrough = now;
  replacement.records.push({ objectType: 'Lead', id: '00Q000000000003', observedAt: now, sourceUpdatedAt: now, firstObservedAt: now, properties: { Source_Record_ID__c: 'source-3', Routing_Status__c: 'Pending' } });
  await page.getByLabel('Replacement destination snapshot', { exact: true }).setInputFiles(uploadObject(replacement, 'delayed-arrival.json'));
  await page.getByRole('status').filter({ hasText: 'Replacement snapshot staged' }).waitFor();
  check('Staging replacement evidence causes no reconciliation', actions.length, 1);
  await page.getByRole('button', { name: 'Reconcile with staged snapshot', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Reconciled using the replacement snapshot' }).waitFor();
  const arrived = saved.get('synthetic-audit-1').report.rows.find(row => row.rowId === 'cohort-3');
  check('Delayed arrival becomes present with routing pending', [arrived.status, arrived.routing], ['present', 'awaiting_routing']);
  check('Reconciliation preserves source cohort and policy immutably', saved.get('synthetic-audit-1').manifest, originalManifest);
  await page.getByLabel('Find row or record ID', { exact: true }).fill('source-3');
  check('Stable ID search finds the delayed arrival', await rows().locator('details[data-row-id]').count(), 1);
  await rows().locator('details[data-row-id="cohort-3"] summary').click();
  check('Row detail exposes source and destination evidence timestamps', [await rows().getByText('Source observed at', { exact: true }).count(), await rows().getByText('Destination observed at', { exact: true }).count()], [1, 1]);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  const evaluatedBefore = saved.get('synthetic-audit-1').evidence.observedAt;
  await page.getByRole('button', { name: 'Reconcile saved evidence', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Its evidence timestamps have not been refreshed' }).waitFor();
  check('Re-evaluation never fabricates a fresh snapshot timestamp', saved.get('synthetic-audit-1').evidence.observedAt, evaluatedBefore);

  const stale = structuredClone(replacement), old = new Date(Date.now() - 120 * 60_000).toISOString();
  stale.observedAt = old; stale.completeThrough = old;
  stale.records.forEach(record => { record.observedAt = old; record.sourceUpdatedAt = old; record.firstObservedAt = old; });
  await page.getByLabel('Replacement destination snapshot', { exact: true }).setInputFiles(uploadObject(stale, 'stale-snapshot.json'));
  await page.getByRole('button', { name: 'Reconcile with staged snapshot', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Replacement evidence predates the latest saved snapshot' }).waitFor();
  check('Older replacement cannot erase the latest observed handoff', [saved.get('synthetic-audit-1').evidence.observedAt, saved.get('synthetic-audit-1').history.length, saved.get('synthetic-audit-1').report.rows.find(row => row.rowId === 'cohort-3').status], [evaluatedBefore, 3, 'present']);
  await page.getByRole('button', { name: 'Discard staged snapshot', exact: true }).click();
  await page.getByLabel('Import audit JSON file', { exact: true }).setInputFiles(uploadObject({ synthetic: true, manifest: { ...exported.manifest, name: 'Synthetic stale evidence audit' }, evidence: stale }, 'separate-stale-audit.json'));
  await page.getByRole('status').filter({ hasText: 'Loaded separate-stale-audit.json' }).waitFor();
  await page.getByRole('button', { name: 'Save read-only audit', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic stale evidence audit', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Stale or incomplete evidence needs review', exact: true }).waitFor();
  check('Older evidence is retained in a separate audit', saved.get('synthetic-audit-2').evidence.observedAt, old);
  check('Stale destination evidence is visibly flagged', saved.get('synthetic-audit-2').report.evidenceSummary.fresh, false);
  await page.getByLabel('Arrival status', { exact: true }).selectOption('unknown');
  check('Stale evidence remains unknown rather than proving arrival or loss', await rows().locator('details[data-row-id]').count() > 0, true);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  check('Desktop does not overflow horizontally', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({ path: resolve(directory, 'stale-desktop.png'), fullPage: true }); report.screenshots.push('stale-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  check('Mobile does not overflow horizontally', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({ path: resolve(directory, 'stale-mobile.png'), fullPage: true }); report.screenshots.push('stale-mobile.png');

  await page.getByRole('button', { name: 'Create revised audit', exact: true }).click();
  await page.getByRole('heading', { name: 'Review a new audit', exact: true }).waitFor();
  await page.getByLabel('Evidence source', { exact: true }).selectOption('monitor');
  await page.getByLabel('Saved HubSpot account', { exact: true }).selectOption('fixture-hubspot');
  await page.getByLabel('Saved Salesforce account', { exact: true }).selectOption('salesforce_fixture-org');
  await page.getByLabel('Audit name', { exact: true }).fill('Synthetic retained-monitor audit');
  await page.getByRole('button', { name: 'Save read-only audit', exact: true }).click();
  await page.getByRole('heading', { name: 'Synthetic retained-monitor audit', exact: true }).waitFor();
  check('Monitor audit uses the explicitly selected account scopes', [saved.get('synthetic-audit-3').sourceAccount, saved.get('synthetic-audit-3').destinationAccount, saved.get('synthetic-audit-3').mode], ['fixture-hubspot', 'salesforce_fixture-org', 'monitor']);
  check('Snapshot upload is not offered for monitor evidence', await page.getByLabel('Replacement destination snapshot', { exact: true }).count(), 0);
  await page.getByRole('button', { name: /Synthetic campaign handoff Imported snapshot/ }).click();
  await page.getByRole('heading', { name: 'Synthetic campaign handoff', exact: true }).waitFor();
  check('Saved audit selection restores original policy', saved.get('synthetic-audit-1').manifest, originalManifest);
  check('Only explicit create and reconcile actions were sent', actions, ['create', 'reconcile', 'reconcile', 'reconcile', 'create', 'create']);
  check('No external request was attempted', blockedRequests, []);
  check('No browser exceptions occurred', pageErrors, []);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error); report.pageErrors = pageErrors; report.blockedRequests = blockedRequests;
  await page.screenshot({ path: resolve(directory, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
console.log(JSON.stringify({ passed: report.passed, fictional: true, apiMocked: true, checks: checks.length, result: resolve(directory, 'report.json'), ...(report.failure ? { failure: report.failure } : {}) }));
