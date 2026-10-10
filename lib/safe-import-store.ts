import { ensureWorkspaceSchema, getDatabase, type DatabaseAdapter } from '@/db';
import type { SafeImportExecution, SafeImportReview } from './safe-import';

const CHUNK_CHARACTERS = 100_000;
let schemaPromise: Promise<void> | null = null;
let lastPendingSeed: { reviewId: string; workspaceId: string; records: SafeImportExecution['records'] } | null = null;

/** Also supports existing local databases; D1 releases have the matching migration. */
export async function ensureSafeImportSchema(): Promise<void> {
  if (schemaPromise) return schemaPromise;
  schemaPromise = ensureWorkspaceSchema().then(async () => {
    const db = await getDatabase();
    if (db.kind === 'd1') return; // D1 releases apply the versioned migration first.
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS safe_import_reviews (
        id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS safe_import_review_chunks (
        review_id TEXT NOT NULL REFERENCES safe_import_reviews(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(review_id, chunk_index)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS safe_import_executions (
        id TEXT PRIMARY KEY NOT NULL, review_id TEXT NOT NULL UNIQUE REFERENCES safe_import_reviews(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        execution_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS safe_import_execution_records (
        execution_id TEXT NOT NULL REFERENCES safe_import_executions(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(execution_id, contact_id)
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_safe_import_reviews_workspace ON safe_import_reviews(workspace_id, created_at)'),
    ]);
  }).catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

/** Reviews are immutable. A revised mapping, identity, or policy gets a new ID. */
export async function saveSafeImportReview(review: SafeImportReview): Promise<void> {
  await ensureSafeImportSchema();
  const db = await getDatabase();
  const json = JSON.stringify(review);
  const statements = [db.prepare(`INSERT INTO safe_import_reviews (id, workspace_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(review.id, review.workspaceId, review.createdAt, review.expiresAt)];
  for (let offset = 0, index = 0; offset < json.length; index += 1) {
    let end = Math.min(offset + CHUNK_CHARACTERS, json.length);
    // Do not separate a Unicode pair when SQLite encodes each bound chunk as UTF-8.
    if (end < json.length && json.charCodeAt(end - 1) >= 0xd800 && json.charCodeAt(end - 1) <= 0xdbff) end -= 1;
    statements.push(db.prepare('INSERT INTO safe_import_review_chunks (review_id, chunk_index, payload) VALUES (?, ?, ?)')
      .bind(review.id, index, json.slice(offset, end)));
    offset = end;
  }
  await db.batch(statements);
}

export async function getSafeImportReview(workspaceId: string, reviewId: string): Promise<SafeImportReview | null> {
  await ensureSafeImportSchema();
  const db = await getDatabase();
  const row = await db.prepare('SELECT id FROM safe_import_reviews WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, reviewId).first<{ id: string }>();
  if (!row) return null;
  const chunks = await db.prepare('SELECT chunk_index, payload FROM safe_import_review_chunks WHERE review_id = ? ORDER BY chunk_index')
    .bind(reviewId).all<{ chunk_index: number; payload: string }>();
  if (!chunks.results.length || chunks.results.some((chunk, index) => chunk.chunk_index !== index)) {
    throw new Error('The saved import review is incomplete. Prepare a new review.');
  }
  const review = JSON.parse(chunks.results.map((chunk) => chunk.payload).join('')) as SafeImportReview;
  if (review.id !== reviewId || review.workspaceId !== workspaceId) throw new Error('The saved review identity is inconsistent.');
  return review;
}

/** Recovery does not depend on the browser retaining the review ID. */
export async function getLatestSafeImportReview(workspaceId: string): Promise<SafeImportReview | null> {
  await ensureSafeImportSchema();
  const db = await getDatabase();
  const row = await db.prepare('SELECT id FROM safe_import_reviews WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .bind(workspaceId).first<{ id: string }>();
  return row ? getSafeImportReview(workspaceId, row.id) : null;
}

export async function getSafeImportExecution(workspaceId: string, reviewId: string): Promise<SafeImportExecution | null> {
  await ensureSafeImportSchema();
  return readExecution(await getDatabase(), workspaceId, reviewId);
}

/** The unique review constraint decides the sole winner, before any CRM request. */
export async function claimSafeImportExecution(
  review: SafeImportReview,
  execution: SafeImportExecution,
): Promise<{ claimed: boolean; execution: SafeImportExecution }> {
  const saved = await getSafeImportReview(review.workspaceId, review.id);
  if (!saved || JSON.stringify(saved) !== JSON.stringify(review)) throw new Error('Approval must use the exact saved import review.');
  if (execution.reviewId !== review.id || execution.workspaceId !== review.workspaceId
    || JSON.stringify(execution.account) !== JSON.stringify(review.account)) throw new Error('Execution does not match the approved account and review.');
  const db = await getDatabase();
  const headerJson = JSON.stringify({ ...execution, records: [] });
  const row = await db.prepare(`INSERT INTO safe_import_executions
    (id, review_id, workspace_id, execution_key, payload_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(review_id) DO NOTHING RETURNING id`)
    .bind(execution.id, review.id, review.workspaceId, execution.executionKey, headerJson, execution.updatedAt)
    .first<{ id: string }>();
  const current = await readExecution(db, review.workspaceId, review.id);
  if (!current) throw new Error('The durable execution claim could not be read. No CRM write should start.');
  return { claimed: Boolean(row), execution: current };
}

/** Compare-and-set prevents a reconciliation request overwriting an active request. */
export async function updateSafeImportExecution(execution: SafeImportExecution, previous?: SafeImportExecution): Promise<void> {
  await ensureSafeImportSchema();
  const db = await getDatabase();
  const header = await readExecutionHeader(db, execution.workspaceId, execution.reviewId);
  const current = header ? await hydrateExecution(db, header.payload_json) : null;
  const baseline = previous ?? current;
  if (!baseline || baseline.id !== execution.id || baseline.executionKey !== execution.executionKey
    || baseline.approvedAt !== execution.approvedAt || baseline.createdAt !== execution.createdAt
    || JSON.stringify(baseline.account) !== JSON.stringify(execution.account)) {
    throw new Error('A saved execution cannot change its approval or account.');
  }
  if (!header || !current || JSON.stringify(current) !== JSON.stringify(baseline)
    || execution.records.length !== baseline.records.length
    || execution.records.some((record, index) => record.contactId !== baseline.records[index].contactId || record.nativeId !== baseline.records[index].nativeId
      || record.objectType !== baseline.records[index].objectType)) {
    throw new Error('Execution progress changed in another request. Read the saved execution before proceeding.');
  }
  // Targets come from the immutable review. Readback evidence lives per row,
  // so a whole 5,000-row import never needs one oversized D1 JSON binding.
  const headerJson = JSON.stringify({ ...execution, records: [], progressToken: crypto.randomUUID() });
  const statements = [db.prepare(`UPDATE safe_import_executions SET payload_json = ?, updated_at = ?
    WHERE workspace_id = ? AND review_id = ? AND id = ? AND payload_json = ?`)
    .bind(headerJson, execution.updatedAt, execution.workspaceId, execution.reviewId, execution.id, header.payload_json)];
  execution.records.forEach((record, index) => {
    if (JSON.stringify(record) === JSON.stringify(baseline.records[index])) return;
    statements.push(db.prepare(`INSERT INTO safe_import_execution_records (execution_id, contact_id, payload_json)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM safe_import_executions WHERE id = ? AND payload_json = ?)
      ON CONFLICT(execution_id, contact_id) DO UPDATE SET payload_json = excluded.payload_json`)
      .bind(execution.id, record.contactId, JSON.stringify(record), execution.id, headerJson));
  });
  await db.batch(statements);
  const stored = await readExecutionHeader(db, execution.workspaceId, execution.reviewId);
  if (stored?.payload_json !== headerJson) throw new Error('Execution progress changed in another request. Read the saved execution before proceeding.');
}

async function readExecution(db: DatabaseAdapter, workspaceId: string, reviewId: string): Promise<SafeImportExecution | null> {
  const row = await readExecutionHeader(db, workspaceId, reviewId);
  return row ? hydrateExecution(db, row.payload_json) : null;
}

async function readExecutionHeader(db: DatabaseAdapter, workspaceId: string, reviewId: string): Promise<{ payload_json: string } | null> {
  const row = await db.prepare('SELECT payload_json FROM safe_import_executions WHERE workspace_id = ? AND review_id = ?')
    .bind(workspaceId, reviewId).first<{ payload_json: string }>();
  return row;
}

async function hydrateExecution(db: DatabaseAdapter, json: string): Promise<SafeImportExecution> {
  const execution = JSON.parse(json) as SafeImportExecution & { progressToken?: string };
  delete execution.progressToken;
  if (!execution.records.length) {
    if (lastPendingSeed?.reviewId !== execution.reviewId || lastPendingSeed.workspaceId !== execution.workspaceId) {
      const review = await getSafeImportReview(execution.workspaceId, execution.reviewId);
      if (!review) throw new Error('The execution has no saved approved review.');
      lastPendingSeed = {
        reviewId: review.id, workspaceId: review.workspaceId,
        records: review.plans.flatMap((plan) => plan.records.filter((record) => record.operation === 'update').map((record) => ({
          contactId: record.contactId, nativeId: record.nativeId!, status: 'pending' as const, error: null,
          ...(review.connectorId === 'salesforce' ? { objectType: record.matches[0].objectType } : {}),
        }))),
      };
    }
    // A one-entry cache avoids reparsing the immutable whole file at every row;
    // it has no authority and can always be reconstructed after a restart.
    execution.records = lastPendingSeed.records.map((record) => ({ ...record }));
  }
  const rows = await db.prepare('SELECT contact_id, payload_json FROM safe_import_execution_records WHERE execution_id = ?')
    .bind(execution.id).all<{ contact_id: string; payload_json: string }>();
  const byId = new Map(rows.results.map((row) => [row.contact_id, JSON.parse(row.payload_json) as SafeImportExecution['records'][number]]));
  execution.records = execution.records.map((record) => {
    const progress = byId.get(record.contactId);
    if (progress && (progress.contactId !== record.contactId || progress.nativeId !== record.nativeId
      || progress.objectType !== record.objectType)) throw new Error('Saved execution progress has a different approved target.');
    return progress ?? record;
  });
  return execution;
}
