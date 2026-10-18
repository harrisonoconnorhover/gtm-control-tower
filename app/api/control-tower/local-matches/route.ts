import { operatorAccessError } from '@/lib/operator-auth';
import { decideLocalMatch, getLocalMatchReview, LocalMatchReviewError, type LocalMatchReviewOptions } from '@/lib/local-match-review-server';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  const query = new URL(request.url).searchParams;
  try {
    const report = await getLocalMatchReview(query.get('workspaceId') ?? '', {
      offset: query.has('offset') ? Number(query.get('offset')) : undefined,
      limit: query.has('limit') ? Number(query.get('limit')) : undefined,
      status: (query.get('status') ?? undefined) as LocalMatchReviewOptions['status'],
      kind: (query.get('kind') ?? undefined) as LocalMatchReviewOptions['kind'],
    });
    return Response.json(report, { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  let payload: unknown;
  try { payload = await request.json(); } catch {
    return Response.json({ error: 'A JSON body is required.' }, { status: 400, headers });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalidBody();
  const body = payload as Record<string, unknown>;
  if (typeof body.workspaceId !== 'string' || typeof body.id !== 'string' || typeof body.fingerprint !== 'string'
    || (body.action !== 'confirm' && body.action !== 'dismiss' && body.action !== 'clear')) return invalidBody();
  try {
    return Response.json(await decideLocalMatch(body.workspaceId, body.id, body.fingerprint, body.action), { headers });
  } catch (error) { return failure(error); }
}

function invalidBody() {
  return Response.json({ error: 'Choose a saved workspace, current suggestion and Confirm, Dismiss or Clear.' }, { status: 400, headers });
}

function failure(error: unknown) {
  if (error instanceof LocalMatchReviewError) return Response.json({ error: error.message }, { status: error.status, headers });
  console.error('Local match review failed', error);
  return Response.json({ error: 'Local match review could not be loaded or saved.' }, { status: 500, headers });
}
