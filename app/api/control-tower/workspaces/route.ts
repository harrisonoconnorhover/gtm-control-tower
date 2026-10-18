import { operatorAccessError } from '@/lib/operator-auth';
import { listSavedWorkspaces, persistenceEnabled } from '@/lib/workspace-store';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const denied = operatorAccessError(request);
  if (denied) return denied;
  if (!persistenceEnabled()) return Response.json({ error: 'Persistent workspaces are disabled on this deployment.' }, { status: 503, headers });
  const params = new URL(request.url).searchParams;
  const limit = params.has('limit') ? Number(params.get('limit')) : 50;
  const offset = params.has('offset') ? Number(params.get('offset')) : 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    return Response.json({ error: 'Use a limit from 1 to 100 and a non-negative integer offset.' }, { status: 400, headers });
  }
  try { return Response.json(await listSavedWorkspaces({ limit, offset }), { headers }); }
  catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Saved workspaces could not be listed.' }, { status: 500, headers });
  }
}
