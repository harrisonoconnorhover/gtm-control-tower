import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// The application UI is real; every API response is an in-memory fixture.
// This regression cannot reach HubSpot, providers, or local saved workspaces.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3100');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a local app.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
const output = resolve('outputs/hubspot-import-ui');
mkdirSync(output, { recursive: true });
const at = '2026-10-16T18:00:00.000Z', key = 'hubspot-import-ui-fixture-key';
const contacts = Array.from({ length: 12 }, (_, index) => ({
  importObject: 'contact_company', contactId: `ROW-${index + 1}`, fullName: `Alex Person${index + 1}`,
  firstName: '', lastName: '', rawEmail: `person${index + 1}@fixture.test`, normalizedEmail: `person${index + 1}@fixture.test`,
  company: '', website: '', country: 'US', state: 'CA', jobTitle: 'RevOps', department: '', persona: '',
  customFields: { favorite_ice_cream: 'Vanilla' },
  associatedCompany: { recordId: null, name: 'Synthetic CRM Company', website: 'https://fixture.test', phone: '', state: 'CA', country: 'US', customFields: { industry: 'CRM software' } },
  region: '', segment: '', lifecycleStage: 'lead', expectedLifecycleStage: 'lead', ownerId: '',
  canonicalContactId: null, recordStatus: 'active', lastAction: 'Imported fixture', qualityFlags: [], updatedAt: at,
}));
const workspace = { id: 'hubspot-import-ui-fixture', name: 'HubSpot normalized import fixture', revision: 1,
  createdAt: at, updatedAt: at, presets: [], state: {
    importObject: 'contact_company', contacts, originalContacts: structuredClone(contacts),
    customFields: [{ object: 'contact', key: 'favorite_ice_cream', label: 'Fav. Ice Cream' }, { object: 'company', key: 'industry', label: 'Industry' }],
    repairHistory: [], correctionHistory: [], receipts: [], mapping: {}, fileName: 'hubspot-ui-fixture.csv', sourceType: 'csv', destinationType: 'csv',
  } };
const property = (name, label, options) => ({ name, label, type: options ? 'enumeration' : 'string', fieldType: options ? 'select' : 'text',
  options: (options ?? []).map(([value, optionLabel]) => ({ value, label: optionLabel, hidden: false })),
  readOnly: false, calculated: false, externalOptions: false, hidden: false });
const schema = { portalId: '123456', fetchedAt: at, warnings: [], properties: {
  contact: [property('email', 'Email'), property('firstname', 'First name'), property('lastname', 'Last name'), property('country', 'Country'),
    property('state', 'State'), property('jobtitle', 'Job title'), property('department', 'Department'), property('hs_persona', 'Persona', []),
    { ...property('hs_object_id', 'Record ID'), readOnly: true }, { ...property('computed', 'Calculated value'), calculated: true },
    { ...property('external', 'External choices', []), externalOptions: true }],
  company: [property('name', 'Company name'), property('website', 'Website'), property('country', 'Country'), property('state', 'State'),
    property('industry', 'Industry', [['COMPUTER_SOFTWARE', 'Computer Software'], ['HOSPITAL_HEALTH_CARE', 'Hospital & Health Care']])],
} };
let review = null, schemaReads = 0, previewCalls = 0;
const failures = [], checks = [], requests = [];
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1100 } });
await context.addInitScript((value) => sessionStorage.setItem('gtm-control-tower-operator-key', value), key);
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on('pageerror', (error) => failures.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { failures.push(`Blocked external request: ${url.origin}`); return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const endpoint = url.pathname.replace('/api/control-tower/', '');
  const body = request.method() === 'POST' ? request.postDataJSON() : null;
  requests.push({ endpoint, method: request.method() });
  try {
    if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: true,
      connectors: [{ id: 'csv', label: 'CSV', configured: true, directions: ['source', 'destination'], phases: [] },
        { id: 'hubspot', label: 'HubSpot', configured: true, mode: 'direct', directions: ['source', 'destination'], phases: [], features: ['safe-writeback', 'write', 'preview'] }] } });
    if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from this fixture.' } });
    if (endpoint === 'workspace') {
      if (body) {
        assert.equal(body.action, 'save');
        assert.equal(body.id, workspace.id);
        assert.equal(body.reason, 'hubspot_import_mapping_saved');
        workspace.state = structuredClone(body.state); workspace.revision++;
      }
      return route.fulfill({ json: { workspace } });
    }
    if (endpoint === 'import-templates') { assert.equal(request.method(), 'GET'); return route.fulfill({ json: { templates: [] } }); }
    if (endpoint === 'suppressions') { assert.equal(request.method(), 'GET'); return route.fulfill({ json: { rules: [] } }); }
    if (endpoint === 'website-checks') { assert.equal(request.method(), 'GET'); return route.fulfill({ json: { checks: [] } }); }
    if (endpoint === 'pomade-qualification') { assert.equal(request.method(), 'GET'); return route.fulfill({ json: { configured: false, qualification: null } }); }
    if (endpoint === 'local-matches') {
      assert.equal(request.method(), 'GET');
      return route.fulfill({ json: { workspaceId: workspace.id, workspaceRevision: workspace.revision,
        importObject: 'contact_company', ruleVersion: 'fixture', findings: [], warnings: [], snapshots: [],
        coverage: { importRows: contacts.length, crmRecords: 0, suppressionRules: 0, comparedPairs: 0 },
        rarity: { sampleSize: contacts.length, available: false }, counts: { pending: 0, confirmed: 0, dismissed: 0 },
        total: 0, offset: 0, limit: 50, nextOffset: null } });
    }
    assert.equal(endpoint, 'hubspot-import', `Unexpected API request: ${endpoint}`);
    assert.equal(request.headers()['x-control-tower-key'], key);
    if (url.searchParams.get('action') === 'schema') { schemaReads++; return route.fulfill({ json: { schema } }); }
    if (!body) return route.fulfill({ json: { review, stale: Boolean(review && review.workspaceRevision !== workspace.revision) } });
    assert.equal(body.workspaceId, workspace.id); assert.equal(body.workspaceRevision, workspace.revision);
    assert.equal(body.binding.portalId, schema.portalId);
    assert.equal(body.binding.fields.associatedCompanyCountry.object, 'company');
    assert.equal(body.binding.fields.country.object, 'contact');
    assert(!body.binding.fields['custom:contact:favorite_ice_cream']);
    assert(body.normalizationSettings.valueRules.some((rule) => rule.field === 'custom:company:industry' && rule.from === 'CRM software' && rule.to === 'COMPUTER_SOFTWARE'));
    previewCalls++;
    const fields = [{ field: 'country', propertyName: 'country', label: 'Country', original: 'US', normalized: 'United States',
      current: 'Canada', proposed: body.policy === 'overwrite' ? 'United States' : 'Canada',
      action: body.policy === 'overwrite' ? 'set' : 'preserve', reason: body.policy === 'overwrite' ? 'Would overwrite the existing value.' : 'Preserved the existing value under fill-empty policy.' }];
    const objects = contacts.map((row, index) => ({ key: row.contactId, object: 'contact', sourceRowIds: [row.contactId], nativeId: `HS-${index}`,
      status: 'review', reasons: ['Persona has no available picklist options.'], fields }));
    objects.push({ key: 'company-shared', object: 'company', sourceRowIds: contacts.map((row) => row.contactId), nativeId: 'COMPANY-1', status: 'update', reasons: [],
      fields: [{ field: 'custom:company:industry', propertyName: 'industry', label: 'Industry', original: 'CRM software', normalized: 'COMPUTER_SOFTWARE', current: '', proposed: 'COMPUTER_SOFTWARE', action: 'set', reason: 'Would fill an empty HubSpot property with an allowed internal value.' }] });
    review = { portalId: schema.portalId, checkedAt: at, workspaceId: workspace.id, workspaceRevision: workspace.revision,
      fingerprint: `fixture-${previewCalls}`, schemaFetchedAt: at, normalizedChanges: 72, policy: body.policy, objects,
      counts: { contact: { create: 0, update: 0, unchanged: 0, review: 12, skipped: 0 }, company: { create: 0, update: 1, unchanged: 0, review: 0, skipped: 0 } },
      warnings: ['Synthetic read-only result; no CRM was contacted.'], readOnly: true };
    return route.fulfill({ json: { review } });
  } catch (error) { failures.push(error.message); return route.fulfill({ status: 400, json: { error: error.message } }); }
});

const panel = page.getByRole('region', { name: 'HubSpot normalized import', exact: true });
const results = panel.getByRole('region', { name: 'HubSpot dry-run results', exact: true });
try {
  await page.goto(new URL(`/app/lab?workspaceId=${workspace.id}`, base).href);
  await page.getByText('SQLite r1 · saved', { exact: true }).waitFor({ timeout: 45_000 });
  await panel.getByRole('button', { name: 'Load HubSpot fields', exact: true }).waitFor();
  assert.equal(schemaReads, 0, 'Opening the review must not automatically read HubSpot metadata.');
  await panel.getByRole('button', { name: 'Load HubSpot fields', exact: true }).click();
  await panel.getByText(/Verified portal 123456/u).waitFor();
  assert.equal(schemaReads, 1);
  assert.equal(await panel.getByLabel('HubSpot property for Country', { exact: true }).inputValue(), 'country');
  assert.equal(await panel.getByLabel('HubSpot property for Associated company country', { exact: true }).inputValue(), 'country');
  const missing = panel.getByRole('group', { name: 'HubSpot mapping for Fav. Ice Cream (contact)', exact: true });
  await missing.getByText(/This custom field has no selected HubSpot property/u).waitFor();
  assert.notEqual(await panel.getByLabel('HubSpot property for Country', { exact: true }).locator('option[value="hs_object_id"]').getAttribute('disabled'), null);
  assert.notEqual(await panel.getByLabel('HubSpot property for Country', { exact: true }).locator('option[value="external"]').getAttribute('disabled'), null);
  const contactId = panel.getByLabel('HubSpot property for Contact ID', { exact: true });
  assert.equal(await contactId.inputValue(), '', 'Synthetic local row IDs must never be automatically treated as HubSpot IDs.');
  assert.equal(await contactId.locator('option[value="hs_object_id"]').getAttribute('disabled'), null);
  assert.notEqual(await contactId.locator('option[value="firstname"]').getAttribute('disabled'), null);
  assert.notEqual(await panel.getByLabel('HubSpot property for Email', { exact: true }).locator('option[value="firstname"]').getAttribute('disabled'), null);
  await panel.getByText(/HubSpot exposes no selectable values for this picklist/u).waitFor();
  checks.push('Explicit field reads, verified portal, separate object mappings, unavailable custom field, read-only/external property holds and empty persona picklist');

  const industry = panel.getByRole('group', { name: 'HubSpot mapping for Industry (company)', exact: true });
  await industry.getByText('Actual picklist values · 2', { exact: true }).click();
  await industry.getByText('(COMPUTER_SOFTWARE)', { exact: true }).waitFor();
  await industry.getByLabel('Source value for Industry (company)', { exact: true }).fill('CRM software');
  await industry.getByLabel('HubSpot picklist value for Industry (company)', { exact: true }).selectOption('COMPUTER_SOFTWARE');
  await industry.getByRole('button', { name: 'Add value mapping', exact: true }).click();
  await industry.getByText('Saved value rule: CRM software → COMPUTER_SOFTWARE', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Save HubSpot mapping', exact: true }).click();
  await page.getByText('SQLite r2 · saved', { exact: true }).waitFor();
  assert.equal(workspace.state.hubspotBinding.portalId, '123456');
  assert(workspace.state.normalizationSettings.valueRules.some((rule) => rule.field === 'custom:company:industry' && rule.to === 'COMPUTER_SOFTWARE'));
  assert.deepEqual(workspace.state.contacts, contacts, 'Saving mappings must not normalize or mutate source rows.');
  checks.push('Actual labels/internal values, company custom-field value mapping and saved binding/rules with original rows preserved');

  await panel.getByRole('button', { name: 'Run normalized HubSpot dry run', exact: true }).click();
  await results.waitFor();
  await results.locator('details').first().locator('summary').click();
  const firstTable = results.getByRole('table').first();
  await firstTable.getByRole('columnheader', { name: 'Current in HubSpot', exact: true }).waitFor();
  await firstTable.getByRole('cell', { name: 'US', exact: true }).waitFor();
  await firstTable.getByRole('cell', { name: 'United States', exact: true }).waitFor();
  assert.equal(await firstTable.getByRole('cell', { name: 'Canada', exact: true }).count(), 2);
  await firstTable.getByText('Preserved the existing value under fill-empty policy.', { exact: true }).waitFor();
  await results.getByRole('button', { name: 'Next dry-run objects', exact: true }).click();
  await results.getByText('11–13 of 13 objects', { exact: true }).waitFor();
  await results.getByLabel('Filter HubSpot dry-run objects', { exact: true }).selectOption('company');
  await results.locator('details').first().locator('summary').click();
  await results.getByRole('cell', { name: 'COMPUTER_SOFTWARE', exact: true }).first().waitFor();
  checks.push('Original/normalized/CRM/proposed table, fill-empty policy, company aggregation and paged results');

  await panel.getByLabel('HubSpot dry-run update policy', { exact: true }).selectOption('overwrite');
  await results.getByText(/This dry run is stale/u).waitFor();
  await panel.getByRole('button', { name: 'Run normalized HubSpot dry run', exact: true }).click();
  await panel.getByText('Dry run saved locally. HubSpot was read; no CRM records were changed.', { exact: true }).waitFor();
  assert.equal(previewCalls, 2);
  assert.equal(await results.getByText(/This dry run is stale/u).count(), 0);
  assert.equal(review.objects[0].fields[0].proposed, 'United States');
  await panel.getByLabel('HubSpot property for Country', { exact: true }).selectOption('');
  await results.getByText(/This dry run is stale/u).waitFor();
  checks.push('Overwrite preview and mapping edits correctly invalidate the prior dry run');
  schema.portalId = '654321';
  await panel.getByRole('button', { name: 'Refresh HubSpot fields', exact: true }).click();
  await panel.getByText(/This mapping belongs to HubSpot portal 123456; the connected portal is 654321/u).waitFor();
  assert(await panel.getByRole('button', { name: 'Run normalized HubSpot dry run', exact: true }).isDisabled());
  assert.equal(workspace.state.hubspotBinding.portalId, '123456', 'Refreshing metadata must not silently rebind a saved template to another portal.');
  await panel.getByRole('button', { name: 'Use connected HubSpot portal', exact: true }).click();
  await panel.getByText('A new mapping was suggested for the connected portal. Review every field and value rule before saving.', { exact: true }).waitFor();
  checks.push('Explicit lookup-only IDs, compatible email mappings and a portal change requiring an explicit rebind');
  await panel.screenshot({ path: resolve(output, 'hubspot-import-review.png') });
  assert.deepEqual(failures, []);
  writeFileSync(resolve(output, 'receipt.json'), JSON.stringify({ checks, schemaReads, previewCalls, requests, crmWrites: 0, paidChecks: 0, fixtureOnly: true }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, output, crmWrites: 0, paidChecks: 0, fixtureOnly: true }, null, 2));
} finally { await browser.close(); }
