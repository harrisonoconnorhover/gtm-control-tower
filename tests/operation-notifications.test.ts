import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureWatchdog, tickWatchdog, triageWatchdogFinding } from '@/lib/watchdog';
import { receiveImport, assignImportWork } from '@/lib/operations-inbox';
import { notifyImportExecution } from '@/lib/operation-notifications';
import { saveSafeImportReview } from '@/lib/safe-import-store';
import { defaultCrmUpdatePolicy } from '@/lib/crm-workflow';
import { safeImportCounts, type SafeImportExecution, type SafeImportReview } from '@/lib/safe-import';
import type { WatchdogContact } from '@/lib/watchdog-types';
import type { WatchdogSource } from '@/lib/watchdog-hubspot';
import { getDatabase } from '@/db';

const directory = mkdtempSync(join(tmpdir(), 'gtm-operation-notifications-'));
process.env.CONTROL_TOWER_SQLITE_PATH = join(directory, 'notifications.db');
vi.stubEnv('CONTROL_TOWER_SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/Tfixture/Bfixture/fictional');
vi.stubEnv('CONTROL_TOWER_APP_URL', 'https://tower.example.com');
const network = vi.fn(() => { throw new Error('Source events must never make a network request.'); });
vi.stubGlobal('fetch', network);
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
async function events(prefix: string) { return (await (await getDatabase()).prepare('SELECT event_key, provider, title, summary, path FROM slack_notification_events WHERE event_key LIKE ?').bind(`${prefix}%`).all<{ event_key: string; provider: string; title: string; summary: string; path: string }>()).results; }

describe('saved operations produce Slack events', () => {
  it('notifies new findings and verified repairs once, with no alerts for unchanged scans', async () => {
    const contact: WatchdogContact = { id: '101', updatedAt: '2026-10-01T12:00:00.000Z', properties: { email: 'private@example.com', firstname: 'Private Person', company: ' Private company ', jobtitle: 'Engineer', lifecyclestage: 'lead', hubspot_owner_id: '42' } };
    const source: WatchdogSource = {
      list: async () => ({ contacts: [structuredClone(contact)], after: null }),
      changes: async () => ({ contacts: [structuredClone(contact)], after: null, total: 1 }),
      read: async () => structuredClone(contact),
      patch: async (_id, properties) => { Object.assign(contact.properties, properties); contact.updatedAt = '2026-10-01T12:01:00.000Z'; },
    };
    await configureWatchdog('notif-hs', { enabled: true, automaticRepairs: true, intervalSeconds: 300, defaultAssignee: 'Private teammate' });
    const result = await tickWatchdog('notif-hs', 'unused', { force: true, source });
    expect(result.totals.fixed).toBe(1);
    expect(await events('finding:hubspot:notif-hs:')).toHaveLength(1);
    expect(await events('repair:notif-hs:')).toHaveLength(1);
    await tickWatchdog('notif-hs', 'unused', { force: true, source });
    expect(await events('finding:hubspot:notif-hs:')).toHaveLength(1); expect(await events('repair:notif-hs:')).toHaveLength(1);
    const serialized = JSON.stringify(await events(''));
    expect(serialized).not.toMatch(/private@example|Private Person|Private company|Private teammate/);
    expect(network).not.toHaveBeenCalled();
  });

  it('sends Salesforce human-triage and uncertain repair notices without duplicate form-save alerts', async () => {
    const contact: WatchdogContact = { provider: 'salesforce', objectType: 'Contact', id: '003000000000001', updatedAt: '2026-10-01T12:00:00.000Z', properties: { email: 'private@example.com', jobtitle: ' Engineer ' } };
    const source: WatchdogSource = { provider: 'salesforce', accountId: '00D000000000001', list: async () => ({ contacts: [contact], after: null }), changes: async () => ({ contacts: [contact], after: null }), read: async () => contact, patch: async () => { throw new Error('lost response'); } };
    const scope = 'salesforce_00D000000000001';
    await configureWatchdog(scope, { enabled: true, automaticRepairs: true, intervalSeconds: 300, defaultAssignee: 'RevOps' });
    const report = await tickWatchdog(scope, '', { force: true, source });
    expect(await events(`repair:${scope}:`)).toEqual([expect.objectContaining({ provider: 'salesforce', title: 'Watchdog repair needs verification' })]);
    await tickWatchdog(scope, '', { force: true, source }); expect(await events(`repair:${scope}:`)).toHaveLength(1);
    const input = { id: report.findings[0].id, status: 'in_progress' as const, assignee: 'Harrison', note: 'Private customer notes' };
    await Promise.all([triageWatchdogFinding(scope, input), triageWatchdogFinding(scope, input)]);
    expect(await events('assignment:')).toHaveLength(1);
  });

  it('deduplicates an outage until a successful scan, then alerts on a new outage', async () => {
    const source: WatchdogSource = { list: async () => { throw new Error('API unavailable'); }, changes: async () => { throw new Error('API unavailable'); }, read: async () => { throw new Error('unused'); }, patch: async () => undefined };
    await configureWatchdog('failure-hs', { enabled: true, automaticRepairs: false, intervalSeconds: 300, defaultAssignee: 'RevOps' });
    await tickWatchdog('failure-hs', '', { source, force: true }); await tickWatchdog('failure-hs', '', { source, force: true });
    expect(await events('scan:failure-hs:')).toHaveLength(1);
    source.list = async () => ({ contacts: [], after: null });
    await tickWatchdog('failure-hs', '', { source, force: true }); await tickWatchdog('failure-hs', '', { source, force: true });
    expect(await events('scan:failure-hs:')).toHaveLength(2);
  });

  it('announces received imports, saved reviews, and honest execution counts without source contents', async () => {
    const input = { provider: 'salesforce' as const, fileName: 'Private customer event.csv', csv: 'Email\nprivate@example.com' };
    const received = await receiveImport(input); await receiveImport(input);
    expect(await events(`work:${received.id}:`)).toHaveLength(1);
    const assignedBefore = (await events('assignment:')).length;
    await Promise.all([assignImportWork(received.id, 'Person', 'Private detail'), assignImportWork(received.id, 'Person', 'Private detail')]);
    expect(await events('assignment:')).toHaveLength(assignedBefore + 1);
    const review: SafeImportReview = { id: 'review-notification', workspaceId: received.workspaceId, workspaceRevision: 0, connectorId: 'salesforce', account: { connectorId: 'salesforce', accountId: '00D000000000001' }, sourceFile: input.fileName, sourceFileHash: 'a'.repeat(64), workspaceFingerprint: 'b'.repeat(64), mapping: {}, recordMode: 'update-existing', updatePolicy: defaultCrmUpdatePolicy(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString(), complete: true, plans: [], rows: [], counts: { ...safeImportCounts([]), held: 2, 'proposed-update': 1 } };
    await saveSafeImportReview(review);
    expect(await events('review:')).toEqual([expect.objectContaining({ summary: expect.stringContaining('1 proposed updates; 2 held') })]);
    const run: SafeImportExecution = { id: 'execution-notification', executionKey: 'key', reviewId: review.id, workspaceId: review.workspaceId, account: review.account, approvedAt: review.createdAt, createdAt: review.createdAt, updatedAt: review.createdAt, status: 'completed', records: [{ contactId: 'row', nativeId: '003000000000001', objectType: 'contact', status: 'accepted', error: null }] };
    await notifyImportExecution(review, run); await notifyImportExecution(review, { ...run, updatedAt: new Date(Date.now() + 1000).toISOString() });
    expect(await events('execution:')).toEqual([expect.objectContaining({ title: 'Safe Import outcomes need verification', summary: expect.stringContaining('0 verified updates; 1 uncertain') })]);
    expect(JSON.stringify(await events(''))).not.toMatch(/Private customer|private@example|Private detail/);
    expect(network).not.toHaveBeenCalled();
  });
});
