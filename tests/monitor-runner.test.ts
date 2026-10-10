import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

describe('unattended monitor runner', () => {
  it.each(['completed', 'failed'] as const)('reports a %s tick and sends only operator credentials', async (status) => {
    const requests: { key?: string; body: string; authorization?: string }[] = [];
    let notificationRequests = 0;
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      if (request.url === '/api/control-tower/notifications/slack') {
        notificationRequests++;
        expect(JSON.parse(body)).toEqual({ action: 'deliver' });
        expect(request.headers['x-control-tower-key']).toBe('fixture-operator-key');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ slack: { configured: false }, outcome: 'idle' }));
        return;
      }
      if (request.url === '/api/control-tower/safe-import/worker') {
        expect(request.headers['x-control-tower-key']).toBe('fixture-operator-key');
        expect(body).toBe('');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ execution: null, queued: false }));
        return;
      }
      requests.push({ key: request.headers['x-control-tower-key'] as string, body, authorization: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ monitor: {
        config: { enabled: true }, nextCheckAt: new Date(Date.now() + 300_000).toISOString(),
        runs: [{ id: 'fixture-run', status, scanned: 5, opened: 1, fixed: 0, error: status === 'failed' ? 'Fixture provider unavailable' : null }],
        totals: { open: 1, inProgress: 0, unknown: 0 },
      } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture server port.');
      const child = spawn(process.execPath, ['scripts/monitor.mjs', '--once'], {
        cwd: process.cwd(), env: { ...process.env, CONTROL_TOWER_MONITOR_URL: `http://127.0.0.1:${address.port}`,
          CONTROL_TOWER_SYNC_KEY: 'fixture-operator-key', HUBSPOT_ACCESS_TOKEN: 'must-not-be-sent' },
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const [exitCode] = await once(child, 'close');
      expect(exitCode).toBe(status === 'failed' ? 1 : 0);
      expect(requests).toEqual([{ key: 'fixture-operator-key', body: '{"action":"tick"}', authorization: undefined }]);
      expect(notificationRequests).toBe(1);
      expect(output).toContain('fixture-run');
      expect(output).not.toContain('must-not-be-sent');
      expect(output).not.toContain('fixture-operator-key');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});

it('continues Salesforce when HubSpot fails and never forwards CRM credentials', async () => {
  const requests: { provider: string; key: string | undefined; authorization: string | undefined }[] = [];
  let notificationRequests = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.url === '/api/control-tower/notifications/slack') {
      notificationRequests++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ slack: { configured: true, pending: 0, delivered: 1, failed: 0, unknown: 0 }, outcome: 'delivered' }));
      return;
    }
    if (request.url === '/api/control-tower/safe-import/worker') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ execution: null, queued: false }));
      return;
    }
    const provider = JSON.parse(body).provider ?? 'hubspot';
    requests.push({ provider, key: request.headers['x-control-tower-key'] as string | undefined, authorization: request.headers.authorization });
    response.writeHead(provider === 'hubspot' ? 503 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(provider === 'hubspot' ? { error: 'Fixture HubSpot unavailable' } : { monitor: {
      config: { enabled: true }, nextCheckAt: null, runs: [{ id: 'salesforce-fixture-run', status: 'completed', scanned: 2, opened: 1, fixed: 0 }],
      totals: { open: 1, inProgress: 0, unknown: 0 },
    } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
    const child = spawn(process.execPath, ['scripts/monitor.mjs', '--once'], { cwd: process.cwd(), env: { ...process.env,
      CONTROL_TOWER_MONITOR_URL: `http://127.0.0.1:${address.port}`, CONTROL_TOWER_MONITOR_PROVIDERS: 'hubspot,salesforce',
      CONTROL_TOWER_SYNC_KEY: 'fixture-operator-key', SALESFORCE_ACCESS_TOKEN: 'sf-must-not-be-sent', HUBSPOT_ACCESS_TOKEN: 'hs-must-not-be-sent',
    } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const [exitCode] = await once(child, 'close');
    expect(exitCode).toBe(1);
    expect(requests.map((request) => request.provider).sort()).toEqual(['hubspot', 'salesforce']);
    expect(notificationRequests).toBe(1);
    expect(requests.every((request) => request.key === 'fixture-operator-key' && request.authorization === undefined)).toBe(true);
    expect(output).toContain('salesforce-fixture-run');
    expect(output).not.toContain('must-not-be-sent');
    expect(output).not.toContain('fixture-operator-key');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

it('keeps import continuations and Slack moving while a provider scan remains in flight, without overlapping a lane', async () => {
  const counts = { hubspot: 0, salesforce: 0, imports: 0, slack: 0 };
  const active = { hubspot: 0, salesforce: 0, imports: 0, slack: 0 };
  const maximum = { ...active };
  let heldProvider: import('node:http').ServerResponse | undefined;
  let ready!: () => void;
  const advanced = new Promise<void>((resolve) => { ready = resolve; });
  const report = (provider: string) => ({ monitor: { config: { enabled: true }, nextCheckAt: null,
    runs: [{ id: `${provider}-independent-run`, status: 'completed', scanned: 1, opened: 0, fixed: 0 }],
    totals: { open: 0, inProgress: 0, unknown: 0 } } });
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const lane = request.url === '/api/control-tower/safe-import/worker' ? 'imports'
      : request.url === '/api/control-tower/notifications/slack' ? 'slack'
        : JSON.parse(body).provider === 'salesforce' ? 'salesforce' : 'hubspot';
    counts[lane]++; active[lane]++; maximum[lane] = Math.max(maximum[lane], active[lane]);
    response.once('finish', () => { active[lane]--; });
    response.writeHead(200, { 'content-type': 'application/json' });
    if (lane === 'hubspot') { heldProvider = response; return; }
    if (lane === 'imports') {
      // Continue a real-shaped queued execution while the native scan is still blocked.
      response.end(JSON.stringify({ execution: { id: 'queued-fixture', status: 'running' }, queued: true }));
    } else if (lane === 'slack') response.end(JSON.stringify({ slack: { configured: true, pending: 1, delivered: counts.slack, failed: 0, unknown: 0 } }));
    else response.end(JSON.stringify(report(lane)));
    if (counts.imports >= 3 && counts.slack >= 2 && counts.salesforce >= 1) ready();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
  const child = spawn(process.execPath, ['scripts/monitor.mjs'], { cwd: process.cwd(), env: { ...process.env,
    CONTROL_TOWER_MONITOR_URL: `http://127.0.0.1:${address.port}`, CONTROL_TOWER_MONITOR_PROVIDERS: 'hubspot,salesforce', CONTROL_TOWER_SYNC_KEY: 'fixture-key',
  } });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const closed = once(child, 'close');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([advanced, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Independent lanes did not advance while the provider was held.')), 4500); })]);
    expect(heldProvider?.writableEnded).toBe(false);
    expect(counts.hubspot).toBe(1);
    expect(counts.imports).toBeGreaterThanOrEqual(3);
    expect(counts.slack).toBeGreaterThanOrEqual(2);
    expect(Object.values(maximum)).toEqual([1, 1, 1, 1]);
    // Repeated execution state logs stay deduplicated even though continuations keep running.
    expect(output.match(/"importExecution":"queued-fixture"/g)).toHaveLength(1);
    child.kill('SIGTERM');
    heldProvider!.end(JSON.stringify(report('hubspot')));
    const [exitCode] = await closed;
    expect(exitCode).toBe(0);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    heldProvider?.destroy();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}, 8000);
