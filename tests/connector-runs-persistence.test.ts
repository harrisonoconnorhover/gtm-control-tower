import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorReceipt } from '../lib/connector-contract';

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
});

function fields(jobTitle: string) {
  return { firstName: 'Test', lastName: 'Contact', company: 'Example', phone: null, jobTitle, website: null };
}
