import { Buffer } from 'node:buffer';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export class WebsiteNetworkError extends Error {
  constructor(public readonly kind: 'invalid' | 'timeout' | 'network' | 'limit', message: string) {
    super(message);
    this.name = 'WebsiteNetworkError';
  }
}

/** Only public, globally routable addresses. IPv4-mapped IPv6 is deliberately refused. */
export function isPublicWebsiteAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('%') || address.includes('.')) return false;
  const [first, second = '0'] = address.toLowerCase().split(':');
  const prefix = Number.parseInt(first, 16), next = Number.parseInt(second || '0', 16);
  // Global unicast, excluding IETF special-purpose, documentation and 6to4 ranges.
  return prefix >= 0x2000 && prefix <= 0x3fff
    && !(prefix === 0x2001 && (next < 0x200 || next === 0xdb8))
    && prefix !== 0x2002 && !(prefix === 0x3fff && next < 0x1000);
}

export function publicWebsiteUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new WebsiteNetworkError('invalid', 'Enter a valid public HTTP or HTTPS website.'); }
  if (value.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (url.port && !['80', '443'].includes(url.port))) {
    throw new WebsiteNetworkError('invalid', 'Only public HTTP/HTTPS websites on ports 80 or 443 without credentials can be checked.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
      || (isIP(hostname) && !isPublicWebsiteAddress(hostname))) {
    throw new WebsiteNetworkError('invalid', 'Local, private and reserved network addresses cannot be checked.');
  }
  url.hash = '';
  return url;
}

type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** Resolve inside socket creation and return only the exact checked addresses to Node. */
export function publicWebsiteLookup(resolve: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then((addresses) => {
      if (!addresses.length || addresses.some(({ address }) => !isPublicWebsiteAddress(address))) {
        callback(new WebsiteNetworkError('invalid', 'The website resolves to a local, private or reserved address.'), '', 4);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }, (error: Error) => callback(error, '', 4));
  };
}

export type WebsiteResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

type RequestWebsiteOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  followRedirects?: boolean;
  method?: 'GET' | 'HEAD';
  signal?: AbortSignal;
};

function responseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(key)) {
      result[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return result;
}

async function requestOnce(url: URL, options: RequestWebsiteOptions, timeoutMs: number): Promise<WebsiteResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, response?: WebsiteResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(response!);
    };
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    const requestOptions: RequestOptions = {
      method: options.method ?? 'GET', agent: false, lookup: publicWebsiteLookup(),
      headers: { 'User-Agent': 'ControlTower-WebsiteCheck/1.0', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Encoding': 'identity' },
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, requestOptions, (response) => {
      let wireBytes = 0, decodedBytes = 0;
      const chunks: Buffer[] = [];
      const encoding = response.headers['content-encoding']?.toLowerCase();
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress()
        : encoding === 'deflate' ? createInflate() : undefined;
      const stream = decoder ? response.pipe(decoder) : response;
      response.on('data', (chunk: Buffer) => {
        wireBytes += chunk.length;
        if (wireBytes > maxBytes) {
          const error = new WebsiteNetworkError('limit', 'The website exceeded the download-size limit.');
          finish(error);
          request.destroy(error);
          decoder?.destroy();
        }
      });
      response.on('error', (error) => { decoder?.destroy(); finish(error); });
      stream.on('error', (error) => { request.destroy(); finish(error); });
      stream.on('data', (chunk: Buffer) => {
        decodedBytes += chunk.length;
        if (decodedBytes > maxBytes) {
          const error = new WebsiteNetworkError('limit', 'The website exceeded the download-size limit.');
          finish(error);
          request.destroy(error);
          decoder?.destroy();
        } else chunks.push(chunk);
      });
      stream.on('end', () => finish(undefined, {
        url: url.href, status: response.statusCode ?? 0, headers: responseHeaders(response.headers), body: Buffer.concat(chunks),
      }));
    });
    const abort = () => request.destroy(new WebsiteNetworkError('timeout', 'The website check was cancelled or exceeded its time limit.'));
    const timer = setTimeout(() => request.destroy(new WebsiteNetworkError('timeout', 'The website did not respond within the time limit.')), timeoutMs);
    request.on('error', (error) => finish(error));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    request.end();
  });
}

/** Redirect targets get a new validated URL and a new guarded, pinned connection. */
export async function requestWebsite(value: string, options: RequestWebsiteOptions = {}): Promise<WebsiteResponse> {
  let url = publicWebsiteUrl(value);
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new WebsiteNetworkError('timeout', 'The website did not respond within the time limit.');
    const response = await requestOnce(url, options, remaining);
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.location) return response;
    const next = publicWebsiteUrl(new URL(response.headers.location, url).href);
    if (options.followRedirects === false) return { ...response, headers: { ...response.headers, location: next.href } };
    if (redirects === 5) throw new WebsiteNetworkError('limit', 'The website redirected more than five times.');
    url = next;
  }
  throw new WebsiteNetworkError('limit', 'The website redirected too many times.');
}
