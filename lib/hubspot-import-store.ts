import { createHash } from 'node:crypto';
import { getDatabase } from '@/db';
import type { WorkspaceState } from './workspace';
import { validateNormalizationSettings, type NormalizationSettings } from './import-normalization';
import type { HubSpotImportBinding, HubSpotImportDryRun } from './hubspot-import';

export function hubspotImportFingerprint(state: WorkspaceState, binding: HubSpotImportBinding | undefined = state.hubspotBinding, settings: NormalizationSettings = validateNormalizationSettings(state.normalizationSettings), policy: 'fill-empty' | 'overwrite' = 'fill-empty'): string {
  return createHash('sha256').update(JSON.stringify({ object: state.importObject ?? 'contact', contacts: state.contacts,
    originals: state.originalContacts, customFields: state.customFields ?? [], binding, settings, policy })).digest('hex');
}

async function reviewDatabase() {
  const db = await getDatabase();
  if (db.kind !== 'sqlite') throw new Error('HubSpot import dry runs require the self-hosted SQLite app.');
  await db.prepare('CREATE TABLE IF NOT EXISTS hubspot_import_reviews (workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, review_json TEXT NOT NULL)').run();
  return db;
}
export async function readHubSpotImportReview(workspaceId: string): Promise<HubSpotImportDryRun | null> {
  const row = await (await reviewDatabase()).prepare('SELECT review_json FROM hubspot_import_reviews WHERE workspace_id = ?').bind(workspaceId).first<{ review_json: string }>();
  return row ? JSON.parse(row.review_json) as HubSpotImportDryRun : null;
}
export async function saveHubSpotImportReview(review: HubSpotImportDryRun): Promise<void> {
  await (await reviewDatabase()).prepare('INSERT INTO hubspot_import_reviews (workspace_id, review_json) VALUES (?, ?) ON CONFLICT(workspace_id) DO UPDATE SET review_json = excluded.review_json')
    .bind(review.workspaceId, JSON.stringify(review)).run();
}
