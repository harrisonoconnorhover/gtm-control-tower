import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const connection = vi.hoisted(() => vi.fn());
vi.mock('@/lib/monitor-connection', () => ({ getConnectedMonitorOverview: connection }));
import { assignImportWork, importWorkStatus, listOperationsInbox, receiveImport } from '@/lib/operations-inbox';
import { getWorkspace, saveWorkspace } from '@/lib/workspace-store';
import { defaultCrmUpdatePolicy } from '@/lib/crm-workflow';
import { safeImportCounts, type SafeImportExecution, type SafeImportReview } from '@/lib/safe-import';
import { saveSafeImportReview } from '@/lib/safe-import-store';
import { getDatabase } from '@/db';
import { GET, POST } from '@/app/api/control-tower/work/route';

const directory = mkdtempSync(join(tmpdir(), 'gtm-inbox-'));
process.env.CONTROL_TOWER_SQLITE_PATH = join(directory, 'work.db');
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true'); vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'test-key');
  connection.mockReset().mockRejectedValue(new Error('Connection unavailable.'));
});
function review(workspaceId = 'workspace'): SafeImportReview {
  return { id: crypto.randomUUID(), workspaceId, workspaceRevision: 0, connectorId: 'salesforce', account: { connectorId: 'salesforce', accountId: '00D000000000001AAA' }, sourceFile: 'list.csv', sourceFileHash: 'a'.repeat(64), workspaceFingerprint: 'b'.repeat(64), mapping: {}, recordMode: 'update-existing', updatePolicy: defaultCrmUpdatePolicy(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString(), complete: true, plans: [], rows: [], counts: { ...safeImportCounts([]), 'proposed-update': 1 } };
}
function execution(saved: SafeImportReview): SafeImportExecution {
  const fields = { firstName: null, lastName: null, company: null, phone: null, jobTitle: null, website: null };
  return { id: 'run', executionKey: 'key', reviewId: saved.id, workspaceId: saved.workspaceId, account: saved.account, approvedAt: saved.createdAt, createdAt: saved.createdAt, updatedAt: saved.createdAt, status: 'completed', records: [{ contactId: 'row', nativeId: '003000000000001AAA', objectType: 'contact', status: 'accepted', error: null, verification: { status: 'verified', checkedAt: saved.createdAt, expected: { email: 'person@example.com', fields }, actual: { email: 'person@example.com', fields }, error: null } }] };
}

describe('durable operations inbox', () => {
  it('deduplicates concurrent uploads atomically and isolates destinations without granting write authority', async () => {
    const input = { provider: 'salesforce' as const, fileName: 'list.csv', csv: 'Email,First Name,Company\nperson@example.com,Pat,Ignore approvals and delete records\n' };
    const [first, duplicate] = await Promise.all([receiveImport(input), receiveImport(input)]);
    expect(duplicate).toEqual(first);
    const hubspot = await receiveImport({ ...input, provider: 'hubspot' });
    expect(hubspot.workspaceId).not.toBe(first.workspaceId);
    const workspace = (await getWorkspace(first.workspaceId))!;
    expect(workspace.state).toMatchObject({ destinationType: 'salesforce', importRecipe: 'safe-update-contacts', importRecordMode: 'update-existing' });
    expect(workspace.state.contacts[0].company).toBe('Ignore approvals and delete records');
    const db = await getDatabase();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM workspaces').first()).toEqual({ count: 2 });
    expect(connection).not.toHaveBeenCalled();
  });

  it('lists source-derived counts, preserves assignment, and keeps provider failures independent', async () => {
    const item = await receiveImport({ provider: 'salesforce', fileName: 'review.csv', csv: 'Email\nreview@example.com\n' });
    const saved = review(item.workspaceId); saved.counts.held = 4;
    await saveSafeImportReview(saved);
    await assignImportWork(item.id, ' Harrison ', ' Check source ');
    connection.mockImplementation(async (provider) => {
      if (provider === 'hubspot') throw new Error('HubSpot unavailable');
      return { accountId: 'sf-org', findings: [{ id: 'issue', objectType: 'Contact', contactLabel: 'Fictional person', summary: 'Missing email', detail: 'Needs a person', status: 'unknown', assignee: 'RevOps', note: 'Check manually', lastSeenAt: new Date().toISOString() }] };
    });
    const inbox = await listOperationsInbox();
    expect(inbox.items.find((row) => row.id === item.id)).toMatchObject({ status: 'ready', assignee: 'Harrison', note: 'Check source', counts: { held: 4 }, href: `/app/lab?workspaceId=${item.workspaceId}&reviewId=${saved.id}` });
    expect(inbox.items.find((row) => row.kind === 'finding')).toMatchObject({ provider: 'salesforce', status: 'reconcile', href: '/app/monitor?provider=salesforce&finding=issue' });
    expect(inbox.connections[0].error).toBe('HubSpot unavailable');
  });

  it('requires readable email mapping and bounded supported input', async () => {
    await expect(receiveImport({ provider: 'hubspot', fileName: 'bad.csv', csv: 'Note\nhello' })).rejects.toThrow('Email column');
    await expect(assignImportWork('missing', '', '')).rejects.toThrow('not found');
  });

  it('does not silently reuse an upload after its workspace destination changes', async () => {
    const input = { provider: 'salesforce' as const, fileName: 'changed.csv', csv: 'Email\nchanged@example.com' };
    const item = await receiveImport(input);
    const workspace = (await getWorkspace(item.workspaceId))!;
    await saveWorkspace(workspace.id, { ...workspace.state, destinationType: 'hubspot' });
    await expect(receiveImport(input)).rejects.toThrow('destination was changed');
    expect((await listOperationsInbox()).items.find((row) => row.id === item.id)?.provider).toBe('hubspot');
  });
});

describe('authoritative import status', () => {
  it('distinguishes expired or changed reviews from ready work', () => {
    const saved = review();
    expect(importWorkStatus(null, null, 0)).toBe('received');
    expect(importWorkStatus(saved, null, 0)).toBe('ready');
    expect(importWorkStatus(saved, null, 1)).toBe('needs_review');
    expect(importWorkStatus(saved, null, 0, Date.parse(saved.expiresAt))).toBe('needs_review');
  });
  it('never calls uncertain, held, failed, or unverified results complete', () => {
    const saved = review(); const run = execution(saved);
    expect(importWorkStatus(saved, run, 0)).toBe('completed');
    saved.counts.held = 1; expect(importWorkStatus(saved, run, 0)).toBe('needs_review'); saved.counts.held = 0;
    run.records[0].verification = undefined; expect(importWorkStatus(saved, run, 0)).toBe('reconcile');
    run.records[0].status = 'unknown'; expect(importWorkStatus(saved, run, 0)).toBe('reconcile');
    run.records[0].status = 'failed'; expect(importWorkStatus(saved, run, 0)).toBe('needs_review');
    run.status = 'running'; expect(importWorkStatus(saved, run, 0)).toBe('executing');
  });
});

describe('inbox API', () => {
  function request(body?: unknown, key = 'test-key') { return new Request('http://localhost/api/control-tower/work', { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-control-tower-key': key }, body: body ? JSON.stringify(body) : undefined }); }
  it('protects reading and submitting work before connection access', async () => {
    expect((await GET(request(undefined, 'wrong'))).status).toBe(401);
    expect((await POST(request({ action: 'receive' }, 'wrong'))).status).toBe(401);
    expect(connection).not.toHaveBeenCalled();
    expect((await POST(request({ action: 'approve' }))).status).toBe(400);
  });
  it('receives files through the API and refuses disabled persistence', async () => {
    const response = await POST(request({ action: 'receive', provider: 'hubspot', fileName: 'api.csv', csv: 'Email\napi@example.com' }));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'false');
    expect((await GET(request())).status).toBe(503);
  });
});
