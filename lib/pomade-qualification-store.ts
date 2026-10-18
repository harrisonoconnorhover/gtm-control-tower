import { ensureWorkspaceSchema, getDatabase } from '@/db';
import type { StoredPomadeQualification } from './pomade-qualification';

async function qualificationDatabase() {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  if (db.kind !== 'sqlite') throw new Error('Pomade qualification requires the self-hosted SQLite app.');
  await db.prepare(`CREATE TABLE IF NOT EXISTS pomade_qualifications (
    workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    request_token TEXT NOT NULL,
    qualification_json TEXT
  )`).run();
  return db;
}

export async function getPomadeQualification(workspaceId: string): Promise<StoredPomadeQualification | null> {
  const db = await qualificationDatabase();
  const row = await db.prepare('SELECT qualification_json FROM pomade_qualifications WHERE workspace_id = ?')
    .bind(workspaceId).first<{ qualification_json: string | null }>();
  return row?.qualification_json ? JSON.parse(row.qualification_json) as StoredPomadeQualification : null;
}

/** Reserve before the external request so an older send cannot replace a newer one. */
export async function beginPomadeQualification(workspaceId: string, baseline?: StoredPomadeQualification | null): Promise<string | null> {
  const db = await qualificationDatabase();
  const previous = baseline === undefined ? await getPomadeQualification(workspaceId) : baseline;
  const expected = previous ? JSON.stringify(previous) : null;
  const token = crypto.randomUUID();
  const row = await db.prepare(`INSERT INTO pomade_qualifications (workspace_id, request_token) VALUES (?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET request_token = excluded.request_token
    WHERE qualification_json IS ? RETURNING request_token`).bind(workspaceId, token, expected).first<{ request_token: string }>();
  return row?.request_token ?? null;
}

/** Save the execution identity before starting work, invalidating an overlapping send. */
export async function claimPomadeExecution(workspaceId: string, baseline: StoredPomadeQualification,
  next: StoredPomadeQualification): Promise<boolean> {
  const db = await qualificationDatabase();
  const row = await db.prepare(`UPDATE pomade_qualifications SET qualification_json = ?, request_token = ?
    WHERE workspace_id = ? AND qualification_json = ? RETURNING workspace_id`)
    .bind(JSON.stringify(next), crypto.randomUUID(), workspaceId, JSON.stringify(baseline)).first();
  return Boolean(row);
}

export async function savePomadeQualification(workspaceId: string, token: string, qualification: StoredPomadeQualification): Promise<boolean> {
  const db = await qualificationDatabase();
  const row = await db.prepare(`UPDATE pomade_qualifications SET qualification_json = ?
    WHERE workspace_id = ? AND request_token = ? RETURNING workspace_id`)
    .bind(JSON.stringify(qualification), workspaceId, token).first();
  return Boolean(row);
}

/** A refresh attaches only to the exact saved request it read, never a later send. */
export async function refreshPomadeQualification(workspaceId: string, baseline: StoredPomadeQualification,
  next: StoredPomadeQualification): Promise<boolean> {
  const db = await qualificationDatabase();
  const row = await db.prepare(`UPDATE pomade_qualifications SET qualification_json = ?
    WHERE workspace_id = ? AND qualification_json = ? RETURNING workspace_id`)
    .bind(JSON.stringify(next), workspaceId, JSON.stringify(baseline)).first();
  return Boolean(row);
}
