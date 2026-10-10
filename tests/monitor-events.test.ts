import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  receiveHubSpotMonitorEvents, receiveSalesforceMonitorEvents, getMonitorEventStatus,
  takePendingMonitorEvents, markMonitorEventProcessed, markMonitorEventFailed, retryHeldMonitorEvents,
  markMonitorEventsReconciled, getRecentMonitorEvents,
} from '../lib/monitor-events';
import { getDatabase } from '../db';

const directory = mkdtempSync(join(tmpdir(), 'gtm-native-monitor-'));
const portal = '87654321';
const org = '00D000000000001';
const scope = `salesforce_${org}`;
const secret = 'synthetic-relay-secret-with-32-characters';
const hubspotUrl = 'https://control-tower.example.test/api/control-tower/events/hubspot';
const salesforceUrl = 'https://control-tower.example.test/api/control-tower/events/salesforce';
process.env.CONTROL_TOWER_SQLITE_PATH = join(directory, 'monitor.db');
beforeEach(() => {
  vi.stubEnv('HUBSPOT_MONITOR_CLIENT_SECRET', secret);
  vi.stubEnv('HUBSPOT_MONITOR_PORTAL_ID', portal);
  vi.stubEnv('HUBSPOT_MONITOR_WEBHOOK_URL', hubspotUrl);
  vi.stubEnv('CONTROL_TOWER_CDC_RELAY_SECRET', secret);
  vi.stubEnv('SALESFORCE_MONITOR_ORG_ID', org);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const now = () => Date.now();
function hubspot(value: unknown, options: { time?: number; secret?: string } = {}) {
  const body = JSON.stringify(value);
  const timestamp = String(options.time ?? now());
  const signature = createHmac('sha256', options.secret ?? secret).update(`POST${hubspotUrl}${body}${timestamp}`).digest('base64');
  return new Request(hubspotUrl, { method: 'POST', body, headers: { 'x-hubspot-request-timestamp': timestamp, 'x-hubspot-signature-v3': signature } });
}
function salesforce(value: unknown) {
  const body = JSON.stringify(value); const timestamp = String(now());
  const signature = createHmac('sha256', secret).update(`${timestamp}\nPOST\n/api/control-tower/events/salesforce\n${body}`).digest('hex');
  return new Request(salesforceUrl, { method: 'POST', body, headers: { 'x-control-tower-timestamp': timestamp, 'x-control-tower-signature': signature } });
}
const hubspotEvent = (extra: Record<string, unknown> = {}) => ({ portalId: Number(portal), eventId: 1, subscriptionId: 2, subscriptionType: 'contact.propertyChange', objectId: 123, occurredAt: 1791205200000, propertyName: 'jobtitle', propertyValue: ' Engineer ', sourceId: 'userId:42', changeSource: 'CRM_UI', attemptNumber: 0, ...extra });
const cdc = (extra: Record<string, unknown> = {}) => ({ ChangeEventHeader: { entityName: 'Opportunity', recordIds: ['006000000000001', '006000000000002'], changeType: 'UPDATE', transactionKey: 'tx-1', sequenceNumber: 1, commitTimestamp: 1791205200000, commitUser: '005000000000001', changeOrigin: 'com/salesforce/api/rest/67.0;client=fixture', changedFields: ['StageName'], ...extra }, StageName: 'Discovery' });
const envelope = (replayId: string, previousReplayId: string | null, events: unknown[] = [cdc()], extra: Record<string, unknown> = {}) => ({ organizationId: org, channel: '/data/ChangeEvents', replayId, previousReplayId, events, ...extra });

describe('native CRM change intake', () => {
  it('verifies raw-body HMAC, timestamp and pinned account before saving HubSpot hints', async () => {
    await expect(receiveHubSpotMonitorEvents(hubspot([hubspotEvent()], { secret: 'wrong' }))).rejects.toThrow('signature');
    await expect(receiveHubSpotMonitorEvents(hubspot([hubspotEvent()], { time: now() - 300_001 }))).rejects.toThrow('timestamp');
    await expect(receiveHubSpotMonitorEvents(hubspot([hubspotEvent({ portalId: 987 })]))).rejects.toThrow('account');
    expect((await getMonitorEventStatus(portal)).pending).toBe(0);
    await receiveHubSpotMonitorEvents(hubspot([hubspotEvent()]));
    await receiveHubSpotMonitorEvents(hubspot([hubspotEvent({ attemptNumber: 2 })]));
    const pending = await takePendingMonitorEvents(portal);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'refresh', objectType: 'Contact', recordId: '123', source: { actorId: 'userId:42', origin: 'CRM_UI', changedFields: ['jobtitle'] } });
    expect(pending[0]).not.toHaveProperty('properties');
    expect(pending[0]).not.toHaveProperty('before');
    expect(pending[0].source).toMatchObject({ attribution: 'refresh_trigger_only', reportedValues: { jobtitle: ' Engineer ' } });
    await markMonitorEventProcessed(portal, pending[0].id);
    await receiveHubSpotMonitorEvents(hubspot([hubspotEvent({ attemptNumber: 3 })]));
    expect(await takePendingMonitorEvents(portal)).toEqual([]);
    const evidence = await getRecentMonitorEvents(portal, ['123']);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].source.reportedValues).toEqual({ jobtitle: ' Engineer ' });
    expect(evidence[0].processedAt).not.toBeNull();
  });

  it('does not rely on HubSpot eventId alone and preserves deletion as evidence without a made-up record', async () => {
    await receiveHubSpotMonitorEvents(hubspot([hubspotEvent({ objectId: 124 }), hubspotEvent({ objectId: 125, subscriptionType: 'company.deletion' })]));
    const pending = await takePendingMonitorEvents(portal);
    expect(pending).toHaveLength(2);
    expect(pending.find((event) => event.objectType === 'Company')).toMatchObject({ kind: 'delete', recordId: '125' });
    for (const event of pending) await markMonitorEventProcessed(portal, event.id);
  });

  it('atomically checkpoints ordered CDC payloads and deduplicates retries without replay ID arithmetic', async () => {
    const value = envelope('opaque:one==', null);
    expect(await receiveSalesforceMonitorEvents(salesforce(value))).toMatchObject({ accepted: 2, replayId: 'opaque:one==' });
    expect(await receiveSalesforceMonitorEvents(salesforce(value))).toMatchObject({ accepted: 0 });
    expect(await takePendingMonitorEvents(scope)).toHaveLength(2);
    await expect(receiveSalesforceMonitorEvents(salesforce(envelope('opaque:bad==', 'wrong')))).rejects.toThrow('checkpoint');
    const next = envelope('opaque:two==', 'opaque:one==', [cdc({ transactionKey: 'tx-2', recordIds: ['001000000000001'], entityName: 'Account' })]);
    await receiveSalesforceMonitorEvents(salesforce(next));
    await receiveSalesforceMonitorEvents(salesforce(value)); // old HTTP response retry cannot regress checkpoint
    expect((await getMonitorEventStatus(scope)).streams[0].replayId).toBe('opaque:two==');
    const pending = await takePendingMonitorEvents(scope);
    expect(pending).toHaveLength(3);
    expect(pending[0].source.kind).toBe('salesforce_cdc');
    expect(pending[0].source).toMatchObject({ attribution: 'refresh_trigger_only', reportedValues: { StageName: 'Discovery' } });
    for (const event of pending) await markMonitorEventProcessed(scope, event.id);
  });

  it('exposes native gaps and expired replay windows, preserving a gap received during baseline', async () => {
    const beforeGap = new Date(now() - 1000).toISOString();
    await receiveSalesforceMonitorEvents(salesforce(envelope('gap:one==', 'opaque:two==', [cdc({ changeType: 'GAP_OVERFLOW', recordIds: ['000000000000000AAA'], transactionKey: 'tx-gap' })])));
    let status = await getMonitorEventStatus(scope);
    expect(status.streams[0].needsReconciliation).toBe(true);
    const pending = await takePendingMonitorEvents(scope);
    expect(pending[0]).toMatchObject({ kind: 'gap', recordId: null });
    await markMonitorEventsReconciled(scope, beforeGap);
    expect((await getMonitorEventStatus(scope)).streams[0].needsReconciliation).toBe(true);
    await markMonitorEventsReconciled(scope, new Date(now() + 1000).toISOString());
    expect((await getMonitorEventStatus(scope)).streams[0].needsReconciliation).toBe(false);
    const db = await getDatabase();
    await db.prepare('UPDATE monitor_native_streams SET received_at=? WHERE account_id=?').bind(new Date(now() - 73 * 3600_000).toISOString(), scope).run();
    await receiveSalesforceMonitorEvents(salesforce(envelope('expired:one==', 'gap:one==', [cdc({ transactionKey: 'tx-expired' })])));
    status = await getMonitorEventStatus(scope);
    expect(status.streams[0]).toMatchObject({ needsReconciliation: true, detail: expect.stringContaining('72-hour') });
    for (const event of await takePendingMonitorEvents(scope)) await markMonitorEventProcessed(scope, event.id);
  });

  it('holds failing rehydration after bounded retries, and an explicit operator retry restores eligibility', async () => {
    await receiveHubSpotMonitorEvents(hubspot([hubspotEvent({ objectId: 199, eventId: 199 })]));
    const event = (await takePendingMonitorEvents(portal))[0];
    await markMonitorEventFailed(portal, event.id, 'HTTP 403');
    expect(await takePendingMonitorEvents(portal)).toHaveLength(0);
    await markMonitorEventFailed(portal, event.id, 'HTTP 403');
    await markMonitorEventFailed(portal, event.id, 'HTTP 403');
    expect((await getMonitorEventStatus(portal)).held).toBe(1);
    await retryHeldMonitorEvents(portal);
    expect((await getMonitorEventStatus(portal)).held).toBe(0);
    expect(await takePendingMonitorEvents(portal)).toHaveLength(1);
  });

  it('bounds retained native values and prunes only old processed evidence, never pending work', async () => {
    await receiveHubSpotMonitorEvents(hubspot([hubspotEvent({ eventId: 800, objectId: 800, propertyValue: 'x'.repeat(2000) }), hubspotEvent({ eventId: 801, objectId: 801 })]));
    const values = await getRecentMonitorEvents(portal, ['800', '801']);
    expect(values.find(event => event.recordId === '800')?.source).toMatchObject({ reportedValuesTruncated: true, reportedValues: { jobtitle: 'x'.repeat(1000) } });
    const db = await getDatabase();
    const old = new Date(now() - 31 * 86_400_000).toISOString();
    await db.prepare('UPDATE monitor_native_events SET received_at=? WHERE account_id=? AND id IN (?,?)').bind(old, portal, ...values.map(event => event.id)).run();
    await markMonitorEventProcessed(portal, values.find(event => event.recordId === '800')!.id);
    const remaining = await getRecentMonitorEvents(portal, ['800', '801']);
    expect(remaining.map(event => event.recordId)).toEqual(['801']);
  });

  it('enforces single-writer checkpoint advancement during simultaneous deliveries', async () => {
    const before = (await getMonitorEventStatus(scope)).streams[0].replayId;
    const values = ['race-a', 'race-b'].map((id) => envelope(id, before, [cdc({ transactionKey: id })]));
    const results = await Promise.allSettled(values.map((value) => receiveSalesforceMonitorEvents(salesforce(value))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const pending = await takePendingMonitorEvents(scope);
    expect(pending).toHaveLength(2); // the losing batch leaves no partial hints
    expect(new Set(pending.map((event) => event.source.transactionId)).size).toBe(1);
  });
});

it('accepts native association payloads without objectId and refreshes both explicitly typed endpoints', async () => {
  const association = { portalId: Number(portal), eventId: 910, subscriptionId: 2, subscriptionType: 'contact.associationChange',
    occurredAt: 1791205200000, associationType: 'CONTACT_TO_COMPANY', fromObjectId: 910, toObjectId: 911,
    associationRemoved: true, isPrimaryAssociation: true, attemptNumber: 0 };
  const property = hubspotEvent({ eventId: 912, objectId: 912 });
  expect(await receiveHubSpotMonitorEvents(hubspot([association, property]))).toEqual({ accepted: 3 });
  await receiveHubSpotMonitorEvents(hubspot([{ ...association, attemptNumber: 1 }]));
  const evidence = await getRecentMonitorEvents(portal, ['910', 'Company:911']);
  expect(evidence).toHaveLength(2);
  expect(evidence.map(event => `${event.objectType}:${event.recordId}`).sort()).toEqual(['Company:911', 'Contact:910']);
  for (const event of evidence) {
    expect(event.kind).toBe('refresh');
    expect(event.nativeDetails).toMatchObject({ associationType: 'CONTACT_TO_COMPANY', fromObjectId: '910', toObjectId: '911', associationRemoved: true, isPrimaryAssociation: true });
    expect(event.source.attribution).toBe('refresh_trigger_only');
  }
});

it('refreshes the new merge survivor, preserves old identities as evidence, and requests reconciliation', async () => {
  const merge = { portalId: Number(portal), eventId: 920, subscriptionId: 2, subscriptionType: 'contact.merge',
    occurredAt: 1791205200000, objectId: 920, primaryObjectId: 920, newObjectId: 922, mergedObjectIds: [921], numberOfPropertiesMoved: 7 };
  await receiveHubSpotMonitorEvents(hubspot([merge]));
  await receiveHubSpotMonitorEvents(hubspot([{ ...merge, attemptNumber: 2 }]));
  const evidence = await getRecentMonitorEvents(portal, ['921']); // Old identity can retrieve the merge context.
  expect(evidence).toHaveLength(2);
  expect(evidence.filter(event => event.kind === 'refresh').map(event => event.recordId)).toEqual(['922']);
  expect(evidence.find(event => event.kind === 'gap')).toMatchObject({ recordId: null, reason: expect.stringContaining('not remapped') });
  expect(evidence[0].nativeDetails).toMatchObject({ primaryObjectId: '920', newObjectId: '922', mergedObjectIds: ['921'], numberOfPropertiesMoved: 7 });
  expect((await getMonitorEventStatus(portal)).needsReconciliation).toBe(true);
  const noNewId = { ...merge, eventId: 923, primaryObjectId: 923, newObjectId: undefined, objectId: undefined, mergedObjectIds: [924] };
  await receiveHubSpotMonitorEvents(hubspot([noNewId]));
  expect((await getRecentMonitorEvents(portal, ['923'])).find(event => event.kind === 'refresh')?.recordId).toBe('923');
});

it('retains ambiguous association/merge evidence as baseline gaps instead of rejecting unrelated valid batch entries', async () => {
  const ambiguous = { portalId: Number(portal), eventId: 930, subscriptionId: 2, subscriptionType: 'deal.associationChange', occurredAt: 1791205200000,
    associationType: 'CUSTOM_RELATIONSHIP', fromObjectId: 930, toObjectId: 931, associationRemoved: false };
  const merge = { portalId: Number(portal), eventId: 932, subscriptionId: 2, subscriptionType: 'company.merge', occurredAt: 1791205200000,
    primaryObjectId: 932, newObjectId: 'unknown-survivor', mergedObjectIds: [933] };
  expect(await receiveHubSpotMonitorEvents(hubspot([ambiguous, merge, hubspotEvent({ objectId: 934, eventId: 934 })]))).toEqual({ accepted: 3 });
  const hints = (await takePendingMonitorEvents(portal, 50)).filter(event => ['930', '932', '934'].includes(event.source.eventId));
  expect(hints.filter(event => event.kind === 'gap')).toHaveLength(2);
  expect(hints.filter(event => event.kind === 'refresh').map(event => event.recordId)).toEqual(['934']);
  expect(hints.find(event => event.source.eventId === '930')?.nativeDetails).toMatchObject({ associationType: 'CUSTOM_RELATIONSHIP', fromObjectId: '930', toObjectId: '931' });
});
