import { setTimeout as delay } from 'node:timers/promises';

// Runs independently of browser tabs. The server owns cadence, claims, and state.
if (process.argv.includes('--help')) {
  console.log('Usage: npm run watchdog [-- --once]\nSet CONTROL_TOWER_WATCHDOG_URL (default http://127.0.0.1:3000) and CONTROL_TOWER_SYNC_KEY. Enable monitoring in /app/watchdog first.');
  process.exit(0);
}

const base = new URL(process.env.CONTROL_TOWER_WATCHDOG_URL || 'http://127.0.0.1:3000');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
  throw new Error('CONTROL_TOWER_WATCHDOG_URL must be an HTTP(S) app URL without credentials, query, or fragment.');
}
const endpoint = new URL('/api/control-tower/watchdog', base);
const once = process.argv.includes('--once');
const sleepController = new AbortController();
let stopping = false;
let failures = 0;
let lastMessage = '';
let lastRunId = '';

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    sleepController.abort();
    // Let an active request finish; terminating/retrying a PATCH can be ambiguous.
  });
}

console.log(`Watchdog runner connected to ${base.origin}; Ctrl+C stops this runner.`);
while (!stopping) {
  let waitMs = 30_000;
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(240_000),
      headers: { 'content-type': 'application/json', ...(process.env.CONTROL_TOWER_SYNC_KEY
        ? { 'x-control-tower-key': process.env.CONTROL_TOWER_SYNC_KEY } : {}) },
      body: JSON.stringify({ action: 'tick' }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.watchdog) throw new Error(payload.error || `Watchdog returned HTTP ${response.status}.`);
    const { config, nextCheckAt, runs, totals } = payload.watchdog;
    const latest = runs[0];
    if (latest && latest.id !== lastRunId) {
      lastRunId = latest.id;
      console.log(JSON.stringify({ at: new Date().toISOString(), run: latest.id, status: latest.status,
        checked: latest.scanned, newIssues: latest.opened, fixed: latest.fixed,
        openIssues: totals.open + totals.inProgress + totals.unknown, error: latest.error }));
    }
    if (latest?.status === 'failed') {
      if (once) process.exitCode = 1;
      waitMs = Math.min(300_000, 30_000 * (2 ** Math.min(failures++, 4)));
    } else {
      failures = 0;
      waitMs = config.enabled ? Math.min(60_000, Math.max(2_000,
        nextCheckAt ? Date.parse(nextCheckAt) - Date.now() : 2_000)) : 30_000;
    }
    const message = config.enabled ? 'Monitoring enabled. Reports and triage: /app/watchdog.' : 'Monitoring paused. Enable it in /app/watchdog.';
    if (message !== lastMessage) { console.log(message); lastMessage = message; }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Watchdog request failed.';
    console.error(JSON.stringify({ at: new Date().toISOString(), error: message }));
    waitMs = Math.min(300_000, 30_000 * (2 ** Math.min(failures++, 4)));
    if (once) process.exitCode = 1;
  }
  if (once || stopping) break;
  await delay(waitMs, undefined, { signal: sleepController.signal }).catch((error) => {
    if (error.name !== 'AbortError') throw error;
  });
}
