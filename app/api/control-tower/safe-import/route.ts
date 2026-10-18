import { operatorAccessError } from '@/lib/operator-auth';
import { getWorkspace, persistenceEnabled } from '@/lib/workspace-store';
import { readCrmAccountIdentity, sameCrmAccount } from '@/lib/crm-account';
import { buildSafeImportReview, safeImportEvidenceFingerprint, safeImportWorkspaceFingerprint } from '@/lib/safe-import-review-server';
import { getSafeImportReview, getLatestSafeImportReview, saveSafeImportReview, getSafeImportExecution } from '@/lib/safe-import-store';
import { executeSafeImportReview, reconcileSafeImportExecution, continueSafeImportExecution } from '@/lib/safe-import-execution';
import { isCrmReadDeferredError } from '@/lib/crm-read-transport';

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
    || !['prepare', 'approve', 'recover', 'load', 'continue'].includes(String(payload.action))
    || Object.keys(payload).some((key) => !['action', 'workspaceId', 'reviewId'].includes(key))) {
    return respond({ error: 'Submit only the action, saved workspace ID and review ID. Import settings and plans must be saved server-side.' }, 400);
  }
  try {
    const workspace = await getWorkspace(payload.workspaceId);
    if (!workspace) return respond({ error: 'Saved workspace not found.' }, 404);
    const connectorId = workspace.state.destinationType;
    if (connectorId !== 'hubspot' && connectorId !== 'salesforce') return respond({ error: 'Select a HubSpot or Salesforce destination for Safe Import.' }, 409);
    if (payload.action === 'prepare') {
      const account = await readCrmAccountIdentity(connectorId);
      const review = await buildSafeImportReview(workspace, account);
      const latest = await getWorkspace(workspace.id);
      if (!latest || review.workspaceFingerprint !== await safeImportWorkspaceFingerprint(latest)
        || !sameCrmAccount(account, await readCrmAccountIdentity(connectorId))) {
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
    const execution = await getSafeImportExecution(workspace.id, review.id);
    // Saved progress remains available during a provider outage. Reading it cannot authorize a write.
    if (payload.action === 'load') return respond({ review, execution });
    if (payload.action === 'approve' && execution) return respond({ review, execution }, 202);
    if (payload.action === 'continue' && execution?.nextAttemptAt
      && Date.parse(execution.nextAttemptAt) > Date.now() && Date.parse(review.expiresAt) > Date.now()) return respond({ review, execution }, 202);
    if (payload.action === 'continue') {
      if (!execution) return respond({ error: 'A saved approval is required before continuation.' }, 409);
      // The executor checks expiry locally and verifies the account before native work.
      // An unavailable CRM must not prevent expired, unsent rows becoming held.
      return respond({ review, execution: await continueSafeImportExecution(review) }, 202);
    }
    const account = await readCrmAccountIdentity(connectorId);
    if (!sameCrmAccount(review.account, account)) return respond({ error: 'The configured CRM account differs from this review. Execution and verification are unavailable until that account is restored.' }, 409);
    if (payload.action === 'recover') {
      if (!execution) return respond({ error: 'No execution was started for this review. Prepare or approve a current review.' }, 409);
      return respond({ review, execution: await reconcileSafeImportExecution(review, execution) });
    }
    // A duplicate click returns durable progress even after expiry or workspace edits.
    // Only the separate bounded worker continues pending rows under this approval.
    if (execution) return respond({ review, execution }, 202);
    if (!review.complete || review.rows.some((row) => row.status === 'unresolved')) return respond({ error: 'The whole-file review is incomplete. Resolve lookup failures and prepare review again before approval.' }, 409);
    if (!review.counts['proposed-update']) return respond({ error: 'This review has no contact updates to approve.' }, 409);
    if (Date.parse(review.expiresAt) <= Date.now()) return respond({ error: 'This review expired. Prepare a fresh review before approval.' }, 409);
    if (workspace.revision !== review.workspaceRevision || await safeImportWorkspaceFingerprint(workspace) !== review.workspaceFingerprint) {
      return respond({ error: 'The saved mapping, selected rows, match decisions or policy changed. Prepare a new review; earlier approval does not cover those changes.' }, 409);
    }
    const fresh = await buildSafeImportReview(workspace, account);
    if (!fresh.complete || await safeImportEvidenceFingerprint(fresh) !== await safeImportEvidenceFingerprint(review)) {
      return respond({ error: 'CRM values or identity evidence changed after review. No write was sent. Prepare a new review.' }, 409);
    }
    return respond({ review, execution: await executeSafeImportReview(review) }, 202);
  } catch (error) {
    if (isCrmReadDeferredError(error)) return Response.json({ error: error.message, retryable: true, retryAt: error.retryAt,
      guidance: 'Wait for the CRM cooldown, then load saved progress before continuing. An approval or write is never replayed automatically by this endpoint.' }, {
      status: 503, headers: { ...noStore, 'Retry-After': new Date(error.retryAt).toUTCString() },
    });
    return respond({ error: error instanceof Error ? error.message : 'Safe Import could not complete. Load the saved review to inspect durable execution before making another decision.' }, 409);
  }
}
