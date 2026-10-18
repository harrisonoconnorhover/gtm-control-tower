import { existsSync } from 'node:fs';
import type { WebsiteCheckResult } from './website-check-types';
import { publicWebsiteUrl, requestWebsite, WebsiteNetworkError, type WebsiteResponse } from './website-network';

type PageEvidence = { finalUrl: string; httpStatus: number | null; title: string | null; text: string; html?: string };
type WebsiteClassification = Pick<WebsiteCheckResult, 'status' | 'detail'>;

function decodeText(text: string): string {
  return text.replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
    const number = code[0].toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number(code);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  }).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim();
}

function htmlEvidence(response: WebsiteResponse): PageEvidence {
  const html = new TextDecoder().decode(response.body);
  const title = decodeText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 300) || null;
  const text = decodeText(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '));
  return { finalUrl: response.url, httpStatus: response.status, title, text, html };
}

function classify(evidence: PageEvidence): WebsiteClassification {
  const { httpStatus: status, title, text } = evidence;
  if (status === 401 || status === 403 || status === 407 || status === 429) {
    return { status: 'blocked', detail: `The website restricted automated access (HTTP ${status}). This does not establish that the website is unavailable.` };
  }
  if (status !== null && status >= 400) return { status: 'failed', detail: `The website returned HTTP ${status}.` };
  if (status !== null && (status < 200 || status >= 300)) return { status: 'needs_review', detail: `The website returned HTTP ${status} without a usable page.` };
  if (/^(?:404\b|page not found\b|not found\b|account suspended\b|this account has been suspended\b|500 internal server error\b)/i.test(title ?? '')) {
    return { status: 'failed', detail: 'The page reports a missing page, suspended account or server error despite returning a successful HTTP response.' };
  }
  const challenge = /just a moment|checking (?:your )?browser|verify (?:that )?you(?:'re| are) (?:a )?human|attention required|access denied|security verification|captcha challenge|checking your connection/i;
  if (challenge.test(title ?? '') || (text.length < 2500 && challenge.test(text))) {
    return { status: 'blocked', detail: 'The website returned an access check or bot challenge; page availability remains unconfirmed.' };
  }
  const parked = /(?:this |the )?domain (?:name )?(?:is )?(?:for sale|parked)|buy this domain|domain has expired|website (?:is )?coming soon|site under construction/i;
  if (parked.test(title ?? '') || (text.length < 6000 && parked.test(text))) {
    return { status: 'needs_review', detail: 'The page appears to be parked, expired or under construction. Review the website.' };
  }
  if (text.length < 80 || (text.length < 600 && /(?:enable|turn on|requires?) javascript|javascript (?:is )?(?:disabled|required)|loading\.{2,}/i.test(text))) {
    return { status: 'needs_review', detail: 'The page returned little readable content or requires JavaScript. Availability needs review.' };
  }
  return { status: 'reachable', detail: 'The website returned a page with readable content. This checks reachability only.' };
}

function classifyHttp(response: WebsiteResponse): { evidence: PageEvidence; classification: WebsiteClassification } {
  const evidence = htmlEvidence(response);
  if (response.status >= 200 && response.status < 300 && !/text\/html|application\/xhtml\+xml/i.test(response.headers['content-type'] ?? '')
      && !/<(?:!doctype html|html|body)\b/i.test(evidence.html ?? '')) {
    return { evidence, classification: { status: 'needs_review', detail: 'The address returned a file or non-HTML response instead of a website page.' } };
  }
  return { evidence, classification: classify(evidence) };
}

let activeBrowsers = 0;
const browserWaiters: (() => void)[] = [];

async function browserSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeBrowsers >= 2) await new Promise<void>((resolve) => browserWaiters.push(resolve));
  else activeBrowsers += 1;
  try { return await run(); }
  finally {
    const next = browserWaiters.shift();
    if (next) next(); else activeBrowsers -= 1;
  }
}

function browserExecutable(chromium: typeof import('playwright-core').chromium): string | undefined {
  const configured = process.env.CONTROL_TOWER_BROWSER_EXECUTABLE_PATH;
  if (configured) {
    if (!existsSync(configured)) throw new Error('The configured Chromium executable was not found.');
    return configured;
  }
  return [chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((path) => existsSync(path));
}

async function checkInBrowser(url: string): Promise<PageEvidence> {
  return browserSlot(async () => {
    // The browser is a Node deployment dependency, not part of Vite's preview/worker bundle.
    const moduleName = 'playwright-core';
    const { chromium } = await import(/* @vite-ignore */ moduleName) as typeof import('playwright-core');
    const executablePath = browserExecutable(chromium);
    if (!executablePath) throw new Error('Chromium is unavailable. Install Chromium or set CONTROL_TOWER_BROWSER_EXECUTABLE_PATH.');
    const browser = await chromium.launch({
      executablePath, headless: true, timeout: 10_000,
      // All page HTTP goes through guarded Node transport. Refuse any Chromium network path that escapes routing.
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
    });
    const controller = new AbortController();
    const deadline = Date.now() + 20_000;
    const timer = setTimeout(() => {
      controller.abort();
      void browser.close().catch(() => {});
    }, 20_000);
    try {
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      const page = await context.newPage();
      let requests = 0, bytes = 0, inFlight = 0, mainStatus: number | null = null;
      let mainError: Error | undefined;
      const pending: (() => void)[] = [];
      await context.routeWebSocket('**/*', (socket) => socket.close());
      await context.route('**/*', async (route) => {
        const request = route.request();
        const isMain = request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (!['GET', 'HEAD'].includes(request.method()) || ['image', 'media', 'font'].includes(request.resourceType())
            || ++requests > 40 || bytes >= 8 * 1024 * 1024 || controller.signal.aborted) {
          await route.abort().catch(() => {});
          return;
        }
        if (inFlight >= 4) await new Promise<void>((resolve) => pending.push(resolve));
        else inFlight += 1;
        try {
          if (controller.signal.aborted || bytes >= 8 * 1024 * 1024) { await route.abort(); return; }
          const response = await requestWebsite(request.url(), { followRedirects: false, maxBytes: 2 * 1024 * 1024,
            timeoutMs: Math.max(1, Math.min(8_000, deadline - Date.now())), method: request.method() as 'GET' | 'HEAD', signal: controller.signal });
          bytes += response.body.length;
          if (bytes > 8 * 1024 * 1024) throw new WebsiteNetworkError('limit', 'The browser exceeded the total download-size limit.');
          if (isMain) mainStatus = response.status;
          await route.fulfill({ status: response.status, headers: response.headers, body: response.body });
        } catch (error) {
          if (isMain) mainError = error instanceof Error ? error : new Error('Browser navigation failed.');
          await route.abort().catch(() => {});
        } finally {
          const next = pending.shift();
          if (next) next(); else inFlight -= 1;
        }
      });
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 16_000 }); }
      catch (error) { throw mainError ?? error; }
      // Give client-side rendering a bounded chance to produce readable text.
      await page.waitForFunction(() => (document.body?.innerText.trim().length ?? 0) >= 80, null, { timeout: 3000 }).catch(() => {});
      if (mainError) throw mainError;
      const finalUrl = publicWebsiteUrl(page.url()).href;
      const { title, text } = await page.evaluate(() => ({ title: document.title.slice(0, 300), text: document.body?.innerText.slice(0, 100_000) ?? '' }));
      return { finalUrl, httpStatus: mainStatus, title: title || null, text: text.replace(/\s+/g, ' ').trim() };
    } finally {
      clearTimeout(timer);
      controller.abort();
      await browser.close();
    }
  });
}

function errorClassification(error: unknown): WebsiteClassification {
  if (error instanceof WebsiteNetworkError) {
    return { status: error.kind === 'invalid' ? 'invalid' : error.kind === 'timeout' ? 'timed_out' : error.kind === 'limit' ? 'needs_review' : 'failed', detail: error.message };
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { status: 'failed', detail: 'The website hostname could not be resolved.' };
  if (code && /CERT|SSL|TLS|SELF_SIGNED/.test(code)) return { status: 'failed', detail: 'The website could not establish a trusted HTTPS connection.' };
  return { status: 'failed', detail: 'The website connection failed.' };
}

export type WebsiteCheckerDependencies = {
  request?: typeof requestWebsite;
  browser?: (url: string) => Promise<PageEvidence>;
};

/** Public-site reachability only; never qualifies company identity, ICP or email deliverability. */
export async function checkWebsite(value: string, dependencies: WebsiteCheckerDependencies = {}): Promise<WebsiteCheckResult> {
  const base = { url: value, finalUrl: null, httpStatus: null, title: null, method: 'http' as const, checkedAt: new Date().toISOString() };
  let url: string;
  try { url = publicWebsiteUrl(value).href; }
  catch (error) { return { ...base, ...errorClassification(error) }; }
  let http: WebsiteCheckResult;
  let useBrowser = false;
  try {
    const response = await (dependencies.request ?? requestWebsite)(url);
    const { evidence, classification } = classifyHttp(response);
    http = { ...base, ...classification, finalUrl: evidence.finalUrl, httpStatus: evidence.httpStatus, title: evidence.title };
    useBrowser = classification.status === 'blocked' || (classification.status === 'needs_review'
      && !/parked|non-HTML/.test(classification.detail));
  } catch (error) {
    const classification = errorClassification(error);
    http = { ...base, ...classification };
    const code = (error as NodeJS.ErrnoException)?.code;
    useBrowser = classification.status === 'timed_out' || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(code ?? '');
  }
  if (!useBrowser) return http;
  try {
    const evidence = await (dependencies.browser ?? checkInBrowser)(url);
    return { ...base, ...classify(evidence), method: 'browser', finalUrl: evidence.finalUrl, httpStatus: evidence.httpStatus, title: evidence.title };
  } catch (error) {
    if (error instanceof WebsiteNetworkError && error.kind === 'invalid') {
      return { ...http, method: 'browser', status: 'invalid', detail: error.message };
    }
    const reason = error instanceof Error && /Chromium|executable/.test(error.message) ? error.message : 'The browser retry did not complete.';
    return { ...http, detail: `${http.detail} Browser fallback: ${reason}` };
  }
}
