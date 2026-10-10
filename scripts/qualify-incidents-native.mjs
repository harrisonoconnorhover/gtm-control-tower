import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateMessyCrm } from '../fixtures/messy-crm.mjs';

// Explicit test-account writes. Never runs from CI, startup, or the ordinary monitor runner.
const args = process.argv.slice(2);
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
if (!args.includes('--run')) {
  console.log('Native test-account qualification: --run --provider hubspot|salesforce --account ACCOUNT_ID --run-id RUN_ID [--phase seed|formatting|monitor|import|all] [--cached-cli]. HubSpot requires HUBSPOT_DEVELOPMENT_ACCOUNT_ID matching --account. Outputs and credentials stay private.');
  process.exit(0);
}
const provider = value('--provider'), accountId = value('--account'), runId = value('--run-id');
const phase = value('--phase', 'all');
assert(['hubspot', 'salesforce'].includes(provider) && accountId && /^[a-z0-9-]{6,50}$/.test(runId ?? ''), 'Specify provider, pinned test account and stable run ID.');
assert(['seed', 'formatting', 'monitor', 'import', 'all'].includes(phase), 'Unsupported phase.');
const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'outputs/native-incidents', runId, provider);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const save = (name, data) => writeFileSync(resolve(directory, name + '.json'), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
const progress = (data) => console.log(JSON.stringify({ provider, ...data }));
for (const name of ['OPENAI_API_KEY', 'CONTROL_TOWER_INVESTIGATION_MODEL', 'CONTROL_TOWER_SLACK_WEBHOOK_URL']) delete process.env[name];
process.env.CONTROL_TOWER_PERSISTENCE_ENABLED = 'true';
process.env.CONTROL_TOWER_SYNC_KEY = randomUUID();
if (provider === 'salesforce' && args.includes('--cached-cli')) {
  const cli = (command) => {
    try {
      const result = JSON.parse(execFileSync('sf', [...command, '--target-org', 'gtm-control-tower-salesforce', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      assert.equal(result.status, 0); return result.result;
    } catch { throw new Error('Could not read the authorized Salesforce CLI session. Credentials were not printed.'); }
  };
  // Token-display commands can return cached data after refresh errors. A real
  // read proves the existing CLI authorization is usable before starting writes.
  const fresh = cli(['data', 'query', '--query', 'SELECT Id FROM Organization LIMIT 1']);
  assert.equal(fresh.records?.[0]?.Id, accountId, 'Refreshed CLI authorization belongs to another org.');
  const org = cli(['org', 'display']);
  assert.equal(new URL(org.instanceUrl).origin, new URL(process.env.SALESFORCE_INSTANCE_URL).origin, 'CLI account differs from the configured instance.');
  assert.equal(org.id, accountId, 'CLI org differs from the pinned test account.');
  process.env.SALESFORCE_ACCESS_TOKEN = cli(['org', 'auth', 'show-access-token']).accessToken;
  process.env.SALESFORCE_API_VERSION = org.apiVersion;
}
if (provider === 'hubspot') assert.equal(process.env.HUBSPOT_DEVELOPMENT_ACCOUNT_ID, accountId, 'Explicitly pin the designated HubSpot development portal.');
const token = process.env[provider === 'hubspot' ? 'HUBSPOT_ACCESS_TOKEN' : 'SALESFORCE_ACCESS_TOKEN'];
const instanceUrl = process.env.SALESFORCE_INSTANCE_URL, apiVersion = process.env.SALESFORCE_API_VERSION ?? '67.0';
assert(token, 'A configured native test-account connection is required.');
// Forced test ticks run much faster than the deployed schedule. Pace every
// native adapter call without replacing responses or retrying CRM mutations.
const nativeFetch = globalThis.fetch;
const expectedOrigin = provider === 'hubspot' ? 'https://api.hubapi.com' : new URL(instanceUrl).origin;
let nextRequestAt = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, expectedOrigin, 'Native qualification rejected an unrelated destination.');
  const startAt = Math.max(Date.now(), nextRequestAt); nextRequestAt = startAt + (provider === 'hubspot' ? 225 : 50);
  if (startAt > Date.now()) await new Promise((done) => setTimeout(done, startAt - Date.now()));
  return nativeFetch(input, init);
};
const { createNativeFixtureClient, seedNativeWorld, loadNativeFixtureManifest } = await import('./native-messy-fixtures.mjs');
const client = createNativeFixtureClient({ provider, accountId, token, instanceUrl, apiVersion });
const identity = await client.verifyIdentity(); save('identity', identity);
const manifestPath = resolve(directory, 'manifest.json');
const world = generateMessyCrm(provider, 42);
save('original-world', world);
let manifest;
if (['seed', 'all'].includes(phase)) {
  const result = await seedNativeWorld({ world, client, manifestPath, runId, onProgress: progress });
  manifest = result.manifest;
} else {
  assert(existsSync(manifestPath), 'Seed this run before qualifying it.');
  manifest = loadNativeFixtureManifest(manifestPath);
}
assert.equal(manifest.accountId, accountId, 'Manifest account mismatch.');
const records = Object.values(manifest.records).filter((record) => record.nativeId);
const byNative = new Map(records.map((record) => [`${record.objectType}:${record.nativeId}`, record]));
const nativeRead = async (record) => {
  assert(byNative.has(`${record.objectType}:${record.nativeId}`), 'Native read is outside this run.');
  const row = await client.read(record.objectType, record.nativeId);
  const properties = Object.fromEntries(Object.entries(row.properties ?? row).filter(([name]) => !['attributes', 'Id', 'SystemModstamp', 'LastModifiedDate', 'lastmodifieddate', 'hs_lastmodifieddate'].includes(name)));
  if (record.objectType === 'Contact') {
    const required = provider === 'hubspot' ? ['email', 'firstname', 'lastname', 'phone', 'jobtitle', 'company', 'hubspot_owner_id']
      : ['Email', 'FirstName', 'LastName', 'Phone', 'Title', 'AccountId', 'OwnerId'];
    for (const field of required) if (!(field in properties)) properties[field] = null;
  }
  return { id: String(row.id ?? row.Id), properties };
};
const verifyOwnership = async (record, current) => {
  assert(byNative.has(`${record.objectType}:${record.nativeId}`), 'Record is outside this manifest.');
  const row = current ?? await nativeRead(record);
  const marker = row.properties[provider === 'salesforce' ? 'Description' : record.objectType === 'Contact' ? 'message' : 'description'];
  assert(typeof marker === 'string' && marker.includes(manifest.marker), 'Native fixture ownership marker is missing.');
  return row;
};
const results = { provider, accountId, runId, baselineRecords: records.length, startedAt: new Date().toISOString() };
if (['formatting', 'all'].includes(phase)) {
  assert(manifest.seedCompletedAt, 'Complete native seeding before supplemental formatting probes.');
  const probePath = resolve(directory, 'formatting-probes.json');
  const probes = existsSync(probePath) ? JSON.parse(readFileSync(probePath, 'utf8')) : [];
  assert(!probes.some((probe) => probe.status === 'sending'), 'Reconcile pending formatting probes before continuing; do not resend them.');
  const field = provider === 'hubspot' ? 'jobtitle' : 'Title';
  for (const [index, space] of ['\u00a0', '\u2009', '\ufeff'].entries()) {
    const fixtureId = world.contacts[74 + index].id;
    if (probes.some((probe) => probe.fixtureId === fixtureId)) continue;
    const record = records.find((row) => row.objectType === 'Contact' && row.fixtureId === fixtureId);
    assert(record, 'A formatting probe Contact is missing.');
    const before = await verifyOwnership(record);
    const original = before.properties[field];
    assert(typeof original === 'string' && original.trim() && original === original.trim());
    const probe = { fixtureId, nativeId: record.nativeId, field, before: original, proposed: space + original + space, status: 'sending', sentAt: new Date().toISOString() };
    probes.push(probe); save('formatting-probes', probes);
    await client.patchOwned('Contact', record.nativeId, { [field]: probe.proposed }, manifest.marker);
    const after = await verifyOwnership(record);
    probe.nativeValue = after.properties[field]; probe.status = 'readback';
    probe.normalizedByProvider = probe.nativeValue === original;
    assert(probe.nativeValue === original || probe.nativeValue === probe.proposed, 'Unexpected formatting readback; inspect the saved probe.');
    save('formatting-probes', probes);
  }
  results.formatting = { supplemental: true, probes: probes.length, retainedWhitespace: probes.filter((probe) => !probe.normalizedByProvider).length };
}
if (['monitor', 'all'].includes(phase)) {
  assert(manifest.seedCompletedAt, 'Complete native seeding before monitor qualification.');
  const outputDirectory = resolve(directory, 'monitor-' + Date.now()); mkdirSync(outputDirectory, { mode: 0o700 });
  process.env.CONTROL_TOWER_SQLITE_PATH = resolve(outputDirectory, 'qualification.db');
  const { runNativeMonitor } = await import('./native-incident-monitor.mjs');
  results.monitor = await runNativeMonitor({ root, provider, accountId, token, instanceUrl, apiVersion, outputDirectory, records, verifyOwnership, onProgress: progress,
    applyTemporalChanges: async (changes) => {
      const evidence = { applied: [], rejected: [], pending: [], completedAt: null };
      const evidenceName = 'temporal-' + Date.now();
      for (const change of changes) {
        const property = provider === 'hubspot' ? change.field : ({ jobtitle: 'Title', domain: 'Website', amount: 'Amount' })[change.field];
        const before = await verifyOwnership(change);
        assert.equal(String(before.properties[property] ?? ''), change.before, 'Fixture changed before temporal test mutation.');
        const desired = provider === 'salesforce' && change.after === '' ? null : change.after;
        evidence.pending.push({ ...change, property }); save(evidenceName, evidence);
        await client.patchOwned(change.objectType, change.nativeId, { [property]: desired }, manifest.marker);
        const after = await verifyOwnership(change);
        assert.equal(String(after.properties[property] ?? ''), change.after, 'Native temporal mutation did not read back the intended value.');
        evidence.applied.push(change); evidence.pending = []; save(evidenceName, evidence);
        if (evidence.applied.length % 25 === 0) progress({ phase: 'native_temporal_changes', applied: evidence.applied.length, total: changes.length });
      }
      evidence.completedAt = new Date().toISOString(); save(evidenceName, evidence); return evidence;
    },
  });
}
if (['import', 'all'].includes(phase)) {
  const outputDir = resolve(directory, 'import'); mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  // Import bundle has its own database instance; this path is never an operator database.
  process.env.CONTROL_TOWER_SQLITE_PATH = resolve(outputDir, 'qualification.db');
  const { runNativeSafeImport } = await import('./native-incident-safe-import.mjs');
  results.safeImport = await runNativeSafeImport({ provider, accountId, records, outputDir, nativeRead, verifyOwnership });
}
results.finishedAt = new Date().toISOString(); results.passed = [results.monitor, results.safeImport].filter(Boolean).every((result) => result.passed);
save(phase + '-result', results);
progress({ phase: 'finished', passed: results.passed, baselineRecords: records.length, directory });
if (!results.passed) process.exitCode = 1;
