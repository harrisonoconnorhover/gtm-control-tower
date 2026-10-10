import { describe, expect, it, vi } from 'vitest';
import { createSalesforceCdcSubscriber } from '../scripts/lib/salesforce-cdc.mjs';

const origin = 'https://fictional.my.salesforce.com';
const relayUrl = 'https://control-tower.example.test/api/control-tower/events/salesforce';
const organizationId = '00D000000000001';
const channel = '/data/ChangeEvents';
const configuration = { instanceUrl: origin, organizationId, accessToken: 'fixture-native-token', relaySecret: 'fixture-relay-secret-longer-than-thirty-two', relayUrl, checkpointPath: '/fixture/checkpoint.json' };
const payload = { ChangeEventHeader: { entityName: 'Account', recordIds: ['001000000000001'], transactionKey: 'tx-one', sequenceNumber: 1, changeType: 'UPDATE', commitTimestamp: 1791205200000 }, Name: 'Fictional Company' };
const event = (replayId: string | number = 123) => ({ channel, data: { event: { replayId }, payload } });
function harness(options: { initialState?: Record<string, unknown>; onConnect?: (count: number) => unknown[]; onSubscribe?: (count: number) => unknown[]; onRelay?: (body: Record<string, unknown>, count: number) => Response | Promise<Response>; failPersistence?: boolean } = {}) {
  let saved = options.initialState ? structuredClone(options.initialState) : null;
  const snapshots: unknown[] = [];
  let connectCount = 0; let subscribeCount = 0; let relayCount = 0;
  const fetcher = vi.fn(async (target: string | URL, init: RequestInit) => {
    const url = String(target);
    if (url === relayUrl) {
      const body = JSON.parse(String(init.body));
      if (options.onRelay) return options.onRelay(body, ++relayCount);
      return Response.json({ replayId: body.replayId, accepted: body.events.length, needsReconciliation: Boolean(body.gapReason) });
    }
    if (url.includes('/services/data/')) return Response.json({ done: true, records: [{ Id: organizationId }] });
    const message = JSON.parse(String(init.body))[0];
    if (message.channel === '/meta/handshake') return Response.json([{ channel: '/meta/handshake', successful: true, clientId: 'fixture-client', supportedConnectionTypes: ['long-polling'], ext: { replay: true } }], { headers: { 'set-cookie': 'BAYEUX_BROWSER=fixture-cookie; Secure; HttpOnly; Path=/' } });
    if (message.channel === '/meta/subscribe') return Response.json(options.onSubscribe?.(++subscribeCount) ?? [{ channel: '/meta/subscribe', successful: true }]);
    if (message.channel === '/meta/connect') return Response.json(options.onConnect?.(++connectCount) ?? [event(), { channel: '/meta/connect', successful: true }]);
    return Response.json([{ channel: '/meta/disconnect', successful: true }]);
  });
  const sleep = vi.fn(async () => undefined);
  const subscriber = createSalesforceCdcSubscriber(configuration, {
    fetch: fetcher, sleep, onStatus: vi.fn(), readState: async () => saved,
    writeState: async (_path: string, state: Record<string, unknown>) => {
      if (options.failPersistence) throw new Error('disk full');
      saved = structuredClone(state); snapshots.push(structuredClone(state));
    },
  });
  return { subscriber, fetcher, sleep, snapshots, saved: () => saved };
}
const checkpoint = (replayId = '99') => ({ version: 1, organizationId, channel, instance: origin, relayUrl, nativeReplayId: replayId, relayReplayId: replayId, acknowledgedAt: '2026-10-01T00:00:00Z', pending: null });

describe('optional Salesforce native CDC subscriber', () => {
  it('handshakes, subscribes with replay, forwards decoded events and checkpoints only after acknowledgement', async () => {
    const test = harness();
    await test.subscriber.run({ maxConnects: 1 });
    const nativeCalls = test.fetcher.mock.calls.filter(([target]) => String(target).startsWith(origin));
    const relayCalls = test.fetcher.mock.calls.filter(([target]) => String(target) === relayUrl);
    expect(nativeCalls.every(([, init]) => (init.headers as Record<string, string>).authorization === 'Bearer fixture-native-token' && init.redirect === 'error')).toBe(true);
    expect(nativeCalls.every(([, init]) => !(init.headers as Record<string, string>)['x-control-tower-signature'])).toBe(true);
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0][1].headers).not.toHaveProperty('authorization');
    expect(relayCalls[0][1].headers).not.toHaveProperty('cookie');
    const subscribe = nativeCalls.map(([, init]) => init.body ? JSON.parse(String(init.body))[0] : null).find((message) => message?.channel === '/meta/subscribe');
    expect(subscribe.ext.replay[channel]).toBe(-2);
    const connect = nativeCalls.find(([, init]) => String(init.body).includes('/meta/connect'))!;
    expect(connect[1].headers).toHaveProperty('cookie', 'BAYEUX_BROWSER=fixture-cookie');
    expect(test.snapshots).toContainEqual(expect.objectContaining({ nativeReplayId: null, pending: expect.objectContaining({ envelope: expect.objectContaining({ replayId: '123' }) }) }));
    expect(test.saved()).toMatchObject({ nativeReplayId: '123', relayReplayId: '123', pending: null });
  });

  it('preserves an in-flight envelope over lost response and retries it exactly before resubscribing', async () => {
    let attempts = 0;
    const requests: string[] = [];
    const test = harness({ onRelay: async (body) => { requests.push(JSON.stringify(body)); if (++attempts === 1) throw new Error('response lost'); return Response.json({ replayId: body.replayId, accepted: 0 }); }, onConnect: (count) => count === 1 ? [event(), { channel: '/meta/connect', successful: true }] : [{ channel: '/meta/connect', successful: true }] });
    await test.subscriber.run({ maxConnects: 1 });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(test.sleep).toHaveBeenCalled();
    const subscriptions = test.fetcher.mock.calls.filter(([target, init]) => String(target).startsWith(origin) && String(init.body).includes('/meta/subscribe')).map(([, init]) => JSON.parse(String(init.body))[0]);
    expect(subscriptions[1].ext.replay[channel]).toBe(123);
    expect(test.saved()).toMatchObject({ nativeReplayId: '123', pending: null });
  });

  it('restores an exact pending envelope after process restart before touching the native stream', async () => {
    const state = checkpoint('99');
    const pending = { nativeReplayId: '100', envelope: { organizationId, channel, replayId: '100', previousReplayId: '99', events: [payload] } };
    const test = harness({ initialState: { ...state, pending }, onConnect: () => [{ channel: '/meta/connect', successful: true }] });
    await test.subscriber.run({ maxConnects: 1 });
    expect(String(test.fetcher.mock.calls[0][0])).toBe(relayUrl);
    expect(JSON.parse(String(test.fetcher.mock.calls[0][1].body))).toEqual(pending.envelope);
    expect(test.saved()).toMatchObject({ nativeReplayId: '100', pending: null });
  });

  it('reports invalid replay as a durable gap before restarting retained-history replay', async () => {
    const test = harness({ initialState: checkpoint(), onSubscribe: (count) => count === 1 ? [{ channel: '/meta/subscribe', successful: false, error: '400::The replayId 99 you provided was invalid.' }] : [{ channel: '/meta/subscribe', successful: true }] });
    await test.subscriber.run({ maxConnects: 1 });
    const relays = test.fetcher.mock.calls.filter(([target]) => String(target) === relayUrl).map(([, init]) => JSON.parse(String(init.body)));
    expect(relays[0]).toMatchObject({ previousReplayId: '99', events: [], gapReason: expect.stringContaining('rejected') });
    expect(relays[1].previousReplayId).toBe(relays[0].replayId);
    const subscriptions = test.fetcher.mock.calls.filter(([target, init]) => String(target).startsWith(origin) && String(init.body).includes('/meta/subscribe')).map(([, init]) => JSON.parse(String(init.body))[0]);
    expect(subscriptions.map((message) => message.ext.replay[channel])).toEqual([99, -2]);
  });

  it('stops on revoked authentication or receiver checkpoint conflicts without advancing', async () => {
    const denied = harness({ initialState: checkpoint(), onConnect: () => [{ channel: '/meta/connect', successful: false, error: '401::Authentication invalid', advice: { reconnect: 'none' } }] });
    await expect(denied.subscriber.run({ maxConnects: 1 })).rejects.toThrow('rejected');
    expect(denied.saved()).toMatchObject({ nativeReplayId: '99' });
    const conflict = harness({ initialState: checkpoint(), onRelay: () => new Response(null, { status: 409 }) });
    await expect(conflict.subscriber.run({ maxConnects: 1 })).rejects.toThrow('409');
    expect(conflict.saved()).toMatchObject({ nativeReplayId: '99', pending: expect.any(Object) });
  });

  it('preserves large opaque numeric replay IDs exactly, without arithmetic', async () => {
    const test = harness({ initialState: checkpoint('9007199254740993123'), onConnect: () => [{ channel: '/meta/connect', successful: true }] });
    await test.subscriber.run({ maxConnects: 1 });
    const subscription = test.fetcher.mock.calls.find(([target, init]) => String(target).startsWith(origin) && String(init.body).includes('/meta/subscribe'))!;
    expect(String(subscription[1].body)).toContain('"/data/ChangeEvents":9007199254740993123');
    expect(test.saved()).toMatchObject({ nativeReplayId: '9007199254740993123' });
  });

  it('permits only pinned HTTPS or local relay destinations and rejects credential-bearing native URLs', () => {
    expect(() => createSalesforceCdcSubscriber({ ...configuration, relayUrl: 'http://outside.example.test/api/control-tower/events/salesforce' })).toThrow('HTTPS');
    expect(() => createSalesforceCdcSubscriber({ ...configuration, relayUrl: 'http://app:3000/api/control-tower/events/salesforce' })).not.toThrow();
    expect(() => createSalesforceCdcSubscriber({ ...configuration, instanceUrl: 'https://user:secret@fictional.my.salesforce.com' })).toThrow('HTTPS');
    expect(() => createSalesforceCdcSubscriber({ ...configuration, channel: '/topic/Arbitrary' })).toThrow('supported');
  });

  it('does not start native calls when the checkpoint cannot be persisted or belongs to another account', async () => {
    const disk = harness({ failPersistence: true });
    await expect(disk.subscriber.run({ maxConnects: 1 })).rejects.toThrow('persisted');
    expect(disk.fetcher).not.toHaveBeenCalled();
    const foreign = harness({ initialState: { ...checkpoint(), organizationId: '00D000000000002' } });
    await expect(foreign.subscriber.run({ maxConnects: 1 })).rejects.toThrow('another connection');
    expect(foreign.fetcher).not.toHaveBeenCalled();
  });
});
