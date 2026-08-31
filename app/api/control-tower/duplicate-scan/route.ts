import { getDatabase, type DatabaseAdapter } from '@/db';
import {
  readHubSpotIdentityPage,
  readSalesforceIdentityPage,
  type HubSpotScanCursor,
  type SalesforceScanCursor,
} from '@/lib/crm-source';
import {
  appendDuplicateScanPage,
  failDuplicateScan,
  getDuplicateScan,
  getLatestDuplicateScan,
  resumeDuplicateScanFinalization,
  saveDuplicateReviewDecision,
  startDuplicateScan,
  type DuplicateScanView,
} from '@/lib/duplicate-scan-store';
import { IDENTITY_RULE_VERSION, type IdentityConnector } from '@/lib/identity-resolution';
import { operatorAccessError } from '@/lib/operator-auth';
import { persistenceEnabled, saveConnectorRun } from '@/lib/workspace-store';

const DEFAULT_API_VERSION = '67.0';
const DEFAULT_SCAN_LIMIT = 25_000;
const MAXIMUM_SQLITE_SCAN_LIMIT = 25_000;
const MAXIMUM_D1_SCAN_LIMIT = 10_000;

export const runtime = 'edge';

export async function GET(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  if (!persistenceEnabled()) return unavailable();
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspaceId');
  const connectorId = connector(url.searchParams.get('connectorId'));
  if (!workspaceId || !connectorId) return Response.json({ error: 'workspaceId and a CRM connector are required.' }, { status: 400 });
  try {
    const scan = await getLatestDuplicateScan(workspaceId, connectorId);
    if (scan?.complete) await recordScanRun(scan);
    return Response.json({ scan }, { headers: noStore() });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  if (!persistenceEnabled()) return unavailable();
  let payload: Record<string, unknown>;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== 'object') throw new Error('A JSON body is required.');
    payload = value as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'A JSON body is required.' }, { status: 400 });
  }
  const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : '';
  const connectorId = connector(payload.connectorId);
  if (!workspaceId || !connectorId) return Response.json({ error: 'workspaceId and a CRM connector are required.' }, { status: 400 });
  try {
    if (payload.action === 'start') {
      assertConnectorConfigured(connectorId);
      return Response.json({ scan: await startDuplicateScan(workspaceId, connectorId) }, { status: 201, headers: noStore() });
    }
    if (payload.action === 'restart') {
      assertConnectorConfigured(connectorId);
      const current = await getLatestDuplicateScan(workspaceId, connectorId);
      if (current?.status === 'scanning') await failDuplicateScan(current.id);
      return Response.json({ scan: await startDuplicateScan(workspaceId, connectorId) }, { status: 201, headers: noStore() });
    }
    if (payload.action === 'step') {
      if (typeof payload.scanId !== 'string') return Response.json({ error: 'scanId is required.' }, { status: 400 });
      const scan = await getDuplicateScan(payload.scanId);
      if (!scan || scan.workspaceId !== workspaceId || scan.connectorId !== connectorId) return Response.json({ error: 'Duplicate scan not found.' }, { status: 404 });
      if (scan.status === 'scanning' && scan.ruleVersion !== IDENTITY_RULE_VERSION) {
        return Response.json({ error: `Scan rules changed from ${scan.ruleVersion} to ${IDENTITY_RULE_VERSION}. Start over to keep one rule version per audit.` }, { status: 409 });
      }
      if (scan.status !== 'scanning') {
        if (scan.complete) await recordScanRun(scan);
        return Response.json({ scan }, { headers: noStore() });
      }
      if (!scan.cursor) {
        const finalized = await resumeDuplicateScanFinalization(scan.id);
        if (finalized.complete) await recordScanRun(finalized);
        return Response.json({ scan: finalized }, { headers: noStore() });
      }
      const limit = await maximumScanRecords();
      if (scan.recordsScanned >= limit) {
        const finalized = await appendDuplicateScanPage(scan.id, [], scan.cursor, null, false);
        if (finalized.complete) await recordScanRun(finalized);
        return Response.json({ scan: finalized }, { headers: noStore() });
      }
      const page = connectorId === 'hubspot'
        ? await readHubSpotIdentityPage(requiredEnv('HUBSPOT_ACCESS_TOKEN'), scan.cursor as HubSpotScanCursor)
        : await readSalesforceIdentityPage(
          requiredSalesforceInstance(),
          requiredEnv('SALESFORCE_ACCESS_TOKEN'),
          process.env.SALESFORCE_API_VERSION ?? DEFAULT_API_VERSION,
          scan.cursor as SalesforceScanCursor,
        );
      const remaining = limit - scan.recordsScanned;
      const acceptedRecords = page.records.slice(0, remaining);
      const hitLimit = acceptedRecords.length < page.records.length || (!page.complete && acceptedRecords.length >= remaining);
      const sourceComplete = page.complete && !hitLimit;
      const nextCursor = sourceComplete || hitLimit ? null : page.nextCursor;
      const updated = await appendDuplicateScanPage(scan.id, acceptedRecords, scan.cursor, nextCursor, sourceComplete);
      if (updated.complete) await recordScanRun(updated);
      return Response.json({ scan: updated }, { headers: noStore() });
    }
    if (payload.action === 'decide') {
      if (typeof payload.scanId !== 'string' || typeof payload.clusterId !== 'string'
        || (payload.decision !== 'not_duplicate' && payload.decision !== 'confirmed_duplicate')) {
        return Response.json({ error: 'scanId, clusterId, and a valid decision are required.' }, { status: 400 });
      }
      const scan = await getDuplicateScan(payload.scanId);
      if (!scan || scan.workspaceId !== workspaceId || scan.connectorId !== connectorId) return Response.json({ error: 'Duplicate scan not found.' }, { status: 404 });
      const cluster = scan.clusters.find((candidate) => candidate.clusterId === payload.clusterId);
      if (!cluster) return Response.json({ error: 'Duplicate cluster not found in this scan.' }, { status: 404 });
      const primaryRecordKey = typeof payload.primaryRecordKey === 'string' ? payload.primaryRecordKey : null;
      if (payload.decision === 'confirmed_duplicate' && !cluster.members.some((member) => member.record.recordKey === primaryRecordKey)) {
        return Response.json({ error: 'Choose a primary record from this cluster.' }, { status: 400 });
      }
      if (payload.decision === 'confirmed_duplicate' && cluster.ambiguousOverlap) {
        const memberKeys = new Set(cluster.members.map((member) => member.record.recordKey));
        const unresolved = scan.clusters.filter((candidate) => candidate.clusterId !== cluster.clusterId
          && candidate.members.some((member) => memberKeys.has(member.record.recordKey))
          && candidate.review?.decision !== 'not_duplicate');
        if (unresolved.length) {
          return Response.json({ error: 'Dismiss the competing candidate group before approving this cleanup plan.' }, { status: 409 });
        }
      }
      await saveDuplicateReviewDecision(workspaceId, connectorId, cluster.clusterId, payload.decision, primaryRecordKey);
      return Response.json({ scan: await getDuplicateScan(scan.id) }, { headers: noStore() });
    }
    return Response.json({ error: 'Use start, restart, step, or decide.' }, { status: 400 });
  } catch (error) {
    console.error('Duplicate account scan failed', error);
    return failure(error);
  }
}

function connector(value: unknown): IdentityConnector | null {
  return value === 'hubspot' || value === 'salesforce' ? value : null;
}

function assertConnectorConfigured(connectorId: IdentityConnector) {
  if (connectorId === 'hubspot') requiredEnv('HUBSPOT_ACCESS_TOKEN');
  else {
    requiredSalesforceInstance();
    requiredEnv('SALESFORCE_ACCESS_TOKEN');
  }
}

function requiredEnv(name: 'HUBSPOT_ACCESS_TOKEN' | 'SALESFORCE_ACCESS_TOKEN'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured for direct account scans.`);
  return value;
}

function requiredSalesforceInstance(): string {
  const value = process.env.SALESFORCE_INSTANCE_URL;
  if (!value) throw new Error('SALESFORCE_INSTANCE_URL is not configured for direct account scans.');
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('Salesforce instance must use HTTPS.');
  return url.origin;
}

async function maximumScanRecords(): Promise<number> {
  const db = await getDatabase();
  return scanRecordLimit(db.kind, process.env.CONTROL_TOWER_MAX_SCAN_RECORDS);
}

export function scanRecordLimit(databaseKind: DatabaseAdapter['kind'], configuredValue?: string): number {
  const maximum = databaseKind === 'd1' ? MAXIMUM_D1_SCAN_LIMIT : MAXIMUM_SQLITE_SCAN_LIMIT;
  const configured = Number(configuredValue ?? DEFAULT_SCAN_LIMIT);
  return Number.isFinite(configured) ? Math.max(100, Math.min(maximum, Math.floor(configured))) : maximum;
}

function unavailable() {
  return Response.json({ error: 'Duplicate scans require SQLite or D1 persistence.' }, { status: 503 });
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : 'Duplicate account scan failed.';
  const status = message.includes('not configured') ? 503 : message.includes('not found') ? 404 : message.includes('rules changed') ? 409 : 502;
  return Response.json({ error: message }, { status, headers: noStore() });
}

function noStore() {
  return { 'Cache-Control': 'no-store' };
}

async function recordScanRun(scan: DuplicateScanView) {
  await saveConnectorRun(scan.workspaceId, {
    receipt: {
      id: scan.id,
      connectorId: scan.connectorId,
      phase: 'receipt',
      status: scan.sourceComplete ? 'executed' : 'partial',
      summary: scan.sourceComplete
        ? `Scanned the full ${scan.connectorId} account and found ${scan.clusterCount} duplicate candidate groups.`
        : `Scanned ${scan.recordsScanned} ${scan.connectorId} records before the configured safety ceiling and found ${scan.clusterCount} candidate groups.`,
      recordsRead: scan.recordsScanned,
      createdAt: scan.completedAt ?? scan.updatedAt,
      undoAvailable: false,
      nativeReceiptId: scan.id,
    },
    details: {
      sourceLabel: `${scan.connectorId} full-account duplicate audit`,
      inputCount: scan.recordsScanned,
      scan: {
        scanId: scan.id,
        sourceComplete: scan.sourceComplete,
        pagesScanned: scan.pagesScanned,
        candidatesCompared: scan.candidatesCompared,
        clusterCount: scan.clusterCount,
        duplicateRecords: scan.duplicateRecords,
        highConfidenceClusters: scan.highConfidenceClusters,
        reviewClusters: scan.reviewClusters,
        possibleClusters: scan.possibleClusters,
        analysisWarnings: scan.analysisWarnings,
      },
    },
  });
}
