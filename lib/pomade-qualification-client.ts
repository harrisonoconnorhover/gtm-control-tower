import { createHash } from 'node:crypto';
import { z } from 'zod';
import { POMADE_QUALIFICATION_LIMIT, POMADE_QUALIFICATION_RUN_ROW_LIMIT } from './pomade-qualification';
import type { PrepareQualificationInput, QualificationExecution, QualificationRunPreview, QualificationRunScope, StoredPomadeQualification } from './pomade-qualification';

export class PomadeQualificationError extends Error {
  constructor(message: string, public status = 502, public startRejected = false) { super(message); }
}

const id = z.string().min(1).max(120);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const httpUrl = z.string().max(2048).refine((value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
});
const check = z.object({
  state: z.enum(['not_run', 'complete', 'review', 'error', 'stale']), assessment: z.string().max(500).nullable(),
  explanation: z.string().max(8000), sources: z.array(z.object({ url: httpUrl, title: z.string().max(1000).optional(), excerpt: z.string().max(8000).optional() })).max(20),
  checkedAt: z.iso.datetime().nullable(), provider: z.string().max(120).nullable(), receiptId: z.string().max(200).nullable(),
});
const preparedSchema = z.object({ qualificationId: id, tableId: id, tablePath: z.string().max(500), created: z.boolean(), requestDigest: digest, rowCount: z.number().int().min(1).max(POMADE_QUALIFICATION_LIMIT) });
const resultsSchema = z.object({
  qualificationId: id, requestDigest: digest, sourceWorkspaceId: id, sourceRevision: z.number().int().nonnegative(),
  icpCriteria: z.string().min(1).max(1500), tableId: id, tablePath: z.string().max(500), updatedAt: z.number().nonnegative(),
  rows: z.array(z.object({ sourceRowId: id, pomadeRowId: id,
    inputs: z.object({ company: z.string().max(250), website: z.string().max(2048), email: z.string().max(320) }),
    identity: check, icp: check, email: check,
  })).min(1).max(POMADE_QUALIFICATION_LIMIT),
});

function origin(value: string, name: string) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new PomadeQualificationError(`${name} must be an HTTP or HTTPS origin without credentials or a path.`, 503); }
}

function configuration() {
  const apiUrl = process.env.CONTROL_TOWER_POMADE_API_URL?.trim();
  const key = process.env.CONTROL_TOWER_POMADE_API_KEY?.trim();
  if (!apiUrl || !key) throw new PomadeQualificationError('Connect Pomade by setting CONTROL_TOWER_POMADE_API_URL and CONTROL_TOWER_POMADE_API_KEY on the Control Tower server.', 503);
  return { apiUrl: origin(apiUrl, 'CONTROL_TOWER_POMADE_API_URL'), key,
    publicUrl: origin(process.env.CONTROL_TOWER_POMADE_PUBLIC_URL?.trim() || apiUrl, 'CONTROL_TOWER_POMADE_PUBLIC_URL') };
}

export function pomadeQualificationConfigured(): boolean {
  try { configuration(); return true; } catch { return false; }
}

export function qualificationRequestDigest(input: PrepareQualificationInput): string {
  const rows = [...input.rows].sort((left, right) => left.sourceRowId < right.sourceRowId ? -1 : left.sourceRowId > right.sourceRowId ? 1 : 0);
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
    return JSON.stringify(value);
  }
  return createHash('sha256').update(canonical({ sourceWorkspaceId: input.sourceWorkspaceId, icpCriteria: input.icpCriteria.trim(), rows })).digest('hex');
}

type QualificationPath = 'prepare_qualification' | 'get_qualification' | 'preview_qualification_run' | 'start_qualification_run' | 'get_qualification_run' | 'cancel_qualification_run';
async function request(path: QualificationPath, body: unknown): Promise<unknown> {
  const config = configuration();
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > 256 * 1024) throw new PomadeQualificationError('This list exceeds Pomade’s 256 KiB request limit. Split it into smaller saved workspaces.', 400);
  try {
    const response = await fetch(`${config.apiUrl}/api/v1/${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${config.key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: serialized, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const rejected = path === 'start_qualification_run' && response.status >= 400 && response.status < 500;
      if ([401, 403].includes(response.status)) {
        await response.body?.cancel();
        throw new PomadeQualificationError('Pomade rejected the API key or its permissions. Configure a Pomade key with read and run permissions.', 502, rejected);
      }
      // Pomade owns the budget and preview validation. Preserve its actionable refusal
      // without ever returning the server credential, even if an error echoes it.
      let detail = '';
      if ([400, 404, 409].includes(response.status)) {
        try {
          const text = await response.text();
          if (text.length <= 16_384) {
            const value = JSON.parse(text) as { error?: unknown };
            if (typeof value.error === 'string') detail = value.error.replaceAll(config.key, '[redacted]').slice(0, 1500);
          }
        } catch { /* Use the fixed status message below. */ }
      } else await response.body?.cancel();
      throw new PomadeQualificationError(detail || `Pomade returned HTTP ${response.status}. Check the saved run status before retrying.`,
        [400, 404, 409].includes(response.status) ? response.status : 502, rejected);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof PomadeQualificationError) throw error;
    throw new PomadeQualificationError('Pomade could not be reached or returned an invalid response. Reload saved progress and check the run status before retrying; a start may already have queued work.');
  }
}

function tableUrl(tableId: string, tablePath: string): string {
  const expected = `/?table=${encodeURIComponent(tableId)}`;
  if (tablePath !== expected) throw new PomadeQualificationError('Pomade returned an unexpected qualification table link.');
  return `${configuration().publicUrl}${expected}`;
}

export async function preparePomadeQualification(input: PrepareQualificationInput) {
  const parsed = preparedSchema.safeParse(await request('prepare_qualification', input));
  if (!parsed.success) throw new PomadeQualificationError('Pomade returned an invalid qualification receipt.');
  const result = parsed.data;
  if (result.requestDigest !== qualificationRequestDigest(input) || result.rowCount !== input.rows.length) {
    throw new PomadeQualificationError('Pomade’s qualification receipt did not match the submitted list.');
  }
  return { ...result, tableUrl: tableUrl(result.tableId, result.tablePath) };
}

export async function fetchPomadeQualification(workspaceId: string, saved: StoredPomadeQualification) {
  const parsed = resultsSchema.safeParse(await request('get_qualification', { qualificationId: saved.qualificationId }));
  if (!parsed.success) throw new PomadeQualificationError('Pomade returned invalid qualification observations.');
  const result = parsed.data;
  const expected = new Map(saved.rows.map((row) => [row.sourceRowId, row.inputs]));
  if (result.qualificationId !== saved.qualificationId || result.requestDigest !== saved.requestDigest
    || result.sourceWorkspaceId !== workspaceId || result.tableId !== saved.tableId || result.icpCriteria !== saved.icpCriteria
    || result.rows.length !== expected.size || new Set(result.rows.map((row) => row.sourceRowId)).size !== expected.size
    || result.rows.some((row) => { const input = expected.get(row.sourceRowId); return !input
      || input.company !== row.inputs.company || input.website !== row.inputs.website || input.email !== row.inputs.email; })) {
    throw new PomadeQualificationError('Pomade’s observations did not match the saved source rows. The earlier saved observations were retained.');
  }
  if (saved.sourceUpdatedAt !== null && result.updatedAt < saved.sourceUpdatedAt) {
    throw new PomadeQualificationError('Pomade returned observations older than the saved results. The saved results were retained.');
  }
  return { ...result, tableUrl: tableUrl(result.tableId, result.tablePath) };
}


const checkKind = z.enum(['identity', 'icp', 'email']);
const runScope = {
  sourceRowIds: z.array(id).min(1).max(POMADE_QUALIFICATION_RUN_ROW_LIMIT), checks: z.array(checkKind).min(1).max(3),
};
const runPreviewSchema = z.object({
  qualificationId: id, previewHash: digest, ...runScope, rowCount: z.number().int().min(1).max(POMADE_QUALIFICATION_RUN_ROW_LIMIT),
  maximumSubmissions: z.number().int().nonnegative(), backgroundAllowed: z.boolean(), backgroundIssue: z.string().max(8000),
  entries: z.array(z.object({ rowId: id, rowLabel: z.string().max(2000), columnId: id, columnLabel: z.string().max(500),
    state: z.enum(['ready', 'dependent', 'setup', 'input', 'skipped', 'unchecked']), details: z.array(z.string().max(8000)).max(50),
    steps: z.array(z.string().max(2000)).max(50), maximum: z.number().int().nonnegative(),
  })).max(300), warnings: z.array(z.string().max(8000)).max(POMADE_QUALIFICATION_RUN_ROW_LIMIT),
});
const runResponseSchema = z.object({
  qualificationId: id, requestId: z.uuid(), job: z.object({
    id, status: z.enum(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']),
    cursor: z.number().int().min(0).max(POMADE_QUALIFICATION_RUN_ROW_LIMIT), totalRows: z.number().int().min(1).max(POMADE_QUALIFICATION_RUN_ROW_LIMIT),
    completedCount: z.number().int().nonnegative(), skippedCount: z.number().int().nonnegative(),
    error: z.string().max(8000).nullable(), waitingMessage: z.string().max(8000).nullable(),
  }).nullable(),
});
function sameSelection(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && [...left].sort().every((item, index) => item === [...right].sort()[index]);
}
export async function previewPomadeQualificationRun(saved: StoredPomadeQualification, scope: QualificationRunScope): Promise<QualificationRunPreview> {
  const parsed = runPreviewSchema.safeParse(await request('preview_qualification_run', { qualificationId: saved.qualificationId, ...scope }));
  if (!parsed.success) throw new PomadeQualificationError('Pomade returned an invalid run preview.');
  const result = parsed.data;
  if (result.qualificationId !== saved.qualificationId || result.rowCount !== scope.sourceRowIds.length
    || !sameSelection(result.sourceRowIds, scope.sourceRowIds) || !sameSelection(result.checks, scope.checks)) {
    throw new PomadeQualificationError('Pomade’s run preview did not match the selected rows and checks.');
  }
  return result;
}
async function qualificationRunRequest(path: 'start_qualification_run' | 'get_qualification_run' | 'cancel_qualification_run',
  saved: StoredPomadeQualification, execution: QualificationExecution) {
  const identity = { qualificationId: saved.qualificationId, requestId: execution.requestId };
  const parsed = runResponseSchema.safeParse(await request(path, path === 'start_qualification_run'
    ? { ...identity, sourceRowIds: execution.sourceRowIds, checks: execution.checks, previewHash: execution.previewHash, confirmExternalRequests: true }
    : identity));
  if (!parsed.success) throw new PomadeQualificationError('Pomade returned an invalid saved run status. Check status before starting another run.');
  const result = parsed.data;
  if (result.qualificationId !== saved.qualificationId || result.requestId !== execution.requestId
    || (result.job && (result.job.totalRows !== execution.sourceRowIds.length || result.job.cursor > result.job.totalRows))) {
    throw new PomadeQualificationError('Pomade’s run status did not match this saved request.');
  }
  return result;
}
export const startPomadeQualificationRun = (saved: StoredPomadeQualification, execution: QualificationExecution) => qualificationRunRequest('start_qualification_run', saved, execution);
export const getPomadeQualificationRun = (saved: StoredPomadeQualification, execution: QualificationExecution) => qualificationRunRequest('get_qualification_run', saved, execution);
export const cancelPomadeQualificationRun = (saved: StoredPomadeQualification, execution: QualificationExecution) => qualificationRunRequest('cancel_qualification_run', saved, execution);
