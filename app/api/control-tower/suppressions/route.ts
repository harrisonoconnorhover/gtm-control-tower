import { getDatabase } from '@/db';
import { operatorAccessError } from '@/lib/operator-auth';
import { deleteSuppressionRule, getSuppressionRules, importSuppressionRules, saveSuppressionRule } from '@/lib/suppression-store';
import { persistenceEnabled } from '@/lib/workspace-store';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  if (!persistenceEnabled() || (await getDatabase()).kind !== 'sqlite') return unavailable();
  try {
    return Response.json({ rules: await getSuppressionRules() }, { headers });
  } catch (error) {
    console.error('Suppression lists could not be loaded', error);
    return Response.json({ error: 'Suppression lists could not be loaded.' }, { status: 500, headers });
  }
}

export async function POST(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  if (!persistenceEnabled() || (await getDatabase()).kind !== 'sqlite') return unavailable();
  let payload: unknown;
  try { payload = await request.json(); } catch {
    return Response.json({ error: 'A JSON body is required.' }, { status: 400, headers });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return Response.json({ error: 'Choose save, import, or delete.' }, { status: 400, headers });
  }
  const body = payload as Record<string, unknown>;
  try {
    if (body.action === 'save') return Response.json({ rules: await saveSuppressionRule(body.rule) }, { headers });
    if (body.action === 'import') return Response.json({ rules: await importSuppressionRules(body.rules) }, { headers });
    if (body.action === 'delete' && typeof body.id === 'string') {
      return Response.json({ rules: await deleteSuppressionRule(body.id) }, { headers });
    }
    return Response.json({ error: 'Choose save, import, or delete.' }, { status: 400, headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Suppression lists could not be saved.' }, { status: 400, headers });
  }
}

function unavailable() {
  return Response.json({ error: 'Saved suppression lists require the self-hosted SQLite app.' }, { status: 503, headers });
}
