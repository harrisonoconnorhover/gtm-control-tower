import { operatorAccessError } from '@/lib/operator-auth';
import { deleteImportTemplate, getImportTemplates, saveImportTemplate } from '@/lib/import-template-store';
import { persistenceEnabled } from '@/lib/workspace-store';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const access = operatorAccessError(request);
  if (access) return access;
  if (!persistenceEnabled()) return Response.json({ error: 'Saved templates require persistent workspaces.' }, { status: 503, headers });
  try { return Response.json({ templates: await getImportTemplates() }, { headers }); }
  catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const access = operatorAccessError(request);
  if (access) return access;
  if (!persistenceEnabled()) return Response.json({ error: 'Saved templates require persistent workspaces.' }, { status: 503, headers });
  try {
    const body = await request.json() as Record<string, unknown> | null;
    if (body?.action === 'save') return Response.json({ templates: await saveImportTemplate(body.template) }, { headers });
    if (body?.action === 'delete' && typeof body.id === 'string') return Response.json({ templates: await deleteImportTemplate(body.id) }, { headers });
    throw new Error('Choose save or delete.');
  } catch (error) { return failure(error); }
}

function failure(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : 'Import template operation failed.' }, { status: 400, headers });
}
