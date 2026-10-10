import { readHubSpotAccountIdentity, readSalesforceAccountIdentity, salesforceConnection, sameCrmAccount } from './crm-account';
import { readHubSpotRecordById } from './crm-existing-hubspot';
import { readSalesforceRecordById, isSalesforcePersonId } from './crm-existing-salesforce';
import { toHubSpotFieldPayload, toSalesforceFieldPayload } from './crm-field-mapping';
import { portableCrmFieldNames, type CrmPlanRecord, type NativeCrmRecord } from './crm-workflow';
import type { CrmAccountIdentity, SafeImportExecution, SafeImportReview, SafeImportVerification } from './safe-import';
import { claimSafeImportExecution, updateSafeImportExecution, claimSafeImportChunk, releaseSafeImportChunk, getSafeImportExecution } from './safe-import-store';
import { getWorkspace } from './workspace-store';
import { safeImportWorkspaceFingerprint } from './safe-import-review-server';
import { notifyImportExecution } from './operation-notifications';

type WriteOutcome = { status: 'accepted' | 'failed' | 'unknown'; error: string | null };
export type SafeImportExecutionDependencies = {
  readAccount: () => Promise<CrmAccountIdentity>;
  readRecord: (nativeId: string, objectType?: NativeCrmRecord['objectType']) => Promise<NativeCrmRecord | null>;
  writeRecord: (record: CrmPlanRecord) => Promise<WriteOutcome>;
  claimExecution: typeof claimSafeImportExecution;
  saveExecution: typeof updateSafeImportExecution;
  now: () => Date;
  assertWorkspace: () => Promise<void>;
};

export const SAFE_IMPORT_CHUNK_SIZE = 10;
const CHUNK_TIME_MS = 20_000;

/** Approval is unique and durable. Its first bounded chunk uses the same worker as continuations. */
export async function executeSafeImportReview(
  review: SafeImportReview,
  overrides: Partial<SafeImportExecutionDependencies> = {},
): Promise<SafeImportExecution> {
  const deps = dependencies(review, overrides);
  const planned = validateReview(review, deps.now());
  await requireAccount(review.account, deps);
  await deps.assertWorkspace();
  const now = deps.now().toISOString();
  const claim = await deps.claimExecution(review, {
    id: crypto.randomUUID(), executionKey: `safe-import:${review.id}`, reviewId: review.id, workspaceId: review.workspaceId,
    account: review.account, approvedAt: now, createdAt: now, updatedAt: now, status: 'running',
    records: planned.map((record) => ({ contactId: record.contactId, nativeId: record.nativeId!, status: 'pending', error: null,
      ...(review.connectorId === 'salesforce' ? { objectType: record.matches[0].objectType } : {}) })),
  });
  // Duplicate approval never authorizes or triggers another chunk.
  if (!claim.claimed) return claim.execution;
  return continueSafeImportExecution(review, overrides);
}

/** Only definitely unsent pending records can progress. This never creates an approval. */
export async function continueSafeImportExecution(
  review: SafeImportReview,
  overrides: Partial<SafeImportExecutionDependencies> = {},
): Promise<SafeImportExecution> {
  const deps = dependencies(review, overrides);
  // Expired queued records become held; the original authorization deadline never moves.
  const planned = validateReview(review, deps.now(), true);
  const claim = await claimSafeImportChunk(review, deps.now());
  if (!claim.claimed) return claim.execution;
  let execution = claim.execution;
  try {
    execution = await markAbandonedSending(execution, deps);
    const started = deps.now().getTime();
    let processed = 0;
    for (let index = 0; index < execution.records.length; index += 1) {
      const progress = execution.records[index];
      const needsReadback = ['accepted', 'unknown'].includes(progress.status) && !progress.verification;
      if (progress.status !== 'pending' && !needsReadback) continue;
      if (processed >= SAFE_IMPORT_CHUNK_SIZE || (processed > 0 && deps.now().getTime() - started >= CHUNK_TIME_MS)) break;
      processed += 1;
      const record = matchingPlan(review, planned, execution.records[index]);
      if (needsReadback) {
        execution = await saveRecord(execution, index, { verification: await verifyRecord(review.account, record, deps) }, deps);
        continue;
      }
      try {
        if (Date.parse(review.expiresAt) <= deps.now().getTime()) throw new Error('The original approval expired before this record was sent. Prepare a new review.');
        await requireAccount(review.account, deps);
        const current = await deps.readRecord(record.nativeId!, record.matches[0].objectType);
        if (!matchesBaseline(record, current)) throw new Error('The CRM identity or field values changed after review. No update was sent; prepare a new review.');
        // A reread and a PATCH are separate operations, not atomic protection from external writers.
        await requireAccount(review.account, deps);
        await deps.assertWorkspace();
        if (Date.parse(review.expiresAt) <= deps.now().getTime()) throw new Error('The approved review expired during the CRM recheck. Prepare a new review.');
      } catch (error) {
        execution = await saveRecord(execution, index, { status: 'held', error: message(error, 'The CRM could not be rechecked. No update was sent.') }, deps);
        continue;
      }
      // This transaction compare-and-sets both the lease-bearing header and pending row.
      // If a successor acquired the expired lease, the stale worker cannot start another write.
      execution = await saveRecord(execution, index, { status: 'sending', error: null }, deps);
      let outcome: WriteOutcome;
      try { outcome = await deps.writeRecord(record); }
      catch { outcome = { status: 'unknown', error: 'The update response was lost. Outcome unknown; reconcile by reading the CRM. This update will not be resent.' }; }
      execution = await saveRecord(execution, index, outcome, deps);
      if (outcome.status === 'accepted' || outcome.status === 'unknown') {
        execution = await saveRecord(execution, index, { verification: await verifyRecord(review.account, record, deps) }, deps);
      }
    }
    execution = await saveStatus(execution, deps);
    if (execution.status !== 'running') await notifyImportExecution(review, execution);
  } finally { await releaseSafeImportChunk(execution); }
  return (await getSafeImportExecution(review.workspaceId, review.id))!;
}

/** Reads only, in bounded pages. Pending unsent records retain their original approval. */
export async function reconcileSafeImportExecution(
  review: SafeImportReview,
  previous: SafeImportExecution,
  overrides: Partial<SafeImportExecutionDependencies> = {},
): Promise<SafeImportExecution> {
  const deps = dependencies(review, overrides);
  if (previous.reviewId !== review.id || previous.workspaceId !== review.workspaceId || !sameCrmAccount(previous.account, review.account)) {
    throw new Error('The execution does not belong to this saved review and CRM account.');
  }
  await requireAccount(review.account, deps);
  const claim = await claimSafeImportChunk(review, deps.now());
  if (!claim.claimed) return claim.execution;
  let execution = claim.execution;
  try {
    execution = await markAbandonedSending(execution, deps);
    const planned = review.plans.flatMap((plan) => plan.records).filter((record) => record.operation === 'update');
    const started = deps.now().getTime();
    let read = 0;
    let cursor = execution.reconciliationCursor ?? 0;
    for (; cursor < execution.records.length; cursor += 1) {
      const progress = execution.records[cursor];
      if (!['accepted', 'unknown'].includes(progress.status)) continue;
      if (read >= SAFE_IMPORT_CHUNK_SIZE || (read > 0 && deps.now().getTime() - started >= CHUNK_TIME_MS)) break;
      read += 1;
      const record = matchingPlan(review, planned, progress);
      execution = await saveRecord(execution, cursor, { verification: await verifyRecord(review.account, record, deps) }, deps);
    }
    const next = { ...execution, reconciliationCursor: cursor < execution.records.length ? cursor : 0 };
    await deps.saveExecution(next, execution);
    execution = await saveStatus(next, deps);
    if (execution.status !== 'running') await notifyImportExecution(review, execution);
  } finally { await releaseSafeImportChunk(execution); }
  return (await getSafeImportExecution(review.workspaceId, review.id))!;
}

async function markAbandonedSending(execution: SafeImportExecution, deps: SafeImportExecutionDependencies): Promise<SafeImportExecution> {
  const records = execution.records.map((record) => record.status === 'sending'
    ? { ...record, status: 'unknown' as const, error: 'The previous worker stopped after claiming this request. It may have reached the CRM. This update will not be resent.' } : record);
  if (!execution.records.some((record) => record.status === 'sending')) return execution;
  const next = { ...execution, records };
  await deps.saveExecution(next, execution);
  return next;
}

async function saveStatus(execution: SafeImportExecution, deps: SafeImportExecutionDependencies): Promise<SafeImportExecution> {
  const next: SafeImportExecution = { ...execution, updatedAt: deps.now().toISOString(),
    status: execution.records.some((record) => record.status === 'pending' || (['accepted', 'unknown'].includes(record.status) && !record.verification)) ? 'running'
      : execution.records.some((record) => ['sending', 'unknown'].includes(record.status)) ? 'reconciliation-required' : 'completed' };
  await deps.saveExecution(next, execution);
  return next;
}

function matchingPlan(review: SafeImportReview, planned: CrmPlanRecord[], progress: SafeImportExecution['records'][number]): CrmPlanRecord {
  const record = planned.find((candidate) => candidate.contactId === progress.contactId && candidate.nativeId === progress.nativeId
    && candidate.matches[0]?.objectType === (progress.objectType ?? (review.connectorId === 'hubspot' ? 'contact' : undefined)));
  if (!record) throw new Error('Execution progress does not match the saved review target.');
  return record;
}

async function saveRecord(
  previous: SafeImportExecution, index: number, patch: Partial<SafeImportExecution['records'][number]>, deps: SafeImportExecutionDependencies,
): Promise<SafeImportExecution> {
  const records = previous.records.map((record, recordIndex) => recordIndex === index ? { ...record, ...patch } : record);
  const execution = { ...previous, records, updatedAt: deps.now().toISOString(),
    ...(previous.lease ? { lease: { ...previous.lease, expiresAt: new Date(deps.now().getTime() + 300_000).toISOString() } } : {}) };
  await deps.saveExecution(execution, previous);
  return execution;
}

function validateReview(review: SafeImportReview, now: Date, allowExpired = false): CrmPlanRecord[] {
  if (!['hubspot', 'salesforce'].includes(review.connectorId) || review.account.connectorId !== review.connectorId
    || !(review.connectorId === 'hubspot' ? /^\d+$/.test(review.account.accountId) : /^00D(?:[A-Za-z0-9]{12}|[A-Za-z0-9]{15})$/.test(review.account.accountId))
    || !review.complete || review.rows.some((row) => row.status === 'unresolved')
    || review.recordMode !== 'update-existing' || review.updatePolicy.mode !== 'fill-empty' || review.updatePolicy.clearBlanks
    || !Number.isFinite(new Date(review.expiresAt).getTime()) || (!allowExpired && new Date(review.expiresAt).getTime() <= now.getTime())) {
    throw new Error('A complete, unexpired update-only review for a verified CRM account is required.');
  }
  const all = review.plans.flatMap((plan) => {
    if (plan.connectorId !== review.connectorId || plan.records.length > 100 || plan.records.some((record) => record.operation === 'create')) {
      throw new Error('Safe Import cannot create contacts or execute unsupported plans.');
    }
    return plan.records;
  });
  if (new Set(all.map((record) => record.contactId)).size !== all.length) throw new Error('The review contains repeated source rows.');
  const updates = all.filter((record) => record.operation === 'update');
  if (new Set(updates.map((record) => record.nativeId)).size !== updates.length) throw new Error('Multiple import rows cannot update the same native contact.');
  for (const record of updates) {
    if (!record.nativeId || record.matches.length !== 1 || !validTarget(review.connectorId, record)
      || record.matches[0].nativeId !== record.nativeId || !record.before
      || !record.changes.length || new Set(record.changes.map((change) => change.field)).size !== record.changes.length
      || record.changes.some((change) => !allowedFields(review.connectorId, record.matches[0].objectType).includes(change.field)
        || !review.updatePolicy.fields.includes(change.field) || clean(change.before) !== null || clean(record.before![change.field]) !== null
        || clean(change.after) === null || change.after !== record.after[change.field])
      || portableCrmFieldNames.some((field) => !record.changes.some((change) => change.field === field) && clean(record.before![field]) !== clean(record.after[field]))
      || !review.rows.some((row) => row.contactId === record.contactId && row.status === 'proposed-update')) {
      throw new Error('The saved update exceeds the approved fill-empty field policy or has no unique confirmed identity.');
    }
  }
  return updates;
}

function matchesBaseline(record: CrmPlanRecord, current: NativeCrmRecord | null): boolean {
  return Boolean(current && current.nativeId === record.nativeId && current.objectType === record.matches[0].objectType
    && (current.objectType !== 'lead' || current.isConverted === false)
    && current.email.trim().toLowerCase() === record.matches[0].email.trim().toLowerCase()
    && portableCrmFieldNames.every((field) => clean(current.fields[field]) === clean(record.before![field])));
}

async function verifyRecord(account: CrmAccountIdentity, record: CrmPlanRecord, deps: SafeImportExecutionDependencies): Promise<SafeImportVerification> {
  const expected = { email: record.matches[0].email.trim().toLowerCase(), fields: record.after };
  const result: SafeImportVerification = { status: 'unavailable', checkedAt: deps.now().toISOString(), expected, actual: null, error: null };
  try {
    await requireAccount(account, deps);
    const current = await deps.readRecord(record.nativeId!, record.matches[0].objectType);
    if (!current || current.nativeId !== record.nativeId || current.objectType !== record.matches[0].objectType
      || (current.objectType === 'lead' && current.isConverted !== false)) throw new Error('The updated CRM record is missing, converted, or unavailable.');
    result.actual = { email: current.email.trim().toLowerCase(), fields: current.fields };
    result.status = result.actual.email === expected.email && portableCrmFieldNames.every((field) => clean(current.fields[field]) === clean(expected.fields[field])) ? 'verified' : 'different';
  } catch (error) { result.error = message(error, 'Readback could not verify this contact.'); }
  result.checkedAt = deps.now().toISOString();
  return result;
}

async function requireAccount(account: CrmAccountIdentity, deps: SafeImportExecutionDependencies) {
  if (!sameCrmAccount(account, await deps.readAccount())) throw new Error('The configured CRM account differs from the approved account. No write or verification is allowed.');
}

function dependencies(review: SafeImportReview, overrides: Partial<SafeImportExecutionDependencies>): SafeImportExecutionDependencies {
  // Capture this request's token once. A credential change cannot swap the token mid-execution.
  const token = process.env.HUBSPOT_ACCESS_TOKEN ?? '';
  let session: ReturnType<typeof salesforceConnection> | undefined;
  const salesforce = () => session ??= salesforceConnection();
  return {
    readAccount: () => review.connectorId === 'hubspot' ? readHubSpotAccountIdentity(token)
      : readSalesforceAccountIdentity(salesforce().apiRoot, salesforce().headers),
    readRecord: (nativeId, objectType) => review.connectorId === 'hubspot' ? readHubSpotRecordById(nativeId, token)
      : readSalesforceRecordById(nativeId, objectType!, salesforce().apiRoot, salesforce().headers),
    writeRecord: (record) => review.connectorId === 'hubspot' ? writeHubSpotSafeImportRecord(record, token)
      : writeSalesforceSafeImportRecord(record, salesforce().apiRoot, salesforce().headers),
    claimExecution: claimSafeImportExecution, saveExecution: updateSafeImportExecution, now: () => new Date(),
    assertWorkspace: async () => {
      const workspace = await getWorkspace(review.workspaceId);
      if (!workspace || workspace.revision !== review.workspaceRevision
        || await safeImportWorkspaceFingerprint(workspace) !== review.workspaceFingerprint) {
        throw new Error('The saved workspace changed after review. Prepare and approve a new review before updating more records.');
      }
    },
    ...overrides,
  };
}

function allowedFields(connectorId: SafeImportReview['connectorId'], objectType: NativeCrmRecord['objectType']) {
  return portableCrmFieldNames.filter((field) => connectorId !== 'salesforce' || objectType !== 'contact' || !['company', 'website'].includes(field));
}

function validTarget(connectorId: SafeImportReview['connectorId'], record: CrmPlanRecord): boolean {
  const target = record.matches[0];
  return Boolean(record.nativeId && target && (connectorId === 'hubspot'
    ? /^\d+$/.test(record.nativeId) && target.objectType === 'contact'
    : isSalesforcePersonId(record.nativeId, target.objectType) && (target.objectType !== 'lead' || target.isConverted === false)));
}

/** Only the exact native sObject can be patched; never an external-ID upsert or parent relationship. */
export async function writeSalesforceSafeImportRecord(record: CrmPlanRecord, apiRoot: string, headers: Record<string, string>): Promise<WriteOutcome> {
  const root = new URL(apiRoot);
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash
    || !/^\/services\/data\/v\d+\.\d+$/.test(root.pathname)) throw new Error('Salesforce requires an instance API root.');
  if (record.operation !== 'update' || record.matches.length !== 1 || !validTarget('salesforce', record)
    || record.matches[0].nativeId !== record.nativeId || !record.changes.length
    || record.changes.some((change) => !allowedFields('salesforce', record.matches[0].objectType).includes(change.field)
      || clean(change.before) !== null || clean(change.after) === null || change.after !== record.after[change.field])) {
    throw new Error('Safe Import only permits reviewed nonblank fills against existing Salesforce Lead or Contact IDs and supported fields.');
  }
  const objectName = record.matches[0].objectType === 'lead' ? 'Lead' : 'Contact';
  const response = await fetch(`${root.href}/sobjects/${objectName}/${record.nativeId}`, {
    method: 'PATCH', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(30_000),
    headers: { ...headers, 'content-type': 'application/json', 'Sforce-Auto-Assign': 'FALSE' },
    body: JSON.stringify(toSalesforceFieldPayload(record.after, record.changes.map((change) => change.field))),
  });
  if (response.status === 204) return { status: 'accepted', error: null };
  const rejected = [400, 401, 403, 404, 409, 412, 422, 429].includes(response.status);
  return { status: rejected ? 'failed' : 'unknown', error: `Salesforce returned ${response.status}. ${rejected ? 'Prepare a new review before another write.' : 'Outcome unknown; reconcile without resending.'}` };
}

/** Native-ID PATCH only. A timeout or server error cannot be assumed safe to resend. */
export async function writeHubSpotSafeImportRecord(record: CrmPlanRecord, token: string): Promise<WriteOutcome> {
  if (record.operation !== 'update' || !record.nativeId || !/^\d+$/.test(record.nativeId) || !record.changes.length
    || record.changes.some((change) => !portableCrmFieldNames.includes(change.field) || clean(change.before) !== null
      || clean(change.after) === null || change.after !== record.after[change.field])) {
    throw new Error('Safe Import only permits reviewed nonblank fills against existing numeric contact IDs.');
  }
  const response = await fetch(`https://api.hubapi.com/crm/objects/2026-03/contacts/${record.nativeId}`, {
    method: 'PATCH', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ properties: toHubSpotFieldPayload(record.after, record.changes.map((change) => change.field)) }),
  });
  if (!response.ok || response.status === 207) {
    const rejected = [400, 401, 403, 404, 409, 422, 429].includes(response.status);
    return { status: rejected ? 'failed' : 'unknown', error: `HubSpot returned ${response.status}. ${rejected ? 'Prepare a new review before another write.' : 'Outcome unknown; reconcile without resending.'}` };
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('id' in body) || body.id !== record.nativeId
    || ('archived' in body && body.archived !== false)) return { status: 'unknown', error: 'HubSpot did not return the expected native contact identity. Reconcile without resending.' };
  return { status: 'accepted', error: null };
}

function clean(value: string | null | undefined): string | null { return value?.trim() || null; }
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
