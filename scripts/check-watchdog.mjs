import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// UI-only qualification: all Watchdog reads, decisions, and repairs below are
// fictional route fixtures. No request reaches a CRM or the real Watchdog API.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3087');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a disposable local server.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
const output = resolve('.runtime/watchdog-ui');
mkdirSync(output, { recursive: true });
const at = '2026-10-10T14:00:00.000Z';
const accountId = '900000001';
const fixtureKey = 'fictional-watchdog-ui-key';
const common = { accountId, severity: 'warning', status: 'open', assignee: 'RevOps', note: '', firstSeenAt: at, lastSeenAt: at, resolvedAt: null, occurrences: 1, repairError: null };
let overview = {
  accountId,
  config: { enabled: false, automaticRepairs: false, intervalSeconds: 300, defaultAssignee: 'RevOps' },
  phase: 'changes', lastCheckedAt: at, watermark: at, nextCheckAt: null,
  coverageNote: 'Fictional UI fixture: one completed baseline and subsequent contact changes. Not live HubSpot evidence.',
  findings: [
    { ...common, id: 'missing-email', contactId: '101', contactLabel: 'Rowan Lane', rule: 'email_missing', summary: 'This contact has no email.', detail: 'A human must confirm the correct address.', before: { email: '' }, after: {} },
    { ...common, id: 'lifecycle', contactId: '102', contactLabel: 'Alex Morgan', rule: 'lifecycle_regression', severity: 'critical', summary: 'Lifecycle moved from customer to lead.', detail: 'Review whether this was an intentional change. No reversal is proposed.', before: { lifecyclestage: 'customer' }, after: { lifecyclestage: 'lead' } },
    { ...common, id: 'unknown-repair', contactId: '103', contactLabel: 'Casey Taylor', rule: 'text_whitespace', status: 'unknown', summary: 'The repair outcome needs verification.', detail: 'A connection ended before verification completed.', before: { company: '  Example Company  ' }, after: { company: 'Example Company' }, repairError: 'Fictional readback interruption.' },
    { ...common, id: 'fixed-repair', contactId: '104', contactLabel: '=1+1', rule: 'text_whitespace', status: 'fixed', resolvedAt: at, summary: 'Extra job title spaces repaired.', detail: 'The fixture represents a verified repair.', before: { jobtitle: ' Director ' }, after: { jobtitle: 'Director' } },
  ],
  runs: [{ id: 'fixture-run-1', accountId, startedAt: at, finishedAt: at, status: 'completed', scanned: 7, opened: 4, fixed: 1, needsReview: 3, error: null, phase: 'changes' }],
  totals: { open: 2, inProgress: 0, fixed: 1, resolved: 0, unknown: 1 },
};
const errors = [], requests = [];
let getCount = 0, mode = 'ready', externalRequests = 0;
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 1100 } });
await context.addInitScript((key) => sessionStorage.setItem('gtm-control-tower-operator-key', key), fixtureKey);
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on('pageerror', (error) => errors.push(error.message));
await page.clock.install();

await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { externalRequests++; errors.push(`Blocked external request: ${url.origin}`); return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  try {
    assert.equal(url.pathname, '/api/control-tower/watchdog', 'Only the mocked Watchdog endpoint is allowed.');
    assert.equal(request.headers()['x-control-tower-key'], fixtureKey, 'The operator key must be sent in a header.');
    assert(!url.search.includes(fixtureKey), 'Keys must not appear in URLs.');
    if (request.method() === 'GET') {
      getCount++;
      if (mode === 'unconfigured') return route.fulfill({ status: 503, json: { error: 'Fictional HubSpot setup is incomplete.' } });
      return route.fulfill({ json: { watchdog: overview } });
    }
    assert.equal(request.method(), 'POST');
    const body = request.postDataJSON(); requests.push(body);
    if (body.action === 'configure') {
      assert.deepEqual(Object.keys(body).sort(), ['action', 'config']);
      overview.config = body.config;
      overview.nextCheckAt = body.config.enabled ? '2026-10-10T14:05:00.000Z' : null;
    } else if (body.action === 'triage') {
      assert.deepEqual(Object.keys(body).sort(), ['action', 'assignee', 'id', 'note', 'status']);
      const finding = overview.findings.find((entry) => entry.id === body.id);
      assert(finding, 'Triage must reference an existing finding.');
      Object.assign(finding, { status: body.status, assignee: body.assignee, note: body.note });
      overview.totals = {
        open: overview.findings.filter((entry) => entry.status === 'open').length,
        inProgress: overview.findings.filter((entry) => entry.status === 'in_progress').length,
        fixed: overview.findings.filter((entry) => entry.status === 'fixed').length,
        resolved: overview.findings.filter((entry) => entry.status === 'resolved').length,
        unknown: overview.findings.filter((entry) => entry.status === 'unknown').length,
      };
    } else {
      assert.equal(body.action, 'tick');
      assert.deepEqual(body, { action: 'tick', force: true });
      assert(overview.config.enabled, 'Manual checks require saved enabled monitoring.');
      overview.runs.unshift({ ...overview.runs[0], id: 'fixture-manual-run', opened: 0, fixed: 0 });
    }
    return route.fulfill({ json: { watchdog: overview } });
  } catch (error) { errors.push(error.message); return route.fulfill({ status: 400, json: { error: error.message } }); }
});

function endpointResponse(method) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === '/api/control-tower/watchdog' && response.request().method() === method);
}

async function downloadText(buttonName) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: buttonName, exact: true }).click()]);
  const stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function checkWidth(label) {
  const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert(widths.document <= widths.viewport, `${label} layout overflows: ${JSON.stringify(widths)}`);
}

try {
  await page.goto(new URL('/app/watchdog', base).href);
  await page.getByRole('heading', { name: 'Monitoring paused', exact: true }).waitFor({ timeout: 45_000 });
  assert.equal(requests.length, 0, 'Opening the page must not mutate monitoring or contacts.');
  assert(await page.getByRole('button', { name: 'Run check now', exact: true }).isDisabled());
  assert(!(await page.getByRole('checkbox', { name: /Automatically repair extra spaces/ }).isChecked()));
  await page.getByText(/does not verify that the runner is online/).waitFor();
  await page.getByText(`HubSpot ${accountId}`, { exact: true }).waitFor();

  await page.getByRole('checkbox', { name: /Enable scheduled monitoring/ }).check();
  assert.equal(requests.length, 0, 'Changing draft settings must not save or repair anything.');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Monitoring enabled', exact: true }).waitFor();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].config.automaticRepairs, false, 'Enabling monitoring must not opt in to repairs.');
  await page.getByRole('checkbox', { name: /Automatically repair extra spaces/ }).check();
  await page.getByRole('combobox', { name: /Check interval/ }).selectOption('60');
  await page.getByLabel('Default review assignee', { exact: true }).fill('Revenue Systems');
  assert.equal(requests.length, 1);
  await Promise.all([endpointResponse('POST'), page.getByRole('button', { name: 'Save settings', exact: true }).click()]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].config, { enabled: true, automaticRepairs: true, intervalSeconds: 60, defaultAssignee: 'Revenue Systems' });
  await page.getByRole('button', { name: 'Run check now', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Check returned.' }).waitFor();
  assert.equal(requests.filter((body) => body.action === 'tick').length, 1);

  await page.getByRole('button', { name: /Rowan Lane/ }).click();
  await page.getByLabel('Assignee', { exact: true }).fill('Morgan — RevOps');
  await page.getByRole('combobox', { name: /Review status/ }).selectOption('in_progress');
  await page.getByLabel('Decision or next step', { exact: true }).fill('Confirm the address with the account owner.');
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Review decision saved.' }).waitFor();
  assert.deepEqual(requests.find((body) => body.action === 'triage'), { action: 'triage', id: 'missing-email', status: 'in_progress', assignee: 'Morgan — RevOps', note: 'Confirm the address with the account owner.' });
  assert.equal(await page.getByRole('link', { name: 'Open in HubSpot ↗', exact: true }).getAttribute('href'), `https://app.hubspot.com/contacts/${accountId}/contact/101`);
  await page.getByRole('button', { name: /Alex Morgan/ }).click();
  await page.getByRole('columnheader', { name: 'Previously observed', exact: true }).waitFor();
  await page.getByRole('columnheader', { name: 'Current value', exact: true }).waitFor();
  assert.equal(await page.getByRole('columnheader', { name: 'Proposed value', exact: true }).count(), 0, 'Lifecycle evidence must not suggest an automatic reversal.');
  await page.getByRole('button', { name: /Casey Taylor/ }).click();
  await page.getByText(/will not blindly replay this repair/).waitFor();

  const reportText = await downloadText('Report JSON');
  const report = JSON.parse(reportText);
  assert.equal(report.accountId, accountId);
  assert.equal(report.findings.length, 4);
  assert.equal(report.runs.length, 2);
  assert.equal(report.findings.find((finding) => finding.id === 'unknown-repair').status, 'unknown');
  assert(report.scope.includes('not a complete history'));
  assert(!reportText.includes(fixtureKey), 'Reports must exclude access credentials.');
  const csv = await downloadText('Findings CSV');
  assert(csv.includes('"\'=1+1"'), 'Spreadsheet exports neutralize formula-like contact values.');
  assert(csv.includes('"unknown"') && csv.includes('"in_progress"'), 'CSV must include actual saved outcomes.');
  assert(!csv.includes(fixtureKey));

  await checkWidth('Desktop');
  await page.screenshot({ path: resolve(output, 'desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await checkWidth('Mobile');
  await page.screenshot({ path: resolve(output, 'mobile.png'), fullPage: true });

  const writesBeforeReload = requests.length;
  await page.reload();
  await page.getByRole('heading', { name: 'Monitoring enabled', exact: true }).waitFor();
  assert.equal(requests.length, writesBeforeReload, 'Reload must not replay settings, triage, or a check.');
  const readsBeforePoll = getCount;
  await Promise.all([endpointResponse('GET'), page.clock.fastForward(31_000)]);
  assert(getCount > readsBeforePoll, 'The page should poll for fresh results.');
  assert.equal(requests.length, writesBeforeReload, 'Result polling must be read-only.');

  overview = { ...overview, phase: 'baseline', lastCheckedAt: null, watermark: null, nextCheckAt: null, findings: [], runs: [], totals: { open: 0, inProgress: 0, fixed: 0, resolved: 0, unknown: 0 }, coverageNote: 'Fictional baseline is not complete.' };
  await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
  await page.getByRole('heading', { name: 'No findings in this view', exact: true }).waitFor();
  await page.getByText(/No check has completed yet/).waitFor();
  await page.getByText(/No runs recorded/).waitFor();
  mode = 'unconfigured';
  await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Fictional HubSpot setup is incomplete.' }).waitFor();
  await page.getByText(/last loaded snapshot/).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Connect HubSpot to start monitoring.', exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'Run check now', exact: true }).isDisabled());
  assert.equal(await page.getByRole('heading', { name: 'Review queue', exact: true }).count(), 0, 'An unconfigured connection must not display fabricated findings.');
  await checkWidth('Mobile connection error');
  await page.screenshot({ path: resolve(output, 'unconfigured-mobile.png'), fullPage: true });

  assert.equal(requests.length, writesBeforeReload);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, evidence: 'fictional UI fixture; no live CRM calls', reads: getCount, writes: { configure: requests.filter((body) => body.action === 'configure').length, triage: requests.filter((body) => body.action === 'triage').length, manualChecks: requests.filter((body) => body.action === 'tick').length }, externalRequests, downloads: 2, viewports: ['1440x1100', '390x844'], screenshots: output }, null, 2));
} finally { await context.close(); await browser.close(); }
