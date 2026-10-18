import { z } from 'zod';
import { getDatabase } from '@/db';
import { operatorAccessError } from '@/lib/operator-auth';
import { deriveImportReadiness } from '@/lib/import-readiness';
import { getWebsiteChecks } from '@/lib/website-check-store';
import {
  POMADE_QUALIFICATION_RUN_ROW_LIMIT, pendingQualificationRows, qualificationExecutionActive, qualificationInputFingerprint, qualificationInputs, qualificationMatchesCurrentInputs, validateQualificationInputs,
  type PomadeQualificationResponse, type QualificationExecution, type QualificationRunJob, type QualificationRunScope, type StoredPomadeQualification,
} from '@/lib/pomade-qualification';
import {
  cancelPomadeQualificationRun, fetchPomadeQualification, getPomadeQualificationRun, pomadeQualificationConfigured,
  PomadeQualificationError, preparePomadeQualification, previewPomadeQualificationRun, startPomadeQualificationRun,
} from '@/lib/pomade-qualification-client';
import { beginPomadeQualification, claimPomadeExecution, getPomadeQualification, refreshPomadeQualification, savePomadeQualification } from '@/lib/pomade-qualification-store';
import type { SavedWorkspace } from '@/lib/workspace';
import { getWorkspace, persistenceEnabled } from '@/lib/workspace-store';

const headers = { 'Cache-Control': 'no-store' };
const unavailable = () => Response.json({ error: 'Pomade qualification requires saved workspaces in the self-hosted SQLite app.' }, { status: 503, headers });
const workspaceIdSchema = z.string().min(1).max(120);
const scopeSchema = {
  sourceRowIds: z.array(workspaceIdSchema).min(1).max(POMADE_QUALIFICATION_RUN_ROW_LIMIT).refine((ids) => new Set(ids).size === ids.length),
  checks: z.array(z.enum(['identity', 'icp', 'email'])).min(1).max(3).refine((checks) => new Set(checks).size === checks.length),
};
const payloadSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), workspaceId: workspaceIdSchema, icpCriteria: z.string().trim().min(1).max(1500) }).strict(),
  z.object({ action: z.literal('refresh'), workspaceId: workspaceIdSchema }).strict(),
  z.object({ action: z.literal('preview'), workspaceId: workspaceIdSchema, ...scopeSchema }).strict(),
  z.object({ action: z.literal('start'), workspaceId: workspaceIdSchema, ...scopeSchema, previewHash: z.string().regex(/^[a-f0-9]{64}$/u),
    requestId: z.uuid(), confirmExternalRequests: z.literal(true) }).strict(),
  z.object({ action: z.literal('status'), workspaceId: workspaceIdSchema }).strict(),
  z.object({ action: z.literal('cancel'), workspaceId: workspaceIdSchema }).strict(),
]);

function sourceIsStale(workspace: SavedWorkspace, saved: StoredPomadeQualification): boolean {
  return !qualificationMatchesCurrentInputs(workspace.id, workspace.state.contacts, saved.rows, saved.icpCriteria);
}
async function view(workspace: SavedWorkspace, saved: StoredPomadeQualification | null): Promise<PomadeQualificationResponse> {
  const qualification = saved ? {
    qualificationId: saved.qualificationId, requestDigest: saved.requestDigest, tableId: saved.tableId, tableUrl: saved.tableUrl,
    sourceRevision: saved.sourceRevision, icpCriteria: saved.icpCriteria, sentAt: saved.sentAt, refreshedAt: saved.refreshedAt, rows: saved.rows,
    stale: sourceIsStale(workspace, saved), ...(saved.execution ? { execution: saved.execution } : {}),
  } : null;
  const websiteChecks = await getWebsiteChecks(workspace.id);
  return { configured: pomadeQualificationConfigured(), qualification,
    readiness: deriveImportReadiness({ contacts: workspace.state.contacts, workspaceId: workspace.id, websiteChecks, qualification }),
  };
}

export async function GET(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  if (!persistenceEnabled()) return unavailable();
  const parsed = workspaceIdSchema.safeParse(new URL(request.url).searchParams.get('workspaceId'));
  if (!parsed.success) return Response.json({ error: 'Choose a saved workspace.' }, { status: 400, headers });
  try {
    if ((await getDatabase()).kind !== 'sqlite') return unavailable();
    const workspace = await getWorkspace(parsed.data);
    if (!workspace) return Response.json({ error: 'Workspace not found.' }, { status: 404, headers });
    return Response.json(await view(workspace, await getPomadeQualification(workspace.id)), { headers });
  } catch { return Response.json({ error: 'Saved Pomade observations could not be loaded.' }, { status: 500, headers }); }
}

export async function POST(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  if (!persistenceEnabled()) return unavailable();
  let payload: unknown;
  try { payload = await request.json(); } catch { return Response.json({ error: 'A JSON body is required.' }, { status: 400, headers }); }
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return Response.json({ error: 'Choose a saved workspace and valid action. Starting checks requires the reviewed rows, checks, preview hash, request ID and explicit external-request confirmation.' }, { status: 400, headers });
  const input = parsed.data;
  try {
    if ((await getDatabase()).kind !== 'sqlite') return unavailable();
    const workspace = await getWorkspace(input.workspaceId);
    if (!workspace) return Response.json({ error: 'Workspace not found.' }, { status: 404, headers });
    if (workspace.state.importObject === 'company') {
      return failure('Pomade qualification requires contacts or contacts with associated companies. Company-only imports remain local review and export only.', 409);
    }
    const previous = await getPomadeQualification(workspace.id);
    if (input.action === 'send') {
      const rows = qualificationInputs(workspace.state.contacts);
      try { validateQualificationInputs(rows); } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400, headers });
      }
      const fingerprint = qualificationInputFingerprint(workspace.id, rows, input.icpCriteria);
      if (previous && previous.icpCriteria.trim() === input.icpCriteria.trim() && !sourceIsStale(workspace, previous)) return Response.json(await view(workspace, previous), { headers });
      if (qualificationExecutionActive(previous?.execution)) return failure('Finish or cancel the saved Pomade run before replacing this qualification. Check its status if the start is uncertain.', 409);
      const token = await beginPomadeQualification(workspace.id, previous);
      if (!token) return changed();
      const prepared = await preparePomadeQualification({ sourceWorkspaceId: workspace.id, sourceRevision: workspace.revision,
        sourceName: workspace.name.slice(0, 100), icpCriteria: input.icpCriteria, rows });
      const saved: StoredPomadeQualification = { qualificationId: prepared.qualificationId, requestDigest: prepared.requestDigest, tableId: prepared.tableId,
        tableUrl: prepared.tableUrl, sourceRevision: workspace.revision, icpCriteria: input.icpCriteria, sentAt: new Date().toISOString(), refreshedAt: null,
        inputFingerprint: fingerprint, sourceUpdatedAt: null, rows: pendingQualificationRows(rows) };
      if (!await savePomadeQualification(workspace.id, token, saved)) return changed();
    } else {
      if (!previous) return failure('Send this saved list to Pomade before previewing, running or refreshing its checks.', 409);
      if (input.action === 'preview' || input.action === 'start') {
        if (sourceIsStale(workspace, previous)) return failure('The included inputs changed. Send the updated list to Pomade and preview its checks again.', 409);
        if (input.sourceRowIds.some((id) => !previous.rows.some((row) => row.sourceRowId === id))) return failure('Choose rows from this saved Pomade qualification.', 400);
        const includedIds = new Set(qualificationInputs(workspace.state.contacts).map((row) => row.sourceRowId));
        if (input.sourceRowIds.some((id) => !includedIds.has(id))) return failure('Suppressed, skipped or merged rows cannot run Pomade checks.', 409);
        const scope = normalizedScope(input);
        if (input.action === 'preview') {
          const preview = await previewPomadeQualificationRun(previous, scope);
          const currentWorkspace = await getWorkspace(workspace.id);
          const current = await getPomadeQualification(workspace.id);
          if (!currentWorkspace || !current || current.qualificationId !== previous.qualificationId || sourceIsStale(currentWorkspace, current)) return changed();
          return Response.json({ ...await view(currentWorkspace, current), preview }, { headers });
        }
        const existing = previous.execution;
        if (existing?.requestId === input.requestId
          && (existing.previewHash !== input.previewHash || JSON.stringify(normalizedScope(existing)) !== JSON.stringify(scope))) {
          return failure('This request ID already belongs to a different preview or selection. Reload its saved status.', 409);
        }
        if (qualificationExecutionActive(existing) && existing?.requestId !== input.requestId) {
          return failure('This qualification already has an active or uncertain run. Check its saved status instead of starting another.', 409);
        }
        if (existing?.requestId === input.requestId && existing.job) return Response.json(await view(workspace, previous), { headers });
        const now = new Date().toISOString();
        const execution: QualificationExecution = { ...scope, requestId: input.requestId, previewHash: input.previewHash,
          requestedAt: existing?.requestId === input.requestId ? existing.requestedAt : now, updatedAt: now, status: 'starting', job: null, error: null };
        const claimed = { ...previous, execution };
        if (!await claimPomadeExecution(workspace.id, previous, claimed)) return changed();
        try {
          const result = await startPomadeQualificationRun(claimed, execution);
          const saved = { ...claimed, execution: executionWithJob(execution, result.job) };
          if (!await refreshPomadeQualification(workspace.id, claimed, saved)) return changed();
        } catch (error) {
          const message = error instanceof PomadeQualificationError ? error.message : 'The run start could not be confirmed. Check its saved status before retrying.';
          const failed: StoredPomadeQualification = { ...claimed, execution: { ...execution,
            status: error instanceof PomadeQualificationError && error.startRejected ? 'rejected' : 'unknown', error: message, updatedAt: new Date().toISOString() } };
          await refreshPomadeQualification(workspace.id, claimed, failed);
          throw error;
        }
      } else if (input.action === 'status' || input.action === 'cancel') {
        if (!previous.execution) return failure('No saved Pomade run exists for this qualification.', 409);
        const result = input.action === 'cancel'
          ? await cancelPomadeQualificationRun(previous, previous.execution)
          : await getPomadeQualificationRun(previous, previous.execution);
        const observations = await refreshedObservations(workspace.id, previous);
        const saved = { ...observations, execution: executionWithJob(previous.execution, result.job) };
        if (JSON.stringify(saved) !== JSON.stringify(previous) && !await refreshPomadeQualification(workspace.id, previous, saved)) return changed();
      } else {
        const saved = await refreshedObservations(workspace.id, previous);
        if (saved !== previous && !await refreshPomadeQualification(workspace.id, previous, saved)) return changed();
      }
    }
    const current = await getWorkspace(workspace.id);
    if (!current) return changed();
    return Response.json(await view(current, await getPomadeQualification(workspace.id)), { headers });
  } catch (error) {
    if (error instanceof PomadeQualificationError) return failure(error.message, error.status);
    return failure('Pomade qualification could not be saved. Reload saved progress and check the run status before retrying.', 500);
  }
}

function normalizedScope(scope: QualificationRunScope): QualificationRunScope {
  return { sourceRowIds: [...scope.sourceRowIds].sort(), checks: [...scope.checks].sort() };
}
function executionWithJob(execution: QualificationExecution, job: QualificationRunJob | null): QualificationExecution {
  const status = job?.status ?? (execution.status === 'rejected' ? 'rejected' : 'unknown');
  const error = job?.error ?? (job ? null : execution.status === 'rejected' ? execution.error
    : 'Pomade has no saved job for this request yet. Check status again or explicitly retry the same request; do not start a new request.');
  if (execution.status === status && execution.error === error && JSON.stringify(execution.job) === JSON.stringify(job)) return execution;
  return { ...execution, status, job, error, updatedAt: new Date().toISOString() };
}
async function refreshedObservations(workspaceId: string, previous: StoredPomadeQualification): Promise<StoredPomadeQualification> {
  const result = await fetchPomadeQualification(workspaceId, previous);
  if (previous.sourceUpdatedAt === result.updatedAt && JSON.stringify(previous.rows) === JSON.stringify(result.rows)
    && previous.tableUrl === result.tableUrl) return previous;
  return { ...previous, tableUrl: result.tableUrl, rows: result.rows, sourceUpdatedAt: result.updatedAt, refreshedAt: new Date().toISOString() };
}
function failure(error: string, status: number) { return Response.json({ error }, { status, headers }); }
function changed() { return failure('A newer Pomade transfer or run update completed during this request. Reload the saved progress.', 409); }
