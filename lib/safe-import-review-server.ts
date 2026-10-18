import { isSuppressed } from './suppression';
import { createGovernedCrmPlan } from './governed-crm-plan';
import { defaultCrmUpdatePolicy, isSafeContactUpdatePolicy, type CrmWritePlan, type PortableCrmContact } from './crm-workflow';
import { isHubSpotEligible, toHubSpotSyncContact } from './hubspot-sync';
import { toSalesforceUpdateContact } from './salesforce-sync';
import type { SavedWorkspace } from './workspace';
import { MAX_PERSISTED_CONTACTS } from './workspace';
import { safeImportCounts, type CrmAccountIdentity, type SafeImportReview, type SafeImportReviewRow } from './safe-import';

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function safeImportWorkspaceFingerprint(workspace: SavedWorkspace): Promise<string> {
  const s = workspace.state;
  return sha256(JSON.stringify([workspace.id, workspace.revision, s.fileName, s.sourceFileHash, s.mapping,
    s.importRecipe, s.importRecordMode, s.crmUpdatePolicy, s.sourceType, s.destinationType, s.contacts, s.originalContacts]));
}

export function assertSafeImportWorkspace(workspace: SavedWorkspace): void {
  const s = workspace.state;
  if ((s.importObject ?? 'contact') !== 'contact') {
    throw new Error('Company and associated-company imports support local review and export only. Safe Import requires a contacts-only import.');
  }
  if (s.importRecipe !== 'safe-update-contacts' || s.importRecordMode !== 'update-existing'
    || !['hubspot', 'salesforce'].includes(s.destinationType) || !s.crmUpdatePolicy || !isSafeContactUpdatePolicy(s.crmUpdatePolicy)) {
    throw new Error('Select and save Safe Import: Update existing contacts with a HubSpot or Salesforce destination and protected field policy.');
  }
  if (!s.sourceFileHash || !/^[a-f0-9]{64}$/u.test(s.sourceFileHash)) throw new Error('Upload the CSV again to retain its source-file hash before preparing this review.');
  if (!s.contacts.length || s.contacts.length > MAX_PERSISTED_CONTACTS) throw new Error('Use between 1 and 5,000 saved import rows.');
  if (new Set(s.contacts.map((row) => row.contactId)).size !== s.contacts.length
    || new Set(s.originalContacts.map((row) => row.contactId)).size !== s.originalContacts.length) {
    throw new Error('Every source row needs a unique import row ID before preparing a whole-file review.');
  }
}

type ReviewDependencies = {
  createPlan: typeof createGovernedCrmPlan;
  now: () => Date;
};

/** All source rows are represented before approval, using the existing governed batch planner. */
export async function buildSafeImportReview(workspace: SavedWorkspace, account: CrmAccountIdentity,
  overrides: Partial<ReviewDependencies> = {}): Promise<SafeImportReview> {
  assertSafeImportWorkspace(workspace);
  const connectorId = workspace.state.destinationType as SafeImportReview['connectorId'];
  if (account.connectorId !== connectorId) throw new Error('The verified CRM account does not match the saved destination.');
  const { createPlan, now } = { createPlan: createGovernedCrmPlan, now: () => new Date(), ...overrides };
  const started = now();
  const policy = defaultCrmUpdatePolicy();
  const rows = new Map<string, SafeImportReviewRow>();
  const portable: PortableCrmContact[] = [];
  for (const row of workspace.state.contacts) {
    const base = { contactId: row.contactId, email: row.normalizedEmail || row.rawEmail };
    if (isSuppressed(row)) {
      rows.set(row.contactId, { ...base, status: 'skipped', reason: `Suppressed: ${(row.suppressionMatches ?? []).map((match) => `${match.listName}: ${match.reason}`).join('; ')}` });
      continue;
    }
    if (row.importExclusion || row.recordStatus !== 'active') {
      rows.set(row.contactId, { ...base, status: 'skipped', reason: row.importExclusion?.reason ?? 'This source row was merged or removed locally; no CRM write is scheduled.' });
    } else if (!isHubSpotEligible(row)) {
      rows.set(row.contactId, { ...base, status: 'held', reason: `Resolve this row before importing: ${row.qualityFlags.join(', ') || 'no usable email identity'}. No update is scheduled.` });
    } else {
      try { portable.push(connectorId === 'hubspot' ? toHubSpotSyncContact(row) : toSalesforceUpdateContact(row)); }
      catch { rows.set(row.contactId, { ...base, status: 'held', reason: 'The imported values are not eligible for this CRM. Correct this row before importing.' }); }
    }
  }
  const plans: CrmWritePlan[] = [];
  for (let offset = 0; offset < portable.length; offset += 100) {
    const batch = portable.slice(offset, offset + 100);
    try {
      const plan = await createPlan(connectorId, workspace.state.fileName ?? 'contacts.csv', batch, workspace, policy);
      if (plan.requested !== batch.length || plan.records.length !== batch.length
        || plan.connectorId !== connectorId
        || plan.recordMode !== 'update-existing' || plan.records.some((row) => row.operation === 'create')
        || batch.some((input) => plan.records.filter((row) => row.contactId === input.contactId).length !== 1)) {
        throw new Error('The governed planner did not account for this complete update-only batch.');
      }
      plans.push(plan);
      for (const record of plan.records) rows.set(record.contactId, {
        contactId: record.contactId, email: record.email, record, reason: record.reason,
        status: record.operation === 'update' ? 'proposed-update' : record.operation === 'unchanged' ? 'unchanged'
          : !record.matches.length && !record.matchDecision && !record.possibleMatches?.length && !record.possibleImportMatches?.length
            && record.reason?.startsWith('No confirmed existing match') ? 'unmatched' : 'held',
      });
    } catch (failure) {
      for (const contact of batch) rows.set(contact.contactId, {
        contactId: contact.contactId, email: contact.email, status: 'unresolved',
        reason: failure instanceof Error ? failure.message : 'CRM lookup incomplete. This row has not been checked.',
      });
    }
  }
  // Batch planners detect known aliases and confirmations. The assembled review
  // also catches targets learned independently in different batches.
  const claims = new Map<string, SafeImportReviewRow[]>();
  for (const row of rows.values()) {
    if (!row.record || row.record.matches.length !== 1) continue;
    const target = row.record.matches[0];
    const key = `${target.objectType}:${target.nativeId}`;
    claims.set(key, [...claims.get(key) ?? [], row]);
  }
  for (const claim of claims.values()) if (claim.length > 1) for (const row of claim) {
    const record = row.record!;
    row.status = 'held';
    row.reason = 'Multiple source rows target the same CRM person, including across batches. Skip or resolve the other row and prepare a new review.';
    record.operation = 'hold';
    record.reason = row.reason;
    record.changes = [];
    if (record.before) record.after = { ...record.before };
    record.fieldDecisions = record.fieldDecisions?.map((decision) => ({ ...decision,
      proposedValue: decision.currentValue, action: 'review', reasonCode: 'duplicate_target' }));
  }
  for (const plan of plans) {
    plan.updates = plan.records.filter((row) => row.operation === 'update').length;
    plan.unchanged = plan.records.filter((row) => row.operation === 'unchanged').length;
    plan.held = plan.records.filter((row) => row.operation === 'hold').length;
    plan.fingerprint = await sha256(JSON.stringify([plan.connectorId, plan.recordMode, plan.updatePolicy, plan.records]));
  }
  for (const source of workspace.state.originalContacts) if (!rows.has(source.contactId)) rows.set(source.contactId, {
    contactId: source.contactId, email: source.normalizedEmail || source.rawEmail, status: 'skipped',
    reason: 'This original source row was removed locally. No CRM write is scheduled.',
  });
  const allRows = [...rows.values()];
  const expiresAt = new Date(started.getTime() + 15 * 60_000).toISOString();
  return {
    id: crypto.randomUUID(), workspaceId: workspace.id, workspaceRevision: workspace.revision, connectorId, account,
    sourceFile: workspace.state.fileName ?? 'contacts.csv', sourceFileHash: workspace.state.sourceFileHash!,
    workspaceFingerprint: await safeImportWorkspaceFingerprint(workspace), mapping: workspace.state.mapping,
    recordMode: 'update-existing', updatePolicy: policy, createdAt: started.toISOString(), expiresAt,
    complete: allRows.every((row) => row.status !== 'unresolved') && now().getTime() < Date.parse(expiresAt),
    plans, rows: allRows, counts: safeImportCounts(allRows),
  };
}

/** Excludes generated ids/timestamps; binds exactly the decisions and evidence shown. */
export async function safeImportEvidenceFingerprint(review: SafeImportReview): Promise<string> {
  return sha256(JSON.stringify([review.account, review.workspaceFingerprint, review.sourceFileHash, review.mapping,
    review.recordMode, review.updatePolicy, review.complete, review.rows]));
}
