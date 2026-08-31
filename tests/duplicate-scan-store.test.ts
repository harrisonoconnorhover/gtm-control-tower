import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IdentityRecord } from '../lib/identity-resolution';

const acceptanceDirectory = mkdtempSync(join(tmpdir(), 'gtm-control-tower-duplicate-scan-'));
process.env.CONTROL_TOWER_SQLITE_PATH = join(acceptanceDirectory, 'duplicate-scan.db');
process.env.CONTROL_TOWER_PERSISTENCE_ENABLED = 'true';

afterAll(() => rmSync(acceptanceDirectory, { recursive: true, force: true }));

describe('durable duplicate scans', () => {
  it('resumes one active scan, ignores a replayed page, and retains review decisions', async () => {
    const { createWorkspace } = await import('../lib/workspace-store');
    const {
      appendDuplicateScanPage,
      getLatestDuplicateScan,
      resumeDuplicateScanFinalization,
      saveDuplicateReviewDecision,
      startDuplicateScan,
    } = await import('../lib/duplicate-scan-store');
    const workspace = await createWorkspace('Duplicate scan acceptance');
    const started = await startDuplicateScan(workspace.id, 'hubspot');
    const resumed = await startDuplicateScan(workspace.id, 'hubspot');
    expect(resumed.id).toBe(started.id);

    const firstCursor = { after: null } as const;
    const nextCursor = { after: 'page-2' } as const;
    const firstPage = [record('1', 'Alex', 'Rivera', 'alex@example.com'), record('2', 'A.', 'Rivera', 'alex@example.com')];
    const afterFirstPage = await appendDuplicateScanPage(started.id, firstPage, firstCursor, nextCursor, false);
    expect(afterFirstPage).toMatchObject({ pagesScanned: 1, recordsScanned: 2, status: 'scanning' });

    const afterReplay = await appendDuplicateScanPage(started.id, firstPage, firstCursor, nextCursor, false);
    expect(afterReplay).toMatchObject({ pagesScanned: 1, recordsScanned: 2, status: 'scanning' });

    const staleWriter = await appendDuplicateScanPage(
      started.id,
      [record('stale', 'Stale', 'Writer', 'stale@example.com')],
      firstCursor,
      { after: 'incorrect-page' },
      false,
    );
    expect(staleWriter).toMatchObject({ pagesScanned: 1, recordsScanned: 2, cursor: nextCursor, status: 'scanning' });

    const terminalPage = await appendDuplicateScanPage(started.id, [record('3', 'Morgan', 'Lee', 'morgan@example.com')], nextCursor, null, true);
    expect(terminalPage).toMatchObject({ pagesScanned: 2, recordsScanned: 3, sourceComplete: true, status: 'scanning', cursor: null });
    const completed = await resumeDuplicateScanFinalization(started.id);
    expect(completed).toMatchObject({ pagesScanned: 2, recordsScanned: 3, sourceComplete: true, status: 'complete', clusterCount: 1 });
    const cluster = completed.clusters[0];
    expect(cluster.members).toHaveLength(2);

    await saveDuplicateReviewDecision(workspace.id, 'hubspot', cluster.clusterId, 'confirmed_duplicate', cluster.recommendedPrimaryKey);
    const latest = await getLatestDuplicateScan(workspace.id, 'hubspot');
    expect(latest?.clusters[0].review).toMatchObject({
      decision: 'confirmed_duplicate',
      primaryRecordKey: cluster.recommendedPrimaryKey,
    });
  });

  it('recovers a terminal page after a crash and finalizes safely under competing retries', async () => {
    const { createWorkspace } = await import('../lib/workspace-store');
    const { getDatabase } = await import('../db');
    const {
      getDuplicateScan,
      resumeDuplicateScanFinalization,
      startDuplicateScan,
    } = await import('../lib/duplicate-scan-store');
    const workspace = await createWorkspace('Duplicate scan crash recovery');
    const started = await startDuplicateScan(workspace.id, 'hubspot');
    const db = await getDatabase();
    const records = [
      record('10', 'Casey', 'Morgan', 'casey@example.com'),
      record('11', 'C.', 'Morgan', 'casey@example.com'),
    ];
    await db.batch([
      ...records.map((item) => db.prepare(`INSERT INTO duplicate_scan_records (scan_id, record_key, payload_json)
        VALUES (?, ?, ?)`)
        .bind(started.id, item.recordKey, JSON.stringify(item))),
      db.prepare(`UPDATE duplicate_scans SET cursor_json = NULL, records_scanned = 2,
        pages_scanned = 1, source_complete = 1 WHERE id = ?`).bind(started.id),
    ]);

    const interrupted = await getDuplicateScan(started.id);
    expect(interrupted).toMatchObject({ status: 'scanning', cursor: null, sourceComplete: true });
    const [firstRetry, competingRetry] = await Promise.all([
      resumeDuplicateScanFinalization(started.id),
      resumeDuplicateScanFinalization(started.id),
    ]);

    expect(firstRetry).toMatchObject({ status: 'complete', sourceComplete: true, clusterCount: 1 });
    expect(competingRetry).toMatchObject({ status: 'complete', sourceComplete: true, clusterCount: 1 });
  });

  it('reconciles a missing completed-run receipt idempotently on retry', async () => {
    const { createWorkspace, listConnectorRuns } = await import('../lib/workspace-store');
    const { appendDuplicateScanPage, resumeDuplicateScanFinalization, startDuplicateScan } = await import('../lib/duplicate-scan-store');
    const { POST } = await import('../app/api/control-tower/duplicate-scan/route');
    const workspace = await createWorkspace('Duplicate receipt recovery');
    const started = await startDuplicateScan(workspace.id, 'hubspot');
    await appendDuplicateScanPage(
      started.id,
      [record('20', 'Riley', 'Stone', 'riley@example.com')],
      { after: null },
      null,
      true,
    );
    const completed = await resumeDuplicateScanFinalization(started.id);
    expect(completed.status).toBe('complete');
    expect(await listConnectorRuns(workspace.id)).toHaveLength(0);

    const body = JSON.stringify({
      action: 'step', workspaceId: workspace.id, connectorId: 'hubspot', scanId: completed.id,
    });
    const firstRetry = await POST(new Request('http://localhost/api/control-tower/duplicate-scan', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }));
    const secondRetry = await POST(new Request('http://localhost/api/control-tower/duplicate-scan', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }));

    expect(firstRetry.status).toBe(200);
    expect(secondRetry.status).toBe(200);
    const runs = await listConnectorRuns(workspace.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: completed.id, details: { scan: { sourceComplete: true, scanId: completed.id } } });
  });

  it('can abandon an unrecoverable provider cursor and restart from page one', async () => {
    process.env.HUBSPOT_ACCESS_TOKEN = 'test-service-key';
    const { createWorkspace } = await import('../lib/workspace-store');
    const { getDatabase } = await import('../db');
    const { getDuplicateScan, startDuplicateScan } = await import('../lib/duplicate-scan-store');
    const { POST } = await import('../app/api/control-tower/duplicate-scan/route');
    const workspace = await createWorkspace('Duplicate scan restart');
    const original = await startDuplicateScan(workspace.id, 'hubspot');
    const db = await getDatabase();
    await db.prepare(`UPDATE duplicate_scans SET rule_version = 'identity-v2' WHERE id = ?`).bind(original.id).run();
    const staleRuleResponse = await POST(new Request('http://localhost/api/control-tower/duplicate-scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'step', workspaceId: workspace.id, connectorId: 'hubspot', scanId: original.id }),
    }));
    expect(staleRuleResponse.status).toBe(409);

    const response = await POST(new Request('http://localhost/api/control-tower/duplicate-scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'restart', workspaceId: workspace.id, connectorId: 'hubspot' }),
    }));
    const payload = await response.json() as { scan: { id: string; cursor: { after: string | null } } };

    expect(response.status).toBe(201);
    expect(payload.scan.id).not.toBe(original.id);
    expect(payload.scan.cursor).toEqual({ after: null });
    expect(await getDuplicateScan(original.id)).toMatchObject({ status: 'failed' });
  });

  it('uses a measured lower account ceiling on D1 than local SQLite', async () => {
    const { scanRecordLimit } = await import('../app/api/control-tower/duplicate-scan/route');
    expect(scanRecordLimit('sqlite', '999999')).toBe(25_000);
    expect(scanRecordLimit('d1', '999999')).toBe(10_000);
    expect(scanRecordLimit('sqlite', '500')).toBe(500);
    expect(scanRecordLimit('d1', 'not-a-number')).toBe(10_000);
  });
});

function record(nativeId: string, firstName: string, lastName: string, email: string): IdentityRecord {
  return {
    recordKey: `hubspot:contact:${nativeId}`,
    connectorId: 'hubspot',
    objectType: 'contact',
    nativeId,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    email,
    company: 'Example Company',
    phone: '',
    jobTitle: '',
    website: 'https://example.com',
    createdAt: `2026-01-0${nativeId}T00:00:00.000Z`,
    updatedAt: `2026-01-0${nativeId}T00:00:00.000Z`,
  };
}
