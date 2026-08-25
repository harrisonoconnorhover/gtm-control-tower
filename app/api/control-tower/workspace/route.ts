import {
  createWorkspace,
  getWorkspace,
  persistenceEnabled,
  saveConnectorReceipt,
  saveMappingPreset,
  saveWorkspace,
  undoWorkspace,
} from '@/lib/workspace-store';
import { isConnectorReceipt } from '@/lib/connector-contract';

export const runtime = 'edge';

export async function GET(request: Request) {
  if (!persistenceEnabled()) return unavailable();
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'Workspace ID is required.' }, { status: 400 });
  try {
    const workspace = await getWorkspace(id);
    return workspace
      ? Response.json({ workspace })
      : Response.json({ error: 'Workspace not found.' }, { status: 404 });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  if (!persistenceEnabled()) return unavailable();
  try {
    const payload = await request.json() as Record<string, unknown>;
    const action = typeof payload.action === 'string' ? payload.action : 'create';
    if (action === 'create') {
      return Response.json({ workspace: await createWorkspace(typeof payload.name === 'string' ? payload.name : undefined) }, { status: 201 });
    }
    if (typeof payload.id !== 'string' || !payload.id) {
      return Response.json({ error: 'Workspace ID is required.' }, { status: 400 });
    }
    if (action === 'save') {
      return Response.json({ workspace: await saveWorkspace(payload.id, payload.state, typeof payload.reason === 'string' ? payload.reason : undefined) });
    }
    if (action === 'undo') {
      return Response.json({ workspace: await undoWorkspace(payload.id) });
    }
    if (action === 'save-preset') {
      if (typeof payload.name !== 'string' || !payload.mapping || typeof payload.mapping !== 'object') {
        return Response.json({ error: 'Preset name and mapping are required.' }, { status: 400 });
      }
      const presets = await saveMappingPreset(
        payload.id,
        payload.name,
        payload.mapping,
        typeof payload.presetId === 'string' ? payload.presetId : undefined,
      );
      return Response.json({ presets });
    }
    if (action === 'receipt') {
      if (!isConnectorReceipt(payload.receipt)) return Response.json({ error: 'A valid connector receipt is required.' }, { status: 400 });
      await saveConnectorReceipt(payload.id, payload.receipt);
      return Response.json({ saved: true });
    }
    return Response.json({ error: 'Unsupported workspace action.' }, { status: 400 });
  } catch (error) {
    return failure(error);
  }
}

function unavailable() {
  return Response.json({ error: 'Persistent workspaces are disabled on this deployment.' }, { status: 503 });
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : 'Workspace operation failed.';
  const status = message === 'Workspace not found.' ? 404 : 400;
  return Response.json({ error: message }, { status });
}
