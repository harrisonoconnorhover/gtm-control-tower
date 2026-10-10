import { setTimeout as delay } from 'node:timers/promises';

// Runs independently of browser tabs. Each connected provider has its own durable cadence and claims.
if (process.argv.includes('--help')) {
  console.log('Usage: npm run monitor [-- --once]\nSet CONTROL_TOWER_MONITOR_URL (default http://127.0.0.1:3000), CONTROL_TOWER_SYNC_KEY, and optionally CONTROL_TOWER_MONITOR_PROVIDERS=hubspot,salesforce. Otherwise providers are selected from local connection env, falling back to HubSpot. Enable each provider in /app/monitor first.');
  process.exit(0);
}
const base = new URL(process.env.CONTROL_TOWER_MONITOR_URL || 'http://127.0.0.1:3000');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
  throw new Error('CONTROL_TOWER_MONITOR_URL must be an HTTP(S) app URL without credentials, query, or fragment.');
}
const configuredProviders = process.env.CONTROL_TOWER_MONITOR_PROVIDERS?.split(',').map((value) => value.trim());
const inferredProviders = [process.env.HUBSPOT_ACCESS_TOKEN ? 'hubspot' : null,
  process.env.SALESFORCE_INSTANCE_URL && process.env.SALESFORCE_ACCESS_TOKEN ? 'salesforce' : null].filter(Boolean);
const providers = [...new Set(configuredProviders ?? (inferredProviders.length ? inferredProviders : ['hubspot']))];
if (!providers.length || providers.some((provider) => !['hubspot', 'salesforce'].includes(provider))) {
  throw new Error('CONTROL_TOWER_MONITOR_PROVIDERS must contain hubspot and/or salesforce.');
}
const endpoint = new URL('/api/control-tower/monitor', base);
const notificationEndpoint = new URL('/api/control-tower/notifications/slack', base);
const importEndpoint = new URL('/api/control-tower/safe-import/worker', base);
const once = process.argv.includes('--once');
const sleepController = new AbortController();
const states = new Map(providers.map((provider) => [provider, { failures: 0, lastMessage: '', lastRunId: '', nextPollAt: 0 }]));
let stopping = false;
let lastSlackStatus = '';
let lastImportStatus = '';
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { stopping = true; sleepController.abort(); });
}

async function poll(provider) {
  const state = states.get(provider);
  if (!once && state.nextPollAt > Date.now()) return state.nextPollAt - Date.now();
  let waitMs = 30_000;
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(240_000),
      headers: { 'content-type': 'application/json', ...(process.env.CONTROL_TOWER_SYNC_KEY
        ? { 'x-control-tower-key': process.env.CONTROL_TOWER_SYNC_KEY } : {}) },
      // Preserve the original HubSpot request contract for existing installations.
      body: JSON.stringify({ action: 'tick', ...(provider === 'salesforce' ? { provider } : {}) }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.monitor) throw new Error(payload.error || `Monitor returned HTTP ${response.status}.`);
    const { config, nextCheckAt, runs, totals } = payload.monitor;
    const latest = runs[0];
    if (latest && latest.id !== state.lastRunId) {
      state.lastRunId = latest.id;
      console.log(JSON.stringify({ at: new Date().toISOString(), provider, run: latest.id, status: latest.status,
        checked: latest.scanned, newIssues: latest.opened, fixed: latest.fixed,
        openIssues: totals.open + totals.inProgress + totals.unknown, error: latest.error }));
    }
    if (latest?.status === 'failed') {
      if (once) process.exitCode = 1;
      waitMs = Math.min(300_000, 30_000 * (2 ** Math.min(state.failures++, 4)));
    } else {
      state.failures = 0;
      waitMs = config.enabled ? Math.min(60_000, Math.max(2_000,
        nextCheckAt ? Date.parse(nextCheckAt) - Date.now() : 2_000)) : 30_000;
    }
    const message = `${provider}: ${config.enabled ? 'Monitoring enabled. Reports and triage: /app/monitor.' : 'Monitoring paused. Enable it in /app/monitor.'}`;
    if (message !== state.lastMessage) { console.log(message); state.lastMessage = message; }
  } catch (error) {
    console.error(JSON.stringify({ at: new Date().toISOString(), provider, error: error instanceof Error ? error.message : 'Monitor request failed.' }));
    waitMs = Math.min(300_000, 30_000 * (2 ** Math.min(state.failures++, 4)));
    if (once) process.exitCode = 1;
  }
  state.nextPollAt = Date.now() + waitMs;
  return waitMs;
}

async function continueImports() {
  let importsQueued = false;
  try {
    const response = await fetch(importEndpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: process.env.CONTROL_TOWER_SYNC_KEY ? { 'x-control-tower-key': process.env.CONTROL_TOWER_SYNC_KEY } : {} });
    const result = await response.json();
    if (!response.ok) throw new Error('Approved import processing unavailable; inspect the saved execution in Control Tower.');
    importsQueued = result.queued === true;
    if (result.execution) {
      const message = JSON.stringify({ importExecution: result.execution.id, status: result.execution.status, queued: importsQueued });
      if (message !== lastImportStatus) { console.log(message); lastImportStatus = message; }
    }
  } catch {
    const message = 'Approved import processing unavailable; saved sending or unknown writes are never automatically replayed.';
    if (lastImportStatus !== message) { console.error(message); lastImportStatus = message; }
    if (once) process.exitCode = 1;
  }
  return importsQueued ? 1000 : 30_000;
}

async function deliverNotifications() {
  // Notification delivery is independent of CRM success and monitoring opt-in.
  let notificationsQueued = false;
  try {
    const response = await fetch(notificationEndpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', ...(process.env.CONTROL_TOWER_SYNC_KEY ? { 'x-control-tower-key': process.env.CONTROL_TOWER_SYNC_KEY } : {}) },
      body: JSON.stringify({ action: 'deliver' }) });
    const result = await response.json();
    if (!response.ok) throw new Error('Slack notification delivery unavailable; inspect notification status in /app/work.');
    const status = result.slack;
    if (status?.configured) {
      notificationsQueued = status.pending > 0;
      const message = JSON.stringify({ notifications: 'slack', pending: status.pending, delivered: status.delivered, failed: status.failed, unknown: status.unknown });
      if (message !== lastSlackStatus) { console.log(message); lastSlackStatus = message; }
    }
  } catch {
    const message = 'Slack notification delivery unavailable; inspect notification status in /app/work.';
    if (lastSlackStatus !== message) { console.error(message); lastSlackStatus = message; }
    if (once) process.exitCode = 1;
  }
  return notificationsQueued ? 1000 : 30_000;
}

/** A lane never dispatches again until its own request finishes; other lanes keep their cadence. */
async function runLane(action) {
  while (!stopping) {
    const waitMs = await action();
    if (once || stopping) return;
    await delay(Math.max(1000, waitMs), undefined, { signal: sleepController.signal })
      .catch((error) => { if (error.name !== 'AbortError') throw error; });
  }
}

console.log(`Monitor runner connected to ${base.origin} for ${providers.join(', ')}; Ctrl+C stops this runner.`);
await Promise.all([
  ...providers.map((provider) => runLane(() => poll(provider))),
  runLane(continueImports),
  runLane(deliverNotifications),
]);
