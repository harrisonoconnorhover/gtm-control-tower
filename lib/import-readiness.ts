import { isSuppressed } from './suppression';
import { destinationHoldFlags } from './csv-control-tower';
import type { LiveContactState } from './live-control-tower';
import {
  qualificationMatchesCurrentInputs,
  type QualificationCheck, type QualificationCheckKind, type SavedPomadeQualification,
} from './pomade-qualification';
import { normalizeWebsiteUrl, type WebsiteCheckResult } from './website-check-types';

export type ImportReadinessReason = { code: string; message: string };
export type ImportReadinessRow = {
  sourceRowId: string;
  company: string;
  email: string;
  status: 'ready' | 'needs_review' | 'excluded';
  reasons: ImportReadinessReason[];
};
export type ImportReadiness = {
  counts: { ready: number; needsReview: number; excluded: number };
  rows: ImportReadinessRow[];
};
export type ImportReadinessInput = {
  contacts: LiveContactState[];
  workspaceId: string | null;
  websiteChecks: WebsiteCheckResult[];
  qualification: SavedPomadeQualification | null;
  qualificationStale?: boolean;
  websiteState?: 'loading' | 'error' | 'ready';
  qualificationState?: 'loading' | 'error' | 'ready';
  suppressionState?: 'loading' | 'error' | 'ready';
  unsaved?: boolean;
};

const holdMessages: Record<string, string> = {
  invalid_email: 'The email format needs correction.',
  missing_company: 'The company field needs correction.',
  missing_owner: 'An owner needs to be assigned.',
  stage_regression: 'The lifecycle stage would move backward and needs review.',
  duplicate_identity: 'This row has a duplicate identity in the import list.',
};
const checkLabels: Record<QualificationCheckKind, string> = {
  identity: 'Company identity', icp: 'ICP fit', email: 'Email verification',
};
const expectedAssessments = { identity: 'Match', icp: 'Fit', email: 'valid' };

/** A local review aid only: never changes import decisions, source rows or CRM state. */
export function deriveImportReadiness(input: ImportReadinessInput): ImportReadiness {
  const { contacts, workspaceId, websiteChecks, qualification } = input;
  const contactIds = countsBy(contacts.map((row) => row.contactId));
  const qualificationIds = countsBy(qualification?.rows.map((row) => row.sourceRowId) ?? []);
  const qualificationRows = new Map(qualification?.rows.map((row) => [row.sourceRowId, row]));
  const websites = new Map<string, WebsiteCheckResult>();
  for (const result of websiteChecks) {
    const url = normalizeWebsiteUrl(result.url);
    if (!url) continue;
    const previous = websites.get(url);
    if (!previous || Date.parse(result.checkedAt) >= Date.parse(previous.checkedAt)) websites.set(url, result);
  }
  const listChanged = Boolean(qualification && workspaceId
    && !qualificationMatchesCurrentInputs(workspaceId, contacts, qualification.rows, qualification.icpCriteria));
  const qualificationIsStale = Boolean(qualification?.stale || input.qualificationStale || listChanged);

  const rows = contacts.map((contact): ImportReadinessRow => {
    const row: ImportReadinessRow = { sourceRowId: contact.contactId, company: contact.associatedCompany?.name || contact.company || '',
      email: contact.normalizedEmail || contact.rawEmail || '', status: 'needs_review', reasons: [] };
    const add = (code: string, message: string) => row.reasons.push({ code, message });
    if (isSuppressed(contact)) {
      row.status = 'excluded';
      for (const match of contact.suppressionMatches ?? []) add(`suppressed:${match.ruleId}`, `Suppressed by ${match.listName} (${match.type}: ${match.value}): ${match.reason}`);
      if (contact.importExclusion) add('import_excluded', `Excluded from import: ${contact.importExclusion.reason}`);
      return row;
    }
    if (contact.importExclusion) {
      row.status = 'excluded';
      add('import_excluded', `Excluded from import: ${contact.importExclusion.reason}`);
      return row;
    }
    if (contact.recordStatus === 'merged') {
      row.status = 'excluded';
      add('record_merged', 'This row has been merged and is excluded from import.');
      return row;
    }
    if ((contact.importObject ?? 'contact') !== 'contact') {
      add('local_object_review_only', 'Company and associated-company imports support local review and export only. CRM import is unavailable.');
      return row;
    }

    if (input.suppressionState === 'loading') add('suppressions_loading', 'Saved suppression rules are still loading.');
    else if (input.suppressionState === 'error') add('suppressions_load_error', 'Saved suppression rules could not be loaded.');
    if (!workspaceId) add('workspace_not_saved', 'Save this list before assessing import readiness.');
    if (input.unsaved) add('unsaved_changes', 'Save the current changes before assessing import readiness.');
    if (!contact.contactId || (contactIds.get(contact.contactId) ?? 0) !== 1) {
      add('duplicate_row_id', 'This row needs a unique row ID before its results can be matched.');
    }
    if (!row.company.trim()) add('missing_company', 'The company field is empty.');
    if (!row.email.trim()) add('missing_email', 'The email field is empty.');
    for (const flag of new Set(destinationHoldFlags(contact))) {
      if (!row.reasons.some((reason) => reason.code === flag)) add(flag, holdMessages[flag]);
    }

    const website = normalizeWebsiteUrl(contact.website ?? '');
    if (!contact.website?.trim()) add('missing_website', 'The company website is empty.');
    else if (!website) add('invalid_website', 'The company website is not a valid HTTP or HTTPS address.');
    if (input.websiteState === 'loading') add('website_loading', 'Website results are still loading.');
    else if (input.websiteState === 'error') add('website_load_error', 'Website results could not be loaded.');
    else if (website) {
      const result = websites.get(website);
      if (!result) add('website_not_checked', 'The current company website has not been checked.');
      else if (result.status !== 'reachable') {
        const messages: Record<Exclude<WebsiteCheckResult['status'], 'reachable'>, string> = {
          blocked: 'The company website blocked the availability check.',
          timed_out: 'The company website availability check timed out.',
          failed: 'The company website did not load successfully.',
          needs_review: 'The company website availability check needs review.',
          invalid: 'The company website was rejected by the availability check.',
        };
        add(`website_${result.status}`, withDetail(messages[result.status], result.detail));
      }
    }

    if (input.qualificationState === 'loading') add('qualification_loading', 'Pomade results are still loading.');
    else if (input.qualificationState === 'error') add('qualification_load_error', 'Pomade results could not be loaded.');
    else if (!qualification) add('qualification_not_checked', 'Company identity, ICP fit and email verification have not been checked with Pomade.');
    else if (!qualification.icpCriteria.trim()) add('icp_not_defined', 'Define the ICP before assessing qualification results.');
    else if (qualificationIsStale) add('qualification_stale', 'The list, company, website, email or ICP changed. Update the Pomade checks for the current inputs.');
    else {
      const result = qualificationRows.get(contact.contactId);
      if (!result || qualificationIds.get(contact.contactId) !== 1) {
        add('qualification_missing_row', 'Pomade results cannot be matched to this row.');
      } else {
        for (const kind of ['identity', 'icp', 'email'] as const) {
          const reason = qualificationReason(kind, result[kind]);
          if (reason) row.reasons.push(reason);
        }
      }
      const execution = qualification.execution;
      if (execution && execution.sourceRowIds.includes(contact.contactId) && execution.checks.length
        && execution.status !== 'completed') {
        const messages: Record<Exclude<typeof execution.status, 'completed'>, string> = {
          starting: 'The selected Pomade checks are starting.',
          unknown: 'The latest Pomade run status is unknown. Reconcile it before using earlier results.',
          queued: 'The selected Pomade checks are queued.',
          running: 'The selected Pomade checks are still running.',
          paused: 'The selected Pomade checks are paused.',
          failed: 'The latest selected Pomade run failed. Review it before using earlier results.',
          cancelled: 'The latest selected Pomade run was cancelled. Review it before using earlier results.',
          rejected: 'The latest selected Pomade run was rejected. Review it before using earlier results.',
        };
        add(`qualification_run_${execution.status}`, withDetail(messages[execution.status], execution.error ?? execution.job?.waitingMessage ?? ''));
      }
    }
    if (!row.reasons.length) {
      row.status = 'ready';
      add('checks_passed', 'Website reachable; company identity matches; ICP fit confirmed; email verified valid; no local import holds.');
    }
    return row;
  });
  return { rows, counts: {
    ready: rows.filter((row) => row.status === 'ready').length,
    needsReview: rows.filter((row) => row.status === 'needs_review').length,
    excluded: rows.filter((row) => row.status === 'excluded').length,
  } };
}

function qualificationReason(kind: QualificationCheckKind, check: QualificationCheck): ImportReadinessReason | null {
  const label = checkLabels[kind];
  const assessment = kind === 'email' ? check.assessment?.trim().toLowerCase() : check.assessment;
  if (check.state === 'complete' && assessment === expectedAssessments[kind]) return null;
  let message: string;
  if (check.state === 'not_run') message = `${label} has not been checked.`;
  else if (check.state === 'stale') message = `${label} results are stale.`;
  else if (check.state === 'error') message = `${label} check failed.`;
  else if (kind === 'identity' && assessment === 'Mismatch') message = 'Company identity does not match the intended company.';
  else if (kind === 'icp' && assessment === 'Not a fit') message = 'The company does not meet the selected ICP.';
  else message = `${label} needs review${check.assessment ? `: ${check.assessment}` : ''}.`;
  return { code: `${kind}_${check.state === 'complete' ? 'needs_review' : check.state}`, message: withDetail(message, check.explanation) };
}

function withDetail(message: string, detail: string): string {
  const bounded = detail.trim().replace(/\s+/gu, ' ').slice(0, 400);
  return bounded ? `${message} ${bounded}` : message;
}

function countsBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}
