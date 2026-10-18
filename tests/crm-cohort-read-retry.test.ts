import { describe, expect, it, vi } from 'vitest';
import { retryCrmCohortRead, waitForCrmRead } from '../lib/crm-cohort-read-retry';

function runtime() {
  let time = Date.parse('2026-10-13T16:00:00Z');
  const waits: number[] = [];
  return { signal: new AbortController().signal, now: () => time, random: () => 0,
    wait: async (ms: number) => { waits.push(ms); time += ms; }, waits, onWait: vi.fn() };
}
describe('foreground CRM cohort read recovery', () => {
  it('honors numeric and date cooldowns and retries the same read after a connection failure', async () => {
    const r = runtime();
    const read = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(Response.json({ error: 'Rate limited' }, { status: 429, headers: { 'retry-after': '30' } }))
      .mockResolvedValueOnce(Response.json({ error: 'Busy', retryable: true, retryAt: '2026-10-13T16:01:30Z' }, { status: 503,
        headers: { 'retry-after': 'Tue, 13 Oct 2026 16:01:00 GMT' } }))
      .mockResolvedValueOnce(Response.json({ contacts: [], nextCursor: '20' }));
    await expect(retryCrmCohortRead({ ...r, read })).resolves.toEqual({ contacts: [], nextCursor: '20' });
    expect(r.waits).toEqual([1_000, 30_000, 59_000]);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it('stops permission and explicitly permanent failures without repeatedly reading', async () => {
    for (const response of [Response.json({ error: 'Reconnect HubSpot' }, { status: 403 }), Response.json({ error: 'Fix configuration', retryable: false }, { status: 503 })]) {
      const r = runtime(), read = vi.fn().mockResolvedValue(response);
      await expect(retryCrmCohortRead({ ...r, read })).rejects.toThrow();
      expect(read).toHaveBeenCalledOnce(); expect(r.waits).toEqual([]);
    }
  });
  it('defers a long server cooldown without shortening it to the foreground budget', async () => {
    const r = runtime(), read = vi.fn().mockResolvedValue(Response.json({ error: 'Quota reached' }, { status: 429, headers: { 'retry-after': '3600' } }));
    await expect(retryCrmCohortRead({ ...r, read })).rejects.toThrow('2026-10-13T17:00:00.000Z');
    expect(read).toHaveBeenCalledOnce(); expect(r.waits).toEqual([]);
  });
  it('cancels an outstanding wait without dispatching another request', async () => {
    const controller = new AbortController();
    const read = vi.fn().mockResolvedValue(Response.json({ error: 'Busy' }, { status: 503 }));
    await expect(retryCrmCohortRead({ signal: controller.signal, read, onWait: () => controller.abort(), wait: waitForCrmRead })).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).toHaveBeenCalledOnce();
  });
});
