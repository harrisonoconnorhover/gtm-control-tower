import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrmReadDeferredError } from '../lib/crm-read-transport';
import { safeImportReviewFixture, SAFE_IMPORT_TEST_NOW } from './fixtures/safe-import-review';

const directory = mkdtempSync(join(tmpdir(), 'safe-import-worker-cooldown-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'safe-import.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
vi.stubEnv('CONTROL_TOWER_SYNC_KEY', '');
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('durable import worker eligibility', () => {
  it('skips waiting jobs without CRM requests, returns the next eligible time, and wakes when the approval expires', async () => {
    const { createWorkspace } = await import('../lib/workspace-store');
    const { saveSafeImportReview, claimSafeImportExecution, updateSafeImportExecution, getNextSafeImportJob, getNextSafeImportAttemptAt } = await import('../lib/safe-import-store');
    const { continueSafeImportExecution } = await import('../lib/safe-import-execution');
    const { POST } = await import('../app/api/control-tower/safe-import/worker/route');
    const workspace = await createWorkspace('Fictional cooled-down import');
    const review = safeImportReviewFixture(workspace.id, 200);
    const now = SAFE_IMPORT_TEST_NOW.toISOString();
    const nextAttemptAt = new Date(Date.parse(review.expiresAt) + 60_000).toISOString();
    await saveSafeImportReview(review);
    const claimed = await claimSafeImportExecution(review, {
      id: crypto.randomUUID(), executionKey: `safe-import:${review.id}`, reviewId: review.id, workspaceId: review.workspaceId,
      account: review.account, approvedAt: now, createdAt: now, updatedAt: now, status: 'running', nextAttemptAt, retryReason: 'CRM quota',
      records: review.plans.flatMap((plan) => plan.records.map((record) => ({ contactId: record.contactId, nativeId: record.nativeId!, status: 'pending', error: null }))),
    });
    // One previously accepted update still needs readback; it must never become pending again.
    await updateSafeImportExecution({ ...claimed.execution, records: claimed.execution.records.map((record, index) => index === 0 ? { ...record, status: 'accepted' } : record) }, claimed.execution);
    expect(await getNextSafeImportJob(SAFE_IMPORT_TEST_NOW)).toBeNull();
    expect(await getNextSafeImportAttemptAt(SAFE_IMPORT_TEST_NOW)).toBe(review.expiresAt);
    expect((await getNextSafeImportJob(new Date(review.expiresAt)))?.id).toBe(review.id);
    vi.useFakeTimers();
    vi.setSystemTime(SAFE_IMPORT_TEST_NOW);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      const response = await POST(new Request('http://localhost/api/control-tower/safe-import/worker', { method: 'POST' }));
      expect(await response.json()).toEqual({ execution: null, queued: true, nextAttemptAt: review.expiresAt });
      expect(fetch).not.toHaveBeenCalled();
      vi.setSystemTime(new Date(review.expiresAt));
      const readAccount = vi.fn().mockRejectedValue(new CrmReadDeferredError('rate_limit', Date.parse(nextAttemptAt), 429));
      const expired = await continueSafeImportExecution(review, { readAccount });
      expect(expired.records[0].status).toBe('accepted');
      expect(expired.records.slice(1).every((record) => record.status === 'held' && record.error?.includes('expired'))).toBe(true);
      expect(readAccount).toHaveBeenCalledTimes(1);
      expect(await getNextSafeImportJob()).toBeNull();
      expect(await getNextSafeImportAttemptAt()).toBe(nextAttemptAt);
      await continueSafeImportExecution(review, { readAccount });
      expect(readAccount).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
});
