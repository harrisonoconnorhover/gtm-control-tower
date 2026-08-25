import { sql } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
});
