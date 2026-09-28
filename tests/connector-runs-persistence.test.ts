import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorReceipt } from '../lib/connector-contract';
import { verifyCrmRun } from '../lib/crm-run-verification';
import { verificationFixture } from './fixtures/crm-verification-run';

const acceptanceDirectory = mkdtempSync(join(tmpdir(), 'gtm-control-tower-runs-'));
process.env.CONTROL_TOWER_SQLITE_PATH = join(acceptanceDirectory, 'runs.db');
process.env.CONTROL_TOWER_PERSISTENCE_ENABLED = 'true';

afterAll(() => rmSync(acceptanceDirectory, { recursive: true, force: true }));

describe('durable connector run evidence', () => {
  it('persists structured run details and rollback data in SQLite', async () => {
    const { createWorkspace, listConnectorRuns, saveConnectorRun } = await import('../lib/workspace-store');
    const workspace = await createWorkspace('Run acceptance');
    const receipt: ConnectorReceipt = {
      id: crypto.randomUUID(), connectorId: 'salesforce', phase: 'receipt', status: 'executed',
      summary: 'One governed update completed.', recordsRead: 1, recordsWritten: 1, recordsFailed: 0,
      createdAt: new Date().toISOString(), undoAvailable: true, nativeReceiptId: 'native-acceptance-1',
    };
    const undo = {
      rollbackId: crypto.randomUUID(), connectorId: 'salesforce' as const, sourcePlanId: 'plan-1',
      createdAt: new Date().toISOString(), createdRecordsSkipped: 0,
      records: [{
        contactId: 'contact-1', email: 'contact@example.com', nativeId: 'lead-1',
        before: fields('Before'), after: fields('After'), changedFields: ['jobTitle' as const],
      }],
    };
    await saveConnectorRun(workspace.id, {
      receipt,
      details: { sourceLabel: 'acceptance.csv', inputCount: 1, activeCount: 1, heldCount: 0, repairCounts: { merged: 0, rerouted: 0, replayed: 0 } },
      undo,
    });
    await saveConnectorRun(workspace.id, {
      receipt: { ...receipt, summary: 'The same receipt was reconciled without resending its backup.' },
    });
    const [saved] = await listConnectorRuns(workspace.id);
    expect(saved).toMatchObject({
      id: receipt.id, connectorId: 'salesforce', details: { sourceLabel: 'acceptance.csv', inputCount: 1 },
      undo: { sourcePlanId: 'plan-1', records: [{ changedFields: ['jobTitle'] }] },
      receipt: { nativeReceiptId: 'native-acceptance-1' },
    });
    expect(saved.receipt.summary).toContain('reconciled');
  });

  it('saves and rechecks only verification, preserving the original receipt, approved plan, and rollback', async () => {
    const { createWorkspace, getConnectorRun, listConnectorRuns, saveConnectorRun, saveCrmRunVerification } = await import('../lib/workspace-store');
    const workspace = await createWorkspace('Readback acceptance');
    const { run, current } = verificationFixture();
    await saveConnectorRun(workspace.id, { receipt: run.receipt, details: run.details, undo: run.undo });
    const original = (await getConnectorRun(workspace.id, run.id))!;
    const first = await verifyCrmRun(original, async () => current);
    expect(await saveCrmRunVerification(workspace.id, original, first)).toBe(true);
    const checked = (await getConnectorRun(workspace.id, run.id))!;
    expect(checked.details!.verification).toEqual(first);
    const second = await verifyCrmRun(checked, async () => ({ ...current, fields: { ...current.fields, jobTitle: 'Changed later' } }));
    expect(await saveCrmRunVerification(workspace.id, checked, second)).toBe(true);
    const [rechecked] = await listConnectorRuns(workspace.id);
    expect(rechecked.details!.verification).toMatchObject({ verified: 0, different: 1, records: [{ differences: [{ field: 'jobTitle' }] }] });
    expect(rechecked.receipt).toEqual(original.receipt);
    expect(rechecked.details!.plan).toEqual(original.details!.plan);
    expect(rechecked.details!.writeback).toEqual(original.details!.writeback);
    expect(rechecked.undo).toEqual(original.undo);
    expect(rechecked.status).toBe(original.status);
    await saveConnectorRun(workspace.id, { receipt: run.receipt });
    expect((await getConnectorRun(workspace.id, run.id))!.details!.verification).toEqual(second);
  });

  it('scopes lookups and rejects readback persistence when its saved evidence changed', async () => {
    const { createWorkspace, getConnectorRun, saveConnectorRun, saveCrmRunVerification } = await import('../lib/workspace-store');
    const workspace = await createWorkspace('Scoped readback');
    const other = await createWorkspace('Other workspace');
    const { run, current } = verificationFixture();
    await saveConnectorRun(workspace.id, { receipt: run.receipt, details: run.details, undo: run.undo });
    const baseline = (await getConnectorRun(workspace.id, run.id))!;
    const checked = await verifyCrmRun(baseline, async () => current);
    expect(await getConnectorRun(other.id, run.id)).toBeNull();
    expect(await saveCrmRunVerification(other.id, baseline, checked)).toBe(false);
    const changed = structuredClone(run.details!);
    changed.plan!.records[0].after.jobTitle = 'Different approved value';
    await saveConnectorRun(workspace.id, { receipt: run.receipt, details: changed });
    expect(await saveCrmRunVerification(workspace.id, baseline, checked)).toBe(false);
    const latest = (await getConnectorRun(workspace.id, run.id))!;
    expect(latest.details!.plan!.records[0].after.jobTitle).toBe('Different approved value');
    expect(latest.details!.verification).toBeUndefined();
  });

});

function fields(jobTitle: string) {
  return { firstName: 'Test', lastName: 'Contact', company: 'Example', phone: null, jobTitle, website: null };
}
