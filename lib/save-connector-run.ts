import type { ConnectorRunInput } from './connector-run';

export type PendingConnectorRun = {
  workspaceId: string | null;
  run: ConnectorRunInput;
};

export async function saveConnectorRunReceipt(pending: PendingConnectorRun): Promise<void> {
  if (!pending.workspaceId) throw new Error('No saved workspace is available. Download this receipt to keep the CRM result.');
  let response: Response;
  try {
    response = await fetch('/api/control-tower/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pending),
    });
  } catch {
    throw new Error('Run history could not be reached. The CRM operation has already completed.');
  }
  if (!response.ok) throw new Error(`Run history did not save this receipt (HTTP ${response.status}).`);
  let result: unknown;
  try { result = await response.json(); } catch { throw new Error('Run history did not return a save confirmation.'); }
  if (!result || typeof result !== 'object' || !('saved' in result) || result.saved !== true) {
    throw new Error('Run history did not confirm that this receipt was saved.');
  }
}
