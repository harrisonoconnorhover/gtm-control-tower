import { CrmReadDeferredError, resetCrmReadTransportForTests } from '../lib/crm-read-transport';
import { beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSafeImportReview, continueSafeImportExecution, reconcileSafeImportExecution, writeHubSpotSafeImportRecord, type SafeImportExecutionDependencies } from '../lib/safe-import-execution';
import { claimSafeImportExecution, claimSafeImportChunk, releaseSafeImportChunk, getLatestSafeImportReview, getSafeImportExecution, getSafeImportReview, saveSafeImportReview, updateSafeImportExecution } from '../lib/safe-import-store';
import type { SafeImportExecution, SafeImportReview } from '../lib/safe-import';
import type { NativeCrmRecord } from '../lib/crm-workflow';
import { safeImportReviewFixture, SAFE_IMPORT_TEST_NOW } from './fixtures/safe-import-review';

const directory = mkdtempSync(join(tmpdir(), 'safe-import-execution-'));
process.env.CONTROL_TOWER_SQLITE_PATH = join(directory, 'safe-import.db');
process.env.CONTROL_TOWER_PERSISTENCE_ENABLED = 'true';
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

async function setup(count = 1) {
  const { createWorkspace } = await import('../lib/workspace-store');
  const workspace = await createWorkspace('Safe import execution');
  const review = safeImportReviewFixture(workspace.id, count);
  await saveSafeImportReview(review);
  const current = new Map<string, NativeCrmRecord>(review.plans.flatMap((plan) => plan.records.map((record) => [record.nativeId!, {
    nativeId: record.nativeId!, objectType: 'contact' as const, email: record.matches[0].email, fields: structuredClone(record.before!),
  }] as const)));
  const writeRecord = vi.fn(async (record) => {
    const native = current.get(record.nativeId)!;
    for (const change of record.changes) native.fields[change.field as keyof NativeCrmRecord['fields']] = change.after;
    return { status: 'accepted' as const, error: null };
  });
  const deps: SafeImportExecutionDependencies = {
    now: () => SAFE_IMPORT_TEST_NOW, readAccount: async () => review.account,
    readRecord: async (nativeId) => structuredClone(current.get(nativeId) ?? null), writeRecord,
    claimExecution: claimSafeImportExecution, saveExecution: updateSafeImportExecution, assertWorkspace: async () => {},
  };
  return { review, deps, current, writeRecord };
}

async function finish(review: SafeImportReview, deps: SafeImportExecutionDependencies, execution?: SafeImportExecution) {
  let result = execution ?? await executeSafeImportReview(review, deps);
  for (let chunk = 0; result.status === 'running' && chunk < 20; chunk += 1) result = await continueSafeImportExecution(review, deps);
  expect(result.records.some((record) => record.status === 'pending')).toBe(false);
  return result;
}

describe('saved safe import execution', () => {
  it('keeps the execution claim small at the 5,000-row limit with long source IDs', async () => {
    const { createWorkspace } = await import('../lib/workspace-store');
    const workspace = await createWorkspace('Safe import maximum seed');
    const review = safeImportReviewFixture(workspace.id, 5_000);
    review.rows.forEach((row, index) => { row.contactId = `${'r'.repeat(114)}-${String(index).padStart(5, '0')}`; row.record!.contactId = row.contactId; });
    await saveSafeImportReview(review);
    const now = SAFE_IMPORT_TEST_NOW.toISOString();
    const seed = {
      id: crypto.randomUUID(), executionKey: `safe-import:${review.id}`, reviewId: review.id, workspaceId: review.workspaceId,
      account: review.account, approvedAt: now, createdAt: now, updatedAt: now, status: 'running' as const,
      records: review.rows.map((row) => ({ contactId: row.contactId, nativeId: row.record!.nativeId!, status: 'pending' as const, error: null })),
    };
    expect(JSON.stringify(seed).length).toBeGreaterThan(100_000);
    const claimed = await claimSafeImportExecution(review, seed);
    expect(claimed).toMatchObject({ claimed: true, execution: seed });
    const { getDatabase } = await import('../db');
    const db = await getDatabase();
    const header = await db.prepare('SELECT payload_json FROM safe_import_executions WHERE id = ?').bind(seed.id).first<{ payload_json: string }>();
    expect(header!.payload_json.length).toBeLessThan(2_000);
    expect(JSON.parse(header!.payload_json).records).toEqual([]);
    expect((await getSafeImportExecution(review.workspaceId, review.id))?.records).toHaveLength(5_000);
  });

  it('discovers saved reviews after losing the browser ID, and never replaces a saved review', async () => {
    const { review } = await setup();
    expect(await getLatestSafeImportReview(review.workspaceId)).toEqual(review);
    await expect(saveSafeImportReview({ ...review, mapping: { rawEmail: 'Different column' } })).rejects.toThrow();
    expect(await getSafeImportReview(review.workspaceId, review.id)).toEqual(review);
    expect(await getLatestSafeImportReview('another-workspace')).toBeNull();
  });

  it('persists readback per row beyond one D1-sized payload and rejects competing progress changes', async () => {
    const { review, deps } = await setup(101);
    const execution = await finish(review, deps);
    const large = structuredClone(execution);
    for (const record of large.records) {
      record.verification!.expected.fields.jobTitle = 'x'.repeat(20_000);
      record.verification!.actual!.fields.jobTitle = 'x'.repeat(20_000);
    }
    expect(JSON.stringify(large).length).toBeGreaterThan(1_750_000);
    await updateSafeImportExecution(large, execution);
    expect(await getSafeImportExecution(review.workspaceId, review.id)).toEqual(large);
    await expect(updateSafeImportExecution(execution, execution)).rejects.toThrow('changed in another request');
    const { getDatabase } = await import('../db');
    const db = await getDatabase();
    const header = await db.prepare('SELECT payload_json FROM safe_import_executions WHERE id = ?').bind(execution.id).first<{ payload_json: string }>();
    expect(header!.payload_json.length).toBeLessThan(100_000);
  });

  it('persists a whole review across batch/chunk boundaries and executes once without AI', async () => {
    const { review, deps, current, writeRecord } = await setup(101);
    expect(review.plans.map((plan) => plan.records.length)).toEqual([100, 1]);
    expect(JSON.stringify(review).length).toBeGreaterThan(100_000);
    expect(await getSafeImportReview(review.workspaceId, review.id)).toEqual(review);
    const [initial, repeated] = await Promise.all([executeSafeImportReview(review, deps), executeSafeImportReview(review, deps)]);
    expect(initial.id).toBe(repeated.id);
    expect(writeRecord).toHaveBeenCalledTimes(10);
    expect(initial.records.filter((record) => record.status === 'pending')).toHaveLength(91);
    const first = await finish(review, deps, initial);
    expect(writeRecord).toHaveBeenCalledTimes(101);
    expect(first.records.every((record) => record.status === 'accepted' && record.verification?.status === 'verified')).toBe(true);
    expect(first.status).toBe('completed');
    expect(current.get('101')?.fields).toMatchObject({ phone: '2125550100', jobTitle: 'Head of Operations', website: 'example.com' });
    expect((await executeSafeImportReview(review, deps)).id).toBe(first.id);
    expect(writeRecord).toHaveBeenCalledTimes(101);
    expect(await getSafeImportExecution(review.workspaceId, review.id)).toEqual(first);
  });

  it('holds changed CRM fields after approval without sending', async () => {
    const { review, deps, current, writeRecord } = await setup();
    current.get('1')!.fields.jobTitle = 'New work';
    const execution = await executeSafeImportReview(review, deps);
    expect(execution.records[0]).toMatchObject({ status: 'held', error: expect.stringContaining('changed after review') });
    expect(writeRecord).not.toHaveBeenCalled();
  });

  it('checks the workspace immediately before sending, after its native reread', async () => {
    const { review, deps, writeRecord } = await setup();
    const assertWorkspace = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('Mapping changed'));
    const execution = await executeSafeImportReview(review, { ...deps, assertWorkspace });
    expect(execution.records[0]).toMatchObject({ status: 'held', error: 'Mapping changed' });
    expect(writeRecord).not.toHaveBeenCalled();
  });

  it('rejects an expired review and the wrong account before creating an execution', async () => {
    const { review, deps, writeRecord } = await setup();
    await expect(executeSafeImportReview(review, { ...deps, now: () => new Date('2026-10-07') })).rejects.toThrow('unexpired');
    await expect(executeSafeImportReview(review, { ...deps, readAccount: async () => ({ connectorId: 'hubspot', accountId: '999' }) })).rejects.toThrow('differs');
    expect(await getSafeImportExecution(review.workspaceId, review.id)).toBeNull();
    expect(writeRecord).not.toHaveBeenCalled();
  });

  it('does not send if persisting the sending state fails', async () => {
    const { review, deps, writeRecord } = await setup();
    await expect(executeSafeImportReview(review, { ...deps, saveExecution: async () => { throw new Error('storage unavailable'); } })).rejects.toThrow('storage unavailable');
    expect(writeRecord).not.toHaveBeenCalled();
    expect((await getSafeImportExecution(review.workspaceId, review.id))?.records[0].status).toBe('pending');
  });

  it('keeps lost-response outcomes unknown even when approved values are observed; never retries', async () => {
    const { review, deps, writeRecord } = await setup();
    const lostResponse = vi.fn(async (record) => { await writeRecord(record); throw new Error('response lost'); });
    const execution = await executeSafeImportReview(review, { ...deps, writeRecord: lostResponse });
    expect(execution).toMatchObject({ status: 'reconciliation-required', records: [{ status: 'unknown', verification: { status: 'verified' } }] });
    const reconciled = await reconcileSafeImportExecution(review, execution, { ...deps, writeRecord: lostResponse });
    expect(reconciled.records[0]).toMatchObject({ status: 'unknown', verification: { status: 'verified' } });
    await executeSafeImportReview(review, deps);
    expect(lostResponse).toHaveBeenCalledTimes(1);
    expect(writeRecord).toHaveBeenCalledTimes(1);
  });

  it('reconciles a lost receipt without resending and continues only unsent rows', async () => {
    const { review, deps, writeRecord } = await setup(2);
    const saveExecution: SafeImportExecutionDependencies['saveExecution'] = async (execution, previous) => {
      if (execution.records.some((record) => record.status === 'accepted')) throw new Error('receipt storage lost');
      return updateSafeImportExecution(execution, previous);
    };
    await expect(executeSafeImportReview(review, { ...deps, saveExecution })).rejects.toThrow('receipt storage lost');
    const saved = (await getSafeImportExecution(review.workspaceId, review.id))!;
    expect(saved.records.map((record) => record.status)).toEqual(['sending', 'pending']);
    await executeSafeImportReview(review, deps);
    const reconciled = await reconcileSafeImportExecution(review, saved, deps);
    expect(reconciled.records.map((record) => record.status)).toEqual(['unknown', 'pending']);
    expect(reconciled.records[0].verification?.status).toBe('verified');
    expect(writeRecord).toHaveBeenCalledTimes(1);
    const continued = await continueSafeImportExecution(review, deps);
    expect(continued.records.map((record) => record.status)).toEqual(['unknown', 'accepted']);
    expect(writeRecord).toHaveBeenCalledTimes(2);
  });

  it('keeps write acceptance separate from protected-field verification and never reapplies', async () => {
    const { review, deps, current, writeRecord } = await setup();
    const execution = await executeSafeImportReview(review, { ...deps, writeRecord: async (record) => {
      const outcome = await writeRecord(record); current.get('1')!.fields.jobTitle = 'Changed downstream'; return outcome;
    } });
    expect(execution.records[0]).toMatchObject({ status: 'accepted', verification: { status: 'different' } });
    await reconcileSafeImportExecution(review, execution, deps);
    expect(writeRecord).toHaveBeenCalledTimes(1);
    await expect(reconcileSafeImportExecution(review, execution, { ...deps, readAccount: async () => ({ connectorId: 'hubspot', accountId: '999' }) })).rejects.toThrow('differs');
  });

  it('rejects repeated targets, create operations, and replacement fields in a saved contract', async () => {
    const { review, deps, writeRecord } = await setup(2);
    const repeated = structuredClone(review); repeated.plans[0].records[1].nativeId = '1';
    await expect(executeSafeImportReview(repeated, deps)).rejects.toThrow('same native');
    const create = structuredClone(review); create.plans[0].records[0].operation = 'create';
    await expect(executeSafeImportReview(create, deps)).rejects.toThrow('cannot create');
    const replace = structuredClone(review); replace.plans[0].records[0].changes[0].before = 'Existing phone';
    await expect(executeSafeImportReview(replace, deps)).rejects.toThrow('fill-empty');
    expect(writeRecord).not.toHaveBeenCalled();
  });

  it('allows one continuation worker and fences stale progress after lease expiry', async () => {
    const { review, deps, writeRecord } = await setup(21);
    const initial = await executeSafeImportReview(review, deps);
    expect(initial.records.filter((record) => record.status === 'pending')).toHaveLength(11);
    const [left, right] = await Promise.all([continueSafeImportExecution(review, deps), continueSafeImportExecution(review, deps)]);
    expect(left.id).toBe(right.id);
    expect(writeRecord).toHaveBeenCalledTimes(20);
    const old = await claimSafeImportChunk(review, deps.now());
    expect(old.claimed).toBe(true);
    const nextTime = new Date(deps.now().getTime() + 300_001);
    const successor = await claimSafeImportChunk(review, nextTime);
    expect(successor.claimed).toBe(true);
    const sending = { ...old.execution, records: old.execution.records.map((record, index) => index === 20 ? { ...record, status: 'sending' as const } : record) };
    await expect(updateSafeImportExecution(sending, old.execution)).rejects.toThrow('changed in another request');
    await releaseSafeImportChunk(old.execution);
    expect((await getSafeImportExecution(review.workspaceId, review.id))?.lease?.token).toBe(successor.execution.lease?.token);
    await releaseSafeImportChunk(successor.execution);
    const result = await continueSafeImportExecution(review, { ...deps, now: () => nextTime });
    expect(result.status).toBe('completed');
    expect(result.approvedAt).toBe(initial.approvedAt);
    expect(writeRecord).toHaveBeenCalledTimes(21);
  });

  it('holds expired pending rows without extending approval and rechecks edited workspaces', async () => {
    const { review, deps, writeRecord } = await setup(12);
    const initial = await executeSafeImportReview(review, deps);
    const expired = await continueSafeImportExecution(review, { ...deps, now: () => new Date(review.expiresAt) });
    expect(expired.records.slice(10).every((record) => record.status === 'held' && record.error?.includes('expired'))).toBe(true);
    expect(expired.approvedAt).toBe(initial.approvedAt);
    expect(writeRecord).toHaveBeenCalledTimes(10);
    const second = await setup(11);
    await executeSafeImportReview(second.review, second.deps);
    const changed = await continueSafeImportExecution(second.review, { ...second.deps, assertWorkspace: async () => { throw new Error('Workspace changed'); } });
    expect(changed.records[10]).toMatchObject({ status: 'held', error: 'Workspace changed' });
    expect(second.writeRecord).toHaveBeenCalledTimes(10);
  });

  it('requires saved approval and holds changed account or native evidence on continuation', async () => {
    const first = await setup(11);
    await expect(continueSafeImportExecution(first.review, first.deps)).rejects.toThrow('saved approval');
    expect(first.writeRecord).not.toHaveBeenCalled();
    await executeSafeImportReview(first.review, first.deps);
    const forged = structuredClone(first.review);
    forged.sourceFile = 'a different saved source.csv';
    await expect(continueSafeImportExecution(forged, first.deps)).rejects.toThrow('exact saved');
    first.current.get('11')!.fields.phone = 'Changed after the first chunk';
    const changed = await continueSafeImportExecution(first.review, first.deps);
    expect(changed.records[10]).toMatchObject({ status: 'held', error: expect.stringContaining('changed after review') });
    expect(first.writeRecord).toHaveBeenCalledTimes(10);
    const second = await setup(11);
    await executeSafeImportReview(second.review, second.deps);
    const wrongAccount = await continueSafeImportExecution(second.review, { ...second.deps,
      readAccount: async () => ({ connectorId: 'hubspot', accountId: '999' }) });
    expect(wrongAccount.records[10]).toMatchObject({ status: 'held', error: expect.stringContaining('differs') });
    expect(second.writeRecord).toHaveBeenCalledTimes(10);
  });

  it('recovers expired sending claims without replay, and bounds read-only reconciliation', async () => {
    const { review, deps, writeRecord } = await setup(21);
    await finish(review, deps);
    const lease = await claimSafeImportChunk(review, deps.now());
    const interrupted = { ...lease.execution, status: 'running' as const, records: lease.execution.records.map((record, index) => index === 0 ? { ...record, status: 'sending' as const, verification: undefined } : record) };
    await updateSafeImportExecution(interrupted, lease.execution);
    const blocked = await continueSafeImportExecution(review, deps);
    expect(blocked.records[0].status).toBe('sending');
    const afterExpiry = { ...deps, now: () => new Date(deps.now().getTime() + 300_001) };
    const resumed = await continueSafeImportExecution(review, afterExpiry);
    expect(resumed.records[0]).toMatchObject({ status: 'unknown', verification: { status: 'verified' } });
    expect(writeRecord).toHaveBeenCalledTimes(21);
    const readRecord = vi.fn(deps.readRecord);
    const first = await reconcileSafeImportExecution(review, resumed, { ...afterExpiry, readRecord });
    expect(readRecord).toHaveBeenCalledTimes(10);
    expect(first.reconciliationCursor).toBe(10);
    const second = await reconcileSafeImportExecution(review, first, { ...afterExpiry, readRecord });
    expect(readRecord).toHaveBeenCalledTimes(20);
    expect(second.reconciliationCursor).toBe(20);
    const third = await reconcileSafeImportExecution(review, second, { ...afterExpiry, readRecord });
    expect(readRecord).toHaveBeenCalledTimes(21);
    expect(third.reconciliationCursor).toBe(0);
    expect(writeRecord).toHaveBeenCalledTimes(21);
  });

  it('pauses a 200-row burst on a definitely rejected write and resumes only unsent rows after fresh checks', async () => {
    const { review, deps, current, writeRecord } = await setup(200);
    let now = new Date(SAFE_IMPORT_TEST_NOW);
    const retryAt = new Date(now.getTime() + 120_000).toISOString();
    let limited = true;
    const attempts: string[] = [];
    const write: SafeImportExecutionDependencies['writeRecord'] = async (record) => {
      attempts.push(record.nativeId!);
      if (record.nativeId === '4' && limited) {
        limited = false;
        return { status: 'pending', error: '429: wait for CRM capacity', retryAt, reason: 'rate_limit' };
      }
      return writeRecord(record);
    };
    const controls = { ...deps, now: () => now, writeRecord: write };
    const initial = await executeSafeImportReview(review, controls);
    expect(attempts).toEqual(['1', '2', '3', '4']);
    expect(initial).toMatchObject({ status: 'running', nextAttemptAt: retryAt, retryReason: expect.stringContaining('429') });
    expect(initial.records.filter((record) => record.status === 'pending')).toHaveLength(197);
    const saved = await getSafeImportExecution(review.workspaceId, review.id);
    expect(saved?.nextAttemptAt).toBe(retryAt);
    expect((await continueSafeImportExecution(review, controls)).nextAttemptAt).toBe(retryAt);
    expect(attempts).toHaveLength(4);
    // A CRM edit during the cooldown must block this originally approved row.
    current.get('4')!.fields.phone = 'Updated by another integration during cooldown';
    now = new Date(retryAt);
    const resumed = await continueSafeImportExecution(review, controls);
    expect(resumed.records[3]).toMatchObject({ status: 'held', error: expect.stringContaining('changed after review') });
    expect(resumed.nextAttemptAt).toBeUndefined();
    const completed = await finish(review, controls, resumed);
    expect(completed.records.filter((record) => record.status === 'accepted')).toHaveLength(199);
    expect(completed.records.filter((record) => record.status === 'held')).toHaveLength(1);
    expect(completed.approvedAt).toBe(initial.approvedAt);
    expect(attempts).toHaveLength(200);
    expect(new Set(attempts).size).toBe(200);
  });

  it('makes a rejected row retryable after cooldown while preserving approval and accepted rows', async () => {
    const { review, deps, writeRecord } = await setup(2);
    let now = new Date(SAFE_IMPORT_TEST_NOW);
    const retryAt = new Date(now.getTime() + 5_000).toISOString();
    let limited = true;
    const write: SafeImportExecutionDependencies['writeRecord'] = async (record) => {
      if (record.nativeId === '2' && limited) { limited = false; return { status: 'pending', error: '429', retryAt, reason: 'rate_limit' }; }
      return writeRecord(record);
    };
    const controls = { ...deps, now: () => now, writeRecord: write };
    const initial = await executeSafeImportReview(review, controls);
    expect(initial.records.map((record) => record.status)).toEqual(['accepted', 'pending']);
    now = new Date(retryAt);
    const completed = await continueSafeImportExecution(review, controls);
    expect(completed.records.map((record) => record.status)).toEqual(['accepted', 'accepted']);
    expect(writeRecord).toHaveBeenCalledTimes(2);
    expect(completed.approvedAt).toBe(initial.approvedAt);
  });

  it('persists transient precheck delays instead of holding unsent rows, and wakes at the original expiry', async () => {
    const { review, deps, writeRecord } = await setup(12);
    const initial = await executeSafeImportReview(review, deps);
    const retryAt = new Date(Date.parse(review.expiresAt) + 60_000).toISOString();
    const readRecord = vi.fn().mockRejectedValue(new CrmReadDeferredError('transient', Date.parse(retryAt), 503));
    const waiting = await continueSafeImportExecution(review, { ...deps, readRecord });
    expect(waiting.records.slice(10).every((record) => record.status === 'pending')).toBe(true);
    expect(waiting.nextAttemptAt).toBe(retryAt);
    const expired = await continueSafeImportExecution(review, { ...deps, now: () => new Date(review.expiresAt) });
    expect(expired.records.slice(10).every((record) => record.status === 'held' && record.error?.includes('expired'))).toBe(true);
    expect(expired.approvedAt).toBe(initial.approvedAt);
    expect(writeRecord).toHaveBeenCalledTimes(10);
  });

  it('defers readback without replaying an accepted write', async () => {
    const { review, deps, writeRecord } = await setup();
    let now = new Date(SAFE_IMPORT_TEST_NOW);
    const retryAt = now.getTime() + 5_000;
    let reads = 0;
    const controls = { ...deps, now: () => now, readRecord: async (id: string) => {
      if (++reads === 2) throw new CrmReadDeferredError('rate_limit', retryAt, 429);
      return deps.readRecord(id);
    } };
    const waiting = await executeSafeImportReview(review, controls);
    expect(waiting.records[0]).toMatchObject({ status: 'accepted' });
    expect(waiting.records[0].verification).toBeUndefined();
    now = new Date(retryAt);
    const result = await continueSafeImportExecution(review, controls);
    expect(result.records[0].verification?.status).toBe('verified');
    expect(writeRecord).toHaveBeenCalledTimes(1);
  });

  it('holds all remaining unsent rows after definitive permission rejection and preserves unknown and accepted receipts', async () => {
    const { review, deps, writeRecord } = await setup(200);
    const stopReason = 'HubSpot rejected access. Correct permissions and prepare a new review.';
    const attempts = vi.fn(async (record) => {
      if (record.nativeId === '1') { await writeRecord(record); throw new Error('Lost response'); }
      if (record.nativeId === '3') return { status: 'failed' as const, error: '403', stopReason };
      return writeRecord(record);
    });
    const execution = await executeSafeImportReview(review, { ...deps, writeRecord: attempts });
    expect(execution.records.slice(0, 3).map((record) => record.status)).toEqual(['unknown', 'accepted', 'failed']);
    expect(execution.records.slice(3).every((record) => record.status === 'held' && record.error === stopReason)).toBe(true);
    expect(execution.status).toBe('reconciliation-required');
    expect(attempts).toHaveBeenCalledTimes(3);
    expect(await getSafeImportExecution(review.workspaceId, review.id)).toEqual(execution);
    await continueSafeImportExecution(review, { ...deps, writeRecord: attempts });
    expect(attempts).toHaveBeenCalledTimes(3);
    const { getDatabase } = await import('../db');
    const db = await getDatabase();
    const receipts = await db.prepare('SELECT COUNT(*) AS count FROM safe_import_execution_records WHERE execution_id = ?').bind(execution.id).first<{ count: number }>();
    expect(receipts?.count).toBe(3);
    const resumed = (await getSafeImportExecution(review.workspaceId, review.id))!;
    await expect(updateSafeImportExecution({ ...resumed, unsentHoldReason: undefined }, resumed)).rejects.toThrow('cannot change');
  });

  it('classifies actual 429 rejection as pending, but a permanent 403 and ambiguous 503 never become retryable writes', async () => {
    const record = safeImportReviewFixture().plans[0].records[0];
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'Retry-After': '120' } }));
    vi.stubGlobal('fetch', fetchMock);
    const cooldown = await writeHubSpotSafeImportRecord(record, 'limited-token');
    expect(cooldown).toMatchObject({ status: 'pending', reason: 'rate_limit' });
    expect(Date.parse('retryAt' in cooldown ? cooldown.retryAt : '')).toBeGreaterThan(Date.now() + 119_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The second attempt is gated before dispatch, not automatically repeated.
    expect(await writeHubSpotSafeImportRecord(record, 'limited-token')).toMatchObject({ status: 'pending' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 403 }));
    expect(await writeHubSpotSafeImportRecord(record, 'other-token')).toMatchObject({ status: 'failed' });
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    expect(await writeHubSpotSafeImportRecord(record, 'other-token')).toMatchObject({ status: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('checks authorization after waiting for a write slot, before dispatch', async () => {
    const record = safeImportReviewFixture().plans[0].records[0];
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const beforeSend = vi.fn().mockRejectedValue(new Error('The original approval expired while waiting'));
    expect(await writeHubSpotSafeImportRecord(record, 'test-token', beforeSend)).toMatchObject({ status: 'held', error: expect.stringContaining('expired') });
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses only native-ID PATCH with approved field names and excludes primary email', async () => {
    const review = safeImportReviewFixture();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: '1', archived: false }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await writeHubSpotSafeImportRecord(review.plans[0].records[0], 'test-token')).toEqual({ status: 'accepted', error: null });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.hubapi.com/crm/objects/2026-03/contacts/1');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PATCH', redirect: 'manual' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ properties: { phone: '2125550000' } });
  });
});

beforeEach(() => resetCrmReadTransportForTests({ minimumIntervalMs: 0, backoffBaseMs: 0 }));
