import { canVerifyCrmRun, verifyCrmRun } from '@/lib/crm-run-verification';
import { readConfirmedTarget } from '@/lib/import-match-decision-server';
import { operatorAccessError } from '@/lib/operator-auth';
import { getConnectorRun, persistenceEnabled, saveCrmRunVerification } from '@/lib/workspace-store';

export const runtime = 'edge';

export async function POST(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  if (!persistenceEnabled()) return failure('Persistent run history is disabled.', 503);
  let payload: unknown;
  try { payload = await request.json(); } catch { return failure('A JSON body is required.', 400); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return failure('A saved workspace and run are required.', 400);
  const input = payload as Record<string, unknown>;
  if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()
    || typeof input.runId !== 'string' || !input.runId.trim()
    || Object.keys(input).some((key) => key !== 'workspaceId' && key !== 'runId')) {
    return failure('Provide only the saved workspaceId and runId. Verification uses the saved plan and receipt.', 400);
  }
  try {
    const run = await getConnectorRun(input.workspaceId, input.runId);
    if (!run) return failure('Saved run not found in this workspace.', 404);
    if (!canVerifyCrmRun(run)) return failure('This run has no matching saved plan and successful CRM write receipt to verify.', 409);
    const verification = await verifyCrmRun(run, readConfirmedTarget);
    let saved = false;
    try { saved = await saveCrmRunVerification(input.workspaceId, run, verification); }
    catch { return failure('CRM reads completed, but the check could not be saved. The previous saved check and write receipt are unchanged. Retry verification to read again.', 502); }
    if (!saved) return failure('The saved run changed during verification. The check was not saved; reload the run and verify again.', 409);
    return Response.json({ verification }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'The saved run could not be verified.', 502);
  }
}

function failure(error: string, status: number) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}
