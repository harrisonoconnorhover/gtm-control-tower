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
const holdsOnly = process.argv.includes('--holds-only');
const controlsOnly = process.argv.includes('--controls-only');
assert(process.argv.slice(3).length <= 1 && process.argv.slice(3).every(arg => ['--holds-only', '--controls-only'].includes(arg)), 'Choose at most one of --holds-only or --controls-only after the provider.');
const base = env.CONTROL_TOWER_BROWSER_BASE_URL ?? 'http://127.0.0.1:3000', images = runtime + '/screens';
if (controlsOnly) assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Native controls qualification requires a loopback app.');
mkdirSync(images, { recursive: true });
const evidence = { provider, startedAt: new Date().toISOString(), caseId: fixture.caseId, stages: {}, pageErrors: [] };
const browser = await chromium.launch({ executablePath: env.CHROMIUM_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();
page.setDefaultTimeout(45000);
page.on('pageerror', e => evidence.pageErrors.push(e.message));
let stage = 'startup';
let allowedControlRequest = null;
const approvedIds = new Set(fixture.approved.map(r => r.contactId));
const heldInputs = fixture.review.filter(r => ['ENT-EMAIL-CHANGE', 'ENT-COWORKER'].includes(r.contactId));
await page.route('**/api/control-tower/**', async (route) => {
    const q = route.request(), p = new URL(q.url()).pathname, b = q.method() === 'POST' ? q.postDataJSON() : null;
    if (/\/(hubspot-sync|salesforce-sync|demo-intake)$/.test(p))
        throw Error('Unexpected write endpoint');
    if (p.endsWith('/crm-writeback') && b?.action !== 'preview') {
        assert.equal(b.connectorId, provider);
        if (controlsOnly) {
            assert(allowedControlRequest, 'No native control mutation has been qualified for this stage.');
            assert.equal(b.action, allowedControlRequest.action);
            if (b.action === 'execute') {
                assert.deepEqual(b.contacts, allowedControlRequest.contacts);
                assert.deepEqual(b.plan, allowedControlRequest.plan);
                assert.deepEqual(b.updatePolicy, allowedControlRequest.plan.updatePolicy);
            } else {
                assert.equal(b.action, 'rollback');
                assert.deepEqual(b.rollback, allowedControlRequest.rollback);
            }
            allowedControlRequest = null; // One request only; failures require operator reconciliation.
        }
        else if (holdsOnly) {
            assert.equal(b.action, 'execute', 'The holds-only qualification never requests rollback.');
            assert.equal(b.contacts.length, 2);
            assert(b.contacts.every(r => heldInputs.some(f => f.contactId === r.contactId && f.email === r.email)));
            assert.equal(b.plan.creates, 0);
            assert.equal(b.plan.updates, 0);
            assert.equal(b.plan.held, 2);
            assert.equal(b.plan.records.length, 2);
            assert(b.plan.records.every(r => r.operation === 'hold'), 'The holds-only qualification must not submit a native mutation.');
        }
        else if (b.action === 'execute')
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
        if (controlsOnly) assert(r.done === true && Array.isArray(r.records), 'Native fixture read must be complete.');
        out.push(...r.records.map(r => ({ id: r.Id, type: object.toLowerCase(), email: r.Email, firstName: r.FirstName, lastName: r.LastName, company: lead ? r.Company : r.Account?.Name ?? null, phone: r.Phone, jobTitle: r.Title, website: lead ? r.Website : null, state: lead ? r.State : r.MailingState, city: lead ? r.City : r.MailingCity, marker: r.Description, owner: r.OwnerId })));
    }
    return out;
}
function checkpoint(name, data) { save(provider + '-' + name, data); evidence.stages[name] = new Date().toISOString(); persist(); console.log(JSON.stringify({ provider, phase: name, ...(data.records ? { records: data.records.length } : {}) })); }
async function load(file, buffer) {
    await page.getByLabel('Where is your data?').selectOption('csv');
    await page.locator('input[type=file]').setInputFiles(buffer ? { name: file, mimeType: 'text/csv', buffer } : repo + '/public/' + file);
    await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
    await page.getByText(/SQLite r\d+ · saved/).waitFor();
}
async function selectFixtureUpdatePolicy() {
    async function savePolicyChange(change, clearBlanks) {
        const response = page.waitForResponse(r => {
            if (!r.url().endsWith('/workspace') || r.request().method() !== 'POST') return false;
            const body = r.request().postDataJSON();
            return body.action === 'save' && body.reason === 'crm_update_policy_changed';
        });
        const [saved] = await Promise.all([response, change()]);
        assert.equal(saved.status(), 200, 'The intentional update policy must be saved before comparison.');
        const policy = (await saved.json()).workspace.state.crmUpdatePolicy;
        assert.equal(policy.mode, 'replace');
        assert.equal(policy.clearBlanks, clearBlanks);
        assert.deepEqual(policy.fields, ['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website']);
        await page.getByText(/SQLite r\d+ · saved/).waitFor();
    }
    await savePolicyChange(() => page.getByRole('combobox', { name: /^Update existing CRM records/ }).selectOption('replace'), false);
    await savePolicyChange(() => page.getByLabel('Allow blank values to clear selected fields', { exact: true }).click(), true);
}
async function preview(refresh = false) {
    const response = page.waitForResponse(r => r.url().endsWith('/crm-writeback') && r.request().postDataJSON()?.action === 'preview');
    await page.getByRole('button', { name: refresh ? 'Refresh comparison' : /^Compare \d+ with CRM$/ }).click();
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
    // Expand only the scroll container for a legible capture; restore the UI afterward.
    const previousStyle = await list.getAttribute('style');
    try {
        await list.evaluate(element => { element.style.maxHeight = 'none'; element.style.overflow = 'visible'; element.scrollTop = 0; });
        await box.screenshot({ path: images + '/' + provider + '-' + name + '.png', mask: [list.locator('details > p').filter({ hasText: 'Matched CRM records:' }), list.locator('p.font-mono')], maskColor: '#182d25' });
    } finally {
        await list.evaluate((element, style) => { if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style); }, previousStyle);
    }
}
async function checkHolds() {
    evidence.mode = 'holds-only';
    stage = 'holds-before';
    const stable = rows => [...rows].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
    const before = stable(await native());
    assert.equal(before.length, 9, 'Requires the eight retained baseline people and the one Nina created by the first-run qualification.');
    for (const record of fixture.baseline) {
        const found = before.filter(row => row.email === record.email);
        assert.equal(found.length, 1);
        assert(found[0].marker?.includes(fixture.caseId));
    }
    assert.equal(before.filter(row => row.email === fixture.approved.find(r => r.contactId === 'ENT-CREATE').email).length, 1);
    assert(heldInputs.every(input => !before.some(row => row.email === input.email)), 'Both proposed email addresses must be absent before qualification.');
    checkpoint('holds-before', before);
    await page.goto(base + '/app/lab');
    await page.getByText('SQLite r0 · saved', { exact: false }).waitFor();
    await page.getByLabel('Operator access key', { exact: true }).fill(env.CONTROL_TOWER_SYNC_KEY);
    const lines = readFileSync(repo + '/public/enterprise-import-review.csv', 'utf8').trimEnd().split(/\r?\n/);
    const selected = lines.slice(1).filter(line => heldInputs.some(row => line.startsWith(row.contactId + ',')));
    assert.equal(selected.length, 2);
    await load('enterprise-import-holds.csv', Buffer.from([lines[0], ...selected].join('\n') + '\n'));
    await page.getByLabel('Where should clean records go?').selectOption(provider);
    await page.getByText(/SQLite r\d+ · saved/).waitFor();
    const panel = page.getByRole('region', { name: 'Approximate CRM matches' });
    await panel.getByText('No saved snapshot. Read CRM records to build one.', { exact: true }).waitFor();
    stage = 'holds-without-snapshot';
    const missingSnapshot = await preview();
    checkpoint('holds-without-snapshot-plan', missingSnapshot);
    assert.equal(missingSnapshot.creates, 0);
    assert.equal(missingSnapshot.updates, 0);
    assert.equal(missingSnapshot.held, 2);
    assert(missingSnapshot.records.every(record => record.operation === 'hold'));
    await planShot('holds-without-snapshot');

    stage = 'holds-snapshot';
    await panel.getByRole('button', { name: 'Read CRM snapshot', exact: true }).click();
    await panel.getByText(/records · \d+ pages · Provider pagination complete/).waitFor({ timeout: 90000 });
    const workspaceId = await page.evaluate(() => localStorage.getItem('gtm-control-tower-workspace-id'));
    const snapshotResponse = await page.request.get(base + '/api/control-tower/duplicate-scan?workspaceId=' + encodeURIComponent(workspaceId) + '&connectorId=' + provider,
        { headers: { 'x-control-tower-key': env.CONTROL_TOWER_SYNC_KEY } });
    assert.equal(snapshotResponse.status(), 200);
    const snapshot = (await snapshotResponse.json()).scan;
    assert(snapshot.sourceComplete);
    checkpoint('holds-snapshot', snapshot);
    // Exploratory field choices must not weaken the independent create-review guard.
    for (const field of ['Email', 'Phone', 'State', 'Company'])
        await panel.getByRole('checkbox', { name: new RegExp('^' + field) }).uncheck();
    await panel.getByRole('checkbox', { name: /^Name/ }).check();
    await panel.getByRole('button', { name: 'Find suggestions for these rows', exact: true }).click();
    await panel.getByRole('status').filter({ hasText: 'Review ready for 2 imported records.' }).waitFor();
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download this review (JSON)', exact: true }).click();
    checkpoint('holds-name-only-review', JSON.parse(readFileSync(await (await download).path(), 'utf8')));
    stage = 'holds-execute';
    const plan = await preview(true);
    checkpoint('holds-plan', plan);
    assert.equal(plan.creates, 0);
    assert.equal(plan.updates, 0);
    assert.equal(plan.held, 2);
    assert(plan.records.every(record => record.operation === 'hold'));
    const scores = Object.fromEntries(plan.records.map(record => [record.contactId, record.possibleMatches.map(match => match.score).sort((a, b) => b - a)]));
    assert.deepEqual(scores['ENT-EMAIL-CHANGE'], [72]);
    assert.deepEqual(scores['ENT-COWORKER'], [28, 28]);
    const list = page.getByLabel('CRM comparison records', { exact: true });
    for (const detail of await list.locator('details').all()) {
        if (await detail.getAttribute('open') === null) await detail.locator('summary').click();
    }
    await planShot('holds-plan');
    for (const input of heldInputs) {
        const detail = list.locator('details').filter({ has: page.locator('summary').filter({ hasText: input.contactId }) });
        await detail.screenshot({ path: images + '/' + provider + '-holds-' + input.contactId.toLowerCase() + '.png',
            mask: [detail.locator('p.font-mono')], maskColor: '#182d25' });
    }
    const receipt = await execute();
    assert.equal(receipt.created, 0);
    assert.equal(receipt.updated, 0);
    assert.equal(receipt.held, 2);
    assert.equal(receipt.failed, 0);
    assert.equal(receipt.records.length, 2);
    assert(receipt.records.every(record => record.status === 'held'));
    const saved = await history(receipt);
    const savedRun = saved.runs.find(run => run.details?.writeback?.runId === receipt.runId);
    assert.deepEqual(savedRun.details.writeback, receipt);
    assert.equal(savedRun.details.plan.held, 2);
    const after = stable(await native());
    checkpoint('holds-after', after);
    assert.deepEqual(after, before, 'Every retained native fixture must be unchanged.');
    assert(heldInputs.every(input => !after.some(row => row.email === input.email)));
    assert.deepEqual(evidence.pageErrors, []);
    evidence.finishedAt = new Date().toISOString();
    const result = { provider, mode: 'holds-only', caseId: fixture.caseId, startedAt: evidence.startedAt, finishedAt: evidence.finishedAt,
        withoutSnapshot: { created: missingSnapshot.creates, updated: missingSnapshot.updates, held: missingSnapshot.held },
        snapshot: { records: snapshot.recordsScanned, pages: snapshot.pagesScanned, sourceComplete: snapshot.sourceComplete, startedAt: snapshot.startedAt, completedAt: snapshot.completedAt },
        reviewSelection: ['name'], enforcedCandidateScores: scores,
        receipt: { created: receipt.created, updated: receipt.updated, held: receipt.held, failed: receipt.failed },
        nativeFixtureRecords: after.length, proposedEmailsAbsent: true, nativeStateIdentical: true, savedReceiptVerified: true, pageErrors: 0 };
    evidence.result = result;
    persist();
    save(provider + '-holds-result', result);
    console.log(JSON.stringify(result, null, 2));
}
async function checkControls() {
    evidence.mode = 'controls-only';
    const fields = ['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website'];
    const defaultPolicy = { mode: 'fill-empty', fields, clearBlanks: false };
    const selectedPolicy = { mode: 'replace', fields: ['jobTitle', 'website'], clearBlanks: true };
    const clean = value => value?.trim() || null;
    const stable = rows => [...rows].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
    const portable = row => Object.fromEntries(fields.map(field => [field, clean(row[field])]));
    const manifestPath = env.GTM_FIXTURE_MANIFEST;
    assert(manifestPath && isAbsolute(manifestPath), 'Controls qualification requires an existing private GTM_FIXTURE_MANIFEST.');
    const manifestRelative = relative(repo, manifestPath);
    if (manifestRelative !== '..' && !manifestRelative.startsWith('../')) {
        execFileSync('git', ['check-ignore', '--quiet', '--', manifestRelative], { cwd: repo });
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.caseId, fixture.caseId);
    const owned = manifest.providers?.[provider];
    assert(owned?.accountId && owned.records && !owned.pendingCreate, 'Reconcile the fixture manifest before qualification.');
    stage = 'controls-account';
    if (provider === 'hubspot') {
        assert(env.HUBSPOT_DEVELOPMENT_ACCOUNT_ID, 'Set HUBSPOT_DEVELOPMENT_ACCOUNT_ID to the designated development account.');
        const account = await api(provider, '/account-info/v3/details');
        assert.equal(String(account.portalId), env.HUBSPOT_DEVELOPMENT_ACCOUNT_ID);
        assert.equal(String(account.portalId), owned.accountId);
    } else {
        assert.equal(new URL(env.SALESFORCE_INSTANCE_URL).protocol, 'https:');
        const result = await soql('SELECT Id, OrganizationType, IsSandbox FROM Organization LIMIT 1');
        assert(result.done === true && result.records?.length === 1);
        const org = result.records[0];
        assert(org.IsSandbox === true || org.OrganizationType === 'Developer Edition', 'Use the designated Salesforce sandbox or Developer Edition.');
        assert.equal(String(org.Id), owned.accountId);
    }
    checkpoint('controls-account', { developmentAccountVerified: true, manifestVerified: true });
    stage = 'controls-before';
    const before = stable(await native());
    assert.equal(before.length, 9, 'Requires the eight restored baseline records plus retained Nina; never seed or reset here.');
    for (const input of fixture.baseline) {
        const rows = before.filter(row => row.email === input.email);
        assert.equal(rows.length, 1);
        const row = rows[0], saved = owned.records[input.key];
        assert(saved && row.id === saved.nativeId && row.email === saved.email && row.type === saved.objectType, 'Fixture identity must match the private manifest.');
        assert.equal(row.type, provider === 'salesforce' && input.key !== 'denise' ? 'lead' : 'contact');
        assert(row.marker?.includes(fixture.caseId) && row.marker.includes(`Key: ${input.key}.`), 'Baseline record must carry the case ownership marker.');
        const expected = portable(input);
        if (provider === 'salesforce' && input.key === 'denise') expected.website = null;
        assert.deepEqual(portable(row), expected, 'Baseline portable fields must be restored before qualification.');
    }
    const nina = fixture.approved.find(row => row.contactId === 'ENT-CREATE');
    const retained = before.filter(row => row.email === nina.email);
    assert.equal(retained.length, 1);
    assert.deepEqual(portable(retained[0]), portable(nina));
    assert.equal(retained[0].type, provider === 'salesforce' ? 'lead' : 'contact');
    assert(heldInputs.every(input => !before.some(row => row.email === input.email)));
    checkpoint('controls-before', before);

    const marcus = fixture.review.find(row => row.contactId === 'ENT-UPDATE');
    const tess = fixture.review.find(row => row.contactId === 'ENT-NULL-CLEAR');
    const elena = { ...fixture.review.find(row => row.contactId === 'ENT-UNCHANGED'), jobTitle: 'Vice President, Partner Operations' };
    const inputs = [marcus, tess, elena];
    const skipReason = 'This attendee has not approved a title replacement; leave the existing CRM record unchanged.';
    const beforeByEmail = new Map(before.map(row => [row.email, row]));
    const csv = rows => {
        const mapping = { contact_id: 'contactId', first_name: 'firstName', last_name: 'lastName', email: 'email', company: 'company', phone: 'phone', state: 'state', region: 'region', segment: 'segment', owner_id: 'ownerId', job_title: 'jobTitle', website: 'website' };
        const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
        return Buffer.from([Object.keys(mapping).join(','), ...rows.map(row => Object.values(mapping).map(key => cell(row[key])).join(','))].join('\n') + '\n');
    };
    const selection = page.getByRole('region', { name: 'Import row decisions', exact: true });
    const mode = page.getByRole('combobox', { name: /^Update existing CRM records/ });
    const comparisonButton = page.getByRole('button', { name: 'Download comparison CSV', exact: true });
    async function savedChange(action, reason) {
        const response = page.waitForResponse(r => r.url().endsWith('/workspace') && r.request().method() === 'POST'
            && r.request().postDataJSON()?.reason === reason);
        const [result] = await Promise.all([response, action()]);
        assert.equal(result.status(), 200);
        const workspace = (await result.json()).workspace;
        await page.getByText(/SQLite r\d+ · saved/).waitFor();
        return workspace;
    }
    async function savedSelection(skip) {
        if (skip) await selection.getByLabel(`Reason for skipping ${elena.contactId}`, { exact: true }).fill(skipReason);
        const workspace = await savedChange(() => selection.getByRole('button', { name: `${skip ? 'Skip' : 'Restore'} row ${elena.contactId}`, exact: true }).click(), skip ? 'import_row_skipped' : 'import_row_restored');
        const row = workspace.state.contacts.find(row => row.contactId === elena.contactId);
        if (skip) assert.equal(row.importExclusion.reason, skipReason); else assert.equal(row.importExclusion, undefined);
        await page.getByRole('button', { name: `Compare ${skip ? 2 : 3} with CRM`, exact: true }).waitFor();
        assert.equal(await comparisonButton.count(), 0, 'Saved row selection must invalidate comparison.');
        return workspace;
    }
    function validatePlan(plan, rows, expectedChanges, policy) {
        assert.equal(plan.connectorId, provider);
        assert.deepEqual(plan.updatePolicy, policy);
        assert.equal(plan.requested, rows.length);
        assert.equal(plan.records.length, rows.length);
        assert.equal(plan.creates, 0);
        assert.equal(plan.held, 0);
        assert.equal(plan.updates, rows.filter(row => expectedChanges[row.contactId]?.length).length);
        assert.equal(plan.unchanged, rows.length - plan.updates);
        assert.deepEqual(plan.records.map(row => row.contactId).sort(), rows.map(row => row.contactId).sort());
        for (const input of rows) {
            const record = plan.records.find(row => row.contactId === input.contactId);
            const original = beforeByEmail.get(input.email), changes = expectedChanges[input.contactId] ?? [];
            assert.equal(record.email, input.email);
            assert.equal(record.nativeId, original.id);
            assert.equal(record.matches.length, 1);
            assert.equal(record.matches[0].nativeId, original.id);
            assert.equal(record.matches[0].objectType, original.type);
            assert.equal(record.matches[0].email, input.email);
            assert.equal(record.operation, changes.length ? 'update' : 'unchanged');
            assert.deepEqual(record.changes, changes);
        }
    }
    async function download(button, name) {
        const pending = page.waitForEvent('download');
        await button.click();
        const file = await pending;
        assert(file.suggestedFilename().includes('current-batch'));
        const text = readFileSync(await file.path(), 'utf8');
        writeFileSync(runtime + '/' + provider + '-' + name + '.csv', text, { mode: 0o600 });
        return parseControlCsv(text);
    }
    async function compareCsv(plan, name) {
        const rows = await download(comparisonButton, name);
        assert.equal(rows.length, plan.records.length);
        for (const record of plan.records) {
            const row = rows.find(row => row.contact_id === record.contactId);
            assert(row);
            assert.equal(row.report_kind, 'comparison');
            assert.equal(row.report_scope, 'current_batch');
            assert.equal(row.outcome, '');
            assert.equal(row.planned_action, record.operation);
            assert.equal(row.native_id, record.nativeId);
            assert.deepEqual(JSON.parse(row.field_changes), record.changes);
            assert.deepEqual(JSON.parse(row.update_policy), plan.updatePolicy);
        }
    }
    async function executeControls(plan) {
        const bodyResponse = page.waitForRequest(r => r.url().endsWith('/crm-writeback') && r.postDataJSON()?.action === 'execute');
        // The imported values and native targets have already been checked above.
        const rows = stage === 'controls-fill' ? [fillInput] : [marcus, tess];
        const contacts = rows.map(row => ({ contactId: row.contactId, email: row.email, ...portable(row) }));
        allowedControlRequest = { action: 'execute', contacts, plan };
        const receipt = await execute();
        await bodyResponse;
        assert.equal(receipt.created, 0);
        assert.equal(receipt.updated, plan.updates);
        assert.equal(receipt.held, 0);
        assert.equal(receipt.failed, 0);
        assert.equal(receipt.records.length, plan.records.length);
        for (const record of receipt.records) {
            const proposed = plan.records.find(row => row.contactId === record.contactId);
            assert.equal(record.nativeId, proposed.nativeId);
            assert.equal(record.status, 'updated');
        }
        const data = await history(receipt);
        const saved = data.runs.find(run => run.details?.writeback?.runId === receipt.runId);
        assert.deepEqual(saved.details.writeback, receipt);
        assert.deepEqual(saved.details.plan, plan);
        checkpoint(stage + '-history', data);
        return receipt;
    }
    async function resultsCsv(receipt, name) {
        await page.goto(base + '/runs');
        await page.reload();
        const article = page.locator('article').filter({ hasText: receipt.runId });
        await article.getByRole('button', { name: 'Download results CSV', exact: true }).waitFor();
        const rows = await download(article.getByRole('button', { name: 'Download results CSV', exact: true }), name);
        assert.equal(rows.length, receipt.records.length);
        assert.deepEqual(rows.map(row => row.contact_id).sort(), receipt.records.map(row => row.contactId).sort());
        for (const record of receipt.records) {
            const row = rows.find(row => row.contact_id === record.contactId);
            assert(row);
            assert.equal(row.report_kind, 'results');
            assert.equal(row.report_scope, 'current_batch');
            assert.equal(row.run_id, receipt.runId);
            assert.equal(row.native_id, record.nativeId);
            assert.equal(row.outcome, record.status);
        }
    }
    const titleChange = { field: 'jobTitle', before: beforeByEmail.get(marcus.email).jobTitle, after: marcus.jobTitle };
    const clearChange = { field: 'website', before: beforeByEmail.get(tess.email).website, after: null };
    const fillInput = { ...tess, website: clearChange.before, jobTitle: 'Vice President, Commercial Operations' };
    stage = 'controls-selection';
    await page.goto(base + '/app/lab');
    await page.getByText('SQLite r0 · saved', { exact: false }).waitFor();
    await page.getByLabel('Operator access key', { exact: true }).fill(env.CONTROL_TOWER_SYNC_KEY);
    await load('enterprise-import-controls.csv', csv(inputs));
    await page.getByLabel('Where should clean records go?').selectOption(provider);
    await page.getByText(/SQLite r\d+ · saved/).waitFor();
    const initialPlan = await preview();
    validatePlan(initialPlan, inputs, {}, defaultPolicy);
    checkpoint('controls-default-plan', initialPlan);
    await compareCsv(initialPlan, 'controls-default-comparison');
    await page.locator('summary').filter({ hasText: /^Choose rows to import ·/ }).click();
    await savedSelection(true);
    await page.reload();
    await page.locator('summary').filter({ hasText: /^Choose rows to import ·/ }).click();
    await selection.getByText(`Skipped: ${skipReason}`, { exact: true }).waitFor();
    await savedSelection(false);
    checkpoint('controls-selection', await savedSelection(true));
    const skippedPlan = await preview();
    validatePlan(skippedPlan, [marcus, tess], {}, defaultPolicy);
    await compareCsv(skippedPlan, 'controls-skipped-comparison');
    assert.deepEqual(stable(await native()), before, 'Skipping and default-policy comparisons must leave native state unchanged.');
    await savedChange(() => mode.selectOption('replace'), 'crm_update_policy_changed');
    for (const field of ['first name', 'last name', 'company', 'phone']) {
        await savedChange(() => page.getByRole('checkbox', { name: `Update ${field}`, exact: true }).click(), 'crm_update_policy_changed');
        assert.equal(await page.getByRole('checkbox', { name: `Update ${field}`, exact: true }).isChecked(), false);
    }
    await savedChange(() => page.getByLabel('Allow blank values to clear selected fields', { exact: true }).click(), 'crm_update_policy_changed');
    assert.equal(await comparisonButton.count(), 0, 'Policy changes must invalidate comparison.');
    stage = 'controls-replace';
    const replacement = await preview();
    validatePlan(replacement, [marcus, tess], { [marcus.contactId]: [titleChange], [tess.contactId]: [clearChange] }, selectedPolicy);
    for (const record of replacement.records) {
        const original = beforeByEmail.get(record.email);
        assert.deepEqual(record.before, portable(original));
        assert.deepEqual(record.after, { ...portable(original), ...Object.fromEntries(record.changes.map(change => [change.field, change.after])) });
    }
    checkpoint('controls-replace-plan', replacement);
    await compareCsv(replacement, 'controls-replace-comparison');
    for (const detail of await page.getByLabel('CRM comparison records', { exact: true }).locator('details').all()) {
        if (await detail.getAttribute('open') === null) await detail.locator('summary').click();
    }
    await planShot('controls-replace');
    const written = await executeControls(replacement);
    assert.equal(written.rollback.records.length, 2);
    assert.equal(written.rollback.createdRecordsSkipped, 0);
    for (const record of written.rollback.records) {
        const planRecord = replacement.records.find(row => row.contactId === record.contactId);
        assert.equal(record.nativeId, planRecord.nativeId);
        assert.deepEqual(record.changedFields, planRecord.changes.map(change => change.field));
        assert.deepEqual(record.before, planRecord.before);
        assert.deepEqual(record.after, planRecord.after);
    }
    const afterReplace = stable(await native());
    const expectedReplace = before.map(row => row.email === marcus.email ? { ...row, jobTitle: marcus.jobTitle }
        : row.email === tess.email ? { ...row, website: provider === 'hubspot' ? '' : null } : row);
    assert.deepEqual(afterReplace.map(row => ({ ...row, website: clean(row.website) })), expectedReplace.map(row => ({ ...row, website: clean(row.website) })), 'Only approved native fields may change; skipped Elena and all other fixture records stay unchanged.');
    checkpoint('controls-after-replace', afterReplace);
    await resultsCsv(written, 'controls-replace-results');

    stage = 'controls-fill';
    await page.goto(base + '/app/lab');
    await page.getByText(/SQLite r\d+ · saved/).waitFor();
    await load('enterprise-import-controls-fill.csv', csv([fillInput]));
    await savedChange(() => mode.selectOption('fill-empty'), 'crm_update_policy_changed');
    for (const field of ['first name', 'last name', 'company', 'phone']) {
        await savedChange(() => page.getByRole('checkbox', { name: `Update ${field}`, exact: true }).click(), 'crm_update_policy_changed');
        assert.equal(await page.getByRole('checkbox', { name: `Update ${field}`, exact: true }).isChecked(), true);
    }
    const fill = await preview();
    validatePlan(fill, [fillInput], { [tess.contactId]: [{ field: 'website', before: null, after: clearChange.before }] }, defaultPolicy);
    assert.deepEqual(fill.records[0].before, { ...portable(beforeByEmail.get(tess.email)), website: null });
    assert.deepEqual(fill.records[0].after, portable(beforeByEmail.get(tess.email)));
    checkpoint('controls-fill-plan', fill);
    await compareCsv(fill, 'controls-fill-comparison');
    const filled = await executeControls(fill);
    const afterFill = stable(await native());
    assert.deepEqual(afterFill, before.map(row => row.email === marcus.email ? { ...row, jobTitle: marcus.jobTitle } : row));
    checkpoint('controls-after-fill', afterFill);
    await resultsCsv(filled, 'controls-fill-results');

    stage = 'controls-rollback';
    const originalRun = page.locator('article').filter({ hasText: written.runId });
    await page.getByLabel('Operator access key for rollback', { exact: true }).fill(env.CONTROL_TOWER_SYNC_KEY);
    allowedControlRequest = { action: 'rollback', rollback: written.rollback };
    const response = page.waitForResponse(r => r.url().endsWith('/crm-writeback') && r.request().postDataJSON()?.action === 'rollback');
    const saved = page.waitForResponse(r => r.url().endsWith('/runs') && r.request().method() === 'POST');
    await originalRun.getByRole('button', { name: 'Roll back 2 updates', exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 202);
    const undone = await result.json();
    checkpoint('controls-rollback-receipt', undone);
    assert.equal((await saved).status(), 201);
    assert.equal(undone.updated, 1);
    assert.equal(undone.unchanged, 1);
    assert.equal(undone.created, 0);
    assert.equal(undone.held, 0);
    assert.equal(undone.failed, 0);
    assert.equal(undone.records.find(row => row.contactId === marcus.contactId)?.status, 'rolled_back');
    assert.equal(undone.records.find(row => row.contactId === tess.contactId)?.status, 'unchanged');
    checkpoint('controls-rollback-history', await history(undone));
    await resultsCsv(undone, 'controls-rollback-results');
    const restored = stable(await native());
    checkpoint('controls-restored', restored);
    assert.deepEqual(restored, before, 'All nine retained native records must equal the initial snapshot.');
    assert.deepEqual(evidence.pageErrors, []);
    evidence.finishedAt = new Date().toISOString();
    const resultSummary = { provider, mode: 'controls-only', caseId: fixture.caseId, startedAt: evidence.startedAt, finishedAt: evidence.finishedAt,
        developmentAccountVerified: true, baselineManifestVerified: true, nativeFixtureRecords: restored.length,
        savedSkipRestoreVerified: true, skippedRecordUnchanged: true, defaultPolicyUpdates: initialPlan.updates,
        selectedReplacement: { updated: written.updated, fields: ['jobTitle', 'website'], unselectedFieldsPreserved: true },
        fillEmpty: { updated: filled.updated, fields: ['website'], populatedFieldsPreserved: true },
        rollback: { restored: undone.updated, alreadyRestored: undone.unchanged, held: undone.held, failed: undone.failed },
        comparisonCsvVerified: true, savedResultsCsvVerified: true, created: 0, deleted: 0, finalNativeStateIdentical: true, pageErrors: 0 };
    evidence.result = resultSummary;
    persist();
    save(provider + '-controls-result', resultSummary);
    console.log(JSON.stringify(resultSummary, null, 2));
}

function parseControlCsv(text) {
    const records = [];
    let row = [], cell = '', quoted = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            if (quoted && text[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted;
        } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
        else if (char === '\r' && text[index + 1] === '\n' && !quoted) { records.push([...row, cell]); row = []; cell = ''; index++; }
        else cell += char;
    }
    assert(!quoted && !cell && !row.length, 'Expected a complete CRLF CSV download.');
    const [header, ...data] = records;
    header[0] = header[0].replace(/^\uFEFF/u, '');
    return data.map(cells => {
        assert.equal(cells.length, header.length);
        return Object.fromEntries(header.map((column, index) => [column, cells[index]]));
    });
}

try {
    if (controlsOnly) {
        await checkControls();
    } else if (holdsOnly) {
        await checkHolds();
    } else {
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
    // The second CSV records the operator's resolved subset; create candidates also pass the independent snapshot review guard.
    await load('enterprise-import-approved.csv');
    // Marcus's replacement values and Tess's blank website are intentional.
    // The safe default only fills empty fields, so this fixture explicitly opts in.
    await selectFixtureUpdatePolicy();
    stage = 'execute';
    const plan = await preview();
    checkpoint('plan', plan);
    assert.equal(plan.updatePolicy.mode, 'replace');
    assert.equal(plan.updatePolicy.clearBlanks, true);
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
    assert.deepEqual(repeat.updatePolicy, plan.updatePolicy);
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
}
catch (error) {
    evidence.failedStage = stage;
    evidence.error = error.message;
    persist();
    await page.screenshot({ path: runtime + '/' + provider + '-failure.png', fullPage: true });
    if (controlsOnly) throw new Error(`Native controls qualification stopped at ${stage}; reconcile the private evidence before any retry.`);
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
