import type { CrmPlanRecord, CrmUpdatePolicy, CrmWritePlan, NativeCrmRecord } from './crm-workflow';
import type { CsvColumnMapping } from './csv-control-tower';

export const SAFE_IMPORT_RECIPE = 'safe-update-contacts' as const;
export const SAFE_IMPORT_RULES = 'Update existing CRM records only. Fill empty fields from the file. Preserve populated CRM fields. Hold uncertain matches. Do not create, merge, delete, or convert records.';
export type CrmAccountIdentity = { connectorId: 'hubspot' | 'salesforce'; accountId: string };
export type SafeImportRowStatus = 'proposed-update' | 'unchanged' | 'held' | 'unmatched' | 'skipped' | 'unresolved';
export type SafeImportReviewRow = {
  contactId: string;
  email: string;
  status: SafeImportRowStatus;
  reason: string | null;
  record?: CrmPlanRecord;
};
export type SafeImportReview = {
  id: string;
  workspaceId: string;
  workspaceRevision: number;
  connectorId: 'hubspot' | 'salesforce';
  account: CrmAccountIdentity;
  sourceFile: string;
  sourceFileHash: string;
  workspaceFingerprint: string;
  mapping: CsvColumnMapping;
  recordMode: 'update-existing';
  updatePolicy: CrmUpdatePolicy;
  createdAt: string;
  expiresAt: string;
  complete: boolean;
  plans: CrmWritePlan[];
  rows: SafeImportReviewRow[];
  counts: Record<SafeImportRowStatus, number>;
};
export type SafeImportVerification = {
  status: 'verified' | 'different' | 'unavailable';
  checkedAt: string;
  expected: { email: string; fields: NativeCrmRecord['fields'] };
  actual: { email: string; fields: NativeCrmRecord['fields'] } | null;
  error: string | null;
};
export type SafeImportExecutionRecord = {
  contactId: string;
  nativeId: string;
  // Historical HubSpot receipts predate this field and always target contacts.
  objectType?: NativeCrmRecord['objectType'];
  status: 'pending' | 'sending' | 'accepted' | 'held' | 'unknown' | 'failed';
  error: string | null;
  verification?: SafeImportVerification;
};
export type SafeImportExecution = {
  id: string;
  executionKey: string;
  reviewId: string;
  workspaceId: string;
  account: CrmAccountIdentity;
  approvedAt: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'reconciliation-required';
  /** Durable worker ownership; never changes the scope or deadline of approval. */
  lease?: { token: string; expiresAt: string };
  reconciliationCursor?: number;
  /** Provider backpressure survives restarts; the original review expiry still applies. */
  nextAttemptAt?: string;
  retryReason?: string;
  /** A definitive permission failure or expired approval permanently holds all still-unsent rows. */
  unsentHoldReason?: string;
  records: SafeImportExecutionRecord[];
};

export function safeImportCounts(rows: SafeImportReviewRow[]): SafeImportReview['counts'] {
  const counts: SafeImportReview['counts'] = { 'proposed-update': 0, unchanged: 0, held: 0, unmatched: 0, skipped: 0, unresolved: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}
