import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Explicit, fixture-only native qualification. No creates, deletes, seeding,
// marketing changes, model configuration, or automatic mutation retries.
const reconcileIndex = process.argv.indexOf('--reconcile-cleanup');
const reconcilePath = reconcileIndex >= 0 ? process.argv[reconcileIndex + 1] : null;
if (!process.argv.includes('--run') && !reconcilePath) {
  console.log(JSON.stringify({ writes: false, usage: 'Provide HUBSPOT_ACCESS_TOKEN and run with --run; --reconcile-cleanup <private run directory> reads only. Outputs remain private under outputs/safe-import-native-2026-10-06.' }));
  process.exit(0);
}
const token = process.env.HUBSPOT_ACCESS_TOKEN;
assert(token, 'A designated development HubSpot token is required.');
for (const key of Object.keys(process.env)) if (/ANTHROPIC|OPENAI|LLM|MODEL/i.test(key)) delete process.env[key];
const root = resolve(import.meta.dirname, '..');
const outputRoot = resolve(root, 'outputs/safe-import-native-2026-10-06');
const output = reconcilePath ? resolve(reconcilePath) : resolve(outputRoot, new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8));
assert(output.startsWith(outputRoot + '/'), 'Use the private qualification output directory.');
mkdirSync(output, { recursive: true, mode: 0o700 });
chmodSync(output, 0o700);
process.env.CONTROL_TOWER_SQLITE_PATH = resolve(output, 'qualification.db');
process.env.CONTROL_TOWER_PERSISTENCE_ENABLED = 'true';
process.env.CONTROL_TOWER_SYNC_KEY = randomUUID();
const save = (name, value) => writeFileSync(resolve(output, name + '.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
function printSummary(summary) {
  console.log(JSON.stringify({ ...summary, cleanup: summary.cleanup?.map((row) => ({ ...row,
    error: row.error ? 'Inspect the private cleanup evidence.' : undefined })),
    failure: summary.failure ? { stage: summary.failure.stage, message: 'Inspect the private failure evidence.' } : null }));
}
const startedAt = new Date().toISOString();
const nativeFields = { firstname: 'firstName', lastname: 'lastName', company: 'company', phone: 'phone', jobtitle: 'jobTitle', website: 'website' };
const protectedProperties = ['email', 'hs_additional_emails', ...Object.keys(nativeFields), 'message', 'hubspot_owner_id', 'lifecyclestage', 'hs_email_optout', 'hs_marketable_status', 'hs_marketable_until_renewal', 'hs_object_id', 'state', 'city'];
const accountId = '246915016';
const ids = { sales: '543534314230', success: '543536010991', elena: '559649675987', marcus: '559660052212',
  tess: '559619939021', priya: '559676075762', denise: '559622195913', omar: '559612102346',
  jordanNetworks: '559593159364', jordanMarketing: '559379987189' };
const fillValues = { [ids.sales]: '+18145550188', [ids.success]: '+18145550189' };
const rawFetch = globalThis.fetch;
const approvals = new Map();
const writes = [];
const baselines = new Map();
const results = {};
let stage = 'build';
let mainFailure = null;
let modules;

async function nativeRead(path) {
  const response = await rawFetch('https://api.hubapi.com' + path, {
    cache: 'no-store', redirect: 'manual', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok && response.status !== 207, `Native read returned ${response.status}.`);
  return response.json();
}
async function verifyAccount() {
  const account = await nativeRead('/account-info/v3/details');
  assert.equal(String(account.portalId), accountId, 'Unexpected HubSpot account; no mutation is allowed.');
  assert.equal(account.accountType, 'STANDARD');
  return account;
}
async function record(id) {
  const row = await nativeRead(`/crm/objects/2026-03/contacts/${id}?properties=${protectedProperties.join(',')}`);
  assert.equal(row.id, id); assert.equal(row.archived, false);
  return { id: row.id, properties: Object.fromEntries(protectedProperties.map((name) => [name, row.properties[name] ?? null])) };
}
const clean = (value) => value?.trim() || null;
// HubSpot can expose an absent phone as null, then an explicit clear as ''.
// Normalize only that changed field; every other protected property stays exact.
function comparablePhone(row, baseline) {
  return clean(row.properties.phone) === null && clean(baseline.properties.phone) === null
    ? { ...row, properties: { ...row.properties, phone: baseline.properties.phone } } : row;
}
const portable = (row) => Object.fromEntries(Object.entries(nativeFields).map(([name, field]) => [field, clean(row.properties[name])]));
function assertOwned(row, kind) {
  assert(row.properties.email?.endsWith('.example.com') || row.properties.email?.endsWith('@example.com'), 'Fixtures require reserved email domains.');
  if (kind === 'duplicate') {
    assert.equal(row.properties.company, 'GTMCT Fixture · Northstar Labs');
    assert(row.properties.jobtitle?.startsWith('[Synthetic duplicate audit]'));
  } else assert(row.properties.message?.includes('Case: enterprise-import-2026-09-27.'), 'The enterprise ownership marker is missing.');
}
async function nativeIds() {
  const result = [];
  let after = '';
  do {
    const page = await nativeRead('/crm/objects/2026-03/contacts?limit=100&properties=hs_object_id' + (after ? '&after=' + encodeURIComponent(after) : ''));
    assert(Array.isArray(page.results)); result.push(...page.results.map((row) => row.id));
    after = page.paging?.next?.after || '';
  } while (after);
  return result.sort();
}
async function fixtureGuard(id, properties) {
  const approval = approvals.get(id);
  assert(approval, 'No independently reviewed fixture mutation was authorized.');
  assert.deepEqual(Object.keys(properties), ['phone'], 'Only the reviewed phone field may be written.');
  assert.equal(properties.phone, approval.phone);
  await verifyAccount();
  const current = await record(id);
  assertOwned(current, 'duplicate');
  assert.deepEqual(current, approval.before, 'Native state changed after this fixture mutation was reviewed.');
}
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://api.hubapi.com', 'The qualification permits only the actual HubSpot API.');
  const method = init?.method || 'GET';
  if (method === 'PATCH') {
    const id = url.pathname.split('/').at(-1);
    assert.equal(url.pathname, `/crm/objects/2026-03/contacts/${id}`);
    const body = JSON.parse(String(init.body));
    await fixtureGuard(id, body.properties);
    writes.push({ id, method, properties: body.properties, kind: approvals.get(id).kind, sentAt: new Date().toISOString() });
    save('native-mutation-requests', writes);
  } else if (method === 'POST' && url.pathname.endsWith('/batch/update')) {
    const body = JSON.parse(String(init.body));
    assert.equal(body.inputs.length, 1, 'Restoration must address one reviewed fixture.');
    const row = body.inputs[0]; await fixtureGuard(String(row.id), row.properties);
    writes.push({ id: String(row.id), method, properties: row.properties, kind: approvals.get(String(row.id)).kind, sentAt: new Date().toISOString() });
    save('native-mutation-requests', writes);
  } else if (method !== 'GET') {
    assert(method === 'POST' && (url.pathname.endsWith('/batch/read') || url.pathname.endsWith('/search')), 'Creates, deletes and unsupported mutations are forbidden.');
  }
  return rawFetch(input, init);
};

function request(payload) {
  return new Request('http://qualification.local/api/control-tower', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-control-tower-key': process.env.CONTROL_TOWER_SYNC_KEY }, body: JSON.stringify(payload) });
}
async function call(handler, payload, status = 200) {
  const response = await handler(request(payload));
  const body = await response.json();
  assert.equal(response.status, status, `${stage}: ${body.error || 'Unexpected response status'}`);
  return body;
}
const csvCell = (value) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
function csv(rows) {
  const keys = ['contactId', 'firstName', 'lastName', 'email', 'company', 'phone', 'jobTitle', 'website', 'state', 'region', 'segment', 'ownerId'];
  const headers = ['contact_id', 'first_name', 'last_name', 'email', 'company', 'phone', 'job_title', 'website', 'state', 'region', 'segment', 'owner_id'];
  return headers.join(',') + '\n' + rows.map((row) => keys.map((key) => csvCell(row[key])).join(',')).join('\n') + '\n';
}
function incoming(key, index, overrides = {}) {
  const native = baselines.get(ids[key]);
  return { contactId: `NATIVE-${index}`, ...portable(native), email: native.properties.email,
    state: native.properties.state || '', region: 'East', segment: 'SMB', ownerId: 'fictional_qualification_operator', ...overrides };
}
function absent(index) {
  return { contactId: `NATIVE-${index}`, firstName: `Unmatched${index}`, lastName: `Fixture${index}`,
    email: `absent-${index}@safe-import-${randomUUID().slice(0, 8)}.example.com`, company: `Distinct Synthetic Organization ${index}`,
    phone: '', jobTitle: 'Fictional attendee', website: '', state: '', region: 'East', segment: 'SMB', ownerId: 'fictional_qualification_operator' };
}
async function workspace(name, rows, extra = {}) {
  const source = csv(rows);
  const imported = modules.importContactsCsv(source).contacts;
  if (extra.skipIndex !== undefined) imported[extra.skipIndex].importExclusion = { reason: 'Fictional operator skips this attendee', excludedAt: new Date().toISOString() };
  const created = await modules.createWorkspace(name);
  const saved = await modules.saveWorkspace(created.id, { ...modules.emptyWorkspaceState(), contacts: imported, originalContacts: imported,
    fileName: name + '.csv', sourceFileHash: createHash('sha256').update(source).digest('hex'), sourceType: 'csv', destinationType: 'hubspot',
    importRecipe: 'safe-update-contacts', importRecordMode: 'update-existing', ...extra.state }, 'native_qualification_import');
  writeFileSync(resolve(output, name + '.csv'), source, { mode: 0o600 });
  return saved;
}
async function scanWorkspace(saved) {
  let { scan } = await call(modules.scanPOST, { action: 'start', workspaceId: saved.id, connectorId: 'hubspot' }, 201);
  while (!scan.complete) ({ scan } = await call(modules.scanPOST, { action: 'step', workspaceId: saved.id, connectorId: 'hubspot', scanId: scan.id }));
  assert(scan.sourceComplete && scan.complete);
  return scan;
}
async function prepare(saved) {
  return (await call(modules.safePOST, { action: 'prepare', workspaceId: saved.id })).review;
}
async function approveFill(id, phone, kind) {
  const current = await record(id); assert.deepEqual(current, baselines.get(id)); assert.equal(clean(current.properties.phone), null);
  approvals.set(id, { phone, before: current, kind });
}
async function restore(id) {
  const baseline = baselines.get(id);
  if (!baseline) return { sent: false, restored: false, reason: 'No baseline was recorded.' };
  const current = await record(id);
  if (JSON.stringify(comparablePhone(current, baseline)) === JSON.stringify(baseline)) return { sent: false, restored: true };
  assertOwned(current, 'duplicate');
  assert.equal(current.properties.phone, fillValues[id], 'Restoration held: the phone does not equal our reviewed fill.');
  assert.deepEqual({ ...current, properties: { ...current.properties, phone: baseline.properties.phone } }, baseline,
    'Restoration held: another protected field changed; do not overwrite subsequent work.');
  const row = { contactId: `RESTORE-${id}`, ...portable(baseline), email: baseline.properties.email,
    state: baseline.properties.state || '', region: 'East', segment: 'SMB', ownerId: 'fictional_qualification_operator' };
  const policy = { mode: 'replace', fields: ['phone'], clearBlanks: true };
  const saved = await workspace(`restore-${id}`, [row], { state: { importRecipe: undefined, crmUpdatePolicy: policy } });
  const contacts = saved.state.contacts.map(modules.toHubSpotSyncContact);
  const base = { workspaceId: saved.id, connectorId: 'hubspot', sourceFile: saved.state.fileName, contacts, updatePolicy: policy };
  const plan = await call(modules.crmPOST, { ...base, action: 'preview' });
  assert.equal(plan.creates, 0); assert.equal(plan.updates, 1);
  assert.deepEqual(plan.records[0].changes, [{ field: 'phone', before: fillValues[id], after: null }]);
  save(`restoration-${id}-review`, { operation: 'Separately reviewed selected-phone restoration', reviewAt: new Date().toISOString(), plan });
  approvals.set(id, { phone: '', before: current, kind: 'independently-reviewed-restoration' });
  let receipt = null;
  try { receipt = await call(modules.crmPOST, { ...base, action: 'execute', plan }, 202); }
  finally { save(`restoration-${id}-receipt`, receipt); }
  const restored = await record(id); save(`restoration-${id}-readback`, restored);
  assert.deepEqual(comparablePhone(restored, baseline), baseline, 'Restoration did not reproduce the complete protected baseline.');
  return { sent: true, restored: true, accepted: receipt.updated === 1 };
}

if (reconcilePath) {
  // This entry point never calls a writer, creates a workspace, or changes the
  // original failure/result artifacts. It records a separate fresh observation.
  const baseline = JSON.parse(readFileSync(resolve(output, 'baseline.json'), 'utf8'));
  const original = JSON.parse(readFileSync(resolve(output, 'result.json'), 'utf8'));
  await verifyAccount();
  const observed = [];
  for (const before of baseline.records) {
    const current = await record(before.id);
    assertOwned(current, [ids.sales, ids.success].includes(before.id) ? 'duplicate' : 'enterprise');
    assert.deepEqual(comparablePhone(current, before), before, 'Read-only cleanup reconciliation found a protected-value difference.');
    observed.push({ nativeId: before.id, primaryEmailAndOtherProtectedPropertiesExact: true,
      baselinePhone: before.properties.phone, observedPhone: current.properties.phone, portablePhoneRestored: true });
  }
  assert.deepEqual(await nativeIds(), JSON.parse(readFileSync(resolve(output, 'active-ids-before.json'), 'utf8')));
  const reconciliation = { checkedAt: new Date().toISOString(), crmWrites: 0, contactsCreatedOrDeleted: 0,
    records: observed, phoneComparison: 'Existing portable clean semantics: null and empty string are both blank. Other properties compare exactly.' };
  save('cleanup-reconciliation', reconciliation);
  assert.equal(original.failure, null, 'Cleanup reconciliation cannot certify a run whose native feature checks failed.');
  const qualified = { ...original, result: 'native-feature-checks-passed-cleanup-semantically-verified',
    originalRawCleanupResult: original.result, cleanupReconciledReadOnly: true,
    cleanupRepresentation: 'Both changed phones were null before and empty string after the accepted explicit clear. Both are empty.',
    everyOtherProtectedPropertyExact: true, readOnlyReconciliationWrites: 0, reconciliationCheckedAt: reconciliation.checkedAt };
  save('qualified-result', qualified);
  globalThis.fetch = rawFetch;
  printSummary({ ...qualified, evidence: output });
  process.exit(0);
}

try {
  const entry = resolve(output, 'production-entry.mjs');
  await build({ stdin: { contents: `
    export { POST as safePOST } from './app/api/control-tower/safe-import/route';
    export { POST as crmPOST } from './app/api/control-tower/crm-writeback/route';
    export { POST as scanPOST } from './app/api/control-tower/duplicate-scan/route';
    export { POST as confirmPOST } from './app/api/control-tower/import-match-decision/route';
    export * from './lib/workspace-store'; export * from './lib/workspace'; export * from './lib/safe-import-store';
    export * from './lib/safe-import-execution'; export * from './lib/import-match-decision';
    export { importContactsCsv } from './lib/csv-control-tower'; export { toHubSpotSyncContact } from './lib/hubspot-sync';
  `, resolveDir: root, sourcefile: 'native-qualification-entry.ts', loader: 'ts' },
    outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
    alias: { 'next/server': 'next/server.js' }, tsconfig: resolve(root, 'tsconfig.json') });
  chmodSync(entry, 0o600);
  modules = await import(pathToFileURL(entry).href);
  stage = 'native-baseline';
  const account = await verifyAccount();
  for (const [key, id] of Object.entries(ids)) {
    const baseline = await record(id); assertOwned(baseline, ['sales', 'success'].includes(key) ? 'duplicate' : 'enterprise'); baselines.set(id, baseline);
  }
  assert.equal(clean(baselines.get(ids.sales).properties.phone), null); assert.equal(clean(baselines.get(ids.success).properties.phone), null);
  save('baseline', { startedAt, account: { portalId: account.portalId, accountType: account.accountType }, records: [...baselines.values()] });
  const beforeIds = await nativeIds(); save('active-ids-before', beforeIds);
  stage = 'whole-file-workspace';
  const rows = [incoming('sales', 1, { phone: fillValues[ids.sales], jobTitle: 'Event Operations Director', website: '' }),
    incoming('elena', 2), incoming('marcus', 3, { jobTitle: 'Different imported title', phone: '+14085550190' }),
    incoming('tess', 4, { website: '' }), incoming('priya', 5, { email: 'priya.nativequalification@salesforce.example.com' }),
    incoming('jordanNetworks', 6, { email: 'jordan.nativequalification@cisco.example.com', phone: '', jobTitle: '' }),
    incoming('denise', 7), incoming('omar', 8, { firstName: 'Zelda', lastName: 'Unrelated', company: 'Different Fictional Company', phone: '+12125550191' }), absent(9),
    ...Array.from({ length: 92 }, (_, index) => absent(index + 10)),
    incoming('denise', 102, { email: 'denise.nativequalification@servicenow.example.com' }), ...Array.from({ length: 4 }, (_, index) => absent(index + 103))];
  assert.equal(rows.length, 106);
  let saved = await workspace('whole-import-106', rows, { skipIndex: 8 });
  const scan = await scanWorkspace(saved);
  const denise = saved.state.contacts.find((row) => row.contactId === 'NATIVE-102');
  ({ workspace: saved } = await call(modules.confirmPOST, { action: 'confirm', workspaceId: saved.id, revision: saved.revision,
    connectorId: 'hubspot', contactId: denise.contactId, sourceKey: modules.importMatchSourceKey(denise), scanId: scan.id,
    nativeId: ids.denise, objectType: 'contact', fields: ['name', 'email', 'phone', 'state', 'company'],
    reason: 'Fictional fixture comparison confirms Denise by name, direct phone and company. The deliberately competing exact row must still hold both rows.' }));
  stage = 'whole-file-review';
  const staleReview = await prepare(saved); const review = await prepare(saved);
  save('whole-review', review); save('stale-review', staleReview);
  assert(review.complete); assert.equal(review.rows.length, 106); assert.equal(writes.length, 0);
  assert.deepEqual(review.plans.map((plan) => plan.requested), [100, 5]);
  assert.equal(review.counts['proposed-update'], 1);
  const proposal = review.rows.find((row) => row.contactId === 'NATIVE-1').record;
  assert.deepEqual(proposal.changes, [{ field: 'phone', before: null, after: fillValues[ids.sales] }]);
  assert(review.rows.filter((row) => ['NATIVE-7', 'NATIVE-102'].includes(row.contactId)).every((row) => row.status === 'held'));
  assert(review.rows.filter((row) => ['NATIVE-5', 'NATIVE-6', 'NATIVE-8'].includes(row.contactId)).every((row) => row.status === 'held'));
  assert.equal(review.rows.find((row) => row.contactId === 'NATIVE-9').status, 'skipped');
  assert(review.plans.every((plan) => plan.creates === 0));
  results.wholeReview = { rows: review.rows.length, batches: review.plans.map((plan) => plan.requested), counts: review.counts, prepareWrites: 0,
    humanConfirmationSaved: true, competingTargetsHeldAcrossBatches: true };
  stage = 'account-expiration-negative';
  const mismatched = { ...review, id: randomUUID(), account: { connectorId: 'hubspot', accountId: '999999999' } };
  await modules.saveSafeImportReview(mismatched);
  await call(modules.safePOST, { action: 'approve', workspaceId: saved.id, reviewId: mismatched.id }, 409);
  const expired = { ...review, id: randomUUID(), expiresAt: new Date(Date.now() - 60_000).toISOString() };
  await modules.saveSafeImportReview(expired);
  await call(modules.safePOST, { action: 'approve', workspaceId: saved.id, reviewId: expired.id }, 409);
  assert.equal(writes.length, 0);
  results.accountMismatch = 'Actual account read plus injected saved-review account mismatch; no second-portal credential switch';
  results.expiredPlanRejected = true;
  stage = 'native-whole-file-approval';
  await approveFill(ids.sales, fillValues[ids.sales], 'safe-import-approved-fill');
  const { execution } = await call(modules.safePOST, { action: 'approve', workspaceId: saved.id, reviewId: review.id }, 202);
  save('whole-execution', execution);
  assert.equal(execution.records.length, 1); assert.equal(execution.records[0].status, 'accepted'); assert.equal(execution.records[0].verification.status, 'verified');
  assert.equal(writes.length, 1);
  const repeated = await call(modules.safePOST, { action: 'approve', workspaceId: saved.id, reviewId: review.id }, 202);
  assert.equal(repeated.execution.id, execution.id); assert.equal(writes.length, 1);
  const stale = await call(modules.safePOST, { action: 'approve', workspaceId: saved.id, reviewId: staleReview.id }, 409);
  save('stale-native-values-rejected', stale); assert.equal(writes.length, 1);
  for (const [key, id] of Object.entries(ids)) {
    const current = await record(id);
    const expected = id === ids.sales ? { ...baselines.get(id), properties: { ...baselines.get(id).properties, phone: fillValues[id] } } : baselines.get(id);
    assert.deepEqual(current, expected, `Only the reviewed sales phone may change; protected ${key} values must survive.`);
  }
  assert.deepEqual(await nativeIds(), beforeIds); results.accepted = 1; results.verified = 1; results.repeatedApprovalSameExecution = true;
  results.staleNativeBaselineRejected = true; results.protectedFieldsPreserved = true; results.noContactsCreatedOrDeleted = true;
  stage = 'interrupted-response-workspace';
  const recoveryWorkspace = await workspace('lost-response-one-fill', [incoming('success', 1, { phone: fillValues[ids.success], jobTitle: 'Different incoming title', website: '' })]);
  const recoveryReview = await prepare(recoveryWorkspace); save('recovery-review', recoveryReview);
  assert.equal(recoveryReview.counts['proposed-update'], 1);
  await approveFill(ids.success, fillValues[ids.success], 'real-native-fill-injected-lost-response');
  let lossInjected = false;
  const lost = await modules.executeSafeImportReview(recoveryReview, { writeRecord: async (planned) => {
    const outcome = await modules.writeHubSpotSafeImportRecord(planned, token);
    if (outcome.status === 'accepted') { lossInjected = true; throw new Error('Deliberately injected transport loss after the real HubSpot response.'); }
    return outcome;
  } });
  save('recovery-interrupted-execution', lost);
  assert(lossInjected, 'The intended lost-response drill requires an actual accepted native response.');
  assert.equal(lost.records[0].status, 'unknown'); assert.equal(lost.records[0].verification.status, 'verified');
  assert.equal(writes.length, 2);
  const fresh = await import(pathToFileURL(entry).href + '?fresh=' + randomUUID());
  const loaded = await call(fresh.safePOST, { action: 'load', workspaceId: recoveryWorkspace.id });
  assert.equal(loaded.execution.id, lost.id);
  const recovered = await call(fresh.safePOST, { action: 'recover', workspaceId: recoveryWorkspace.id, reviewId: recoveryReview.id });
  assert.equal(recovered.execution.records[0].status, 'unknown'); assert.equal(recovered.execution.records[0].verification.status, 'verified');
  await call(fresh.safePOST, { action: 'approve', workspaceId: recoveryWorkspace.id, reviewId: recoveryReview.id }, 202);
  assert.equal(writes.length, 2); save('recovery-readonly-fresh-runtime', recovered);
  results.recovery = { actualNativeWrites: 1, injectedLostResponse: true, acceptanceRemainsUnknown: true, approvedValuesObserved: true, freshRuntimeLoad: true, resendRequests: 0 };
} catch (error) {
  mainFailure = { stage, message: error.message }; save('failure', mainFailure);
} finally {
  const cleanup = [];
  for (const id of [ids.sales, ids.success]) {
    try { cleanup.push({ id, ...await restore(id) }); }
    catch (error) { cleanup.push({ id, restored: false, held: true, error: error.message }); }
  }
  save('cleanup', cleanup); save('native-mutation-requests', writes);
  const summary = { startedAt, finishedAt: new Date().toISOString(), result: mainFailure ? 'failed' : cleanup.every((row) => row.restored) ? 'passed' : 'cleanup-held',
    nativeWrites: writes.filter((row) => row.kind !== 'independently-reviewed-restoration').length,
    restorationWrites: writes.filter((row) => row.kind === 'independently-reviewed-restoration').length,
    creates: 0, deletes: 0, aiConfigured: false, ...results, cleanup: cleanup.map((row) => ({ sent: row.sent, restored: row.restored,
      accepted: row.accepted, held: row.held, reason: row.reason, error: row.error })), failure: mainFailure,
    limitations: ['Account mismatch injects saved-review identity; no second actual portal credential was used.', 'Lost response is injected after an actual accepted native write.', 'Native reread and write remain separate non-atomic operations.', 'This run uses isolated SQLite, not hosted D1.'] };
  save('result', summary);
  globalThis.fetch = rawFetch;
  printSummary({ ...summary, evidence: output });
  if (summary.result !== 'passed') process.exitCode = 1;
}
