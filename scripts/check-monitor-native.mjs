import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Read-only qualification. All monitoring settings and findings use a disposable
// local database; no saved operator policy or native record is changed.
if (!process.argv.includes('--run')) {
  console.log('Read-only HubSpot check: node --env-file=.env.local scripts/check-monitor-native.mjs --run');
  process.exit(0);
}
assert(process.env.HUBSPOT_ACCESS_TOKEN, 'Configure HUBSPOT_ACCESS_TOKEN first.');
const { mkdirSync } = await import('node:fs');
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'outputs'), { recursive: true });
const output = mkdtempSync(resolve(root, 'outputs/monitor-native-'));
process.env.CONTROL_TOWER_SQLITE_PATH = resolve(output, 'monitor.db');
process.env.CONTROL_TOWER_PERSISTENCE_ENABLED = 'true';
const bundle = resolve(output, 'probe.mjs');
await build({ stdin: {
  contents: `export * from './lib/monitor'; export * from './lib/crm-account'; export * from './lib/monitor-hubspot'; export { getIncidentCoverage } from './lib/crm-incidents';`,
  resolveDir: root, loader: 'ts',
}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle });

const originalFetch = globalThis.fetch;
const objectTypes = ['Contact', 'Company', 'Deal'];
const metadataReadTypes = new Set();
const calls = { get: 0, search: 0, associationReads: 0, blocked: 0, writes: 0 };
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, 'https://api.hubapi.com');
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const metadata = /^\/crm\/v3\/properties\/(contacts|companies|deals)$/.exec(url.pathname);
  const get = method === 'GET' && (url.pathname === '/account-info/v3/details' || metadata
    || /^\/crm\/v3\/objects\/(contacts|companies|deals)(?:\/\d+)?$/.test(url.pathname));
  const search = method === 'POST' && /^\/crm\/v3\/objects\/(contacts|companies|deals)\/search$/.test(url.pathname);
  const associations = method === 'POST' && /^\/crm\/v4\/associations\/(?:companies\/contacts|deals\/(?:companies|contacts))\/batch\/read$/.test(url.pathname);
  if (!get && !search && !associations) calls.blocked++;
  assert(get || search || associations, 'Native monitor qualification allows only object/metadata reads, read-only searches and association batch reads.');
  if (metadata) metadataReadTypes.add(({ contacts: 'Contact', companies: 'Company', deals: 'Deal' })[metadata[1]]);
  if (get) calls.get++; else if (search) calls.search++; else calls.associationReads++;
  return originalFetch(input, { ...init, redirect: 'error' });
};

try {
  const monitorModule = await import(pathToFileURL(bundle).href);
  const { accountId } = await monitorModule.readHubSpotAccountIdentity(process.env.HUBSPOT_ACCESS_TOKEN);
  const nativeSource = monitorModule.hubspotMonitorSource(process.env.HUBSPOT_ACCESS_TOKEN);
  const sampledObjects = new Set();
  const recordsByObject = Object.fromEntries(objectTypes.map((type) => [type, 0]));
  const source = { ...nativeSource, list: async (after) => {
    const page = await nativeSource.list(after);
    for (const record of page.contacts) {
      assert(objectTypes.includes(record.objectType));
      recordsByObject[record.objectType]++;
      if (sampledObjects.has(record.objectType)) continue;
      const reread = await nativeSource.read(record.id, record.objectType);
      assert.equal(reread.id, record.id);
      assert.equal(reread.objectType, record.objectType);
      sampledObjects.add(record.objectType);
    }
    return page;
  } };
  let view = await monitorModule.getMonitorOverview(accountId);
  await monitorModule.configureMonitor(accountId, { ...view.config, enabled: true, automaticRepairs: false });
  let pages = 0;
  let recordsScanned = 0;
  do {
    view = await monitorModule.tickMonitor(accountId, process.env.HUBSPOT_ACCESS_TOKEN, { force: true, source });
    pages++;
    assert.notEqual(view.runs[0]?.status, 'failed', view.runs[0]?.error || 'Native baseline failed.');
    recordsScanned += view.runs[0]?.scanned ?? 0;
    assert.equal(view.config.automaticRepairs, false);
  } while (view.phase === 'baseline' && pages < 40);
  // Continue through each readable object in the same frozen native search window.
  const from = new Date(Date.now() - 86_400_000).toISOString(), through = new Date(Date.now() - 60_000).toISOString();
  let changes, searchPages = 0, changeSearchRecords = 0;
  do {
    changes = await source.changes(from, through, changes?.after ?? null);
    assert(Array.isArray(changes.contacts));
    changeSearchRecords += changes.contacts.length;
    searchPages++;
  } while (changes.after !== null && searchPages < 40);
  const coverage = await monitorModule.getIncidentCoverage(accountId);
  assert.deepEqual(view.objectTypes, objectTypes);
  assert.deepEqual([...metadataReadTypes].sort(), [...objectTypes].sort());
  assert.deepEqual(coverage.capabilities?.map((item) => item.objectType).sort(), [...objectTypes].sort());
  assert.equal(calls.blocked, 0, 'A provider request fell outside the read-only guard; inspect adapter coverage before claiming qualification.');
  const summary = {
    checkedAt: new Date().toISOString(), provider: 'hubspot', objectTypes, nativeReads: true, nativeRepairsTested: false,
    baselineComplete: view.phase === 'changes', baselinePages: pages,
    recordsScanned, recordsByObject, nativeRecordReadTypes: [...sampledObjects], metadataReadTypes: [...metadataReadTypes], coverage,
    observedFindings: view.totals, changeSearchRecords, changeSearchPages: searchPages, changeSearchHasMore: changes.after !== null,
    changeSearchCoverageLimited: changes.total === undefined || changes.total >= 10_000,
    calls, output,
  };
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(summary));
} finally {
  globalThis.fetch = originalFetch;
}
