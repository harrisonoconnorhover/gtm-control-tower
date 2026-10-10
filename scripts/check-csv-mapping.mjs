import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Run against a disposable local app: workspace/preset persistence is real;
// connector discovery is CSV-only and every other private API is blocked.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a local disposable app with persistence enabled.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to an installed Chromium or Chrome executable.');
const output = resolve('outputs/csv-mapping');
mkdirSync(output, { recursive: true });
const headers = ['Contact ID', 'First Name', 'Last Name', 'Work Email', 'Company Name', 'Business Phone', 'Job Title', 'Custom Notes'];
const rows = [
  ['MAP-001', 'Avery', 'Example', 'avery@example.com', 'Example Co', '202-555-0101', 'RevOps Manager', 'Fictional note one'],
  ['MAP-002', 'Jordan', 'Sample', 'jordan@example.com', 'Sample Co', '202-555-0102', 'Operations Analyst', 'Fictional note two'],
  ['MAP-003', 'Morgan', 'Demo', 'morgan@example.com', 'Demo Co', '202-555-0103', 'GTM Engineer', 'Fictional note three'],
];
const csv = [headers, ...rows].map((row) => row.join(',')).join('\n');
const expected = ['contactId', 'firstName', 'lastName', 'rawEmail', 'company', 'phone', 'jobTitle', ''];
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const failures = [], checks = [];
let workspaceSaves = 0;
page.on('pageerror', (error) => failures.push(error.message));
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base.origin) { failures.push(`Blocked external request: ${url.origin}`); return route.abort(); }
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const endpoint = url.pathname.replace('/api/control-tower/', '');
  if (endpoint === 'workspace') return route.continue();
  if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: false,
    connectors: [{ id: 'csv', label: 'CSV', configured: true, directions: ['source', 'destination'], phases: [], mode: 'direct', features: [] }] } });
  if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from CSV mapping regression.' } });
  failures.push(`Blocked unexpected private endpoint: ${endpoint}`);
  return route.fulfill({ status: 403, json: { error: 'Only local workspace persistence is permitted in this regression.' } });
});
const mapping = () => page.getByRole('region', { name: 'CSV column mapping', exact: true });
const field = (header) => mapping().getByLabel(`Control Tower field for ${header}`, { exact: true });
async function upload(source = csv, name = 'mapping-regression.csv') {
  await page.locator('input[type=file][accept*="csv"]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(source) });
  await page.getByRole('button', { name: 'Auto-map headers', exact: true }).waitFor();
}
async function readWorkspace() {
  return page.evaluate(async () => {
    const id = localStorage.getItem('gtm-control-tower-workspace-id');
    if (!id) throw new Error('The scenario must use a saved local workspace.');
    const response = await fetch(`/api/control-tower/workspace?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Workspace read failed: ${response.status}`);
    return (await response.json()).workspace;
  });
}
async function importMapping() {
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/control-tower/workspace'
    && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'save');
  await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
  const response = await saved;
  assert.equal(response.status(), 200, 'Mapped contacts must reach real local persistence.');
  workspaceSaves++;
  await page.getByText(`SQLite r${workspaceSaves} · saved`, { exact: true }).waitFor();
  return readWorkspace();
}
async function assertChoices(values = expected, names = headers) {
  for (const [index, header] of names.entries()) assert.equal(await field(header).inputValue(), values[index], header);
}
async function captureLayout(name, width, height) {
  await page.setViewportSize({ width, height });
  for (const [index, header] of headers.entries()) {
    const source = mapping().getByRole('group', { name: `CSV column ${header}`, exact: true });
    await source.scrollIntoViewIfNeeded();
    assert(await source.getByText(header, { exact: true }).first().isVisible(), `${header} source heading is visible.`);
    assert((await source.innerText()).includes(rows[0][index]), `${header} displays a source value.`);
    const box = await field(header).boundingBox();
    assert(box && box.x >= 0 && box.width >= 160 && box.x + box.width <= width, `${header} select fits ${width}px viewport.`);
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No page overflow at ${width}px.`);
  await mapping().evaluate((element) => { element.scrollTop = 0; });
  const panel = mapping().locator('..');
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: resolve(output, `${name}.png`) });
  checks.push(`${width}px mapping labels, samples, controls, and overflow`);
}

try {
  await page.goto(new URL('/app/lab', base).href);
  await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
  await upload();
  await assertChoices();
  const text = await mapping().innerText();
  assert(/your csv column/i.test(text) && /control tower field/i.test(text), 'Mapping direction must name both sides.');
  assert.equal(await mapping().getByRole('combobox').count(), headers.length, 'Every source column has one destination choice.');
  assert.equal(await field('Custom Notes').locator('option:checked').innerText(), 'Do not import this column');
  checks.push('Common headers automatically map; unknown source column stays visible and unmapped');
  await captureLayout('desktop-auto-mapping', 1440, 1000);
  await captureLayout('mobile-auto-mapping', 390, 844);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await field('Business Phone').selectOption('');
  await page.getByLabel('Mapping preset name', { exact: true }).fill('Email and names only');
  const presetSaved = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/control-tower/workspace'
    && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'save-preset');
  await page.getByRole('button', { name: 'Save mapping', exact: true }).click();
  assert.equal((await presetSaved).status(), 200);
  await page.getByRole('button', { name: 'Use Email and names only', exact: true }).waitFor();
  await page.reload();
  await page.getByText('SQLite r0 · saved', { exact: true }).waitFor();
  await upload();
  assert.equal(await field('Business Phone').inputValue(), 'phone', 'Fresh preview should suggest headers again.');
  await page.getByRole('button', { name: 'Use Email and names only', exact: true }).click();
  await assertChoices(expected.map((value) => value === 'phone' ? '' : value));
  const ignored = await importMapping();
  assert.equal(ignored.state.contacts.length, rows.length);
  assert.equal(ignored.state.mapping.phone, '', 'A saved ignore must override automatic suggestions.');
  for (const [index, contact] of ignored.state.contacts.entries()) {
    const [contactId, firstName, lastName, rawEmail, company, , jobTitle] = rows[index];
    assert.deepEqual({ contactId: contact.contactId, firstName: contact.firstName, lastName: contact.lastName,
      fullName: contact.fullName, rawEmail: contact.rawEmail, company: contact.company, phone: contact.phone, jobTitle: contact.jobTitle },
    { contactId, firstName, lastName, fullName: `${firstName} ${lastName}`, rawEmail, company, phone: null, jobTitle });
    assert(!JSON.stringify(contact).includes('Fictional note'), 'Unmapped source values must not enter the contact model.');
  }
  checks.push('Explicit ignore survives saved preset, reload, preview, and real persisted import');

  await upload();
  await field('Work Email').selectOption('fullName');
  assert.equal(await field('Work Email').inputValue(), 'fullName');
  assert.equal(await mapping().locator('select').evaluateAll((selects) => selects.filter((select) => select.value === 'rawEmail').length), 0);
  const reassigned = await importMapping();
  assert.equal(reassigned.state.mapping.rawEmail, '', 'Reassigning a source must explicitly clear its old destination.');
  assert(reassigned.state.contacts.every((contact, index) => contact.rawEmail === '' && contact.fullName === rows[index][3]));
  await page.getByRole('button', { name: 'Auto-map headers', exact: true }).click();
  await assertChoices();
  const reset = await importMapping();
  assert(reset.state.contacts.every((contact, index) => contact.rawEmail === rows[index][3]
    && contact.fullName === `${rows[index][1]} ${rows[index][2]}` && contact.phone === rows[index][5]));
  checks.push('Reassignment clears the old field in UI and persisted contacts; Auto-map restores suggestions');

  await upload('Full Name,Work Email,Business Email\nTaylor Example,taylor.work@example.com,taylor.business@example.com', 'ambiguous-email.csv');
  await assertChoices(['fullName', '', ''], ['Full Name', 'Work Email', 'Business Email']);
  await page.getByRole('button', { name: 'Use Email and names only', exact: true }).click();
  await assertChoices(['', 'rawEmail', ''], ['Full Name', 'Work Email', 'Business Email']);
  const stalePreset = await importMapping();
  assert(Object.values(stalePreset.state.mapping).every((header) => header === '' || header === 'Work Email'),
    'A preset cannot retain assignments to headers absent from the current file.');
  assert.equal(stalePreset.state.contacts[0].rawEmail, 'taylor.work@example.com');
  assert.equal(stalePreset.state.contacts[0].phone, null);
  assert.equal(stalePreset.state.contacts[0].company, null);
  await page.getByRole('button', { name: 'Auto-map headers', exact: true }).click();
  await assertChoices(['fullName', '', ''], ['Full Name', 'Work Email', 'Business Email']);
  checks.push('A preset on different headers retains only valid assignments and imports no missing source fields');
  await field('Work Email').selectOption('rawEmail');
  await field('Business Email').selectOption('rawEmail');
  await assertChoices(['fullName', '', 'rawEmail'], ['Full Name', 'Work Email', 'Business Email']);
  const resolved = await importMapping();
  assert.equal(resolved.state.contacts[0].rawEmail, 'taylor.business@example.com');
  assert.equal(resolved.state.contacts[0].fullName, 'Taylor Example');
  checks.push('Equally plausible email aliases stay unmapped; explicit selection moves one destination cleanly');
  assert.deepEqual(failures, []);
  const result = { passed: true, checks, workspaceSaves, liveCrmRequests: 0, output };
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
