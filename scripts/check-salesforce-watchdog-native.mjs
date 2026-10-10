import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Read-only qualification uses an isolated database and never enables automatic repairs.
// --cached-cli reads the existing authorized CLI session into this process only; it does not write .env.local.
if (!process.argv.includes('--run')) {
  console.log('Read-only Salesforce check: node --env-file=.env.local scripts/check-salesforce-watchdog-native.mjs --run [--cached-cli]');
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
const output = mkdtempSync(resolve(root, 'outputs/salesforce-watchdog-native-'));
process.env.CONTROL_TOWER_SQLITE_PATH = resolve(output, 'watchdog.db');
process.env.CONTROL_TOWER_PERSISTENCE_ENABLED = 'true';
const bundle = resolve(output, 'probe.mjs');
await build({ stdin: {
  contents: `export * from './lib/watchdog'; export * from './lib/watchdog-types'; export * from './lib/watchdog-connection';`,
  resolveDir: root, loader: 'ts',
}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle });
const originalFetch = globalThis.fetch;
const calls = { get: 0, writes: 0 };
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, instance.origin, 'Read-only qualification rejects other hosts.');
  assert.equal((init?.method || 'GET').toUpperCase(), 'GET', 'Read-only qualification forbids CRM mutations.');
  assert(/^\/services\/data\/v\d+\.\d+\/(?:query|sobjects\/(?:Lead|Contact)\/[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)$/.test(url.pathname), 'Read-only qualification rejects unsupported API paths.');
  calls.get++;
  return originalFetch(input, { ...init, redirect: 'error' });
};
try {
  const watchdogModule = await import(pathToFileURL(bundle).href);
  const connection = await watchdogModule.getWatchdogConnection('salesforce');
  const sampledObjects = new Set();
  const source = { ...connection.source, list: async (after) => {
    const page = await connection.source.list(after);
    for (const record of page.contacts) {
      if (sampledObjects.has(record.objectType)) continue;
      const reread = await connection.source.read(record.id, record.objectType);
      assert.equal(reread.id, record.id);
      assert.equal(reread.objectType, record.objectType);
      sampledObjects.add(record.objectType);
    }
    return page;
  } };
  const initial = await watchdogModule.getWatchdogOverview(connection.scope);
  await watchdogModule.configureWatchdog(connection.scope, { ...initial.config, enabled: true, automaticRepairs: false });
  let view;
  let pages = 0;
  let recordsScanned = 0;
  do {
    view = await watchdogModule.tickWatchdog(connection.scope, '', { force: true, source });
    pages++;
    assert.notEqual(view.runs[0]?.status, 'failed', view.runs[0]?.error || 'Native baseline failed.');
    recordsScanned += view.runs[0]?.scanned ?? 0;
    assert.equal(view.config.automaticRepairs, false);
  } while (view.phase === 'baseline' && pages < 40);
  const changes = await connection.source.changes(new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), null);
  assert(Array.isArray(changes.contacts));
  const summary = {
    checkedAt: new Date().toISOString(), provider: 'salesforce', objectTypes: ['Lead', 'Contact'], nativeReads: true, nativeRepairsTested: false,
    baselineComplete: view.phase === 'changes', baselinePages: pages, recordsScanned, nativeRecordReadTypes: [...sampledObjects],
    observedFindings: view.totals, changeSearchRecords: changes.contacts.length, changeSearchHasMore: changes.after !== null,
    calls, output,
  };
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(summary));
} finally {
  globalThis.fetch = originalFetch;
}
