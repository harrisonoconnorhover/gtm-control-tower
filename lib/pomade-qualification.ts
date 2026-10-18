import { isSuppressed } from './suppression';
import type { LiveContactState } from './live-control-tower';
import type { ImportReadiness } from './import-readiness';

export const POMADE_QUALIFICATION_LIMIT = 100;
export type QualificationInput = { sourceRowId: string; company: string; website: string; email: string };
export type QualificationCheck = {
  state: 'not_run' | 'complete' | 'review' | 'error' | 'stale';
  assessment: string | null;
  explanation: string;
  sources: { url: string; title?: string; excerpt?: string }[];
  checkedAt: string | null;
  provider: string | null;
  receiptId: string | null;
};
export type QualificationRow = {
  sourceRowId: string;
  pomadeRowId: string;
  inputs: { company: string; website: string; email: string };
  identity: QualificationCheck;
  icp: QualificationCheck;
  email: QualificationCheck;
};

export type QualificationCheckKind = 'identity' | 'icp' | 'email';
export type QualificationRunScope = { sourceRowIds: string[]; checks: QualificationCheckKind[] };
export type QualificationRunPreview = QualificationRunScope & {
  qualificationId: string;
  previewHash: string;
  rowCount: number;
  maximumSubmissions: number;
  backgroundAllowed: boolean;
  backgroundIssue: string;
  entries: { rowId: string; rowLabel: string; columnId: string; columnLabel: string;
    state: 'ready' | 'dependent' | 'setup' | 'input' | 'skipped' | 'unchecked'; details: string[]; steps: string[]; maximum: number }[];
  warnings: string[];
};
export type QualificationRunJob = {
  id: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  cursor: number;
  totalRows: number;
  completedCount: number;
  skippedCount: number;
  error: string | null;
  waitingMessage: string | null;
};
export type QualificationExecution = QualificationRunScope & {
  requestId: string;
  previewHash: string;
  requestedAt: string;
  updatedAt: string;
  status: 'starting' | 'unknown' | 'rejected' | QualificationRunJob['status'];
  job: QualificationRunJob | null;
  error: string | null;
};
export function qualificationExecutionActive(execution: QualificationExecution | undefined): boolean {
  return Boolean(execution && !['completed', 'failed', 'cancelled', 'rejected'].includes(execution.status));
}

export type SavedPomadeQualification = {
  qualificationId: string;
  requestDigest: string;
  tableId: string;
  tableUrl: string;
  sourceRevision: number;
  icpCriteria: string;
  sentAt: string;
  refreshedAt: string | null;
  stale: boolean;
  rows: QualificationRow[];
  execution?: QualificationExecution;
};
export type PomadeQualificationResponse = { configured: boolean; qualification: SavedPomadeQualification | null; readiness: ImportReadiness; preview?: QualificationRunPreview };
export type StoredPomadeQualification = Omit<SavedPomadeQualification, 'stale'> & {
  inputFingerprint: string;
  sourceUpdatedAt: number | null;
};
export type PrepareQualificationInput = {
  sourceWorkspaceId: string; sourceRevision: number; sourceName: string;
  icpCriteria: string; rows: QualificationInput[];
};

/** Exact saved values are sent; missing inputs stay empty and are not fabricated. */
export function qualificationInputs(contacts: LiveContactState[]): QualificationInput[] {
  return contacts.filter((row) => (row.importObject ?? 'contact') === 'contact'
    && row.recordStatus === 'active' && !row.importExclusion && !isSuppressed(row))
    .map((row) => ({ sourceRowId: row.contactId, company: row.company ?? '', website: row.website ?? '',
      email: row.normalizedEmail || row.rawEmail || '' }))
    .sort((left, right) => left.sourceRowId < right.sourceRowId ? -1 : left.sourceRowId > right.sourceRowId ? 1 : 0);
}

/** Suppression changes do not invalidate observations for unchanged included rows. */
export function qualificationMatchesCurrentInputs(workspaceId: string, contacts: LiveContactState[], rows: QualificationRow[], icpCriteria: string): boolean {
  const suppressedIds = new Set(contacts.filter(isSuppressed).map((row) => row.contactId));
  const savedInputs = rows.filter((row) => !suppressedIds.has(row.sourceRowId))
    .map((row) => ({ sourceRowId: row.sourceRowId, ...row.inputs }));
  return qualificationInputFingerprint(workspaceId, qualificationInputs(contacts), icpCriteria)
    === qualificationInputFingerprint(workspaceId, savedInputs, icpCriteria);
}

/** Deliberately excludes revision, ordering, import decisions and unrelated fields. */
export function qualificationInputFingerprint(workspaceId: string, rows: QualificationInput[], icpCriteria: string): string {
  return JSON.stringify([workspaceId, icpCriteria.trim(), [...rows]
    .sort((left, right) => left.sourceRowId < right.sourceRowId ? -1 : left.sourceRowId > right.sourceRowId ? 1 : 0)
    .map((row) => [row.sourceRowId, row.company, row.website, row.email])]);
}

export function validateQualificationInputs(rows: QualificationInput[]): void {
  if (!rows.length || rows.length > POMADE_QUALIFICATION_LIMIT) {
    throw new Error(`Send between 1 and ${POMADE_QUALIFICATION_LIMIT} included rows to Pomade. Split larger lists into smaller saved workspaces.`);
  }
  if (new Set(rows.map((row) => row.sourceRowId)).size !== rows.length
    || rows.some((row) => !row.sourceRowId || row.sourceRowId.length > 120
      || row.company.length > 250 || row.website.length > 2048 || row.email.length > 320)) {
    throw new Error('Included rows need distinct contact IDs and company, website and email values within the supported lengths.');
  }
}

export function pendingQualificationRows(rows: QualificationInput[]): QualificationRow[] {
  const check = (): QualificationCheck => ({ state: 'not_run', assessment: null, explanation: 'Run this check in Pomade, then refresh saved results.',
    sources: [], checkedAt: null, provider: null, receiptId: null });
  return rows.map(({ sourceRowId, ...inputs }) => ({ sourceRowId, pomadeRowId: '', inputs, identity: check(), icp: check(), email: check() }));
}
