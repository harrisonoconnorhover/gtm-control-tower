import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Two new fictional workspaces and one named demo template use real local
// persistence. Existing templates are hidden from this isolated browser context
// to avoid changing or conflicting with the user's template library. Every
// provider, website check, CRM operation, and external request is blocked.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3100');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Run this check against a local app only.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an installed Chrome or Chromium executable.');
const keyPath = resolve('.runtime/local-operator-key.txt');
const operatorKey = process.env.CONTROL_TOWER_OPERATOR_KEY || (existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : '');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const templateName = `Normalization demo ${stamp}`;
const output = resolve('outputs/import-normalization', stamp);
mkdirSync(output, { recursive: true });
const fixture = readFileSync(resolve('tests/fixtures/import-normalization/messy-contacts.csv'), 'utf8');
const customField = 'custom:contact:favorite_ice_cream';
const checks = [], failures = [], workspaceIds = new Set(), snapshots = new Map();
let templateId = '', workspaceMutations = 0, templateMutations = 0;
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true, viewport: { width: 1440, height: 1100 } });
await context.addInitScript((value) => sessionStorage.setItem('gtm-control-tower-operator-key', value), operatorKey);
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on('pageerror', (error) => failures.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { failures.push(`Blocked external request: ${url.origin}`); return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const endpoint = url.pathname.replace('/api/control-tower/', '');
  const body = request.method() === 'POST' ? request.postDataJSON() : null;
  try {
    if (endpoint === 'workspace') {
      const id = body?.id ?? url.searchParams.get('id');
      assert(workspaceIds.has(id), 'The test must never read or edit an existing user workspace.');
      if (body) {
        assert(['save', 'undo', 'receipt'].includes(body.action), 'Only local review save, undo, and receipt actions are permitted.');
        workspaceMutations++;
      }
      const response = await route.fetch();
      const data = await response.json();
      if (data.workspace) snapshots.set(id, data.workspace);
      return route.fulfill({ response, json: data });
    }
    if (endpoint === 'import-templates') {
      if (body) {
        assert.equal(body.action, 'save', 'The test must not delete or alter other templates.');
        assert.equal(body.template?.name, templateName);
        if (body.template.id) assert.equal(body.template.id, templateId);
        templateMutations++;
      }
      const response = await route.fetch();
      const data = await response.json();
      if (Array.isArray(data.templates)) {
        data.templates = data.templates.filter((template) => template.name === templateName);
        if (data.templates[0]) templateId = data.templates[0].id;
      }
      return route.fulfill({ response, json: data });
    }
    if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: Boolean(operatorKey),
      connectors: [{ id: 'csv', label: 'CSV', configured: true, directions: ['source', 'destination'], phases: [], mode: 'direct', features: [] }] } });
    if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from local normalization check.' } });
    assert.equal(request.method(), 'GET', `Blocked nonlocal operation: ${endpoint}`);
    if (endpoint === 'suppressions') return route.fulfill({ json: { rules: [] } });
    if (endpoint === 'website-checks') return route.fulfill({ json: { checks: [] } });
    if (endpoint === 'hubspot-import' && !url.searchParams.has('action')) return route.fulfill({ json: { review: null, stale: false } });
    if (endpoint === 'pomade-qualification') return route.fulfill({ json: { configured: false, qualification: null } });
    if (endpoint === 'local-matches') {
      const id = url.searchParams.get('workspaceId');
      const workspace = snapshots.get(id);
      return route.fulfill({ json: { workspaceId: id, workspaceRevision: workspace?.revision ?? 0,
        importObject: workspace?.state.importObject ?? 'contact_company', ruleVersion: 'normalization-ui-isolation', findings: [], warnings: [], snapshots: [],
        coverage: { importRows: workspace?.state.contacts.length ?? 0, crmRecords: 0, suppressionRules: 0, comparedPairs: 0 },
        rarity: { sampleSize: 120, available: false }, counts: { pending: 0, confirmed: 0, dismissed: 0 },
        total: 0, offset: 0, limit: 50, nextOffset: null } });
    }
    throw new Error(`Unexpected endpoint blocked: ${endpoint}`);
  } catch (error) {
    failures.push(error.message);
    return route.fulfill({ status: 403, json: { error: error.message } });
  }
});

const mapping = () => page.getByRole('region', { name: 'CSV column mapping', exact: true });
const templates = () => page.getByRole('region', { name: 'Shared import templates', exact: true });
const normalization = () => page.getByRole('region', { name: 'Import normalization', exact: true });
const field = (name) => mapping().getByLabel(`Control Tower field for ${name}`, { exact: true });
const workspaceResponse = (action, reason) => page.waitForResponse((response) => {
  if (new URL(response.url()).pathname !== '/api/control-tower/workspace' || response.request().method() !== 'POST') return false;
  const body = response.request().postDataJSON();
  return body.action === action && (!reason || body.reason === reason);
});
async function createWorkspace(suffix) {
  // Explicitly fixed local endpoint; APIRequestContext is not subject to browser routing.
  const response = await context.request.post(new URL('/api/control-tower/workspace', base).href,
    { data: { action: 'create', name: `Normalization demo ${suffix} ${stamp}` } });
  assert.equal(response.status(), 201, 'Creating a new isolated local workspace must succeed.');
  const { workspace } = await response.json();
  workspaceIds.add(workspace.id);
  snapshots.set(workspace.id, workspace);
  const templateLoaded = page.waitForResponse((result) => new URL(result.url()).pathname === '/api/control-tower/import-templates'
    && result.request().method() === 'GET' && result.status() === 200);
  await page.goto(new URL(`/app/lab?workspaceId=${workspace.id}`, base).href);
  await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
  await templateLoaded;
  return workspace.id;
}
async function readWorkspace(id) {
  return page.evaluate(async (workspaceId) => {
    const response = await fetch(`/api/control-tower/workspace?id=${encodeURIComponent(workspaceId)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Local workspace read failed: ${response.status}`);
    return (await response.json()).workspace;
  }, id);
}
async function upload() {
  await page.getByLabel('Import object', { exact: true }).selectOption('contact_company');
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name: 'normalization-messy-120.csv', mimeType: 'text/csv', buffer: Buffer.from(fixture) });
  await mapping().waitFor();
}
async function load() {
  const saved = workspaceResponse('save', 'import_validated');
  await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 200, 'The import must reach actual local persistence.');
  const { workspace } = await response.json();
  await page.getByText(`SQLite r${workspace.revision} · saved`, { exact: true }).waitFor();
  await normalization().waitFor();
  return workspace;
}
async function saveTemplate(button) {
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/control-tower/import-templates'
    && response.request().method() === 'POST');
  await templates().getByRole('button', { name: button, exact: true }).click();
  assert.equal((await saved).status(), 200, 'The shared template must reach actual local persistence.');
  await templates().getByRole('button', { name: 'Save shared template', exact: true }).waitFor();
}
async function apply() {
  const saved = workspaceResponse('save', 'local_normalization_applied');
  await normalization().getByRole('button', { name: 'Apply local normalization', exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 200, 'Normalization must reach actual local persistence.');
  const { workspace } = await response.json();
  await normalization().getByText(/Applied [\d,]+ field changes across 120 rows/u).waitFor();
  return workspace;
}
function assertNormalized(workspace, original) {
  assert.equal(workspace.state.contacts.length, 120);
  assert.deepEqual(workspace.state.originalContacts, original, 'Original imported values must remain intact.');
  const rows = workspace.state.contacts;
  assert.deepEqual({ firstName: rows[0].firstName, lastName: rows[0].lastName, country: rows[0].country, state: rows[0].state,
    phone: rows[0].phone, address: rows[0].address, city: rows[0].city, department: rows[0].department, persona: rows[0].persona },
  { firstName: 'Alex', lastName: 'Rivera', country: 'United States', state: 'California', phone: '+12025550100', address: '1 Example Street', city: 'San Francisco', department: 'Revenue Operations', persona: 'GTM operator' });
  assert.equal(rows[1].firstName, '', 'A single name stays for review.');
  assert.equal(rows[2].firstName, '', 'A multipart name stays for review.');
  assert.equal(rows[1].department, 'Sales');
  assert.equal(rows[4].country, 'Canada');
  assert.equal(rows[4].state, 'Ontario');
  assert.equal(rows[9].country, 'United Kingdom');
  assert.equal(rows[9].phone, '+442079460009 ext. 42');
  assert(rows.every((row) => row.associatedCompany.country === 'United States' && row.associatedCompany.state === 'California'));
  assert(rows.every((row) => row.customFields.favorite_ice_cream === 'Vanilla'));
}
function parseCsv(csv) {
  const rows = [], row = [];
  let value = '', quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') { if (quoted && csv[index + 1] === '"') { value += '"'; index++; } else quoted = !quoted; }
    else if (!quoted && (char === ',' || char === '\n')) {
      row.push(value.replace(/\r$/u, '')); value = '';
      if (char === '\n') rows.push(row.splice(0));
    } else value += char;
  }
  if (row.length || value) { row.push(value); rows.push(row); }
  return rows;
}

try {
  const firstId = await createWorkspace('initial review');
  await upload();
  assert.equal(await field('Favorite icecream').inputValue(), '');
  await page.getByText('Add custom destination fields', { exact: false }).click();
  await page.getByLabel('Custom field label', { exact: true }).fill('Fav. Ice Cream');
  await page.getByLabel('Custom field property key', { exact: true }).fill('favorite_ice_cream');
  await page.getByLabel('Custom field object', { exact: true }).selectOption('contact');
  await page.getByRole('button', { name: 'Add custom field', exact: true }).click();
  await field('Favorite icecream').selectOption(customField);
  await templates().getByLabel('Shared template name', { exact: true }).fill(templateName);
  await saveTemplate('Save shared template');
  const imported = await load();
  assert.equal(imported.state.contacts.length, 120);
  assert.equal(imported.state.importObject, 'contact_company');
  assert.equal(imported.state.contacts[0].country, 'US');
  assert.equal(imported.state.contacts[0].customFields.favorite_ice_cream, 'vanilla icecream');
  const original = imported.state.originalContacts;
  checks.push('120 combined contact/company rows and a manually mapped custom CRM property persist locally');

  assert.equal(await normalization().getByLabel('Country and state standard', { exact: true }).inputValue(), 'name');
  await normalization().locator('summary').filter({ hasText: /^Job title rules/u }).click();
  const titleRule = normalization().getByRole('group', { name: 'Job title rule 1', exact: true });
  await titleRule.getByLabel('Persona', { exact: true }).fill('GTM operator');
  await normalization().locator('summary').filter({ hasText: /^Exact value rules/u }).click();
  await normalization().getByRole('button', { name: 'Add value rule', exact: true }).click();
  const valueRule = normalization().getByRole('group', { name: 'Value rule 1', exact: true });
  await valueRule.getByRole('combobox').selectOption(customField);
  await valueRule.getByLabel('Source value', { exact: true }).fill('vanilla icecream');
  await valueRule.getByLabel('Standard value', { exact: true }).fill('Vanilla');
  const previewTable = normalization().getByRole('table', { name: 'Normalization before and after', exact: true });
  await previewTable.waitFor();
  const reviewedRows = new Set();
  let previewPages = 0;
  while (true) {
    for (const id of await previewTable.locator('tbody tr td:first-child').allTextContents()) reviewedRows.add(id);
    previewPages++;
    assert(previewPages <= 100, 'Preview pagination must be bounded.');
    const next = normalization().getByRole('button', { name: 'Next changes', exact: true });
    if (await next.isDisabled()) break;
    await next.click();
  }
  assert.equal(reviewedRows.size, 120, 'Every changed row must be reachable through the before/after pages.');
  const previous = normalization().getByRole('button', { name: 'Previous changes', exact: true });
  while (!(await previous.isDisabled())) await previous.click();
  await normalization().locator('summary').filter({ hasText: /^Review warnings/u }).click();
  assert((await normalization().innerText()).includes('Name order is ambiguous'));
  assert.deepEqual((await readWorkspace(firstId)).state.contacts, imported.state.contacts, 'Preview and editing rules must not modify saved values.');
  await normalization().screenshot({ path: resolve(output, 'normalization-preview.png') });
  checks.push(`Full-name country default, custom value and persona rules, ${previewPages} before/after pages covering all 120 rows, and ambiguous-name warnings`);

  await templates().getByRole('button', { name: `Select ${templateName}`, exact: true }).click();
  await saveTemplate('Update selected template');
  const applied = await apply();
  assertNormalized(applied, original);
  assert(await normalization().getByRole('button', { name: 'Apply local normalization', exact: true }).isDisabled(), 'A repeated apply has no further changes.');
  await page.reload();
  await page.getByText(`SQLite r${applied.revision} · saved`, { exact: true }).waitFor();
  assertNormalized(await readWorkspace(firstId), original);
  checks.push('All 120 rows normalize, state/country and international phones remain scoped correctly, originals survive save/reload');

  const downloadEvent = page.waitForEvent('download');
  const exportSaved = workspaceResponse('save', 'connector_receipt');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).first().click();
  const download = await downloadEvent;
  const exportPath = resolve(output, 'normalized-120.csv');
  await download.saveAs(exportPath);
  assert.equal((await exportSaved).status(), 200);
  const [headers, ...exportedRows] = parseCsv(readFileSync(exportPath, 'utf8'));
  assert.equal(exportedRows.length, 120);
  const firstExport = Object.fromEntries(headers.map((header, index) => [header, exportedRows[0][index]]));
  assert.equal(firstExport[customField], 'Vanilla');
  assert.equal(firstExport.country, 'United States');
  assert.equal(firstExport.associated_company_country, 'United States');
  assert.equal(firstExport.persona, 'GTM operator');
  assert.equal(firstExport.first_name, 'Alex');
  // Export records its own saved receipt. Undo that receipt, then normalization.
  for (let index = 0; index < 2; index++) {
    const undone = workspaceResponse('undo');
    await page.getByRole('button', { name: 'Undo saved change', exact: true }).click();
    const response = await undone;
    assert.equal(response.status(), 200);
    const { workspace } = await response.json();
    await page.getByText(`SQLite r${workspace.revision} · saved`, { exact: true }).waitFor();
  }
  assert.deepEqual((await readWorkspace(firstId)).state.contacts, imported.state.contacts, 'Undo must restore the original imported rows.');
  checks.push('CSV export retains custom and associated-company fields; undo restores original values');

  const secondId = await createWorkspace('template reuse');
  await upload();
  assert.equal(await field('Favorite icecream').inputValue(), customField);
  const customColumn = mapping().getByRole('group', { name: 'CSV column Favorite icecream', exact: true });
  await customColumn.getByText(`Contact object · Auto-mapped · ${templateName}`, { exact: true }).waitFor();
  await customColumn.screenshot({ path: resolve(output, 'auto-mapped-template.png') });
  await field('Favorite icecream').selectOption('');
  assert.equal(await customColumn.getByText(`Contact object · Auto-mapped · ${templateName}`, { exact: true }).count(), 0, 'Manual overrides remove the automatic mapping flag.');
  await page.getByRole('button', { name: 'Auto-map headers', exact: true }).click();
  await customColumn.getByText(`Contact object · Auto-mapped · ${templateName}`, { exact: true }).waitFor();
  const reimported = await load();
  assert.equal(reimported.state.normalizationSettings.countryFormat, 'name');
  assert.equal(reimported.state.normalizationSettings.titleRules[0].persona, 'GTM operator');
  assert.deepEqual(reimported.state.normalizationSettings.valueRules, [{ field: customField, from: 'vanilla icecream', to: 'Vanilla' }]);
  assert.equal(reimported.state.contacts[0].customFields.favorite_ice_cream, 'vanilla icecream', 'Mapping does not silently apply normalization.');
  const finalWorkspace = await apply();
  assertNormalized(finalWorkspace, reimported.state.originalContacts);
  await normalization().screenshot({ path: resolve(output, 'normalized-import-review.png') });
  checks.push('A separate workspace automatically reuses the shared mapping with a visible flag, restores saved rules, and honors manual override');
  assert.deepEqual(failures, []);
  const result = { passed: true, rows: 120, checks, workspaceIds: [...workspaceIds], reviewUrl: new URL(`/app/lab?workspaceId=${secondId}`, base).href,
    templateId, templateName, workspaceMutations, templateMutations, providerRequests: 0, crmWrites: 0, output };
  writeFileSync(resolve(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(resolve(output, 'failure.json'), `${JSON.stringify({ error: error.message, failures, checks, workspaceIds: [...workspaceIds], templateId, templateName }, null, 2)}\n`);
  throw error;
} finally {
  await browser.close();
}
