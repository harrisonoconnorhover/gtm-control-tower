import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrmReadDeferredError, crmRetryAfterMs, readCrmJson, resetCrmReadTransportForTests, withCrmRequestGate } from '../lib/crm-read-transport';

const hubspot = { provider: 'hubspot' as const, accessToken: 'fictional-token' };
const url = 'https://api.hubapi.com/crm/v3/objects/contacts/101';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T12:00:00Z')); resetCrmReadTransportForTests(); });
afterEach(() => { resetCrmReadTransportForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));

describe('paced, resumable CRM reads', () => {
  it('paces 200 fictional reads, bounds concurrency and shares cooldown across retries and sibling requests', async () => {
    const starts: number[] = []; let active = 0; let peak = 0; let throttledAt = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const call = starts.length; starts.push(Date.now()); active += 1; peak = Math.max(active, peak);
      await new Promise((resolve) => setTimeout(resolve, 400)); active -= 1;
      if (call === 8) { throttledAt = Date.now(); return Response.json({}, { status: 429, headers: { 'retry-after': '2' } }); }
      if (call === 20) return Response.json({}, { status: 503 });
      if (call === 41) throw new TypeError('Fictional network interruption');
      return Response.json({ id: '101' });
    }));
    const completed = outcome(Promise.all(Array.from({ length: 200 }, () => readCrmJson(url, {}, hubspot, { budgetMs: 90_000 }))));
    await vi.runAllTimersAsync();
    const result = await completed;
    expect(result.error).toBeNull(); expect(result.value).toHaveLength(200);
    expect(starts).toHaveLength(203); expect(peak).toBeLessThanOrEqual(2);
    expect(starts.slice(1).every((start, index) => start - starts[index] >= 250)).toBe(true);
    expect(starts.filter((start) => start > throttledAt && start < throttledAt + 2_000)).toEqual([]);
  });

  it('honors full numeric and HTTP-date Retry-After values and defers without clipping long delays', async () => {
    const now = Date.now();
    expect(crmRetryAfterMs('120', now)).toBe(120_000);
    expect(crmRetryAfterMs(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}, { status: 429, headers: { 'retry-after': '120' } }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await outcome(readCrmJson(url, {}, hubspot));
    expect(first.error).toMatchObject({ reason: 'rate_limit', retryAt: new Date(now + 120_000).toISOString(), status: 429 });
    const sibling = await outcome(readCrmJson(url, {}, hubspot));
    expect(sibling.error).toBeInstanceOf(CrmReadDeferredError); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [hubspot, url, 429, { policyName: 'DAILY' }],
    [{ provider: 'salesforce' as const, accessToken: 'fictional-sf-token', origin: 'https://fictional.my.salesforce.com' },
      'https://fictional.my.salesforce.com/services/data/v67.0/query?q=SELECT%20Id%20FROM%20Organization', 403, [{ errorCode: 'REQUEST_LIMIT_EXCEEDED' }]],
  ])('defers a provider quota instead of treating it as permission denial or retrying it repeatedly', async (scope, endpoint, status, body) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(body, { status })); vi.stubGlobal('fetch', fetchMock);
    const result = await outcome(readCrmJson(endpoint, {}, scope));
    expect(result.error).toMatchObject({ reason: 'quota', status, retryAt: new Date(Date.now() + 3_600_000).toISOString() }); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 500])('returns permanent/non-retryable HTTP %s without repeating the request', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({}, { status })); vi.stubGlobal('fetch', fetchMock);
    expect((await readCrmJson(url, {}, hubspot)).response.status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a permission denial even when its error body is interrupted', async () => {
    const response = new Response(null, { status: 403 }); vi.spyOn(response, 'json').mockRejectedValue(new TypeError('Interrupted body'));
    const fetchMock = vi.fn().mockResolvedValue(response); vi.stubGlobal('fetch', fetchMock);
    expect((await readCrmJson(url, {}, hubspot)).response.status).toBe(403); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns malformed success JSON for the caller to reject without fabricating a retry result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{invalid', { status: 200 })); vi.stubGlobal('fetch', fetchMock);
    expect((await readCrmJson(url, {}, hubspot)).payload).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries an aborted per-attempt timeout within its elapsed budget', async () => {
    resetCrmReadTransportForTests({ attemptTimeoutMs: 500 });
    const fetchMock = vi.fn().mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })).mockResolvedValueOnce(Response.json({ id: '101' })); vi.stubGlobal('fetch', fetchMock);
    const pending = outcome(readCrmJson(url, {}, hubspot)); await vi.runAllTimersAsync();
    expect((await pending).value?.payload).toEqual({ id: '101' }); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops transient failures at the elapsed deadline with a resumable error', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Response.json({}, { status: 503 })); vi.stubGlobal('fetch', fetchMock);
    const now = Date.now(); const pending = outcome(readCrmJson(url, {}, hubspot, { budgetMs: 2_000 }));
    await vi.runAllTimersAsync();
    expect((await pending).error).toMatchObject({ reason: 'transient', status: 503 });
    expect(Date.now() - now).toBeLessThan(2_000); expect(fetchMock.mock.calls.length).toBeLessThan(8);
  });

  it('respects Retry-After on service unavailability too', async () => {
    const starts: number[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      starts.push(Date.now()); return starts.length === 1 ? Response.json({}, { status: 503, headers: { 'retry-after': '3' } }) : Response.json({});
    }));
    const pending = outcome(readCrmJson(url, {}, hubspot)); await vi.runAllTimersAsync();
    expect((await pending).error).toBeNull(); expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(3_000);
  });

  it('cancels queued work and retry sleep without dispatching it', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => Response.json({}, { status: 429, headers: { 'retry-after': '3' } })); vi.stubGlobal('fetch', fetchMock);
    const first = outcome(readCrmJson(url, {}, hubspot, { signal: controller.signal }));
    const second = outcome(readCrmJson(url, {}, hubspot, { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(50); controller.abort(); await vi.runAllTimersAsync();
    expect((await first).error).toMatchObject({ name: 'AbortError' }); expect((await second).error).toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('limits retry eligibility to reads and never repeats a write gate callback', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Response.json({})); vi.stubGlobal('fetch', fetchMock);
    for (const method of ['PATCH', 'DELETE', 'POST']) await expect(readCrmJson(url, { method }, hubspot)).rejects.toThrow('allowlisted read');
    const search = outcome(readCrmJson('https://api.hubapi.com/crm/v3/objects/deals/search', { method: 'POST' }, hubspot));
    const batch = outcome(readCrmJson('https://api.hubapi.com/crm/objects/2026-03/contacts/batch/read', { method: 'POST' }, hubspot));
    await vi.runAllTimersAsync(); expect((await search).error).toBeNull(); expect((await batch).error).toBeNull();
    const write = vi.fn().mockRejectedValue(new TypeError('Ambiguous write response'));
    const pending = outcome(withCrmRequestGate(hubspot, write)); await vi.runAllTimersAsync();
    expect((await pending).error).toMatchObject({ message: 'Ambiguous write response' }); expect(write).toHaveBeenCalledTimes(1);
  });

  it('lets another credential progress while the first credential is cooling down', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'retry-after': '120' } })).mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal('fetch', fetchMock);
    expect((await outcome(readCrmJson(url, {}, hubspot))).error).toBeInstanceOf(CrmReadDeferredError);
    expect((await readCrmJson(url, {}, { ...hubspot, accessToken: 'another-fictional-token' })).response.ok).toBe(true);
  });
});
