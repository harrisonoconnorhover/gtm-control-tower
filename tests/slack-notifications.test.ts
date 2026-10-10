import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '../db';
import { deliverSlackNotifications, enqueueSlackNotification, getSlackNotificationEventState, getSlackNotificationStatus, type SlackNotificationEvent } from '../lib/slack-notifications';

const directory = mkdtempSync(join(tmpdir(), 'gtm-slack-'));
process.env.CONTROL_TOWER_SQLITE_PATH = join(directory, 'slack.db');
const webhook = 'https://hooks.slack.com/services/T_FIXTURE/B_FIXTURE/fixture-secret';
const initialTime = new Date('2026-10-10T12:00:00.000Z');
const event = (key: string, provider: SlackNotificationEvent['provider'] = 'hubspot'): SlackNotificationEvent => ({
  key, provider, title: 'Watchdog needs attention', summary: '3 findings require review.', path: `/app/watchdog?provider=${provider}&finding=fixture`,
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(initialTime);
  vi.stubEnv('CONTROL_TOWER_SLACK_WEBHOOK_URL', webhook);
  vi.stubEnv('CONTROL_TOWER_APP_URL', 'https://tower.example.test');
  await getSlackNotificationStatus();
  const db = await getDatabase();
  await db.batch([
    db.prepare('DELETE FROM slack_notification_events'),
    db.prepare('DELETE FROM slack_notification_deliveries'),
    db.prepare('UPDATE slack_notification_control SET lease_id = NULL, lease_expires_at = NULL, next_attempt_at = NULL'),
  ]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('durable Slack incoming-webhook notifications', () => {
  it('does not queue history or send while disabled, and returns only safe configuration errors', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.stubEnv('CONTROL_TOWER_SLACK_WEBHOOK_URL', '');
    await enqueueSlackNotification(event('disabled'));
    expect(await getSlackNotificationEventState('disabled')).toBeNull();
    expect(await deliverSlackNotifications()).toMatchObject({ configured: false, pending: 0, lastDelivery: null });
    for (const invalid of [
      'https://hooks.slack.com.evil.test/services/T/B/fixture-secret',
      'http://hooks.slack.com/services/T/B/fixture-secret',
      'https://user:fixture-secret@hooks.slack.com/services/T/B/token',
      'https://hooks.slack.com/services/T/B/fixture-secret?other=true',
    ]) {
      vi.stubEnv('CONTROL_TOWER_SLACK_WEBHOOK_URL', invalid);
      await enqueueSlackNotification(event('invalid'));
      const status = await getSlackNotificationStatus();
      expect(status).toMatchObject({ configured: false, pending: 0 });
      expect(status.error).toBeTruthy();
      expect(JSON.stringify(status)).not.toContain('fixture-secret');
    }
    vi.stubEnv('CONTROL_TOWER_SLACK_WEBHOOK_URL', webhook);
    vi.stubEnv('CONTROL_TOWER_APP_URL', 'http://public.example.test');
    expect((await getSlackNotificationStatus()).configured).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('deduplicates events, sends one bounded mixed-provider digest, and protects labels and links', async () => {
    const fetcher = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const hostile = { ...event('one'), title: '<!channel> *untrusted*', summary: '<@U123> & text' };
    await Promise.all([enqueueSlackNotification(hostile), enqueueSlackNotification(hostile)]);
    await enqueueSlackNotification(event('two', 'salesforce'));
    await enqueueSlackNotification({ ...event('three', 'system'), path: '/app/work', title: 'Connection test' });
    const status = await deliverSlackNotifications();
    expect(status).toMatchObject({ delivered: 3, pending: 0, lastDelivery: { state: 'delivered', eventCount: 3 } });
    expect(await getSlackNotificationEventState('one')).toBe('delivered');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(webhook);
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    const body = JSON.parse(String(options.body));
    expect(body).toMatchObject({ unfurl_links: false, unfurl_media: false });
    expect(body.text).toContain('1 HubSpot · 1 Salesforce · 1 Control Tower');
    expect(body.blocks[2].text).toEqual({ type: 'plain_text', text: 'HubSpot · <!channel> *untrusted*\n<@U123> & text', emoji: false });
    expect(body.blocks[3].elements[0].text).toBe('<https://tower.example.test/app/watchdog?provider=hubspot&amp;finding=fixture|Open in Control Tower>');
    await enqueueSlackNotification(hostile);
    vi.setSystemTime(new Date(initialTime.getTime() + 2000));
    await deliverSlackNotifications();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(enqueueSlackNotification({ ...event('external'), path: '//evil.test/app' })).rejects.toThrow('Invalid Slack');
    await expect(enqueueSlackNotification({ ...event('slash'), path: '/app/\\evil.test' })).rejects.toThrow('Invalid Slack');
  });

  it('allows only one concurrent sender, claims before POST, and respects the one-second rate guard', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async () => { enter(); await gate; return new Response('ok'); });
    vi.stubGlobal('fetch', fetcher);
    await Promise.all(Array.from({ length: 25 }, (_, index) => enqueueSlackNotification(event(`bounded-${index}`))));
    const first = deliverSlackNotifications();
    await entered;
    const concurrent = await deliverSlackNotifications();
    expect(concurrent).toMatchObject({ sending: 20, pending: 5, lastDelivery: { state: 'sending', eventCount: 20 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toMatchObject({ delivered: 20, pending: 5 });
    await deliverSlackNotifications();
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(initialTime.getTime() + 1001));
    expect(await deliverSlackNotifications()).toMatchObject({ delivered: 25, pending: 0, lastDelivery: { eventCount: 5 } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('requeues only a definite 429 rejection and honors Retry-After across delivery calls', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('rate_limited', { status: 429, headers: { 'Retry-After': '30' } }))
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetcher);
    await enqueueSlackNotification(event('rate-limit'));
    expect(await deliverSlackNotifications()).toMatchObject({ pending: 1, delivered: 0, nextAttemptAt: '2026-10-10T12:00:30.000Z', lastDelivery: { state: 'rate_limited' } });
    expect(await getSlackNotificationEventState('rate-limit')).toBe('pending');
    vi.setSystemTime(new Date(initialTime.getTime() + 29_999));
    await deliverSlackNotifications();
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(initialTime.getTime() + 30_000));
    expect(await deliverSlackNotifications()).toMatchObject({ pending: 0, delivered: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([400, 403, 404])('records HTTP %s as a rejected delivery without leaking the response or retrying', async (code) => {
    const fetcher = vi.fn(async () => new Response(webhook, { status: code }));
    vi.stubGlobal('fetch', fetcher);
    await enqueueSlackNotification(event(`rejected-${code}`));
    const status = await deliverSlackNotifications();
    expect(status).toMatchObject({ failed: 1, lastDelivery: { state: 'failed' } });
    expect(JSON.stringify(status)).not.toContain('fixture-secret');
    vi.setSystemTime(new Date(initialTime.getTime() + 2000));
    await deliverSlackNotifications();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'server', 'unexpected'] as const)('holds %s outcomes as unknown without repeating a possible accepted message', async (kind) => {
    const fetcher = vi.fn(async () => {
      if (kind === 'network') throw new Error(`Connection to ${webhook} lost`);
      return new Response(webhook, { status: kind === 'server' ? 500 : 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    await enqueueSlackNotification(event(`unknown-${kind}`));
    const status = await deliverSlackNotifications();
    expect(status).toMatchObject({ unknown: 1, lastDelivery: { state: 'unknown' } });
    expect(JSON.stringify(status)).not.toContain('fixture-secret');
    vi.setSystemTime(new Date(initialTime.getTime() + 2000));
    await deliverSlackNotifications();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recovers an interrupted sending claim as unknown and fences a late successful response', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn().mockImplementationOnce(async () => { enter(); await gate; return new Response('ok'); })
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetcher);
    await enqueueSlackNotification(event('interrupted'));
    const interrupted = deliverSlackNotifications();
    await entered;
    expect(await getSlackNotificationEventState('interrupted')).toBe('sending');
    vi.setSystemTime(new Date(initialTime.getTime() + 61_000));
    await enqueueSlackNotification(event('new-event', 'salesforce'));
    expect(await deliverSlackNotifications()).toMatchObject({ unknown: 1, delivered: 1, pending: 0 });
    release();
    await interrupted;
    expect(await getSlackNotificationEventState('interrupted')).toBe('unknown');
    expect(await getSlackNotificationEventState('new-event')).toBe('delivered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('supports Slack government webhooks and localhost app links without persisting webhook secrets', async () => {
    vi.stubEnv('CONTROL_TOWER_SLACK_WEBHOOK_URL', 'https://hooks.slack-gov.com/services/T/B/fixture-secret');
    vi.stubEnv('CONTROL_TOWER_APP_URL', 'http://localhost:3000');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
    await enqueueSlackNotification(event('gov'));
    expect(await deliverSlackNotifications()).toMatchObject({ configured: true, delivered: 1 });
    const db = await getDatabase();
    const events = await db.prepare('SELECT * FROM slack_notification_events').all();
    const deliveries = await db.prepare('SELECT * FROM slack_notification_deliveries').all();
    expect(JSON.stringify({ events, deliveries })).not.toContain('fixture-secret');
  });
});
