import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

describe('unattended watchdog runner', () => {
  it.each(['completed', 'failed'] as const)('reports a %s tick and sends only operator credentials', async (status) => {
    const requests: { key?: string; body: string; authorization?: string }[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push({ key: request.headers['x-control-tower-key'] as string, body, authorization: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ watchdog: {
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
      const child = spawn(process.execPath, ['scripts/watchdog.mjs', '--once'], {
        cwd: process.cwd(), env: { ...process.env, CONTROL_TOWER_WATCHDOG_URL: `http://127.0.0.1:${address.port}`,
          CONTROL_TOWER_SYNC_KEY: 'fixture-operator-key', HUBSPOT_ACCESS_TOKEN: 'must-not-be-sent' },
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const [exitCode] = await once(child, 'close');
      expect(exitCode).toBe(status === 'failed' ? 1 : 0);
      expect(requests).toEqual([{ key: 'fixture-operator-key', body: '{"action":"tick"}', authorization: undefined }]);
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
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const provider = JSON.parse(body).provider ?? 'hubspot';
    requests.push({ provider, key: request.headers['x-control-tower-key'] as string | undefined, authorization: request.headers.authorization });
    response.writeHead(provider === 'hubspot' ? 503 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(provider === 'hubspot' ? { error: 'Fixture HubSpot unavailable' } : { watchdog: {
      config: { enabled: true }, nextCheckAt: null, runs: [{ id: 'salesforce-fixture-run', status: 'completed', scanned: 2, opened: 1, fixed: 0 }],
      totals: { open: 1, inProgress: 0, unknown: 0 },
    } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
    const child = spawn(process.execPath, ['scripts/watchdog.mjs', '--once'], { cwd: process.cwd(), env: { ...process.env,
      CONTROL_TOWER_WATCHDOG_URL: `http://127.0.0.1:${address.port}`, CONTROL_TOWER_WATCHDOG_PROVIDERS: 'hubspot,salesforce',
      CONTROL_TOWER_SYNC_KEY: 'fixture-operator-key', SALESFORCE_ACCESS_TOKEN: 'sf-must-not-be-sent', HUBSPOT_ACCESS_TOKEN: 'hs-must-not-be-sent',
    } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const [exitCode] = await once(child, 'close');
    expect(exitCode).toBe(1);
    expect(requests.map((request) => request.provider).sort()).toEqual(['hubspot', 'salesforce']);
    expect(requests.every((request) => request.key === 'fixture-operator-key' && request.authorization === undefined)).toBe(true);
    expect(output).toContain('salesforce-fixture-run');
    expect(output).not.toContain('must-not-be-sent');
    expect(output).not.toContain('fixture-operator-key');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
