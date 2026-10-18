import { isSuppressed } from '@/lib/suppression';
import { getDatabase } from '@/db';
import { operatorAccessError } from '@/lib/operator-auth';
import { checkWebsite } from '@/lib/website-checker';
import { getWebsiteChecks, saveWebsiteCheck } from '@/lib/website-check-store';
import { normalizeWebsiteUrl, WEBSITE_CHECK_BATCH_SIZE, type WebsiteCheckResult } from '@/lib/website-check-types';
import type { SavedWorkspace } from '@/lib/workspace';
import { getWorkspace, persistenceEnabled } from '@/lib/workspace-store';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  if (!persistenceEnabled()) return unavailable();
  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  if (!workspaceId || workspaceId.length > 120) {
    return Response.json({ error: 'Choose a saved workspace.' }, { status: 400, headers });
  }
  try {
    if ((await getDatabase()).kind !== 'sqlite') return unavailable();
    const workspace = await getWorkspace(workspaceId);
    if (!workspace) return Response.json({ error: 'Workspace not found.' }, { status: 404, headers });
    const allowed = workspaceWebsiteUrls(workspace, true);
    const checks = (await getWebsiteChecks(workspaceId)).filter((check) => allowed.has(check.url));
    return Response.json({ checks }, { headers });
  } catch (error) {
    console.error('Website check results could not be loaded', error);
    return Response.json({ error: 'Saved website checks could not be loaded.' }, { status: 500, headers });
  }
}

export async function POST(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  if (!persistenceEnabled()) return unavailable();
  let payload: unknown;
  try { payload = await request.json(); } catch {
    return Response.json({ error: 'A JSON body is required.' }, { status: 400, headers });
  }
  if (!isRecord(payload) || typeof payload.workspaceId !== 'string' || !payload.workspaceId || payload.workspaceId.length > 120
    || !Array.isArray(payload.urls) || !payload.urls.length || payload.urls.length > WEBSITE_CHECK_BATCH_SIZE
    || !payload.urls.every((url) => typeof url === 'string' && url.length <= 2048)
    || (payload.recheck !== undefined && typeof payload.recheck !== 'boolean')) {
    return Response.json({ error: `Choose a saved workspace and between 1 and ${WEBSITE_CHECK_BATCH_SIZE} website URLs.` }, { status: 400, headers });
  }
  const urls = payload.urls.map((url: string) => normalizeWebsiteUrl(url));
  if (urls.some((url) => !url) || new Set(urls).size !== urls.length) {
    return Response.json({ error: 'Choose distinct, valid HTTP or HTTPS website URLs.' }, { status: 400, headers });
  }
  try {
    if ((await getDatabase()).kind !== 'sqlite') return unavailable();
    const workspace = await getWorkspace(payload.workspaceId);
    if (!workspace) return Response.json({ error: 'Workspace not found.' }, { status: 404, headers });
    const allowed = workspaceWebsiteUrls(workspace);
    if (urls.some((url) => !allowed.has(url!))) {
      return Response.json({ error: 'Website checks must match active, included and unsuppressed rows in the saved workspace. Save your changes before checking.' }, { status: 409, headers });
    }
    const cached = new Map((await getWebsiteChecks(payload.workspaceId)).map((check) => [check.url, check]));
    const checks: WebsiteCheckResult[] = [];
    for (const url of urls as string[]) {
      const previous = cached.get(url);
      if (previous && !payload.recheck) {
        checks.push(previous);
        continue;
      }
      const check = await checkWebsite(url);
      const current = await getWorkspace(payload.workspaceId);
      if (!current || !workspaceWebsiteUrls(current).has(url)) {
        return Response.json({ error: 'The imported websites changed during this check. Refresh the review and try again.' }, { status: 409, headers });
      }
      await saveWebsiteCheck(payload.workspaceId, check);
      checks.push(check);
    }
    return Response.json({ checks }, { headers });
  } catch (error) {
    console.error('Website check failed or could not be saved', error);
    return Response.json({ error: 'Website checks could not be completed and saved. Reload saved results before retrying.' }, { status: 500, headers });
  }
}

function workspaceWebsiteUrls(workspace: SavedWorkspace, includeSuppressed = false): Set<string> {
  return new Set(workspace.state.contacts
    .filter((row) => row.recordStatus === 'active' && !row.importExclusion && (includeSuppressed || !isSuppressed(row)))
    .map((row) => normalizeWebsiteUrl(row.website ?? ''))
    .filter((url): url is string => Boolean(url)));
}

function unavailable() {
  return Response.json({ error: 'Website checks require saved workspaces in the self-hosted SQLite app.' }, { status: 503, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
