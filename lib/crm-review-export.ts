import type { CrmWritebackReceipt, CrmWritePlan } from './crm-workflow';
import type { CrmRunVerification } from './crm-run-verification';
import type { PomadeOrigin } from './pomade-handoff';

export type CrmReviewExport = { plan?: CrmWritePlan; writeback?: CrmWritebackReceipt; verification?: CrmRunVerification; originsByContactId?: Record<string, PomadeOrigin[]> };

const columns = [
  'report_kind', 'report_scope', 'provider', 'plan_id', 'run_id', 'source_file',
  'contact_id', 'email', 'planned_action', 'outcome', 'native_id',
  'exact_match_count', 'exact_matches', 'reason', 'field_changes',
  'match_basis', 'matched_native_email', 'match_confirmation_reason', 'match_confirmed_at',
  'crm_candidate_total', 'crm_candidates_shown', 'crm_candidates',
  'import_candidate_total', 'import_candidates_shown', 'import_candidates', 'match_score_basis',
  'snapshot_id', 'snapshot_started_at', 'review_rule_version', 'review_warnings', 'update_policy',
  'plan_requested', 'plan_creates', 'plan_updates', 'plan_unchanged', 'plan_held',
  'receipt_requested', 'receipt_created', 'receipt_updated', 'receipt_unchanged', 'receipt_held', 'receipt_failed',
  'verification_status', 'verification_checked_at', 'verification_expected', 'verification_actual',
  'verification_differences', 'verification_error',
  'source_context', 'source_context_basis', 'source_create_scope',
] as const;

// These reports are for spreadsheet review, not re-import. Protect only the report
// cell: leave source CSV and the stored plan/receipt values unchanged.
function spreadsheetCell(value: string | number | null | undefined): string {
  const text = value == null ? '' : String(value);
  const dangerousPrefix = /^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]*[=+\-@]/u.test(text)
    || /^[\t\r\n]/u.test(text);
  return `"${`${dangerousPrefix ? "'" : ''}${text}`.replaceAll('"', '""')}"`;
}

/** One row per contact in this comparison/receipt, not the whole import. */
export function buildCrmReviewCsv({ plan, writeback, verification, originsByContactId }: CrmReviewExport): string {
  const plannedById = new Map(plan?.records.map((record) => [record.contactId, record]));
  const receivedById = new Map(writeback?.records.map((record) => [record.contactId, record]));
  const verificationMatches = Boolean(plan && writeback && verification
    && plan.planId === writeback.planId && plan.connectorId === writeback.connectorId
    && verification.runId === writeback.runId && verification.planId === writeback.planId
    && verification.connectorId === writeback.connectorId);
  const verifiedById = new Map(verificationMatches ? verification!.records.map((record) => [record.contactId, record]) : []);
  const contactIds = new Set([...plannedById.keys(), ...receivedById.keys()]);
  const lines = [columns.map(spreadsheetCell).join(',')];
  for (const contactId of contactIds) {
    const planned = plannedById.get(contactId);
    const received = receivedById.get(contactId);
    const check = verifiedById.get(contactId);
    const verified = check && planned && received && ['created', 'updated'].includes(received.status)
      && check.nativeId === received.nativeId ? check : undefined;
    const crmCandidates = planned?.possibleMatches ?? [];
    const importCandidates = planned?.possibleImportMatches ?? [];
    const review = planned?.createReview;
    const origins = originsByContactId?.[contactId];
    const values: Record<(typeof columns)[number], string | number | null | undefined> = {
      report_kind: writeback ? 'results' : 'comparison', report_scope: 'current_batch',
      provider: writeback?.connectorId ?? plan?.connectorId, plan_id: writeback?.planId ?? plan?.planId,
      run_id: writeback?.runId, source_file: plan?.sourceFile,
      contact_id: contactId, email: received?.email ?? planned?.email,
      planned_action: planned?.operation,
      // Planned creates/updates are intentions. Only a native receipt provides an outcome.
      outcome: writeback ? received?.status ?? 'no_receipt' : '',
      native_id: received ? received.nativeId : planned?.nativeId,
      exact_match_count: planned ? planned.matchDecision ? '' : planned.matches.length : '',
      exact_matches: planned ? planned.matchDecision ? '' : JSON.stringify(planned.matches) : '',
      match_basis: planned?.matchDecision ? 'human_confirmed' : planned?.matches.length ? 'exact_email' : '',
      matched_native_email: planned?.matchDecision?.email ?? (planned?.matches.length === 1 ? planned.matches[0].email : ''),
      match_confirmation_reason: planned?.matchDecision?.reason, match_confirmed_at: planned?.matchDecision?.confirmedAt,
      reason: received?.error || planned?.reason || '',
      field_changes: planned ? JSON.stringify(planned.changes) : '',
      crm_candidate_total: review?.candidateCount ?? (planned?.possibleMatches ? crmCandidates.length : ''),
      crm_candidates_shown: planned ? crmCandidates.length : '', crm_candidates: planned ? JSON.stringify(crmCandidates) : '',
      import_candidate_total: review?.importCandidateCount ?? (planned?.possibleImportMatches ? importCandidates.length : ''),
      import_candidates_shown: planned ? importCandidates.length : '', import_candidates: planned ? JSON.stringify(importCandidates) : '',
      match_score_basis: crmCandidates.length || importCandidates.length ? 'evidence_score_0_to_100_not_probability' : '',
      snapshot_id: review?.scanId, snapshot_started_at: review?.startedAt, review_rule_version: review?.ruleVersion,
      review_warnings: review ? JSON.stringify(review.warnings) : '',
      update_policy: plan?.updatePolicy ? JSON.stringify(plan.updatePolicy) : '',
      plan_requested: plan?.requested, plan_creates: plan?.creates, plan_updates: plan?.updates,
      plan_unchanged: plan?.unchanged, plan_held: plan?.held,
      receipt_requested: writeback?.requested, receipt_created: writeback?.created, receipt_updated: writeback?.updated,
      receipt_unchanged: writeback?.unchanged, receipt_held: writeback?.held, receipt_failed: writeback?.failed,
      verification_status: verified?.status, verification_checked_at: verified?.checkedAt,
      verification_expected: verified ? JSON.stringify(verified.expected) : '',
      verification_actual: verified ? JSON.stringify(verified.actual) : '',
      verification_differences: verified ? JSON.stringify(verified.differences) : '',
      verification_error: verified?.error,
      source_context: origins?.length ? JSON.stringify(origins) : '',
      source_context_basis: origins?.length ? 'original_pomade_snapshot_not_proof_of_current_values' : '',
      source_create_scope: origins?.length ? 'existing_record_updates_only' : '',
    };
    lines.push(columns.map((column) => spreadsheetCell(values[column])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function downloadCrmReviewCsv(report: CrmReviewExport): void {
  const kind = report.writeback ? 'results' : 'comparison';
  const identifier = report.writeback?.runId ?? report.plan?.planId ?? 'report';
  const safeIdentifier = identifier.replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 100);
  const blob = new Blob(['\uFEFF', buildCrmReviewCsv(report)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `gtm-control-tower-current-batch-${kind}-${safeIdentifier}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
