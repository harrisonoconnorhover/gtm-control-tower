import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Real local persistence and native HubSpot read results. The existing sample is
// read only; all mutations target one newly created local workspace/template.
// Only the dedicated read-only HubSpot preview endpoint may contact the CRM.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3100');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a local app only.');
const sourceId = process.env.CONTROL_TOWER_HUBSPOT_SAMPLE_ID || '0dda58eb-244d-4d62-9c5a-531635ed9c00';
const keyPath = resolve('.runtime/local-operator-key.txt');
const operatorKey = process.env.CONTROL_TOWER_OPERATOR_KEY || (existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : '');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const templateName = `HubSpot normalized demo ${stamp}`;
const output = resolve('outputs/hubspot-import-native', stamp);
mkdirSync(output, { recursive: true });
const checks = [], failures = [], requests = [];
let workspaceId = '', templateId = '', schemaReads = 0, dryRuns = 0, industryMapped = false;
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1100 } });
await context.addInitScript((key) => sessionStorage.setItem('gtm-control-tower-operator-key', key), operatorKey);
const page = await context.newPage();
page.setDefaultTimeout(20_000);
page.on('pageerror', (error) => failures.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  try {
    assert.equal(url.origin, base.origin, `Blocked external browser request: ${url.origin}`);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const endpoint = url.pathname.replace('/api/control-tower/', '');
    const body = request.method() === 'POST' ? request.postDataJSON() : null;
    requests.push({ endpoint, method: request.method() });
    if (endpoint === 'workspace') {
      assert.equal(body?.id ?? url.searchParams.get('id'), workspaceId, 'Browser operations must target only the new demo workspace.');
      if (body) {
        assert.equal(body.action, 'save');
        assert.equal(body.reason, 'hubspot_import_mapping_saved');
      }
      return route.continue();
    }
    if (endpoint === 'import-templates') {
      if (body) {
        assert.equal(body.action, 'save');
        assert.equal(body.template?.name, templateName);
        assert.equal(body.template.id, undefined, 'The proof creates one new template and never updates another.');
      } else assert.equal(request.method(), 'GET');
      return route.continue();
    }
    if (endpoint === 'hubspot-import') {
      assert(['GET', 'POST'].includes(request.method()));
      if (body) {
        assert.equal(body.workspaceId, workspaceId);
        assert.equal(body.policy, 'fill-empty');
        assert(++dryRuns <= 1, 'Run one bounded native dry run.');
      } else if (url.searchParams.get('action') === 'schema') assert(++schemaReads <= 1, 'Read native metadata once explicitly.');
      else assert.equal(url.searchParams.get('workspaceId'), workspaceId);
      return route.continue();
    }
    if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from the import preview proof.' } });
    assert.equal(request.method(), 'GET', `Blocked provider or CRM operation: ${endpoint}`);
    assert(['connectors', 'suppressions', 'website-checks', 'pomade-qualification', 'local-matches'].includes(endpoint), `Unexpected endpoint: ${endpoint}`);
    if (url.searchParams.has('workspaceId')) assert.equal(url.searchParams.get('workspaceId'), workspaceId);
    return route.continue();
  } catch (error) {
    failures.push(error.message);
    return route.fulfill({ status: 403, json: { error: error.message } });
  }
});

const headers = { 'x-control-tower-key': operatorKey };
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function readWorkspace(id) {
  assert([sourceId, workspaceId].includes(id));
  const response = await context.request.get(new URL(`/api/control-tower/workspace?id=${encodeURIComponent(id)}`, base).href, { headers });
  assert.equal(response.status(), 200, 'The bounded local workspace read must succeed.');
  return (await response.json()).workspace;
}
const panel = page.getByRole('region', { name: 'HubSpot normalized import', exact: true });
const results = panel.locator('[aria-label="HubSpot dry-run results"]');
const responseFor = (endpoint, method, predicate = () => true, timeout = 30_000) => page.waitForResponse((response) =>
  new URL(response.url()).pathname === `/api/control-tower/${endpoint}` && response.request().method() === method && predicate(response), { timeout });
async function succeeded(response, label) {
  const payload = await response.json();
  assert(response.ok(), `${label}: ${payload.error || response.status()}`);
  return payload;
}

try {
  const source = await readWorkspace(sourceId);
  const sourceFingerprint = digest(source);
  assert.equal(source.state.importObject, 'contact_company');
  assert.equal(source.state.originalContacts.length, 120, 'Use the existing fictional 120-contact normalization sample.');
  // APIRequestContext bypasses browser routing, so these fixed URLs/payloads are
  // intentionally the only direct local mutations in the proof.
  const created = await context.request.post(new URL('/api/control-tower/workspace', base).href,
    { headers, data: { action: 'create', name: templateName } });
  assert.equal(created.status(), 201);
  workspaceId = (await created.json()).workspace.id;
  const originals = structuredClone(source.state.originalContacts).map((row) => ({ ...row,
    associatedCompany: { ...row.associatedCompany, customFields: { ...row.associatedCompany?.customFields, industry: 'Software' } },
  }));
  const state = { ...structuredClone(source.state), contacts: structuredClone(originals), originalContacts: structuredClone(originals),
    customFields: [...(source.state.customFields ?? []).filter((field) => !(field.object === 'company' && field.key === 'industry')),
      { object: 'company', key: 'industry', label: 'Industry' }],
    mapping: { ...source.state.mapping, 'custom:company:industry': 'Company industry' },
    repairHistory: [], correctionHistory: [], receipts: [], sourceType: 'csv', destinationType: 'csv',
    fileName: 'hubspot-normalized-120-local-copy.csv', hubspotBinding: undefined,
  };
  delete state.sourceFileHash;
  const savedResponse = await context.request.post(new URL('/api/control-tower/workspace', base).href,
    { headers, data: { action: 'save', id: workspaceId, state, reason: 'hubspot_native_demo_copy' } });
  const saved = (await succeeded(savedResponse, 'Save fictional sample copy')).workspace;
  const copiedRows = digest(saved.state.contacts), copiedOriginals = digest(saved.state.originalContacts);
  checks.push('Created a new local copy of all 120 original sample rows; the existing sample is read only');

  await page.goto(new URL(`/app/lab?workspaceId=${workspaceId}`, base).href);
  await page.getByText(`SQLite r${saved.revision} · saved`, { exact: true }).waitFor({ timeout: 45_000 });
  const loadButton = panel.getByRole('button', { name: 'Load HubSpot fields', exact: true });
  await loadButton.waitFor();
  assert.equal(schemaReads, 0);
  const schemaResponse = responseFor('hubspot-import', 'GET', (response) => new URL(response.url()).searchParams.get('action') === 'schema', 90_000);
  await loadButton.click();
  const { schema } = await succeeded(await schemaResponse, 'Native HubSpot property read');
  assert(schema.portalId && schema.properties.contact.length && schema.properties.company.length);
  await panel.getByText(new RegExp(`Verified portal ${schema.portalId}`)).waitFor();
  checks.push(`Loaded actual property metadata for the verified portal: ${schema.properties.contact.length} contact and ${schema.properties.company.length} company fields`);

  const industry = schema.properties.company.find((property) => property.name === 'industry');
  const software = industry?.options.find((option) => option.value === 'COMPUTER_SOFTWARE' && !option.hidden);
  if (industry && software && !industry.readOnly && !industry.calculated && !industry.hidden && !industry.externalOptions) {
    const group = panel.getByRole('group', { name: 'HubSpot mapping for Industry (company)', exact: true });
    await group.getByLabel('HubSpot property for Industry (company)', { exact: true }).selectOption('industry');
    await group.locator('summary').filter({ hasText: /^Actual picklist values/u }).click();
    await group.getByText('(COMPUTER_SOFTWARE)', { exact: true }).waitFor();
    await group.getByLabel('Source value for Industry (company)', { exact: true }).fill('Software');
    await group.getByLabel('HubSpot picklist value for Industry (company)', { exact: true }).selectOption('COMPUTER_SOFTWARE');
    await group.getByRole('button', { name: 'Add value mapping', exact: true }).click();
    await group.getByText('Saved value rule: Software → COMPUTER_SOFTWARE', { exact: true }).waitFor();
    await group.screenshot({ path: resolve(output, 'native-picklist-mapping.png') });
    industryMapped = true;
    checks.push('Mapped Software to the actual company industry picklist value COMPUTER_SOFTWARE using the UI');
  } else checks.push('The portal has no selectable COMPUTER_SOFTWARE industry value; no substitute option was invented');

  const mappingSaved = responseFor('workspace', 'POST', (response) => response.request().postDataJSON().reason === 'hubspot_import_mapping_saved');
  await panel.getByRole('button', { name: 'Save HubSpot mapping', exact: true }).click();
  const mapped = (await succeeded(await mappingSaved, 'Save portal binding')).workspace;
  await page.getByText(`SQLite r${mapped.revision} · saved`, { exact: true }).waitFor();
  assert.equal(mapped.state.hubspotBinding.portalId, schema.portalId);
  if (industryMapped) {
    assert.equal(mapped.state.hubspotBinding.fields['custom:company:industry'].propertyName, 'industry');
    assert(mapped.state.normalizationSettings.valueRules.some((rule) => rule.field === 'custom:company:industry' && rule.from === 'Software' && rule.to === 'COMPUTER_SOFTWARE'));
  }
  assert.equal(digest(mapped.state.contacts), copiedRows);
  assert.equal(digest(mapped.state.originalContacts), copiedOriginals);
  const templates = page.getByRole('region', { name: 'Shared import templates', exact: true });
  await templates.getByLabel('Shared template name', { exact: true }).fill(templateName);
  const templateSaved = responseFor('import-templates', 'POST');
  await templates.getByRole('button', { name: 'Save shared template', exact: true }).click();
  const template = (await succeeded(await templateSaved, 'Save bound template')).templates.find((entry) => entry.name === templateName);
  assert(template);
  templateId = template.id;
  assert.deepEqual(template.hubspotBinding, mapped.state.hubspotBinding);
  assert.deepEqual(template.normalization, mapped.state.normalizationSettings);
  checks.push('Saved verified property bindings and value rules in a new shared template without changing imported rows');

  const previewResponse = responseFor('hubspot-import', 'POST', () => true, 180_000);
  await panel.getByRole('button', { name: 'Run normalized HubSpot dry run', exact: true }).click();
  const { review } = await succeeded(await previewResponse, 'Native normalized import dry run');
  assert.equal(review.readOnly, true);
  assert.equal(review.workspaceId, workspaceId);
  assert.equal(review.portalId, schema.portalId);
  assert.equal(review.policy, 'fill-empty');
  assert.equal(review.objects.filter((item) => item.object === 'contact').length, 120);
  assert(review.normalizedChanges > 0);
  assert(review.objects.flatMap((item) => item.fields).some((field) => field.original === 'US' && field.normalized === 'United States'));
  if (industryMapped) assert(review.objects.filter((item) => item.object === 'company').some((item) => item.fields.some((field) => field.propertyName === 'industry' && field.original === 'Software' && field.normalized === 'COMPUTER_SOFTWARE')));
  await results.waitFor();
  await results.locator('details').first().locator('summary').click();
  const table = results.getByRole('table').first();
  for (const label of ['Original', 'Normalized', 'Current in HubSpot', 'Proposed', 'Action and reason']) await table.getByRole('columnheader', { name: label, exact: true }).waitFor();
  await results.screenshot({ path: resolve(output, 'native-normalized-dry-run.png') });
  checks.push('A real native CRM read produced all 120 contact reviews plus company reviews with original, normalized, current and proposed values');

  await page.reload();
  await page.getByText(`SQLite r${mapped.revision} · saved`, { exact: true }).waitFor({ timeout: 45_000 });
  await results.waitFor();
  assert.equal(await results.getByText(/This dry run is stale/u).count(), 0);
  const storedResponse = await context.request.get(new URL(`/api/control-tower/hubspot-import?workspaceId=${workspaceId}`, base).href, { headers });
  const stored = await succeeded(storedResponse, 'Reload persisted dry run');
  assert.equal(stored.stale, false);
  assert.deepEqual(stored.review, review);
  const after = await readWorkspace(workspaceId);
  assert.equal(digest(after.state.contacts), copiedRows);
  assert.equal(digest(after.state.originalContacts), copiedOriginals);
  assert.equal(digest(await readWorkspace(sourceId)), sourceFingerprint, 'The original sample workspace must remain byte-for-byte equivalent.');
  assert.equal(schemaReads, 1); assert.equal(dryRuns, 1);
  assert.deepEqual(failures, []);
  checks.push('Saved review reloads without rerunning HubSpot checks; copied rows/originals and existing source workspace remain unchanged');
  const result = { passed: true, rows: 120, workspaceId, sourceWorkspaceId: sourceId, templateId, templateName,
    reviewUrl: new URL(`/app/lab?workspaceId=${workspaceId}`, base).href, portalId: schema.portalId,
    schemaPropertyCounts: { contact: schema.properties.contact.length, company: schema.properties.company.length },
    industryMapped, schemaReads, dryRuns, counts: review.counts, normalizedChanges: review.normalizedChanges,
    checks, browserApiRequests: requests, paidChecks: 0, crmWrites: 0, output };
  writeFileSync(resolve(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(resolve(output, 'failure.json'), `${JSON.stringify({ error: error.message, failures, checks, workspaceId, templateId, templateName, schemaReads, dryRuns }, null, 2)}\n`);
  throw error;
} finally { await browser.close(); }
