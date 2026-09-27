import { portableCrmFieldNames, type CrmCreateReviewResult, type CrmWritePlan, type PortableCrmContact } from './crm-workflow';
import type { DuplicateScanView } from './duplicate-scan-store';
import { toHubSpotSyncContact } from './hubspot-sync';
import type { IdentityRecord } from './identity-resolution';
import { compareImportedContacts, IMPORT_MATCH_RULE_VERSION, type ImportMatchInput, type MatchField } from './import-match';
import type { LiveContactState } from './live-control-tower';
import { toSalesforceSyncLead } from './salesforce-sync';
import type { SavedWorkspace } from './workspace';

export const CREATE_REVIEW_MAX_AGE_MS = 15 * 60_000;
const reviewFields: MatchField[] = ['name', 'email', 'phone', 'state', 'company'];

export function reviewImportCreates(
  connectorId: CrmWritePlan['connectorId'],
  proposed: PortableCrmContact[],
  workspace: SavedWorkspace | null,
  scan: DuplicateScanView | null,
  records: IdentityRecord[] | null,
  now = new Date(),
): Map<string, CrmCreateReviewResult> {
  const reviews = new Map<string, CrmCreateReviewResult>();
  const result = (reason: string, status: 'clear' | 'held' = 'held'): CrmCreateReviewResult => ({
    reason, possibleMatches: [],
    review: {
      status, scanId: scan?.id ?? null, startedAt: scan?.startedAt ?? null,
      ruleVersion: IMPORT_MATCH_RULE_VERSION, candidateCount: 0, warnings: [],
    },
  });
  const holdAll = (reason: string) => {
    for (const contact of proposed) reviews.set(contact.contactId, result(reason));
    return reviews;
  };
  if (!workspace) return holdAll('Save this import workspace before creating CRM records so its identity fields can be checked for possible duplicates.');
  const coverageIssue = snapshotCoverageIssue(workspace.id, connectorId, scan, now);
  if (coverageIssue) return holdAll(coverageIssue);
  if (!records || records.length !== scan!.recordsScanned || records.length > 25_000
    || records.some((record) => record.connectorId !== connectorId)) {
    return holdAll('The CRM snapshot records could not be verified. Read a fresh complete snapshot before creating records.');
  }

  const savedById = new Map<string, LiveContactState[]>();
  for (const saved of workspace.state.contacts) {
    if (!saved || typeof saved.contactId !== 'string') continue;
    const existing = savedById.get(saved.contactId) ?? [];
    existing.push(saved);
    savedById.set(saved.contactId, existing);
  }
  const inputs: ImportMatchInput[] = [];
  for (const contact of proposed) {
    const saved = savedById.get(contact.contactId) ?? [];
    const input = saved.length === 1 ? matchingInput(connectorId, contact, saved[0]) : null;
    if (!input) {
      reviews.set(contact.contactId, result('This row does not match a usable saved import identity. Save the current workspace and refresh the preview before creating it.'));
    } else inputs.push(input);
  }
  if (!inputs.length) return reviews;
  const report = compareImportedContacts(inputs, records, reviewFields);
  for (const row of report.rows) {
    // These are the matcher's two search-limit warnings. Missing CRM fields,
    // state normalization, and shared-phone notes are informative, not caps.
    const incomplete = row.warnings.some((warning) => warning.includes('This result is incomplete.')
      || warning.startsWith('Candidate comparison was capped at '));
    const hasCandidates = row.candidateCount > 0;
    const reviewed = result(hasCandidates
      ? `${row.candidateCount} possible existing CRM ${row.candidateCount === 1 ? 'record needs' : 'records need'} review. Do not create this row until the identity is resolved; the match score is not a probability.`
      : incomplete
        ? 'The possible-duplicate search reached a limit. Resolve this row manually before creating it; no suggestion does not establish that it is new.'
        : 'No exact email match or possible-duplicate candidate was found in the recent complete snapshot. This does not guarantee the person is new.',
    hasCandidates || incomplete ? 'held' : 'clear');
    reviewed.review.candidateCount = row.candidateCount;
    reviewed.review.warnings = row.warnings;
    reviewed.possibleMatches = row.candidates.map(({ record, score, evidence }) => ({
      nativeId: record.nativeId, objectType: record.objectType, email: record.email,
      fullName: record.fullName || `${record.firstName} ${record.lastName}`.trim(), score, evidence,
    }));
    reviews.set(row.contactId, reviewed);
  }
  return reviews;
}

export function snapshotCoverageIssue(
  workspaceId: string,
  connectorId: CrmWritePlan['connectorId'],
  scan: DuplicateScanView | null,
  now = new Date(),
): string | null {
  if (!scan || scan.workspaceId !== workspaceId || scan.connectorId !== connectorId) {
    return 'Read a complete CRM snapshot for this workspace before creating records. Possible duplicates have not been checked.';
  }
  if (!scan.complete || !scan.sourceComplete) {
    return 'The CRM snapshot does not cover the complete source. Finish a complete snapshot or resolve this row manually before creating it.';
  }
  const startedAt = Date.parse(scan.startedAt);
  if (!Number.isFinite(startedAt) || startedAt > now.getTime() || now.getTime() - startedAt > CREATE_REVIEW_MAX_AGE_MS) {
    return 'The CRM snapshot is older than 15 minutes or has an invalid timestamp. Read a fresh complete snapshot before creating records.';
  }
  return null;
}

function matchingInput(connectorId: CrmWritePlan['connectorId'], proposed: PortableCrmContact, saved: LiveContactState): ImportMatchInput | null {
  if (typeof saved.fullName !== 'string' || saved.fullName.length > 512
    || typeof saved.rawEmail !== 'string' || typeof saved.normalizedEmail !== 'string'
    || !Array.isArray(saved.qualityFlags) || saved.qualityFlags.some((flag) => typeof flag !== 'string')
    || ['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website', 'state'].some((field) => {
      const value = saved[field as keyof LiveContactState];
      return value !== undefined && value !== null && typeof value !== 'string';
    }) || (saved.state?.length ?? 0) > 100) return null;
  try {
    const portable = connectorId === 'hubspot' ? toHubSpotSyncContact(saved) : toSalesforceSyncLead(saved);
    const fields = ['contactId', 'email', ...portableCrmFieldNames] as const;
    if (fields.some((field) => (portable[field]?.trim() || null) !== (proposed[field]?.trim() || null))) return null;
  } catch {
    return null;
  }
  // The provider mappers prefer mapped first/last names over fullName. Review
  // that same identity when a source supplies inconsistent name columns.
  const writtenName = [proposed.firstName.trim(), proposed.lastName.trim()].filter(Boolean).join(' ');
  const placeholderName = saved.fullName.trim() === saved.contactId.trim() && writtenName === saved.contactId.trim();
  return {
    contactId: proposed.contactId,
    fullName: placeholderName ? '' : writtenName,
    email: proposed.email, phone: saved.phone || '', state: saved.state || '', company: saved.company || '',
  };
}
