import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Read-only qualification uses an isolated database and never enables automatic repairs.
// --cached-cli reads the existing authorized CLI session into this process only; it does not write .env.local.
if (!process.argv.includes('--run')) {
  console.log('Read-only Salesforce check: node --env-file=.env.local scripts/check-salesforce-monitor-native.mjs --run [--cached-cli]');
  process.exit(0);
}
if (process.argv.includes('--cached-cli')) {
  function sf(args) {
    try {
      const result = JSON.parse(execFileSync('sf', [...args, '--target-org', 'gtm-control-tower-salesforce', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      assert.equal(result.status, 0);
      return result.result;
    } catch {
      throw new Error('Salesforce cached CLI session could not be read. Credentials were not printed or saved.');
    }
  }
  const token = sf(['org', 'auth', 'show-access-token']);
  const org = sf(['org', 'display']);
  assert.equal(new URL(org.instanceUrl).origin, new URL(process.env.SALESFORCE_INSTANCE_URL).origin, 'Cached CLI org does not match the configured instance.');
  process.env.SALESFORCE_ACCESS_TOKEN = token.accessToken;
  process.env.SALESFORCE_API_VERSION = org.apiVersion;
}
assert(process.env.SALESFORCE_ACCESS_TOKEN && process.env.SALESFORCE_INSTANCE_URL, 'Configure the Salesforce connection first.');
const instance = new URL(process.env.SALESFORCE_INSTANCE_URL);
assert.equal(instance.protocol, 'https:');
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'outputs'), { recursive: true });
const output = mkdtempSync(resolve(root, 'outputs/salesforce-monitor-native-'));
process.env.CONTROL_TOWER_SQLITE_PATH = resolve(output, 'monitor.db');
process.env.CONTROL_TOWER_PERSISTENCE_ENABLED = 'true';
const bundle = resolve(output, 'probe.mjs');
await build({ stdin: {
  contents: `export * from './lib/monitor'; export * from './lib/monitor-types'; export * from './lib/monitor-connection'; export { getIncidentCoverage } from './lib/crm-incidents';`,
  resolveDir: root, loader: 'ts',
}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle });
const originalFetch = globalThis.fetch;
const objectTypes = ['Lead', 'Contact', 'Account', 'Opportunity'];
const metadataReadTypes = new Set();
const calls = { get: 0, metadata: 0, relationshipQueries: 0, blocked: 0, writes: 0 };
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, instance.origin, 'Read-only qualification rejects other hosts.');
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const metadata = /^\/services\/data\/v\d+\.\d+\/sobjects\/(Lead|Contact|Account|Opportunity)\/describe$/.exec(url.pathname);
  const allowedPath = metadata || /^\/services\/data\/v\d+\.\d+\/(?:query|sobjects\/(?:Lead|Contact|Account|Opportunity)\/[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)$/.test(url.pathname);
  if (method !== 'GET' || !allowedPath) calls.blocked++;
  assert.equal(method, 'GET', 'Read-only qualification forbids CRM mutations.');
  assert(allowedPath, 'Read-only qualification allows only native queries, object metadata and selected record reads.');
  if (metadata) { metadataReadTypes.add(metadata[1]); calls.metadata++; }
  if (/\bFROM\s+OpportunityContactRole\b/i.test(url.searchParams.get('q') ?? '')) calls.relationshipQueries++;
  calls.get++;
  return originalFetch(input, { ...init, redirect: 'error' });
};
try {
  const monitorModule = await import(pathToFileURL(bundle).href);
  const connection = await monitorModule.getMonitorConnection('salesforce');
  const sampledObjects = new Set();
  const recordsByObject = Object.fromEntries(objectTypes.map((type) => [type, 0]));
  const source = { ...connection.source, list: async (after) => {
    const page = await connection.source.list(after);
    for (const record of page.contacts) {
      assert(objectTypes.includes(record.objectType));
      recordsByObject[record.objectType]++;
      if (sampledObjects.has(record.objectType)) continue;
      const reread = await connection.source.read(record.id, record.objectType);
      assert.equal(reread.id, record.id);
      assert.equal(reread.objectType, record.objectType);
      sampledObjects.add(record.objectType);
    }
    return page;
  } };
  const initial = await monitorModule.getMonitorOverview(connection.scope);
  await monitorModule.configureMonitor(connection.scope, { ...initial.config, enabled: true, automaticRepairs: false });
  let view;
  let pages = 0;
  let recordsScanned = 0;
  do {
    view = await monitorModule.tickMonitor(connection.scope, '', { force: true, source });
    pages++;
    assert.notEqual(view.runs[0]?.status, 'failed', view.runs[0]?.error || 'Native baseline failed.');
    recordsScanned += view.runs[0]?.scanned ?? 0;
    assert.equal(view.config.automaticRepairs, false);
  } while (view.phase === 'baseline' && pages < 40);
  const from = new Date(Date.now() - 86_400_000).toISOString(), through = new Date(Date.now() - 60_000).toISOString();
  let changes, searchPages = 0, changeSearchRecords = 0;
  do {
    changes = await connection.source.changes(from, through, changes?.after ?? null);
    assert(Array.isArray(changes.contacts));
    changeSearchRecords += changes.contacts.length;
    searchPages++;
  } while (changes.after !== null && searchPages < 40);
  const coverage = await monitorModule.getIncidentCoverage(connection.scope);
  assert.deepEqual(view.objectTypes, objectTypes);
  assert.deepEqual([...metadataReadTypes].sort(), [...objectTypes].sort());
  assert.deepEqual(coverage.capabilities?.map((item) => item.objectType).sort(), [...objectTypes].sort());
  assert.equal(calls.blocked, 0, 'A provider request fell outside the read-only guard; inspect adapter coverage before claiming qualification.');
  const summary = {
    checkedAt: new Date().toISOString(), provider: 'salesforce', objectTypes, nativeReads: true, nativeRepairsTested: false,
    baselineComplete: view.phase === 'changes', baselinePages: pages, recordsScanned, recordsByObject, nativeRecordReadTypes: [...sampledObjects],
    metadataReadTypes: [...metadataReadTypes], coverage,
    observedFindings: view.totals, changeSearchRecords, changeSearchPages: searchPages, changeSearchHasMore: changes.after !== null,
    calls, output,
  };
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(summary));
} finally {
  globalThis.fetch = originalFetch;
}
