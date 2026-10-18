import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import type { LookupAddress } from 'node:dns';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isPublicWebsiteAddress, publicWebsiteLookup, publicWebsiteUrl, requestWebsite } from '../lib/website-network';

const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:http', async (original) => ({ ...await original<typeof import('node:http')>(), request: mocks.request }));
vi.mock('node:https', async (original) => ({ ...await original<typeof import('node:https')>(), request: mocks.request }));

type Fixture = { status?: number; headers?: Record<string, string>; body?: Buffer | string; hang?: boolean };
let fixtures: Fixture[];
let connections: { url: string; addresses: LookupAddress[] }[];

beforeEach(() => {
  fixtures = []; connections = [];
  mocks.lookup.mockReset().mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
  mocks.request.mockReset().mockImplementation((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const fixture = fixtures.shift() ?? {};
    let destroyed = false;
    const request = Object.assign(new EventEmitter(), {
      end() {
        if (fixture.hang) return;
        options.lookup!(url.hostname, { all: true }, (error, addresses) => {
          if (destroyed) return;
          if (error) { request.destroy(error); return; }
          connections.push({ url: url.href, addresses: addresses as LookupAddress[] });
          const response = Object.assign(new PassThrough(), { statusCode: fixture.status ?? 200, headers: fixture.headers ?? {} });
          callback(response as unknown as IncomingMessage);
          response.end(fixture.body ?? 'hello');
        });
      },
      destroy(error?: Error) {
        if (!destroyed) { destroyed = true; if (error) queueMicrotask(() => request.emit('error', error)); }
        return request;
      },
    });
    return request as unknown as ClientRequest;
  });
});

describe('public website network boundary', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.2', '169.254.169.254', '100.64.0.1', '192.168.1.1',
    '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1', '2002:7f00:1::1'])('rejects nonpublic address %s', (address) => {
    expect(isPublicWebsiteAddress(address)).toBe(false);
  });

  it('accepts normal public IPv4 and IPv6 addresses', () => {
    expect(isPublicWebsiteAddress('93.184.215.14')).toBe(true);
    expect(isPublicWebsiteAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicWebsiteAddress('2001:4860:4860::8888')).toBe(true);
  });

  it.each(['http://2130706433/', 'http://0x7f000001/', 'http://[::1]/', 'http://user:password@example.com/',
    'file:///etc/passwd', 'http://example.com:8080/'])('rejects unsafe URL %s before a request', async (url) => {
    expect(() => publicWebsiteUrl(url)).toThrow();
    await expect(requestWebsite(url)).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('rejects a DNS answer containing both public and private addresses', async () => {
    mocks.lookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    await expect(requestWebsite('https://company.test/')).rejects.toMatchObject({ kind: 'invalid' });
    expect(connections).toHaveLength(0);
  });

  it('pins the connection to the address from the single checked DNS resolution', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '93.184.215.14', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await requestWebsite('https://company.test/');
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(connections).toEqual([{ url: 'https://company.test/', addresses: [{ address: '93.184.215.14', family: 4 }] }]);
    expect(mocks.request.mock.calls[0][1]).toMatchObject({ agent: false, method: 'GET' });
  });

  it('validates each redirect and blocks an internal target before connecting', async () => {
    fixtures.push({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    await expect(requestWebsite('https://company.test/')).rejects.toMatchObject({ kind: 'invalid' });
    expect(connections).toHaveLength(1);
    expect(mocks.request).toHaveBeenCalledOnce();
  });

  it('also checks DNS again for redirects, including the same hostname', async () => {
    fixtures.push({ status: 302, headers: { location: '/next' } });
    mocks.lookup.mockResolvedValueOnce([{ address: '93.184.215.14', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(requestWebsite('https://company.test/')).rejects.toMatchObject({ kind: 'invalid' });
    expect(connections).toHaveLength(1);
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });

  it('keeps browser redirects visible while validating the Location URL', async () => {
    fixtures.push({ status: 301, headers: { location: '/new' } });
    const result = await requestWebsite('https://company.test/', { followRedirects: false });
    expect(result).toMatchObject({ status: 301, headers: { location: 'https://company.test/new' } });
    expect(mocks.request).toHaveBeenCalledOnce();
  });

  it('bounds redirect loops and both compressed and decoded response bytes', async () => {
    fixtures.push(...Array.from({ length: 6 }, () => ({ status: 302, headers: { location: '/again' } })));
    await expect(requestWebsite('https://company.test/')).rejects.toMatchObject({ kind: 'limit' });
    expect(mocks.request).toHaveBeenCalledTimes(6);
    fixtures.push({ body: 'x'.repeat(101) });
    await expect(requestWebsite('https://company.test/', { maxBytes: 100 })).rejects.toMatchObject({ kind: 'limit' });
    fixtures.push({ body: gzipSync('x'.repeat(10_000)), headers: { 'content-encoding': 'gzip' } });
    await expect(requestWebsite('https://company.test/', { maxBytes: 100 })).rejects.toMatchObject({ kind: 'limit' });
  });

  it('enforces a total timeout and cancels an in-flight request', async () => {
    fixtures.push({ hang: true });
    await expect(requestWebsite('https://company.test/', { timeoutMs: 5 })).rejects.toMatchObject({ kind: 'timeout' });
    const controller = new AbortController();
    fixtures.push({ hang: true });
    const pending = requestWebsite('https://company.test/', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('supports the single-address socket lookup callback', async () => {
    const result = await new Promise((resolve, reject) => publicWebsiteLookup(async () => [{ address: '93.184.215.14', family: 4 }])(
      'company.test', { family: 4 }, (error, address, family) => error ? reject(error) : resolve({ address, family })));
    expect(result).toEqual({ address: '93.184.215.14', family: 4 });
  });
});
