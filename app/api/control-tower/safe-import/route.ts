import { operatorAccessError } from '@/lib/operator-auth';
import { getWorkspace, persistenceEnabled } from '@/lib/workspace-store';
import { readHubSpotAccountIdentity, sameCrmAccount } from '@/lib/crm-account';
import { buildSafeImportReview, safeImportWorkspaceFingerprint } from '@/lib/safe-import-review-server';
import { getSafeImportReview, getLatestSafeImportReview, saveSafeImportReview, getSafeImportExecution } from '@/lib/safe-import-store';

const noStore = { 'Cache-Control': 'no-store' };
const respond = (value: unknown, status = 200) => Response.json(value, { status, headers: noStore });

/** Requests identify saved evidence. They cannot substitute rows, plans or policies. */
export async function POST(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  if (!persistenceEnabled()) return respond({ error: 'Safe Import requires a persistent saved workspace.' }, 503);
  let body: unknown;
  try { body = await request.json(); } catch { return respond({ error: 'A JSON body is required.' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return respond({ error: 'Choose a Safe Import action.' }, 400);
  const payload = body as Record<string, unknown>;
  if (typeof payload.workspaceId !== 'string' || !payload.workspaceId
    || !['prepare', 'approve', 'recover', 'load'].includes(String(payload.action))
    || Object.keys(payload).some((key) => !['action', 'workspaceId', 'reviewId'].includes(key))) {
    return respond({ error: 'Submit only the action, saved workspace ID and review ID. Import settings and plans must be saved server-side.' }, 400);
  }
  try {
    const workspace = await getWorkspace(payload.workspaceId);
    if (!workspace) return respond({ error: 'Saved workspace not found.' }, 404);
    const account = await readHubSpotAccountIdentity(process.env.HUBSPOT_ACCESS_TOKEN ?? '');
    if (payload.action === 'prepare') {
      const review = await buildSafeImportReview(workspace, account);
      const latest = await getWorkspace(workspace.id);
      if (!latest || review.workspaceFingerprint !== await safeImportWorkspaceFingerprint(latest)
        || !sameCrmAccount(account, await readHubSpotAccountIdentity(process.env.HUBSPOT_ACCESS_TOKEN ?? ''))) {
        return respond({ error: 'The workspace or CRM account changed while reading. Prepare a new review.' }, 409);
      }
      await saveSafeImportReview(review);
      return respond({ review, execution: null });
    }
    if (payload.action !== 'load' && (typeof payload.reviewId !== 'string' || !payload.reviewId)) return respond({ error: 'A saved review ID is required.' }, 400);
    const review = typeof payload.reviewId === 'string' && payload.reviewId
      ? await getSafeImportReview(workspace.id, payload.reviewId) : await getLatestSafeImportReview(workspace.id);
    if (!review && payload.action === 'load') return respond({ review: null, execution: null });
    if (!review) return respond({ error: 'Saved review not found for this workspace.' }, 404);
    if (!sameCrmAccount(review.account, account)) return respond({ error: 'The configured HubSpot account differs from this review. Execution and verification are unavailable until that account is restored.' }, 409);
    const execution = await getSafeImportExecution(workspace.id, review.id);
    if (payload.action === 'load') return respond({ review, execution });
    return respond({ error: 'This review is saved. Durable approved execution is not enabled in this change yet.' }, 503);
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : 'Safe Import could not complete. Load the saved review to inspect durable execution before making another decision.' }, 409);
  }
}
