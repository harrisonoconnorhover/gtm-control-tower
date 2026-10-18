import { ensureWorkspaceSchema, getDatabase, type DatabaseAdapter } from '@/db';
import type { WebsiteCheckResult } from './website-check-types';

type WebsiteCheckRow = { result_json: string };

// Observations live outside workspace revisions so an autosave cannot erase a check
// or invalidate a CRM dry run whose input rows have not changed.
async function websiteCheckDatabase(): Promise<DatabaseAdapter> {
  await ensureWorkspaceSchema();
  const db = await getDatabase();
  if (db.kind !== 'sqlite') throw new Error('Website checks require the self-hosted SQLite app.');
  await db.prepare(`CREATE TABLE IF NOT EXISTS website_checks (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    normalized_url TEXT NOT NULL,
    result_json TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, normalized_url)
  )`).run();
  return db;
}

export async function getWebsiteChecks(workspaceId: string): Promise<WebsiteCheckResult[]> {
  const db = await websiteCheckDatabase();
  const rows = await db.prepare(`SELECT result_json FROM website_checks
    WHERE workspace_id = ? ORDER BY normalized_url`).bind(workspaceId).all<WebsiteCheckRow>();
  return rows.results.map((row) => JSON.parse(row.result_json) as WebsiteCheckResult);
}

export async function saveWebsiteCheck(workspaceId: string, check: WebsiteCheckResult): Promise<void> {
  const db = await websiteCheckDatabase();
  await db.prepare(`INSERT INTO website_checks (workspace_id, normalized_url, result_json, checked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id, normalized_url) DO UPDATE SET
      result_json = excluded.result_json, checked_at = excluded.checked_at
    WHERE excluded.checked_at >= website_checks.checked_at`)
    .bind(workspaceId, check.url, JSON.stringify(check), check.checkedAt).run();
}
