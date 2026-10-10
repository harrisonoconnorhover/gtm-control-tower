import { ensureWorkspaceSchema, getDatabase } from '@/db';
import { importContactsCsv, previewContactsCsv } from './csv-control-tower';
import { defaultCrmUpdatePolicy } from './crm-workflow';
import { emptyWorkspaceState, validateWorkspaceState } from './workspace';
import { getLatestSafeImportReview, getSafeImportExecution } from './safe-import-store';
import type { SafeImportExecution, SafeImportReview } from './safe-import';
import { getConnectedMonitorOverview } from './monitor-connection';
import type { MonitorProvider } from './monitor-types';
import { notifyAssignment, notifyImportReceived } from './operation-notifications';
import { listIncidents } from './crm-incidents';
import { incidentAccounts } from './incident-accounts';

export type WorkStatus = 'received' | 'needs_review' | 'ready' | 'executing' | 'completed' | 'reconcile';
export type OperationsItem = {
  id: string; kind: 'import' | 'finding' | 'incident'; provider: MonitorProvider; title: string; source: string;
  status: WorkStatus; summary: string; assignee: string; note: string; updatedAt: string; href: string;
  accountId?: string; counts?: SafeImportReview['counts'];
};
export type OperationsInbox = {
  items: OperationsItem[];
  connections: { provider: MonitorProvider; accountId?: string; error?: string }[];
  coverage: string;
};
type WorkRow = {
  id: string; workspace_id: string; provider: MonitorProvider; source_name: string;
  assignee: string; note: string; created_at: string; updated_at: string;
};

async function inboxDatabase() {
  const db = await getDatabase();
  if (db.kind !== 'sqlite') throw new Error('The Operations Inbox currently requires the self-hosted SQLite runtime.');
  await ensureWorkspaceSchema();
  await db.prepare(`CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), provider TEXT NOT NULL,
    source_hash TEXT NOT NULL, source_name TEXT NOT NULL, assignee TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(provider, source_hash)
  )`).run();
  return db;
}

/** Identical uploads return the same task. Workspace and task are committed together. */
export async function receiveImport(input: { provider: MonitorProvider; fileName: string; csv: string }): Promise<{ id: string; workspaceId: string }> {
  if (!['hubspot', 'salesforce'].includes(input.provider)) throw new Error('Choose HubSpot or Salesforce.');
  if (typeof input.csv !== 'string' || new TextEncoder().encode(input.csv).length > 4 * 1024 * 1024) throw new Error('Upload a CSV smaller than 4 MB.');
  if (typeof input.fileName !== 'string' || !input.fileName.trim() || input.fileName.length > 180) throw new Error('A filename of at most 180 characters is required.');
  const preview = previewContactsCsv(input.csv);
  if (!preview.suggestedMapping.rawEmail && !preview.suggestedMapping.normalizedEmail) throw new Error('This inbox expects an Email column. Use the CSV cleanup lab to map a different header.');
  const imported = importContactsCsv(input.csv, preview.suggestedMapping);
  if (!imported.contacts.length) throw new Error('The CSV has no data rows.');
  const sourceHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.csv))))
    .map((value) => value.toString(16).padStart(2, '0')).join('');
  const state = validateWorkspaceState({ ...emptyWorkspaceState(), contacts: imported.contacts, originalContacts: imported.contacts,
    mapping: preview.suggestedMapping, fileName: input.fileName.trim(), destinationType: input.provider,
    crmUpdatePolicy: defaultCrmUpdatePolicy(), importRecordMode: 'update-existing', importRecipe: 'safe-update-contacts', sourceFileHash: sourceHash });
  const db = await inboxDatabase();
  const existing = async () => {
    const row = await db.prepare(`SELECT w.id, w.workspace_id, s.destination_type FROM work_items w JOIN workspaces s ON s.id = w.workspace_id WHERE w.provider = ? AND w.source_hash = ?`)
      .bind(input.provider, sourceHash).first<{ id: string; workspace_id: string; destination_type: string }>();
    if (row && row.destination_type !== input.provider) throw new Error('This file already has a task whose destination was changed. Open its workspace and review the destination before resubmitting.');
    return row;
  };
  const prior = await existing();
  if (prior) return { id: prior.id, workspaceId: prior.workspace_id };
  const id = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const now = new Date().toISOString();
  const serialized = JSON.stringify(state);
  const chunks = [];
  for (let offset = 0, index = 0; offset < serialized.length; index++) {
    let end = Math.min(offset + 120_000, serialized.length);
    if (end < serialized.length && serialized.charCodeAt(end - 1) >= 0xd800 && serialized.charCodeAt(end - 1) <= 0xdbff) end--;
    chunks.push(db.prepare('INSERT INTO workspace_state_chunks (workspace_id, revision, chunk_index, payload, created_at) VALUES (?, 0, ?, ?, ?)')
      .bind(workspaceId, index, serialized.slice(offset, end), now));
    offset = end;
  }
  try {
    await db.batch([
      db.prepare(`INSERT INTO workspaces (id, name, revision, source_type, destination_type, created_at, updated_at) VALUES (?, ?, 0, 'csv', ?, ?, ?)`)
        .bind(workspaceId, input.fileName.trim(), input.provider, now, now),
      ...chunks,
      db.prepare(`INSERT INTO work_items (id, workspace_id, provider, source_hash, source_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, workspaceId, input.provider, sourceHash, input.fileName.trim(), now, now),
    ]);
  } catch (error) {
    const duplicate = await existing();
    if (duplicate) return { id: duplicate.id, workspaceId: duplicate.workspace_id };
    throw error;
  }
  await notifyImportReceived(id, workspaceId, input.provider, imported.contacts.length);
  return { id, workspaceId };
}

export function importWorkStatus(review: SafeImportReview | null, execution: SafeImportExecution | null, revision: number, now = Date.now()): WorkStatus {
  if (!review) return 'received';
  if (execution?.status === 'running') return 'executing';
  if (execution && (execution.status === 'reconciliation-required' || execution.records.some((record) => record.status === 'unknown'
    || record.status === 'sending' || (record.status === 'accepted' && record.verification?.status !== 'verified')))) return 'reconcile';
  if (review.workspaceRevision !== revision) return 'needs_review';
  const unresolved = review.counts.held + review.counts.unmatched + review.counts.unresolved;
  if (execution) return !unresolved && execution.records.length === review.counts['proposed-update']
    && execution.records.every((record) => record.status === 'accepted' && record.verification?.status === 'verified') ? 'completed' : 'needs_review';
  if (!review.complete || Date.parse(review.expiresAt) <= now) return 'needs_review';
  if (review.counts['proposed-update'] > 0) return 'ready';
  return unresolved ? 'needs_review' : 'completed';
}

export async function listOperationsInbox(): Promise<OperationsInbox> {
  const db = await inboxDatabase();
  const rows = await db.prepare(`SELECT w.*, s.revision, s.destination_type FROM work_items w JOIN workspaces s ON s.id = w.workspace_id ORDER BY w.updated_at DESC LIMIT 50`)
    .all<WorkRow & { revision: number; destination_type: string }>();
  const items: OperationsItem[] = await Promise.all(rows.results.map(async (row) => {
    const review = await getLatestSafeImportReview(row.workspace_id);
    const execution = review ? await getSafeImportExecution(row.workspace_id, review.id) : null;
    const status = importWorkStatus(review, execution, row.revision);
    const verified = execution?.records.filter((record) => record.status === 'accepted' && record.verification?.status === 'verified').length ?? 0;
    const provider = review?.connectorId ?? (row.destination_type === 'salesforce' ? 'salesforce' : row.destination_type === 'hubspot' ? 'hubspot' : row.provider);
    return { id: row.id, kind: 'import', provider, title: row.source_name, source: 'CSV upload', status,
      summary: review ? `${review.counts['proposed-update']} proposed · ${review.counts.held} held · ${review.counts.unmatched} unmatched · ${review.counts.unresolved} unresolved${execution ? ` · ${verified} verified` : ''}` : 'File received. Open the workspace to prepare a saved review.',
      assignee: row.assignee, note: row.note, updatedAt: execution?.updatedAt ?? review?.createdAt ?? row.updated_at,
      href: `/app/lab?workspaceId=${encodeURIComponent(row.workspace_id)}${review ? `&reviewId=${encodeURIComponent(review.id)}` : ''}`,
      accountId: review?.account.accountId, counts: review?.counts };
  }));
  const connections = await Promise.all((['hubspot', 'salesforce'] as const).map(async (provider) => {
    try {
      const overview = await getConnectedMonitorOverview(provider);
      for (const finding of overview.findings) items.push({ id: `${provider}:${finding.id}`, kind: 'finding', provider,
        title: finding.summary, source: `${finding.objectType} · ${finding.contactLabel}`, accountId: overview.accountId,
        status: finding.status === 'unknown' ? 'reconcile' : ['fixed', 'resolved'].includes(finding.status) ? 'completed' : 'needs_review',
        summary: finding.detail, assignee: finding.assignee, note: finding.note, updatedAt: finding.lastSeenAt,
        href: `/app/monitor?provider=${provider}&finding=${encodeURIComponent(finding.id)}` });
      return { provider, accountId: overview.accountId };
    } catch (error) {
      return { provider, error: error instanceof Error ? error.message : 'Connection unavailable.' };
    }
  }));
  // Saved incidents remain reachable even when native account verification is temporarily unavailable.
  for (const account of await incidentAccounts()) {
    for (const incident of await listIncidents(account.scope, { limit: 100 })) items.push({
      id: `incident:${incident.id}`, kind: 'incident', provider: account.provider, accountId: account.accountId,
      title: incident.title, source: `${incident.objectType} · ${incident.affectedRecords} affected records`,
      status: incident.status === 'resolved' ? 'completed' : 'needs_review',
      summary: `${incident.kind.replaceAll('_', ' ')} · ${incident.status}. Inspect the change history and coverage before choosing a response.`,
      assignee: incident.assignee, note: incident.note, updatedAt: incident.lastSeenAt,
      href: `/app/incidents?provider=${account.provider}&account=${encodeURIComponent(account.scope)}&incident=${encodeURIComponent(incident.id)}`,
    });
  }
  items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { items, connections, coverage: 'Latest 50 inbox uploads, up to 100 saved Monitor findings per connected CRM, and up to 100 incidents per saved account. Reading this inbox does not run a scan or change CRM records.' };
}

export async function assignImportWork(id: string, assignee: string, note: string): Promise<void> {
  if (typeof id !== 'string' || typeof assignee !== 'string' || typeof note !== 'string' || assignee.length > 120 || note.length > 2_000) throw new Error('Enter an assignee under 120 characters and a note under 2,000 characters.');
  const db = await inboxDatabase();
  const row = await db.prepare('UPDATE work_items SET assignee = ?, note = ?, updated_at = ? WHERE id = ? AND (assignee != ? OR note != ?) RETURNING workspace_id, provider')
    .bind(assignee.trim(), note.trim(), new Date().toISOString(), id, assignee.trim(), note.trim()).first<{ workspace_id: string; provider: MonitorProvider }>();
  if (!row) {
    if (await db.prepare('SELECT id FROM work_items WHERE id = ?').bind(id).first()) return;
    throw new Error('Work item not found.');
  }
  const workspace = await db.prepare('SELECT destination_type FROM workspaces WHERE id = ?').bind(row.workspace_id).first<{ destination_type: string }>();
  const provider = workspace?.destination_type === 'salesforce' ? 'salesforce' : workspace?.destination_type === 'hubspot' ? 'hubspot' : row.provider;
  await notifyAssignment(provider, `/app/lab?workspaceId=${encodeURIComponent(row.workspace_id)}`, Boolean(assignee.trim()));
}
