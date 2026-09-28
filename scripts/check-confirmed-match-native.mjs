import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Update one retained fictional record, then restore through the app's rollback.
// No create/delete/reset or automatic mutation retry. Evidence stays private.
const repo = fileURLToPath(new URL('..', import.meta.url));
const env = process.env, provider = process.argv[2];
assert(['hubspot', 'salesforce'].includes(provider));
const base = new URL(env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert(env.CONTROL_TOWER_SYNC_KEY, 'Use the disposable app operator key.');
const output = env.GTM_FIXTURE_OUTPUT, manifestPath = env.GTM_FIXTURE_MANIFEST;
for (const path of [output, manifestPath]) {
  assert(path && isAbsolute(path), 'Set absolute private output and existing manifest paths.');
  const local = relative(repo, path);
  if (local !== '..' && !local.startsWith('../')) execFileSync('git', ['check-ignore', '--quiet', '--', local], { cwd: repo });
}
mkdirSync(output, { recursive: true, mode: 0o700 });
chmodSync(output, 0o700);
const fixture = JSON.parse(readFileSync(repo + '/fixtures/enterprise-import-case.json', 'utf8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.caseId, fixture.caseId);
const owned = manifest.providers?.[provider];
assert(owned?.accountId && owned.records && !owned.pendingCreate);
const fields = ['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website'];
const matchingFields = ['name', 'email', 'phone', 'state', 'company'];
const clean = value => value?.trim() || null;
const portable = row => Object.fromEntries(fields.map(field => [field, clean(row[field])]));
const stable = rows => [...rows].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
const evidence = { provider, startedAt: new Date().toISOString(), caseId: fixture.caseId };
function save(name, data) { writeFileSync(`${output}/${provider}-${name}.json`, JSON.stringify(data, null, 2), { mode: 0o600 }); }
async function native(path) {
  const origin = provider === 'hubspot' ? 'https://api.hubapi.com' : env.SALESFORCE_INSTANCE_URL;
  const token = env[provider === 'hubspot' ? 'HUBSPOT_ACCESS_TOKEN' : 'SALESFORCE_ACCESS_TOKEN'];
  assert(origin && token);
  const response = await fetch(origin + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `Native read returned ${response.status}`);
  return response.json();
}
const soql = query => native('/services/data/v67.0/query?q=' + encodeURIComponent(query));
async function readFixture() {
  const emails = [...new Set([...fixture.baseline, ...fixture.review].map(row => row.email))];
  const rows = [];
  if (provider === 'hubspot') {
    let after = '';
    do {
      const result = await native('/crm/v3/objects/contacts?limit=100&properties=email,firstname,lastname,company,phone,jobtitle,website,state,city,message,hubspot_owner_id' + (after ? '&after=' + encodeURIComponent(after) : ''));
      rows.push(...result.results.filter(row => emails.includes(row.properties.email)).map(row => ({ id: row.id, type: 'contact', email: row.properties.email,
        firstName: clean(row.properties.firstname), lastName: clean(row.properties.lastname), company: clean(row.properties.company), phone: clean(row.properties.phone),
        jobTitle: clean(row.properties.jobtitle), website: clean(row.properties.website), state: clean(row.properties.state), city: clean(row.properties.city), marker: clean(row.properties.message), owner: clean(row.properties.hubspot_owner_id) })));
      after = result.paging?.next?.after || '';
    } while (after);
  } else {
    const clause = emails.map(email => "'" + email.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'").join(',');
    for (const object of ['Lead', 'Contact']) {
      const lead = object === 'Lead';
      const result = await soql(`SELECT Id,Email,FirstName,LastName,${lead ? 'Company' : 'Account.Name'},Phone,Title,${lead ? 'Website,State,City,IsConverted' : 'MailingState,MailingCity'},Description,OwnerId FROM ${object} WHERE Email IN (${clause})`);
      assert(result.done === true);
      rows.push(...result.records.map(row => ({ id: row.Id, type: object.toLowerCase(), email: row.Email,
        firstName: clean(row.FirstName), lastName: clean(row.LastName), company: clean(lead ? row.Company : row.Account?.Name), phone: clean(row.Phone),
        jobTitle: clean(row.Title), website: clean(lead ? row.Website : null), state: clean(lead ? row.State : row.MailingState), city: clean(lead ? row.City : row.MailingCity), marker: clean(row.Description), owner: clean(row.OwnerId), ...(lead ? { isConverted: row.IsConverted } : {}) })));
    }
  }
  return stable(rows);
}
async function app(path, payload, expected = 200) {
  const response = await fetch(new URL('/api/control-tower/' + path, base), {
    method: payload ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-control-tower-key': env.CONTROL_TOWER_SYNC_KEY },
    body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json();
  if (response.status !== expected) save('unexpected-response', { path, status: response.status, body });
  assert.equal(response.status, expected, `${path} returned ${response.status}`);
  return body;
}
try {
  if (provider === 'hubspot') {
    const account = await native('/account-info/v3/details');
    assert.equal(String(account.portalId), env.HUBSPOT_DEVELOPMENT_ACCOUNT_ID);
    assert.equal(String(account.portalId), owned.accountId);
    evidence.accountType = account.accountType;
  } else {
    const result = await soql('SELECT Id, OrganizationType, IsSandbox FROM Organization LIMIT 1');
    assert(result.done && result.records.length === 1);
    const account = result.records[0];
    assert.equal(account.Id, owned.accountId);
    assert(account.IsSandbox || account.OrganizationType === 'Developer Edition');
    evidence.accountType = account.OrganizationType; evidence.isSandbox = account.IsSandbox;
  }
  const before = await readFixture();
  assert.equal(before.length, 9, 'Requires the eight baseline records and retained Nina; never reset here.');
  for (const input of fixture.baseline) {
    const rows = before.filter(row => row.email === input.email), saved = owned.records[input.key];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, saved.nativeId); assert.equal(rows[0].type, saved.objectType);
    assert(rows[0].marker?.includes(fixture.caseId) && rows[0].marker.includes(`Key: ${input.key}.`));
    const expected = portable(input);
    if (provider === 'salesforce' && input.key === 'denise') expected.website = null;
    assert.deepEqual(portable(rows[0]), expected, 'Restore fixture fields before qualification.');
    if (rows[0].type === 'lead') assert.equal(rows[0].isConverted, false);
  }
  save('before', before);
  const priya = { ...fixture.review.find(row => row.contactId === 'ENT-EMAIL-CHANGE'), jobTitle: 'Director, Sales Strategy' };
  const jordan = fixture.review.find(row => row.contactId === 'ENT-COWORKER');
  assert(priya.email !== owned.records.priya.email);
  assert([priya, jordan].every(input => !before.some(row => row.email === input.email)));
  const rows = [priya, jordan].map(input => ({ ...portable(input), contactId: input.contactId,
    fullName: `${input.firstName} ${input.lastName}`, rawEmail: input.email, normalizedEmail: input.email,
    state: input.state || '', region: input.region || '', segment: input.segment || '',
    lifecycleStage: 'lead', expectedLifecycleStage: 'lead', ownerId: input.ownerId || null,
    canonicalContactId: null, recordStatus: 'active', lastAction: 'imported', qualityFlags: [], updatedAt: new Date().toISOString(),
  }));
  const updatePolicy = { mode: 'replace', fields: ['jobTitle'], clearBlanks: false };
  let { workspace } = await app('workspace', { action: 'create', name: `Confirmed match native check ${provider}` }, 201);
  ({ workspace } = await app('workspace', { action: 'save', id: workspace.id, state: { ...workspace.state, contacts: rows, originalContacts: rows, crmUpdatePolicy: updatePolicy, sourceType: 'csv', destinationType: provider, fileName: 'confirmed-match-fictional.csv' } }));
  let { scan } = await app('duplicate-scan', { action: 'start', workspaceId: workspace.id, connectorId: provider }, 201);
  while (!scan.complete) ({ scan } = await app('duplicate-scan', { action: 'step', workspaceId: workspace.id, connectorId: provider, scanId: scan.id }));
  assert(scan.sourceComplete);
  const contacts = rows.map(row => ({ contactId: row.contactId, email: row.normalizedEmail, ...portable(row) }));
  const request = { connectorId: provider, workspaceId: workspace.id, sourceFile: workspace.state.fileName, contacts, updatePolicy };
  const held = await app('crm-writeback', { ...request, action: 'preview' });
  assert.equal(held.held, 2); assert.equal(held.creates + held.updates, 0);
  const sourceKey = JSON.stringify([rows[0].contactId, rows[0].fullName, rows[0].firstName, rows[0].lastName, rows[0].rawEmail, rows[0].normalizedEmail, rows[0].company, rows[0].phone, rows[0].state, rows[0].jobTitle, rows[0].website].map(clean));
  ({ workspace } = await app('import-match-decision', { action: 'confirm', connectorId: provider, workspaceId: workspace.id, revision: workspace.revision,
    contactId: priya.contactId, sourceKey, scanId: scan.id, nativeId: owned.records.priya.nativeId, objectType: owned.records.priya.objectType, fields: matchingFields,
    reason: 'Fictional fixture: same full name, direct phone, company and state; event email differs. Preserve the existing CRM email.' }));
  const reread = await app('workspace?id=' + encodeURIComponent(workspace.id));
  assert.deepEqual(reread.workspace.state.contacts[0].crmMatchDecisions, workspace.state.contacts[0].crmMatchDecisions);
  const plan = await app('crm-writeback', { ...request, action: 'preview' });
  save('plan', plan);
  assert.equal(plan.creates, 0); assert.equal(plan.updates, 1); assert.equal(plan.held, 1);
  const selected = plan.records.find(row => row.contactId === priya.contactId);
  assert.equal(selected.nativeId, owned.records.priya.nativeId);
  assert.equal(selected.matchDecision.email, owned.records.priya.email);
  assert.deepEqual(selected.changes, [{ field: 'jobTitle', before: before.find(row => row.id === selected.nativeId).jobTitle, after: priya.jobTitle }]);
  const written = await app('crm-writeback', { ...request, action: 'execute', plan }, 202);
  save('receipt', written);
  assert.equal(written.updated, 1); assert.equal(written.held, 1); assert.equal(written.created + written.failed, 0);
  const after = await readFixture(); save('after', after);
  assert.deepEqual(after, before.map(row => row.id === selected.nativeId ? { ...row, jobTitle: priya.jobTitle } : row));
  const savedRun = { receipt: {
    id: written.runId, connectorId: provider, phase: 'receipt', status: written.status,
    summary: 'Fictional confirmed-match update; unresolved coworker held.',
    recordsRead: written.requested, recordsWritten: written.created + written.updated,
    recordsFailed: written.failed, createdAt: written.completedAt,
    undoAvailable: Boolean(written.rollback?.records.length), nativeReceiptId: written.runId,
  }, details: { sourceLabel: plan.sourceFile, plan, writeback: written }, undo: written.rollback };
  await app('runs', { workspaceId: workspace.id, run: savedRun }, 201);
  const verifyRequest = { workspaceId: workspace.id, runId: written.runId };
  const { verification } = await app('runs/verify', verifyRequest);
  save('verification', verification);
  assert.equal(verification.verified, 1);
  assert.equal(verification.different + verification.unavailable, 0);
  assert.equal(verification.records.length, 1, 'Held Jordan must not be reported verified.');
  assert.equal(verification.records[0].expected.email, owned.records.priya.email);
  assert.equal(verification.records[0].actual.email, owned.records.priya.email);
  const { verification: rechecked } = await app('runs/verify', verifyRequest);
  assert.equal(rechecked.verified, 1);
  assert.deepEqual(await readFixture(), after, 'Read-only recheck must leave all retained values unchanged.');
  const { runs } = await app('runs?workspaceId=' + encodeURIComponent(workspace.id));
  const saved = runs.find(run => run.id === written.runId);
  assert.deepEqual(saved.details.verification, rechecked);
  assert.deepEqual(saved.details.writeback, written);
  assert.deepEqual(saved.receipt, savedRun.receipt);
  save('saved-run', saved);
  // Reusing the earlier preview after the target changed must not write again.
  await app('crm-writeback', { ...request, action: 'execute', plan }, 409);
  const undone = await app('crm-writeback', { action: 'rollback', connectorId: provider, rollback: written.rollback }, 202);
  save('rollback', undone);
  assert.equal(undone.updated, 1); assert.equal(undone.failed + undone.held + undone.created, 0);
  await app('runs', { workspaceId: workspace.id, run: { receipt: {
    id: undone.runId, connectorId: provider, phase: 'undo', status: undone.status,
    summary: 'Restored the fictional title update; no created records or deletions.',
    recordsWritten: undone.updated, recordsFailed: undone.failed, createdAt: undone.completedAt,
    undoAvailable: false, nativeReceiptId: undone.runId,
  }, details: { writeback: undone } } }, 201);
  const restored = await readFixture(); save('restored', restored); assert.deepEqual(restored, before);
  // Deliberately restored values now differ from this original update's expected result.
  // A verification difference is an observation, not a failed write or a retry request.
  const { verification: afterRollback } = await app('runs/verify', verifyRequest);
  save('verification-after-rollback', afterRollback);
  assert.equal(afterRollback.different, 1);
  assert.equal(afterRollback.verified + afterRollback.unavailable, 0);
  assert.deepEqual(afterRollback.records[0].differences, [{ field: 'jobTitle', expected: priya.jobTitle, actual: selected.before.jobTitle }]);
  const { runs: finalRuns } = await app('runs?workspaceId=' + encodeURIComponent(workspace.id));
  assert.deepEqual(finalRuns.find(run => run.id === written.runId).details.writeback, written);
  assert.deepEqual(await readFixture(), before, 'Checking the restored value must not repeat the update.');
  Object.assign(evidence, { finishedAt: new Date().toISOString(), retainedRecords: before.length, confirmedUpdates: 1, unresolvedHeld: 1,
    creates: 0, deletes: 0, primaryEmailPreserved: true, decisionReloaded: true, staleExecutionBlocked: true, rollbackRestored: 1, comparedFieldsRestored: true,
    verifiedUpdatedRecords: verification.verified, verificationReloaded: true, readOnlyRecheck: true, differenceAfterRollback: afterRollback.different,
    originalWriteReceiptUnchanged: true });
  save('result', evidence);
  console.log(JSON.stringify(evidence));
} catch (error) {
  save('failure', { ...evidence, failedAt: new Date().toISOString(), error: error.message });
  throw new Error(`Native confirmation check stopped: ${error.message}. Reconcile private evidence before retrying.`);
}
