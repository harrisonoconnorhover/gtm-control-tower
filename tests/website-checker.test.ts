import { describe, expect, it, vi } from 'vitest';
import { checkWebsite } from '../lib/website-checker';
import { WebsiteNetworkError, type WebsiteResponse } from '../lib/website-network';

const readable = 'Welcome to our company. We provide useful software and services to business customers. Learn about our products and contact our team.';
function response(html: string, status = 200, contentType = 'text/html'): WebsiteResponse {
  return { url: 'https://www.company.test/', status, headers: { 'content-type': contentType }, body: Buffer.from(html) };
}

describe('website reachability checks', () => {
  it('records HTTP page evidence without launching a browser for a readable page', async () => {
    const browser = vi.fn();
    const result = await checkWebsite('https://company.test/', { request: vi.fn().mockResolvedValue(response(`<title>Company &amp; Co</title><body>${readable}</body>`)), browser });
    expect(result).toMatchObject({ url: 'https://company.test/', finalUrl: 'https://www.company.test/', status: 'reachable', method: 'http', httpStatus: 200, title: 'Company & Co' });
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(browser).not.toHaveBeenCalled();
  });

  it('falls back for a JavaScript shell and saves rendered browser evidence', async () => {
    const browser = vi.fn().mockResolvedValue({ finalUrl: 'https://company.test/app', httpStatus: 200, title: 'Company', text: readable });
    const result = await checkWebsite('https://company.test/', { request: vi.fn().mockResolvedValue(response('<div id="root"></div><script>render()</script>')), browser });
    expect(result).toMatchObject({ status: 'reachable', method: 'browser', finalUrl: 'https://company.test/app', title: 'Company' });
    expect(browser).toHaveBeenCalledOnce();
  });

  it.each([
    [403, '<title>Forbidden</title>', 'blocked'],
    [200, '<title>Just a moment...</title><body>Checking your browser</body>', 'blocked'],
    [200, '<title>This domain is for sale</title>', 'needs_review'],
    [200, '<html><body></body></html>', 'needs_review'],
    [404, '<title>Not found</title>', 'failed'],
    [200, `<title>Page not found | Company</title><body>${readable}</body>`, 'failed'],
    [200, `<title>Account suspended</title><body>${readable}</body>`, 'failed'],
  ])('does not call HTTP %i a successful website merely because a response arrived', async (status, html, expected) => {
    const result = await checkWebsite('https://company.test/', { request: vi.fn().mockResolvedValue(response(html, status)), browser: vi.fn().mockRejectedValue(new Error('Chromium is unavailable.')) });
    expect(result.status).toBe(expected);
  });

  it('preserves the original status when Chromium is unavailable', async () => {
    const result = await checkWebsite('https://company.test/', { request: vi.fn().mockResolvedValue(response('<title>Blocked</title>', 403)), browser: vi.fn().mockRejectedValue(new Error('Chromium is unavailable.')) });
    expect(result).toMatchObject({ status: 'blocked', method: 'http', httpStatus: 403, title: 'Blocked' });
    expect(result.detail).toContain('Chromium is unavailable');
  });

  it('does not browser-retry unsafe URLs, private DNS, TLS failures, 404s or parked domains', async () => {
    const browser = vi.fn();
    const cases = [
      vi.fn().mockRejectedValue(new WebsiteNetworkError('invalid', 'Private address')),
      vi.fn().mockRejectedValue(Object.assign(new Error('expired'), { code: 'CERT_HAS_EXPIRED' })),
      vi.fn().mockResolvedValue(response('<title>Missing</title>', 404)),
      vi.fn().mockResolvedValue(response('<title>Buy this domain</title>')),
    ];
    for (const request of cases) await checkWebsite('https://company.test/', { request, browser });
    const request = vi.fn();
    expect(await checkWebsite('http://127.0.0.1/', { request, browser })).toMatchObject({ status: 'invalid' });
    expect(request).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
  });

  it('retries a timeout in the browser without turning an empty rendered page into success', async () => {
    const result = await checkWebsite('https://company.test/', {
      request: vi.fn().mockRejectedValue(new WebsiteNetworkError('timeout', 'Request timed out')),
      browser: vi.fn().mockResolvedValue({ finalUrl: 'https://company.test/', httpStatus: 200, title: '', text: '' }),
    });
    expect(result).toMatchObject({ status: 'needs_review', method: 'browser' });
  });

  it('does not mistake downloadable/non-HTML content for a website', async () => {
    const browser = vi.fn();
    const result = await checkWebsite('https://company.test/', { request: vi.fn().mockResolvedValue(response(readable, 200, 'application/pdf')), browser });
    expect(result).toMatchObject({ status: 'needs_review' });
    expect(result.detail).toContain('non-HTML');
    expect(browser).not.toHaveBeenCalled();
  });
});
