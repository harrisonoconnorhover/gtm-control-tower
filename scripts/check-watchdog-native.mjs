import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Read-only qualification. All monitoring settings and findings use a disposable
// local database; no saved operator policy or native record is changed.
if (!process.argv.includes('--run')) {
  console.log('Read-only HubSpot check: node --env-file=.env.local scripts/check-watchdog-native.mjs --run');
  process.exit(0);
}
assert(process.env.HUBSPOT_ACCESS_TOKEN, 'Configure HUBSPOT_ACCESS_TOKEN first.');
const { mkdirSync } = await import('node:fs');
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'outputs'), { recursive: true });
const output = mkdtempSync(resolve(root, 'outputs/watchdog-native-'));
process.env.CONTROL_TOWER_SQLITE_PATH = resolve(output, 'watchdog.db');
const bundle = resolve(output, 'probe.mjs');
await build({ stdin: {
  contents: `export * from './lib/watchdog'; export * from './lib/crm-account'; export * from './lib/watchdog-hubspot';`,
  resolveDir: root, loader: 'ts',
}, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle });

const originalFetch = globalThis.fetch;
const calls = { get: 0, search: 0, writes: 0 };
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://api.hubapi.com');
  const method = (init?.method || 'GET').toUpperCase();
  assert(method === 'GET' || (method === 'POST' && url.pathname.endsWith('/contacts/search')), 'Native watchdog qualification forbids CRM mutations.');
  if (method === 'GET') calls.get++; else calls.search++;
  return originalFetch(input, init);
};

try {
  const watchdogModule = await import(pathToFileURL(bundle).href);
  const { accountId } = await watchdogModule.readHubSpotAccountIdentity(process.env.HUBSPOT_ACCESS_TOKEN);
  let view = await watchdogModule.getWatchdogOverview(accountId);
  await watchdogModule.configureWatchdog(accountId, { ...view.config, enabled: true, automaticRepairs: false });
  let pages = 0;
  do {
    view = await watchdogModule.tickWatchdog(accountId, process.env.HUBSPOT_ACCESS_TOKEN, { force: true });
    pages++;
    assert.notEqual(view.runs[0]?.status, 'failed', view.runs[0]?.error || 'Native baseline failed.');
  } while (view.phase === 'baseline' && pages < 40);
  // Exercise the actual contact Search API even when the baseline is partial.
  const source = watchdogModule.hubspotWatchdogSource(process.env.HUBSPOT_ACCESS_TOKEN);
  const changes = await source.changes(new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() - 60_000).toISOString(), null);
  assert(Array.isArray(changes.contacts));
  const summary = {
    checkedAt: new Date().toISOString(), nativeReads: true, nativeRepairsTested: false,
    baselineComplete: view.phase === 'changes', baselinePages: pages,
    contactsScanned: view.runs.reduce((total, run) => total + run.scanned, 0),
    observedFindings: view.totals, changeSearchRecords: changes.contacts.length, changeSearchTotal: changes.total ?? null,
    calls, output,
  };
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(summary));
} finally {
  globalThis.fetch = originalFetch;
}
