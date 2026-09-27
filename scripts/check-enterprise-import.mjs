import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('..', import.meta.url));
const env = process.env;
const runtime = env.GTM_FIXTURE_OUTPUT;
assert(runtime && isAbsolute(runtime), 'GTM_FIXTURE_OUTPUT must be an absolute private directory. Native snapshots and browser state stay there.');
const outputRelative = relative(repo, runtime);
if (outputRelative !== '..' && !outputRelative.startsWith('../')) {
    execFileSync('git', ['check-ignore', '--quiet', '--', outputRelative], { cwd: repo });
}
mkdirSync(runtime, { recursive: true, mode: 0o700 });
chmodSync(runtime, 0o700);
assert(env.CONTROL_TOWER_SYNC_KEY, 'Use the same operator key as the local app.');
const fixture = JSON.parse(readFileSync(repo + '/fixtures/enterprise-import-case.json', 'utf8'));
const provider = process.argv[2];
assert(['hubspot', 'salesforce'].includes(provider));
const base = env.CONTROL_TOWER_BROWSER_BASE_URL ?? 'http://127.0.0.1:3000', images = runtime + '/screens';
mkdirSync(images, { recursive: true });
const evidence = { provider, startedAt: new Date().toISOString(), caseId: fixture.caseId, stages: {}, pageErrors: [] };
const browser = await chromium.launch({ executablePath: env.CHROMIUM_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();
page.setDefaultTimeout(45000);
page.on('pageerror', e => evidence.pageErrors.push(e.message));
let stage = 'startup';
const approvedIds = new Set(fixture.approved.map(r => r.contactId));
await page.route('**/api/control-tower/**', async (route) => {
    const q = route.request(), p = new URL(q.url()).pathname, b = q.method() === 'POST' ? q.postDataJSON() : null;
    if (/\/(hubspot-sync|salesforce-sync|demo-intake)$/.test(p))
        throw Error('Unexpected write endpoint');
    if (p.endsWith('/crm-writeback') && b?.action !== 'preview') {
        assert.equal(b.connectorId, provider);
        if (b.action === 'execute')
            assert(b.contacts.every(r => approvedIds.has(r.contactId) && fixture.approved.some(f => f.contactId === r.contactId && f.email === r.email)));
        else
            assert.equal(b.action, 'rollback');
    }
    await route.continue();
});
function persist() { save(provider + '-evidence-private', evidence); }
async function native() {
    const emails = [...new Set([...fixture.baseline, ...fixture.review].map(r => r.email))];
    if (provider === 'hubspot') {
        const records = [];
        let after = '';
        do {
            const d = await api(provider, '/crm/v3/objects/contacts?limit=100&properties=email,firstname,lastname,company,phone,jobtitle,website,state,city,message,hubspot_owner_id' + (after ? '&after=' + after : ''));
            records.push(...d.results.filter(r => emails.includes(r.properties.email)));
            after = d.paging?.next?.after ?? '';
        } while (after);
        return records.map(r => ({ id: r.id, type: 'contact', email: r.properties.email, firstName: r.properties.firstname ?? null, lastName: r.properties.lastname ?? null, company: r.properties.company ?? null, phone: r.properties.phone ?? null, jobTitle: r.properties.jobtitle ?? null, website: r.properties.website ?? null, state: r.properties.state ?? null, city: r.properties.city ?? null, marker: r.properties.message ?? null, owner: r.properties.hubspot_owner_id ?? null }));
    }
    const clause = emails.map(quote).join(',');
    const out = [];
    for (const object of ['Lead', 'Contact']) {
        const lead = object === 'Lead';
        const r = await soql(`SELECT Id,Email,FirstName,LastName,${lead ? 'Company' : 'Account.Name'},Phone,Title,${lead ? 'Website,State,City' : 'MailingState,MailingCity'},Description,OwnerId FROM ${object} WHERE Email IN (${clause})`);
        out.push(...r.records.map(r => ({ id: r.Id, type: object.toLowerCase(), email: r.Email, firstName: r.FirstName, lastName: r.LastName, company: lead ? r.Company : r.Account?.Name ?? null, phone: r.Phone, jobTitle: r.Title, website: lead ? r.Website : null, state: lead ? r.State : r.MailingState, city: lead ? r.City : r.MailingCity, marker: r.Description, owner: r.OwnerId })));
    }
    return out;
}
function checkpoint(name, data) { save(provider + '-' + name, data); evidence.stages[name] = new Date().toISOString(); persist(); console.log(JSON.stringify({ provider, phase: name, ...(data.records ? { records: data.records.length } : {}) })); }
async function load(file) {
    await page.getByLabel('Where is your data?').selectOption('csv');
    await page.locator('input[type=file]').setInputFiles(repo + '/public/' + file);
    await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
    await page.getByText(/SQLite r\d+ · saved/).waitFor();
}
async function preview() {
    const response = page.waitForResponse(r => r.url().endsWith('/crm-writeback') && r.request().postDataJSON()?.action === 'preview');
    await page.getByRole('button', { name: /^Compare \d+ with CRM$/ }).click();
    const r = await response;
    assert.equal(r.status(), 200);
    return await r.json();
}
async function execute() {
    const response = page.waitForResponse(r => r.url().endsWith('/crm-writeback') && r.request().postDataJSON()?.action === 'execute');
    const saved = page.waitForResponse(r => r.url().endsWith('/runs') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /^Execute \d+ approved changes$|^Record comparison result$/ }).click();
    const r = await response;
    assert.equal(r.status(), 202);
    const receipt = await r.json();
    checkpoint(stage + '-receipt', receipt);
    assert.equal((await saved).status(), 201);
    return receipt;
}
async function history(receipt) {
    const id = await page.evaluate(() => localStorage.getItem('gtm-control-tower-workspace-id'));
    const r = await page.request.get(base + '/api/control-tower/runs?workspaceId=' + encodeURIComponent(id));
    assert.equal(r.status(), 200);
    const data = await r.json();
    assert(data.runs.some(run => run.details?.writeback?.runId === receipt.runId));
    save(provider + '-history', data);
    return data;
}
async function planShot(name) {
    const list = page.getByLabel('CRM comparison records', { exact: true });
    const box = list.locator('..');
    await box.screenshot({ path: images + '/' + provider + '-' + name + '.png', mask: [list.locator('details > p').filter({ hasText: 'Matched CRM records:' })], maskColor: '#182d25' });
}
try {
    stage = 'before';
    const before = await native();
    assert.equal(before.length, 8, 'Requires eight baseline people and no created Nina yet. This first-run check does not reset or delete existing CRM data.');
    assert(before.every(r => fixture.baseline.some(f => f.email === r.email) && r.marker?.includes(fixture.caseId)), 'Every baseline record must belong to this fictional case.');
    checkpoint('before', before);
    await page.goto(base + '/app/lab');
    await page.getByText('SQLite r0 · saved', { exact: false }).waitFor();
    await page.getByLabel('Operator access key', { exact: true }).fill(env.CONTROL_TOWER_SYNC_KEY);
    await load('enterprise-import-review.csv');
    await page.getByLabel('Where should clean records go?').selectOption(provider);
    await page.getByText(/SQLite r\d+ · saved/).waitFor();
    stage = 'review';
    const panel = page.getByRole('region', { name: 'Approximate CRM matches' });
    await panel.getByRole('button', { name: 'Read CRM snapshot', exact: true }).click();
    await panel.getByText(/records · \d+ pages · Provider pagination complete/).waitFor({ timeout: 90000 });
    await panel.getByRole('button', { name: 'Find suggestions for these rows', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Review ready for 7 imported records.' }).waitFor();
    const d = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download this review (JSON)', exact: true }).click();
    const review = JSON.parse(readFileSync(await (await d).path(), 'utf8'));
    checkpoint('review', review);
    const byCase = Object.fromEntries(review.report.rows.map(r => [r.contactId, r]));
    assert(byCase['ENT-EMAIL-CHANGE'].candidates.some(c => c.record.email === fixture.baseline.find(x => x.key === 'priya').email));
    assert.equal(byCase['ENT-COWORKER'].candidates.filter(c => c.record.fullName === 'Jordan Lee').length, 2);
    evidence.review = review.report.rows.map(r => ({ contactId: r.contactId, candidates: r.candidates.map(c => ({ name: c.record.fullName, email: c.record.email, score: c.score, objectType: c.record.objectType })), warnings: r.warnings }));
    persist();
    const priya = panel.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'ENT-EMAIL-CHANGE' }) });
    await priya.locator('summary').click();
    await priya.screenshot({ path: images + '/' + provider + '-approximate.png', mask: [priya.locator('p.font-mono')], maskColor: '#182d25' });
    const jordan = panel.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'ENT-COWORKER' }) });
    await jordan.locator('summary').click();
    await jordan.screenshot({ path: images + '/' + provider + '-coworkers.png', mask: [jordan.locator('p.font-mono')], maskColor: '#182d25' });
    // Operator resolution is represented by a second CSV; approximate suggestions never modify write eligibility.
    await load('enterprise-import-approved.csv');
    stage = 'execute';
    const plan = await preview();
    checkpoint('plan', plan);
    assert.equal(plan.creates, 1);
    assert.equal(plan.updates, 2);
    assert.equal(plan.held, provider === 'salesforce' ? 1 : 0);
    assert.equal(plan.unchanged, provider === 'salesforce' ? 1 : 2);
    for (const detail of await page.getByLabel('CRM comparison records', { exact: true }).locator('details').all()) {
        if (/ENT-UPDATE|ENT-NULL-CLEAR/.test(await detail.innerText()))
            await detail.locator('summary').click();
    }
    await planShot('plan');
    const backup = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download pre-write backup', exact: true }).click();
    save(provider + '-backup', JSON.parse(readFileSync(await (await backup).path(), 'utf8')));
    const receipt = await execute();
    assert.equal(receipt.created, 1);
    assert.equal(receipt.updated, 2);
    assert.equal(receipt.failed, 0);
    await history(receipt);
    const after = await native();
    checkpoint('after', after);
    assert.equal(after.length, 9);
    const fields = ['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website'];
    for (const prior of before) {
        const row = after.find(r => r.id === prior.id);
        assert(row);
        const proposed = fixture.approved.find(f => f.email === row.email);
        if (['ENT-UPDATE', 'ENT-NULL-CLEAR'].includes(proposed?.contactId)) {
            for (const field of fields)
                assert.equal(row[field] || null, proposed[field] || null);
            assert.equal(row.owner, prior.owner);
            assert.equal(row.marker, prior.marker);
        }
        else
            assert.deepEqual(row, prior);
    }
    const newRow = after.find(r => r.email === fixture.approved.find(f => f.contactId === 'ENT-CREATE').email);
    assert(newRow);
    const proposedNew = fixture.approved.find(f => f.contactId === 'ENT-CREATE');
    for (const field of fields) assert.equal(newRow[field] || null, proposedNew[field] || null);
    assert.equal(after.filter(r => r.email === newRow.email).length, 1);
    evidence.firstWrite = { created: receipt.created, updated: receipt.updated, unchanged: receipt.unchanged, held: receipt.held, failed: receipt.failed, nativeRecordsAfter: after.length, unrelatedFixtureRecordsPreserved: true, ownersPreserved: true };
    persist();
    await page.getByText(new RegExp((provider === 'hubspot' ? 'HubSpot' : 'Salesforce') + ' receipt:')).screenshot({ path: images + '/' + provider + '-receipt.png' });
    stage = 'repeat';
    await load('enterprise-import-approved.csv');
    const repeat = await preview();
    checkpoint('repeat-plan', repeat);
    assert.equal(repeat.creates, 0);
    assert.equal(repeat.updates, 0);
    assert.equal(repeat.unchanged, provider === 'hubspot' ? 5 : 4);
    await planShot('repeat');
    const repeated = await execute();
    assert.equal(repeated.created, 0);
    assert.equal(repeated.updated, 0);
    assert.equal(repeated.failed, 0);
    await history(repeated);
    assert.deepEqual(await native(), after);
    evidence.repeat = { created: repeated.created, updated: repeated.updated, unchanged: repeated.unchanged, held: repeated.held, failed: repeated.failed, nativeStateIdentical: true };
    persist();
    stage = 'rollback';
    await page.goto(base + '/runs');
    await page.getByRole('button', { name: 'Roll back 2 updates', exact: true }).waitFor();
    await page.getByLabel('Operator access key for rollback', { exact: true }).fill(env.CONTROL_TOWER_SYNC_KEY);
    const rollbackResponse = page.waitForResponse(r => r.url().endsWith('/crm-writeback') && r.request().postDataJSON()?.action === 'rollback'), rollbackSaved = page.waitForResponse(r => r.url().endsWith('/runs') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Roll back 2 updates', exact: true }).click();
    const rr = await rollbackResponse;
    assert.equal(rr.status(), 202);
    const undone = await rr.json();
    checkpoint('rollback-receipt', undone);
    assert.equal((await rollbackSaved).status(), 201);
    assert.equal(undone.updated, 2);
    assert.equal(undone.failed, 0);
    assert.equal(undone.held, 0);
    await history(undone);
    const restored = await native();
    checkpoint('restored', restored);
    assert.equal(restored.length, 9);
    for (const row of before)
        assert.deepEqual(restored.find(r => r.id === row.id), row);
    assert.deepEqual(restored.find(r => r.id === newRow.id), newRow);
    evidence.rollback = { restored: undone.updated, held: undone.held, failed: undone.failed, baselineFieldsRestored: true, createdRecordRetained: true };
    await page.getByRole('button', { name: 'Rollback completed', exact: true }).waitFor();
    const undoCard = page.locator('article').filter({ has: page.getByRole('heading', { name: provider + ' · undo', exact: true }) });
    await undoCard.screenshot({ path: images + '/' + provider + '-rollback.png', mask: [undoCard.locator('p.font-mono').first()], maskColor: '#182d25' });
    assert.deepEqual(evidence.pageErrors, []);
    evidence.finishedAt = new Date().toISOString();
    persist();
    console.log(JSON.stringify(evidence, null, 2));
}
catch (error) {
    evidence.failedStage = stage;
    evidence.error = error.message;
    persist();
    await page.screenshot({ path: runtime + '/' + provider + '-failure.png', fullPage: true });
    throw error;
}
finally {
    await context.storageState({ path: runtime + '/' + provider + '-browser-state.json' });
    await browser.close();
}
function save(name, data) {
    writeFileSync(runtime + '/' + name + '.json', JSON.stringify(data, null, 2), { mode: 0o600 });
}
async function api(provider, path, method = 'GET', body) {
    const origin = provider === 'hubspot' ? 'https://api.hubapi.com' : env.SALESFORCE_INSTANCE_URL;
    const token = provider === 'hubspot' ? env.HUBSPOT_ACCESS_TOKEN : env.SALESFORCE_ACCESS_TOKEN;
    assert(origin && token, 'Native read-back credentials are required.');
    const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok) {
        save('native-read-error', { provider, status: response.status, data });
        throw Error(provider + ' read-back returned ' + response.status);
    }
    return data;
}
function soql(query) { return api('salesforce', '/services/data/v67.0/query?q=' + encodeURIComponent(query)); }
function quote(value) { return "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'"; }
