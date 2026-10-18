import { incidentAccess } from '@/lib/incident-access';
import { createHandoffAudit, getHandoffAuditOverview, HANDOFF_BODY_LIMIT, HandoffAuditError, reconcileHandoffAudit } from '@/lib/handoff-audit-store';

const headers = { 'cache-control': 'no-store' };

export async function GET(request: Request) {
  const access = incidentAccess(request);
  if (access instanceof Response) return access;
  try {
    return Response.json(await getHandoffAuditOverview(new URL(request.url).searchParams.get('id')), { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const access = incidentAccess(request);
  if (access instanceof Response) return access;
  if (access.role !== 'operator') return Response.json({ error: 'Operator access is required to save an audit or a reconciliation snapshot.' }, { status: 403, headers });
  try {
    const body = await boundedJson(request);
    let id: string;
    if (body.action === 'create') {
      if (typeof body.requestId !== 'string') throw new HandoffAuditError('A stable requestId is required.');
      id = (await createHandoffAudit({ requestId: body.requestId, manifest: body.manifest, ...(body.evidence === undefined ? {} : { evidence: body.evidence }) })).id;
    } else if (body.action === 'reconcile') {
      if (typeof body.id !== 'string') throw new HandoffAuditError('The saved audit ID is required.');
      if (body.manifest !== undefined) throw new HandoffAuditError('A saved source cohort is immutable. Create a new audit to use a different manifest.');
      id = (await reconcileHandoffAudit(body.id, body.evidence)).id;
    } else throw new HandoffAuditError('Choose create or reconcile.');
    return Response.json(await getHandoffAuditOverview(id), { headers });
  } catch (error) { return failure(error); }
}

async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > HANDOFF_BODY_LIMIT) throw new HandoffAuditError('Audit JSON exceeds the 5 MiB request limit.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new HandoffAuditError('Send a JSON audit action.');
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > HANDOFF_BODY_LIMIT) { await reader.cancel(); throw new HandoffAuditError('Audit JSON exceeds the 5 MiB request limit.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new HandoffAuditError('Send a valid JSON audit action.'); }
}

function failure(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : 'The handoff audit could not be completed.' },
    { status: error instanceof HandoffAuditError ? error.status : error instanceof Error && error.name === 'ZodError' ? 400 : 503, headers });
}
