import { isConnectorReceipt } from '@/lib/connector-contract';
import { isConnectorRunInput } from '@/lib/connector-run';
import { listConnectorRuns, persistenceEnabled, saveConnectorRun } from '@/lib/workspace-store';

export const runtime = 'edge';

export async function GET(request: Request) {
  if (!persistenceEnabled()) return Response.json({ error: 'Persistent run history is disabled.' }, { status: 503 });
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspaceId');
  if (!workspaceId) return Response.json({ error: 'workspaceId is required.' }, { status: 400 });
  const limit = Number(url.searchParams.get('limit') ?? 50);
  try {
    return Response.json({ runs: await listConnectorRuns(workspaceId, limit) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  if (!persistenceEnabled()) return Response.json({ error: 'Persistent run history is disabled.' }, { status: 503 });
  try {
    const payload = await request.json() as Record<string, unknown>;
    if (typeof payload.workspaceId !== 'string' || !isConnectorRunInput(payload.run) || !isConnectorReceipt(payload.run.receipt)) {
      return Response.json({ error: 'A workspace and valid connector run are required.' }, { status: 400 });
    }
    await saveConnectorRun(payload.workspaceId, payload.run);
    return Response.json({ saved: true }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : 'Run history operation failed.' }, { status: 400 });
}
