import { ensureWorkspaceSchema, getDatabase, type DatabaseAdapter } from '@/db';
import type { ConnectorReceipt } from './connector-contract';
import type { ConnectorRun, ConnectorRunInput } from './connector-run';
import {
  emptyWorkspaceState,
  validateWorkspaceState,
  type MappingPreset,
  type SavedWorkspace,
  type WorkspaceState,
} from './workspace';
import type { CsvColumnMapping } from './csv-control-tower';

const STATE_CHUNK_LENGTH = 120_000;
const KEPT_REVISIONS = 20;

type WorkspaceRow = {
  id: string;
  name: string;
  revision: number;
  source_type: string;
  destination_type: string;
  created_at: string;
  updated_at: string;
};

type ChunkRow = { payload: string };
type PresetRow = {
  id: string;
  name: string;
  mapping_json: string;
  created_at: string;
  updated_at: string;
};

export function persistenceEnabled(): boolean {
  return process.env.CONTROL_TOWER_PERSISTENCE_ENABLED === 'true'
    || (process.env.NODE_ENV !== 'production' && process.env.CONTROL_TOWER_PERSISTENCE_ENABLED !== 'false');
}

export async function createWorkspace(name = 'My GTM workspace'): Promise<SavedWorkspace> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const state = emptyWorkspaceState();
  const chunks = chunkJson(state);
  await db.batch([
    db.prepare(`INSERT INTO workspaces
      (id, name, revision, source_type, destination_type, created_at, updated_at)
      VALUES (?, ?, 0, 'csv', 'csv', ?, ?)`).bind(id, cleanName(name), now, now),
    ...chunks.map((payload, index) => db.prepare(`INSERT INTO workspace_state_chunks
      (workspace_id, revision, chunk_index, payload, created_at) VALUES (?, 0, ?, ?, ?)`)
      .bind(id, index, payload, now)),
  ]);
  return { id, name: cleanName(name), revision: 0, state, presets: [], createdAt: now, updatedAt: now };
}

export async function getWorkspace(id: string): Promise<SavedWorkspace | null> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const row = await db.prepare(`SELECT id, name, revision, source_type, destination_type, created_at, updated_at
    FROM workspaces WHERE id = ?`).bind(id).first<WorkspaceRow>();
  if (!row) return null;
  const state = await readRevision(db, id, row.revision);
  const presets = await readPresets(db, id);
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    state,
    presets,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function saveWorkspace(id: string, stateValue: unknown, reason = 'workspace_saved'): Promise<SavedWorkspace> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const state = validateWorkspaceState(stateValue);
  const existing = await db.prepare('SELECT name FROM workspaces WHERE id = ?').bind(id).first<{ name: string }>();
  if (!existing) throw new Error('Workspace not found.');
  const revisionRow = await db.prepare('SELECT COALESCE(MAX(revision), -1) AS revision FROM workspace_state_chunks WHERE workspace_id = ?')
    .bind(id).first<{ revision: number }>();
  const revision = Number(revisionRow?.revision ?? -1) + 1;
  const now = new Date().toISOString();
  const chunks = chunkJson(state);
  const receipt: ConnectorReceipt = {
    id: crypto.randomUUID(),
    connectorId: state.sourceType,
    phase: 'receipt',
    status: 'executed',
    summary: reason,
    recordsRead: state.contacts.length,
    createdAt: now,
    undoAvailable: revision > 0,
  };
  const statements = [
    ...chunks.map((payload, index) => db.prepare(`INSERT INTO workspace_state_chunks
      (workspace_id, revision, chunk_index, payload, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, revision, index, payload, now)),
    db.prepare(`UPDATE workspaces SET revision = ?, source_type = ?, destination_type = ?, updated_at = ? WHERE id = ?`)
      .bind(revision, state.sourceType, state.destinationType, now, id),
    db.prepare(`INSERT INTO connector_runs
      (id, workspace_id, connector_id, phase, status, receipt_json, created_at)
      VALUES (?, ?, ?, 'receipt', 'executed', ?, ?)`)
      .bind(receipt.id, id, receipt.connectorId, JSON.stringify(receipt), now),
  ];
  await db.batch(statements);
  await pruneOldRevisions(db, id);
  return (await getWorkspace(id))!;
}

export async function undoWorkspace(id: string): Promise<SavedWorkspace> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const row = await db.prepare('SELECT revision FROM workspaces WHERE id = ?').bind(id).first<{ revision: number }>();
  if (!row) throw new Error('Workspace not found.');
  const target = await db.prepare(`SELECT MAX(revision) AS revision FROM workspace_state_chunks
    WHERE workspace_id = ? AND revision < ?`).bind(id, row.revision).first<{ revision: number | null }>();
  if (target?.revision === null || target?.revision === undefined) throw new Error('There is no earlier saved state to restore.');
  const state = await readRevision(db, id, target.revision);
  const now = new Date().toISOString();
  const receipt: ConnectorReceipt = {
    id: crypto.randomUUID(),
    connectorId: state.sourceType,
    phase: 'undo',
    status: 'undone',
    summary: `Restored workspace revision ${target.revision}.`,
    recordsRead: state.contacts.length,
    createdAt: now,
    undoAvailable: target.revision > 0,
  };
  await db.batch([
    db.prepare(`UPDATE workspaces SET revision = ?, source_type = ?, destination_type = ?, updated_at = ? WHERE id = ?`)
      .bind(target.revision, state.sourceType, state.destinationType, now, id),
    db.prepare(`INSERT INTO connector_runs
      (id, workspace_id, connector_id, phase, status, receipt_json, created_at)
      VALUES (?, ?, ?, 'undo', 'undone', ?, ?)`)
      .bind(receipt.id, id, receipt.connectorId, JSON.stringify(receipt), now),
  ]);
  return (await getWorkspace(id))!;
}

export async function saveMappingPreset(
  workspaceId: string,
  name: string,
  mapping: CsvColumnMapping,
  presetId?: string,
): Promise<MappingPreset[]> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const exists = await db.prepare('SELECT id FROM workspaces WHERE id = ?').bind(workspaceId).first();
  if (!exists) throw new Error('Workspace not found.');
  const id = presetId || crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO mapping_presets
    (id, workspace_id, name, mapping_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, mapping_json = excluded.mapping_json, updated_at = excluded.updated_at`)
    .bind(id, workspaceId, cleanName(name), JSON.stringify(mapping), now, now).run();
  return readPresets(db, workspaceId);
}

export async function saveConnectorReceipt(workspaceId: string, receipt: ConnectorReceipt): Promise<void> {
  return saveConnectorRun(workspaceId, { receipt });
}

export async function saveConnectorRun(workspaceId: string, input: ConnectorRunInput): Promise<void> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const exists = await db.prepare('SELECT id FROM workspaces WHERE id = ?').bind(workspaceId).first();
  if (!exists) throw new Error('Workspace not found.');
  const receipt = input.receipt;
  const payload = input.details === undefined ? { receipt } : { receipt, details: input.details };
  await db.prepare(`INSERT INTO connector_runs
    (id, workspace_id, connector_id, phase, status, receipt_json, undo_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status,
      receipt_json = json_patch(connector_runs.receipt_json, excluded.receipt_json),
      undo_json = COALESCE(excluded.undo_json, connector_runs.undo_json)`)
    .bind(
      receipt.id,
      workspaceId,
      receipt.connectorId,
      receipt.phase,
      receipt.status,
      JSON.stringify(payload),
      input.undo ? JSON.stringify(input.undo) : null,
      receipt.createdAt,
    )
    .run();
}

export async function listConnectorRuns(workspaceId: string, limit = 50): Promise<ConnectorRun[]> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 50;
  const result = await db.prepare(`SELECT id, workspace_id, connector_id, phase, status, receipt_json, undo_json, created_at
    FROM connector_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(workspaceId, boundedLimit).all<{
      id: string; workspace_id: string; connector_id: string; phase: string; status: string;
      receipt_json: string; undo_json: string | null; created_at: string;
    }>();
  return result.results.flatMap((row): ConnectorRun[] => {
    try {
      const parsed = JSON.parse(row.receipt_json) as { receipt?: ConnectorReceipt; details?: ConnectorRun['details'] } | ConnectorReceipt;
      const receipt = 'receipt' in parsed && parsed.receipt ? parsed.receipt : parsed as ConnectorReceipt;
      return [{
        id: row.id, workspaceId: row.workspace_id, connectorId: row.connector_id as ConnectorRun['connectorId'],
        phase: row.phase as ConnectorRun['phase'], status: row.status as ConnectorRun['status'], receipt,
        details: 'details' in parsed ? parsed.details ?? null : null,
        undo: row.undo_json ? JSON.parse(row.undo_json) as ConnectorRun['undo'] : null,
        createdAt: row.created_at,
      }];
    } catch {
      return [];
    }
  });
}

async function readRevision(db: DatabaseAdapter, workspaceId: string, revision: number): Promise<WorkspaceState> {
  const result = await db.prepare(`SELECT payload FROM workspace_state_chunks
    WHERE workspace_id = ? AND revision = ? ORDER BY chunk_index`).bind(workspaceId, revision).all<ChunkRow>();
  if (!result.results.length) return emptyWorkspaceState();
  return validateWorkspaceState(JSON.parse(result.results.map((row) => row.payload).join('')));
}

async function readPresets(db: DatabaseAdapter, workspaceId: string): Promise<MappingPreset[]> {
  const result = await db.prepare(`SELECT id, name, mapping_json, created_at, updated_at FROM mapping_presets
    WHERE workspace_id = ? ORDER BY updated_at DESC`).bind(workspaceId).all<PresetRow>();
  return result.results.map((row) => ({
    id: row.id,
    name: row.name,
    mapping: JSON.parse(row.mapping_json) as CsvColumnMapping,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function pruneOldRevisions(db: DatabaseAdapter, workspaceId: string): Promise<void> {
  const cutoff = await db.prepare(`SELECT revision FROM workspace_state_chunks WHERE workspace_id = ?
    GROUP BY revision ORDER BY revision DESC LIMIT 1 OFFSET ?`).bind(workspaceId, KEPT_REVISIONS - 1).first<{ revision: number }>();
  if (cutoff) {
    await db.prepare('DELETE FROM workspace_state_chunks WHERE workspace_id = ? AND revision < ?')
      .bind(workspaceId, cutoff.revision).run();
  }
}

function chunkJson(value: unknown): string[] {
  const serialized = JSON.stringify(value);
  const chunks: string[] = [];
  for (let index = 0; index < serialized.length; index += STATE_CHUNK_LENGTH) {
    chunks.push(serialized.slice(index, index + STATE_CHUNK_LENGTH));
  }
  return chunks.length ? chunks : ['{}'];
}

function cleanName(value: string): string {
  const cleaned = value.trim().slice(0, 80);
  return cleaned || 'My GTM workspace';
}
