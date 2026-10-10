import { operatorAccessError } from '@/lib/operator-auth';
import { assignImportWork, listOperationsInbox, receiveImport } from '@/lib/operations-inbox';
import { persistenceEnabled } from '@/lib/workspace-store';

const headers = { 'cache-control': 'no-store' };
function accessError(request: Request) {
  return operatorAccessError(request) ?? (!persistenceEnabled() ? Response.json({ error: 'The Operations Inbox requires persistent storage.' }, { status: 503, headers }) : null);
}
export async function GET(request: Request) {
  const denied = accessError(request);
  if (denied) return denied;
  try { return Response.json(await listOperationsInbox(), { headers }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Inbox unavailable.' }, { status: 503, headers }); }
}
export async function POST(request: Request) {
  const denied = accessError(request);
  if (denied) return denied;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Send a work item action.');
    const body = value as Record<string, unknown>;
    if (body.action === 'receive') {
      if ((body.provider !== 'hubspot' && body.provider !== 'salesforce') || typeof body.fileName !== 'string' || typeof body.csv !== 'string') throw new Error('Choose a CRM and provide a CSV file.');
      return Response.json(await receiveImport({ provider: body.provider, fileName: body.fileName, csv: body.csv }), { headers });
    }
    if (body.action === 'assign') {
      if (typeof body.id !== 'string' || typeof body.assignee !== 'string' || typeof body.note !== 'string') throw new Error('Provide a work item, assignee and note.');
      await assignImportWork(body.id, body.assignee, body.note);
      return Response.json({ saved: true }, { headers });
    }
    throw new Error('Choose receive or assign.');
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Work item could not be saved.' }, { status: 400, headers }); }
}
