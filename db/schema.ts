import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default('My GTM workspace'),
  revision: integer('revision').notNull().default(0),
  sourceType: text('source_type').notNull().default('csv'),
  destinationType: text('destination_type').notNull().default('csv'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const workspaceStateChunks = sqliteTable('workspace_state_chunks', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.revision, table.chunkIndex] })]);

export const mappingPresets = sqliteTable('mapping_presets', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  mappingJson: text('mapping_json').notNull(),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const connectorRuns = sqliteTable('connector_runs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  connectorId: text('connector_id').notNull(),
  phase: text('phase').notNull(),
  status: text('status').notNull(),
  receiptJson: text('receipt_json').notNull(),
  undoJson: text('undo_json'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index('idx_connector_runs_workspace_created').on(table.workspaceId, table.createdAt)]);

export const duplicateScans = sqliteTable('duplicate_scans', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  connectorId: text('connector_id').notNull(),
  status: text('status').notNull(),
  cursorJson: text('cursor_json'),
  recordsScanned: integer('records_scanned').notNull().default(0),
  pagesScanned: integer('pages_scanned').notNull().default(0),
  candidatesCompared: integer('candidates_compared').notNull().default(0),
  sourceComplete: integer('source_complete', { mode: 'boolean' }).notNull().default(false),
  analysisWarningsJson: text('analysis_warnings_json').notNull().default('[]'),
  ruleVersion: text('rule_version').notNull(),
  startedAt: text('started_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text('completed_at'),
}, (table) => [
  index('idx_duplicate_scans_workspace_created').on(table.workspaceId, table.startedAt),
  uniqueIndex('idx_duplicate_scans_one_active').on(table.workspaceId, table.connectorId).where(sql`${table.status} = 'scanning'`),
]);

export const duplicateScanRecords = sqliteTable('duplicate_scan_records', {
  scanId: text('scan_id').notNull().references(() => duplicateScans.id, { onDelete: 'cascade' }),
  recordKey: text('record_key').notNull(),
  payloadJson: text('payload_json').notNull(),
}, (table) => [primaryKey({ columns: [table.scanId, table.recordKey] })]);

export const duplicateScanClusters = sqliteTable('duplicate_scan_clusters', {
  scanId: text('scan_id').notNull().references(() => duplicateScans.id, { onDelete: 'cascade' }),
  clusterId: text('cluster_id').notNull(),
  band: text('band').notNull(),
  confidence: integer('confidence').notNull(),
  payloadJson: text('payload_json').notNull(),
}, (table) => [primaryKey({ columns: [table.scanId, table.clusterId] })]);

export const duplicateReviewDecisions = sqliteTable('duplicate_review_decisions', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  connectorId: text('connector_id').notNull(),
  clusterId: text('cluster_id').notNull(),
  decision: text('decision').notNull(),
  primaryRecordKey: text('primary_record_key'),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.connectorId, table.clusterId] })]);
