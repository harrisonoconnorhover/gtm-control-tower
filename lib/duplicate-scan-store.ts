import { ensureWorkspaceSchema, getDatabase, type DatabaseAdapter } from '@/db';
import {
  IDENTITY_RULE_VERSION,
  resolveDuplicateIdentities,
  type DuplicateCluster,
  type IdentityConnector,
  type IdentityRecord,
} from './identity-resolution';
import type { HubSpotScanCursor, SalesforceScanCursor } from './crm-source';

const MAX_D1_JSON_BINDING_BYTES = 1_750_000;

export type DuplicateScanCursor = HubSpotScanCursor | SalesforceScanCursor;
export type DuplicateReviewDecision = {
  decision: 'not_duplicate' | 'confirmed_duplicate';
  primaryRecordKey: string | null;
  updatedAt: string;
};

export type ReviewedDuplicateCluster = DuplicateCluster & { review: DuplicateReviewDecision | null };

export type DuplicateScanView = {
  id: string;
  workspaceId: string;
  connectorId: IdentityConnector;
  status: 'scanning' | 'complete' | 'failed';
  cursor: DuplicateScanCursor | null;
  recordsScanned: number;
  pagesScanned: number;
  candidatesCompared: number;
  sourceComplete: boolean;
  analysisWarnings: string[];
  ruleVersion: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  complete: boolean;
  clusterCount: number;
  duplicateRecords: number;
  highConfidenceClusters: number;
  reviewClusters: number;
  possibleClusters: number;
  clusters: ReviewedDuplicateCluster[];
};

type ScanRow = {
  id: string;
  workspace_id: string;
  connector_id: IdentityConnector;
  status: DuplicateScanView['status'];
  cursor_json: string | null;
  records_scanned: number;
  pages_scanned: number;
  candidates_compared: number;
  source_complete: number;
  analysis_warnings_json: string;
  rule_version: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
};

type ClusterRow = { payload_json: string };
type DecisionRow = { cluster_id: string; decision: DuplicateReviewDecision['decision']; primary_record_key: string | null; updated_at: string };

export async function startDuplicateScan(workspaceId: string, connectorId: IdentityConnector): Promise<DuplicateScanView> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const workspace = await db.prepare('SELECT id FROM workspaces WHERE id = ?').bind(workspaceId).first<{ id: string }>();
  if (!workspace) throw new Error('Workspace not found.');
  const active = await db.prepare(`SELECT id, workspace_id, connector_id, status, cursor_json, records_scanned, pages_scanned,
    candidates_compared, source_complete, analysis_warnings_json, rule_version, started_at, updated_at, completed_at
    FROM duplicate_scans WHERE workspace_id = ? AND connector_id = ? AND status = 'scanning' LIMIT 1`)
    .bind(workspaceId, connectorId).first<ScanRow>();
  if (active) return hydrateScan(db, active);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const cursor: DuplicateScanCursor = connectorId === 'hubspot'
    ? { after: null }
    : { objectType: 'lead', nextRecordsUrl: null };
  try {
    await db.prepare(`INSERT INTO duplicate_scans
      (id, workspace_id, connector_id, status, cursor_json, records_scanned, pages_scanned, candidates_compared, rule_version, started_at, updated_at)
      VALUES (?, ?, ?, 'scanning', ?, 0, 0, 0, ?, ?, ?)`)
      .bind(id, workspaceId, connectorId, JSON.stringify(cursor), IDENTITY_RULE_VERSION, now, now).run();
  } catch (error) {
    const concurrent = await getLatestDuplicateScan(workspaceId, connectorId);
    if (concurrent?.status === 'scanning') return concurrent;
    throw error;
  }
  return (await getDuplicateScan(id))!;
}

export async function getDuplicateScan(scanId: string): Promise<DuplicateScanView | null> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const row = await readScanRow(db, scanId);
  return row ? hydrateScan(db, row) : null;
}

export async function getLatestDuplicateScan(workspaceId: string, connectorId: IdentityConnector): Promise<DuplicateScanView | null> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const row = await db.prepare(`SELECT id, workspace_id, connector_id, status, cursor_json, records_scanned, pages_scanned,
    candidates_compared, source_complete, analysis_warnings_json, rule_version, started_at, updated_at, completed_at
    FROM duplicate_scans WHERE workspace_id = ? AND connector_id = ? ORDER BY started_at DESC LIMIT 1`)
    .bind(workspaceId, connectorId).first<ScanRow>();
  return row ? hydrateScan(db, row) : null;
}

export async function appendDuplicateScanPage(
  scanId: string,
  records: IdentityRecord[],
  expectedCursor: DuplicateScanCursor,
  nextCursor: DuplicateScanCursor | null,
  sourceComplete: boolean,
): Promise<DuplicateScanView> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const row = await readScanRow(db, scanId);
  if (!row) throw new Error('Duplicate scan not found.');
  if (row.status !== 'scanning') return hydrateScan(db, row);
  assertCurrentRuleVersion(row);
  const now = new Date().toISOString();
  const expectedCursorJson = JSON.stringify(expectedCursor);
  const results = await db.batch([
    db.prepare(`INSERT INTO duplicate_scan_records (scan_id, record_key, payload_json)
      SELECT ?, json_extract(value, '$.recordKey'), value FROM json_each(?) WHERE EXISTS (
        SELECT 1 FROM duplicate_scans WHERE id = ? AND status = 'scanning' AND cursor_json = ?
      ) ON CONFLICT(scan_id, record_key) DO UPDATE SET payload_json = excluded.payload_json`)
      .bind(scanId, JSON.stringify(records), scanId, expectedCursorJson),
    db.prepare(`UPDATE duplicate_scans SET records_scanned = (
      SELECT COUNT(*) FROM duplicate_scan_records WHERE scan_id = ?
    ) WHERE id = ? AND status = 'scanning' AND cursor_json = ?`).bind(scanId, scanId, expectedCursorJson),
    db.prepare(`UPDATE duplicate_scans SET cursor_json = ?, pages_scanned = pages_scanned + 1,
      source_complete = ?, updated_at = ?
      WHERE id = ? AND status = 'scanning' AND cursor_json = ?`)
      .bind(nextCursor ? JSON.stringify(nextCursor) : null, sourceComplete ? 1 : 0, now, scanId, expectedCursorJson),
  ]);
  if (changedRows(results.at(-1)) === 0) return (await getDuplicateScan(scanId))!;
  return (await getDuplicateScan(scanId))!;
}

export async function resumeDuplicateScanFinalization(scanId: string): Promise<DuplicateScanView> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const row = await readScanRow(db, scanId);
  if (!row) throw new Error('Duplicate scan not found.');
  if (row.status !== 'scanning') return hydrateScan(db, row);
  assertCurrentRuleVersion(row);
  if (row.cursor_json !== null) throw new Error('Duplicate scan still has provider pages to read.');
  return finalizeDuplicateScan(scanId, row.source_complete === 1);
}

export async function failDuplicateScan(scanId: string): Promise<void> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  await db.prepare(`UPDATE duplicate_scans SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'scanning'`)
    .bind(new Date().toISOString(), scanId).run();
}

export async function saveDuplicateReviewDecision(
  workspaceId: string,
  connectorId: IdentityConnector,
  clusterId: string,
  decision: DuplicateReviewDecision['decision'],
  primaryRecordKey: string | null,
): Promise<void> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO duplicate_review_decisions
    (workspace_id, connector_id, cluster_id, decision, primary_record_key, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, connector_id, cluster_id) DO UPDATE SET
      decision = excluded.decision, primary_record_key = excluded.primary_record_key, updated_at = excluded.updated_at`)
    .bind(workspaceId, connectorId, clusterId, decision, primaryRecordKey, now).run();
}

async function finalizeDuplicateScan(scanId: string, sourceComplete: boolean): Promise<DuplicateScanView> {
  const db = await getDatabase();
  const rows = await db.prepare('SELECT payload_json FROM duplicate_scan_records WHERE scan_id = ? ORDER BY record_key')
    .bind(scanId).all<{ payload_json: string }>();
  const records = rows.results.map((row) => JSON.parse(row.payload_json) as IdentityRecord);
  const result = resolveDuplicateIdentities(records);
  const now = new Date().toISOString();
  const clusterRows = result.clusters.map((cluster) => ({
    clusterId: cluster.clusterId,
    band: cluster.band,
    confidence: cluster.confidence,
    payloadJson: JSON.stringify(cluster),
  }));
  for (const chunk of chunkJsonRows(clusterRows, MAX_D1_JSON_BINDING_BYTES)) {
    await db.prepare(`INSERT INTO duplicate_scan_clusters (scan_id, cluster_id, band, confidence, payload_json)
      SELECT ?, json_extract(value, '$.clusterId'), json_extract(value, '$.band'),
        json_extract(value, '$.confidence'), json_extract(value, '$.payloadJson')
      FROM json_each(?) WHERE true
      ON CONFLICT(scan_id, cluster_id) DO UPDATE SET band = excluded.band,
        confidence = excluded.confidence, payload_json = excluded.payload_json`)
      .bind(scanId, JSON.stringify(chunk)).run();
  }
  const completion = await db.prepare(`UPDATE duplicate_scans SET status = 'complete', cursor_json = NULL, records_scanned = ?,
    candidates_compared = ?, source_complete = ?, analysis_warnings_json = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND status = 'scanning' AND cursor_json IS NULL`)
    .bind(result.recordsScanned, result.candidatesCompared, sourceComplete ? 1 : 0, JSON.stringify(result.analysisWarnings), now, now, scanId).run();
  if (changedRows(completion) === 0) return (await getDuplicateScan(scanId))!;
  return (await getDuplicateScan(scanId))!;
}

async function hydrateScan(db: DatabaseAdapter, row: ScanRow): Promise<DuplicateScanView> {
  const clusterRows = await db.prepare(`SELECT payload_json FROM duplicate_scan_clusters
    WHERE scan_id = ? ORDER BY CASE band WHEN 'high_confidence' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, confidence DESC, cluster_id`)
    .bind(row.id).all<ClusterRow>();
  const clusters = clusterRows.results.map((cluster) => JSON.parse(cluster.payload_json) as DuplicateCluster);
  const decisions = await db.prepare(`SELECT cluster_id, decision, primary_record_key, updated_at FROM duplicate_review_decisions
    WHERE workspace_id = ? AND connector_id = ?`).bind(row.workspace_id, row.connector_id).all<DecisionRow>();
  const decisionsByCluster = new Map(decisions.results.map((decision) => [decision.cluster_id, {
    decision: decision.decision,
    primaryRecordKey: decision.primary_record_key,
    updatedAt: decision.updated_at,
  } satisfies DuplicateReviewDecision]));
  const reviewedClusters = clusters.map((cluster) => ({ ...cluster, review: decisionsByCluster.get(cluster.clusterId) ?? null }));
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    connectorId: row.connector_id,
    status: row.status,
    cursor: row.cursor_json ? JSON.parse(row.cursor_json) as DuplicateScanCursor : null,
    recordsScanned: row.records_scanned,
    pagesScanned: row.pages_scanned,
    candidatesCompared: row.candidates_compared,
    sourceComplete: row.source_complete === 1,
    analysisWarnings: parseWarnings(row.analysis_warnings_json),
    ruleVersion: row.rule_version,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    complete: row.status === 'complete',
    clusterCount: reviewedClusters.length,
    duplicateRecords: reviewedClusters.reduce((total, cluster) => total + cluster.members.length - 1, 0),
    highConfidenceClusters: reviewedClusters.filter((cluster) => cluster.band === 'high_confidence').length,
    reviewClusters: reviewedClusters.filter((cluster) => cluster.band === 'review').length,
    possibleClusters: reviewedClusters.filter((cluster) => cluster.band === 'possible').length,
    clusters: reviewedClusters,
  };
}

function readScanRow(db: DatabaseAdapter, scanId: string): Promise<ScanRow | null> {
  return db.prepare(`SELECT id, workspace_id, connector_id, status, cursor_json, records_scanned, pages_scanned,
    candidates_compared, source_complete, analysis_warnings_json, rule_version, started_at, updated_at, completed_at FROM duplicate_scans WHERE id = ?`)
    .bind(scanId).first<ScanRow>();
}

function parseWarnings(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function assertCurrentRuleVersion(row: ScanRow): void {
  if (row.rule_version !== IDENTITY_RULE_VERSION) {
    throw new Error(`Scan rules changed from ${row.rule_version} to ${IDENTITY_RULE_VERSION}. Start over to keep one rule version per audit.`);
  }
}

function changedRows(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  if ('changes' in result && typeof result.changes === 'number') return result.changes;
  if ('meta' in result && result.meta && typeof result.meta === 'object'
    && 'changes' in result.meta && typeof result.meta.changes === 'number') return result.meta.changes;
  return null;
}

function chunkJsonRows<T>(rows: T[], maximumBytes: number): T[][] {
  const encoder = new TextEncoder();
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 2;
  for (const row of rows) {
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + (current.length ? 1 : 0);
    if (current.length && currentBytes + rowBytes > maximumBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
