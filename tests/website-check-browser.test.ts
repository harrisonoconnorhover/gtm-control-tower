import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureRequests = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/website-network', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/website-network')>();
  return {
    ...original,
    requestWebsite: async (value: string, options?: Parameters<typeof original.requestWebsite>[1]) => {
      fixtureRequests.push(value);
      const url = new URL(value);
      if (url.hostname !== 'website-browser-fixture.test') return original.requestWebsite(value, options);
      const script = url.pathname === '/app.js';
      const body = script
        ? `document.title = 'Rendered company fixture'; document.getElementById('app').textContent = 'This fictional company provides scheduling software for service teams. The browser successfully rendered this content using JavaScript. Contact our fictional team to learn about our product and services.'; fetch('http://127.0.0.1/private').catch(() => {});`
        : url.pathname === '/static'
          ? '<html><head><title>Static company fixture</title></head><body><main>This fictional company provides scheduling software for service teams. This is a complete page with useful company content, product information, contact information and an explanation of our services.</main></body></html>'
          : '<html><head><title>Loading</title></head><body><div id="app"></div><script src="/app.js"></script></body></html>';
      return { url: value, status: 200, headers: { 'content-type': script ? 'application/javascript' : 'text/html' }, body: Buffer.from(body) };
    },
  };
});

import { checkWebsite } from '@/lib/website-checker';

const browserPath = process.env.CONTROL_TOWER_BROWSER_EXECUTABLE_PATH
  || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
// Explicit opt-in keeps normal unit checks independent of a browser installation.
const enabled = process.env.WEBSITE_CHECK_BROWSER_TEST === 'true' && existsSync(browserPath);

describe.skipIf(!enabled)('website checker with real Chromium and owned HTTP fixtures', () => {
  beforeEach(() => { fixtureRequests.length = 0; });

  it('uses HTTP alone for a complete page and renders an empty JavaScript shell with the fallback', async () => {
    const plain = await checkWebsite('https://website-browser-fixture.test/static');
    expect(plain).toMatchObject({ status: 'reachable', method: 'http', title: 'Static company fixture' });
    expect(fixtureRequests).toEqual(['https://website-browser-fixture.test/static']);

    fixtureRequests.length = 0;
    const rendered = await checkWebsite('https://website-browser-fixture.test/rendered');
    expect(rendered).toMatchObject({ status: 'reachable', method: 'browser', title: 'Rendered company fixture' });
    expect(fixtureRequests.filter((url) => url.endsWith('/rendered'))).toHaveLength(2);
    expect(fixtureRequests).toContain('https://website-browser-fixture.test/app.js');
    // The real network guard rejects this script's local-address request before connecting.
    expect(fixtureRequests).toContain('http://127.0.0.1/private');
  }, 40_000);
});
