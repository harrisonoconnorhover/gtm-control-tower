import { createHash } from 'node:crypto';
import { ensureWorkspaceSchema, getDatabase, type DatabaseAdapter } from '@/db';
import { getDuplicateScanRecords, getLatestDuplicateScan } from './duplicate-scan-store';
import type { IdentityConnector, IdentityRecord } from './identity-resolution';
import { buildLocalMatchReport, type LocalMatchFinding } from './local-match';
import { getSuppressionRules } from './suppression-store';
import { getWorkspace, persistenceEnabled } from './workspace-store';

export type LocalMatchDecision = { status: 'confirmed' | 'dismissed'; decidedAt: string };
export type LocalMatchReviewFinding = LocalMatchFinding & {
  id: string;
  fingerprint: string;
  decision: LocalMatchDecision | null;
};
export type LocalMatchReviewOptions = {
  offset?: number;
  limit?: number;
  status?: 'all' | 'pending' | LocalMatchDecision['status'];
  kind?: 'all' | LocalMatchFinding['kind'];
};
export type LocalMatchSnapshot = {
  id: string;
  connectorId: IdentityConnector;
  recordsScanned: number;
  sourceComplete: boolean;
  completedAt: string | null;
};
export type LocalMatchReviewReport = Omit<ReturnType<typeof buildLocalMatchReport>, 'findings'> & {
  workspaceId: string;
  workspaceRevision: number;
  findings: LocalMatchReviewFinding[];
  snapshots: LocalMatchSnapshot[];
  counts: { pending: number; confirmed: number; dismissed: number };
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
};

export class LocalMatchReviewError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 | 503) { super(message); }
}

type DecisionRow = { finding_id: string; fingerprint: string; status: LocalMatchDecision['status']; decided_at: string };
type FullReport = Omit<LocalMatchReviewReport, 'total' | 'offset' | 'limit' | 'nextOffset'>;
const statuses = new Set(['all', 'pending', 'confirmed', 'dismissed']);
const kinds = new Set(['all', 'company_variant', 'possible_duplicate', 'possible_suppression']);

/** Compares only saved local inputs. This does not scan, refresh or contact a CRM. */
export async function getLocalMatchReview(workspaceId: string, options: LocalMatchReviewOptions = {}): Promise<LocalMatchReviewReport> {
  validateWorkspaceId(workspaceId);
  const validated = validateOptions(options);
  return paginate(await fullReport(await reviewDatabase(), workspaceId), validated);
}

/** Confirmation records an acknowledgement, never a merge, correction or CRM target. */
export async function decideLocalMatch(
  workspaceId: string, id: string, fingerprint: string, action: 'confirm' | 'dismiss' | 'clear',
): Promise<LocalMatchReviewReport> {
  validateWorkspaceId(workspaceId);
  if (!/^[a-f0-9]{64}$/u.test(id) || !/^[a-f0-9]{64}$/u.test(fingerprint)
    || !['confirm', 'dismiss', 'clear'].includes(action)) {
    throw new LocalMatchReviewError('Choose a current suggestion and Confirm, Dismiss or Clear.', 400);
  }
  const db = await reviewDatabase();
  const report = await fullReport(db, workspaceId);
  const finding = report.findings.find((item) => item.id === id);
  if (!finding || finding.fingerprint !== fingerprint) {
    throw new LocalMatchReviewError('This suggestion changed or no longer applies. Reload the local match review before deciding.', 409);
  }
  if (action === 'clear') {
    await db.prepare('DELETE FROM local_match_decisions WHERE workspace_id = ? AND finding_id = ? AND fingerprint = ?')
      .bind(workspaceId, id, fingerprint).run();
    finding.decision = null;
  } else {
    const status = action === 'confirm' ? 'confirmed' : 'dismissed';
    const decidedAt = new Date().toISOString();
    await db.prepare(`INSERT INTO local_match_decisions (workspace_id, finding_id, fingerprint, status, decided_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, finding_id) DO UPDATE SET fingerprint = excluded.fingerprint,
        status = excluded.status, decided_at = excluded.decided_at
      WHERE local_match_decisions.fingerprint != excluded.fingerprint OR local_match_decisions.status != excluded.status`)
      .bind(workspaceId, id, fingerprint, status, decidedAt).run();
    const saved = await db.prepare(`SELECT finding_id, fingerprint, status, decided_at FROM local_match_decisions
      WHERE workspace_id = ? AND finding_id = ?`).bind(workspaceId, id).first<DecisionRow>();
    finding.decision = saved && saved.fingerprint === fingerprint ? { status: saved.status, decidedAt: saved.decided_at } : null;
  }
  report.counts = countDecisions(report.findings);
  return paginate(report, validateOptions({}));
}

async function fullReport(db: DatabaseAdapter, workspaceId: string): Promise<FullReport> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new LocalMatchReviewError('Workspace not found.', 404);
  const rules = await getSuppressionRules();
  const connectors = [...new Set(workspace.state.importObject === 'company' ? [] : [workspace.state.sourceType, workspace.state.destinationType])]
    .filter((connector): connector is IdentityConnector => connector === 'hubspot' || connector === 'salesforce');
  const snapshots: LocalMatchSnapshot[] = [];
  const records: IdentityRecord[] = [];
  const snapshotWarnings: string[] = [];
  for (const connectorId of connectors) {
    const label = connectorId === 'hubspot' ? 'HubSpot' : 'Salesforce';
    const scan = await getLatestDuplicateScan(workspaceId, connectorId);
    if (!scan?.complete) {
      snapshotWarnings.push(scan
        ? `The latest saved ${label} snapshot is ${scan.status}; no records from that CRM were compared. Finish or refresh its scan separately.`
        : `No completed ${label} snapshot is saved for this workspace. Only available local inputs were compared.`);
      continue;
    }
    const savedRecords = await getDuplicateScanRecords(scan.id);
    records.push(...savedRecords);
    snapshots.push({ id: scan.id, connectorId, recordsScanned: savedRecords.length, sourceComplete: scan.sourceComplete, completedAt: scan.completedAt });
    if (!scan.sourceComplete) snapshotWarnings.push(`The saved ${label} snapshot is incomplete; some CRM records were not compared.`);
    snapshotWarnings.push(`${label} evidence comes from a saved snapshot${scan.completedAt ? ` completed ${scan.completedAt}` : ' with no completion date'}; it has not been refreshed from the CRM.`);
    snapshotWarnings.push(...scan.analysisWarnings.map((warning) => `${label} snapshot: ${warning}`));
  }
  const analysis = buildLocalMatchReport({ contacts: workspace.state.contacts, crmRecords: records, suppressionRules: rules, importObject: workspace.state.importObject });
  const saved = await db.prepare(`SELECT finding_id, fingerprint, status, decided_at FROM local_match_decisions
    WHERE workspace_id = ?`).bind(workspaceId).all<DecisionRow>();
  const byId = new Map(saved.results.map((row) => [row.finding_id, row]));
  const associatedCompanies = new Map(workspace.state.contacts.map((row) => [row.contactId, row.associatedCompany ?? null]));
  const findings: LocalMatchReviewFinding[] = analysis.findings.map((finding) => {
    const id = digest(finding.key);
    // Include the displayed inputs, evidence and rule version. A changed candidate
    // or rationale must be reviewed again instead of inheriting an old decision.
    const fingerprint = digest(JSON.stringify({ ruleVersion: analysis.ruleVersion, finding,
      ...(analysis.importObject && analysis.importObject !== 'contact' ? { importObject: analysis.importObject,
        associatedCompanies: [finding.contactId, finding.candidate.source === 'import' ? finding.candidate.id : ''].map((id) => associatedCompanies.get(id) ?? null) } : {}),
      ...(finding.kind === 'possible_duplicate' ? { rarity: analysis.rarity } : {}) }));
    const prior = byId.get(id);
    return { ...finding, id, fingerprint, decision: prior?.fingerprint === fingerprint
      ? { status: prior.status, decidedAt: prior.decided_at } : null };
  });
  return { ...analysis, workspaceId, workspaceRevision: workspace.revision, findings, snapshots,
    warnings: [...new Set([...snapshotWarnings, ...analysis.warnings])], counts: countDecisions(findings) };
}

function paginate(report: FullReport, options: Required<LocalMatchReviewOptions>): LocalMatchReviewReport {
  const filtered = report.findings.filter((finding) => (options.status === 'all' || (finding.decision?.status ?? 'pending') === options.status)
    && (options.kind === 'all' || finding.kind === options.kind));
  const findings = filtered.slice(options.offset, options.offset + options.limit);
  return { ...report, findings, total: filtered.length, offset: options.offset, limit: options.limit,
    nextOffset: options.offset + findings.length < filtered.length ? options.offset + findings.length : null };
}

function countDecisions(findings: LocalMatchReviewFinding[]): FullReport['counts'] {
  const counts = { pending: 0, confirmed: 0, dismissed: 0 };
  for (const finding of findings) counts[finding.decision?.status ?? 'pending'] += 1;
  return counts;
}

function validateOptions(options: LocalMatchReviewOptions): Required<LocalMatchReviewOptions> {
  const { offset = 0, limit = 50, status = 'all', kind = 'all' } = options;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100
    || !statuses.has(status) || !kinds.has(kind)) {
    throw new LocalMatchReviewError('Use a limit from 1 to 100, a non-negative integer offset and a supported review status or suggestion type.', 400);
  }
  return { offset, limit, status, kind };
}

function validateWorkspaceId(workspaceId: string): void {
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 120) {
    throw new LocalMatchReviewError('A saved workspace ID is required.', 400);
  }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

async function reviewDatabase(): Promise<DatabaseAdapter> {
  if (!persistenceEnabled()) throw new LocalMatchReviewError('Local match review requires the self-hosted SQLite app.', 503);
  const db = await getDatabase();
  if (db.kind !== 'sqlite') throw new LocalMatchReviewError('Local match review requires the self-hosted SQLite app.', 503);
  await ensureWorkspaceSchema();
  await db.prepare(`CREATE TABLE IF NOT EXISTS local_match_decisions (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    finding_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('confirmed', 'dismissed')),
    decided_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, finding_id)
  )`).run();
  return db;
}
