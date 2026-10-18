import { evaluateCrmCohort, parseCrmCohortDefinition, type CrmCohortContact, type CrmCohortDefinition } from './crm-cohort';
import { crmEvidenceSourceSupportsField, parseCrmEvidenceRequest, parseCrmEvidenceResult, type CrmEvidenceContact, type CrmEvidenceCoverage, type CrmEvidenceField, type CrmEvidenceRequest, type CrmEvidenceResult } from './crm-evidence-request';

export type CohortReview = {
  result: CrmEvidenceResult;
  checkedAt: string;
  current: CrmEvidenceContact[];
  decisions: Record<string, 'accepted' | 'rejected'>;
};
export type CrmCohortWorkspace = {
  mode: 'fictional' | 'hubspot';
  definition: CrmCohortDefinition;
  contacts: CrmCohortContact[];
  populationCoverage: CrmEvidenceCoverage;
  nextCursor: string | null;
  totalDeals: number | null;
  selectedContactIds: string[];
  request?: CrmEvidenceRequest;
  reviews: CohortReview[];
};
export type CohortReviewRow = {
  contactId: string;
  state: 'ready_for_review' | 'held' | 'excluded';
  reasons: string[];
  proposals: { field: CrmEvidenceField; value: string; decision: 'accepted' | 'rejected' | 'pending' }[];
};

export function cohortDecisionKey(contactId: string, field: CrmEvidenceField) { return `${contactId}:${field}`; }

/** Fresh assessments are authoritative for this review; proposals never mutate them or the CRM. */
export function reviewCohortResult(request: CrmEvidenceRequest, review: CohortReview): CohortReviewRow[] {
  return request.contacts.map((original) => {
    const current = review.current.find((row) => row.contactId === original.contactId);
    const returned = review.result.contacts.find((row) => row.contactId === original.contactId);
    if (!current || !returned) return { contactId: original.contactId, state: 'held', reasons: ['Contact is missing from the fresh comparison.'], proposals: [] };
    const reasons = [...current.assessments.reasons];
    let state = current.assessments.state;
    const proposals: CohortReviewRow['proposals'] = [];
    for (const field of returned.fields) {
      const before = original.existingValues[field.field];
      const now = current.existingValues[field.field];
      if (now !== before) {
        reasons.push(`${field.field}: CRM value changed since the request; the current value is preserved. Prepare a new request.`);
        if (state !== 'excluded') state = 'held';
        continue;
      }
      if (field.status !== 'supported' || !field.value) {
        reasons.push(`${field.field}: ${field.status.replaceAll('_', ' ')}. ${field.rationale}`);
        if (state !== 'excluded') state = 'held';
        continue;
      }
      if (field.evidence.some((citation) => {
        const source = current.evidence.find((item) => item.id === citation.sourceId);
        return !source || !crmEvidenceSourceSupportsField(field.field, source, current) || !source.text.includes(citation.quote);
      })) {
        reasons.push(`${field.field}: supporting CRM evidence changed or is unavailable. Prepare a new request.`);
        if (state !== 'excluded') state = 'held';
        continue;
      }
      const decision = review.decisions[cohortDecisionKey(original.contactId, field.field)] ?? 'pending';
      proposals.push({ field: field.field, value: field.value, decision });
      if (decision !== 'accepted') {
        reasons.push(`${field.field}: ${decision === 'rejected' ? 'proposal rejected' : 'source interpretation needs review'}.`);
        if (state !== 'excluded') state = 'held';
      }
    }
    return { contactId: original.contactId, state, reasons: [...new Set(reasons)], proposals };
  });
}

const MORE_DEALS_MESSAGE = 'More matching deals are available; continue reading pages before claiming a complete population.';

/** Keep durable omissions across pages while clearing the previous page's cursor warning. */
export function mergeCohortPopulationCoverage(previous: CrmEvidenceCoverage | undefined, incoming: CrmEvidenceCoverage, nextCursor: string | null): CrmEvidenceCoverage {
  const missing = [...new Set([...(previous?.missing ?? []), ...incoming.missing].filter((reason) => reason !== MORE_DEALS_MESSAGE))];
  if (nextCursor !== null) missing.push(MORE_DEALS_MESSAGE);
  const omittedSourceIds = [...new Set([...(previous?.omittedSourceIds ?? []), ...incoming.omittedSourceIds])];
  return { complete: missing.length === 0 && omittedSourceIds.length === 0 && nextCursor === null, missing, omittedSourceIds };
}

export function mergeCohortContacts(previous: CrmCohortContact[], incoming: CrmCohortContact[]): CrmCohortContact[] {
  const result = new Map(previous.map((contact) => [contact.contactId, contact]));
  for (const contact of incoming) {
    const old = result.get(contact.contactId);
    result.set(contact.contactId, old ? {
      ...contact,
      dealIds: [...new Set([...old.dealIds, ...contact.dealIds])],
      companyIds: [...new Set([...old.companyIds, ...contact.companyIds])],
      deals: [...new Map([...old.deals, ...contact.deals].map((deal) => [deal.dealId, deal])).values()],
      evidence: [...new Map([...old.evidence, ...contact.evidence].map((item) => [item.id, item])).values()],
      coverage: { complete: old.coverage.complete && contact.coverage.complete,
        missing: [...new Set([...old.coverage.missing, ...contact.coverage.missing,
          ...(JSON.stringify(old.properties) !== JSON.stringify(contact.properties) || JSON.stringify(old.existingValues) !== JSON.stringify(contact.existingValues)
            ? ['Repeated native contact snapshots disagree; refresh the contact.'] : [])])],
        omittedSourceIds: [...new Set([...old.coverage.omittedSourceIds, ...contact.coverage.omittedSourceIds])] },
    } : contact);
  }
  if (result.size > 1_000) throw new Error('This review contains 1,000 contacts. Narrow the deal date range before reading more.');
  return [...result.values()];
}

/** Workspace persistence owns byte limits. File parsers own external request/result validation. */
export function validateCrmCohortWorkspace(value: unknown): CrmCohortWorkspace {
  if (!value || typeof value !== 'object') throw new Error('CRM cohort workspace is invalid.');
  const item = value as CrmCohortWorkspace;
  if (!['fictional', 'hubspot'].includes(item.mode) || !Array.isArray(item.contacts) || item.contacts.length > 1_000
    || !Array.isArray(item.selectedContactIds) || item.selectedContactIds.length > 100
    || !Array.isArray(item.reviews) || item.reviews.length > 10
    || !validCoverage(item.populationCoverage)
    || !(item.nextCursor === null || typeof item.nextCursor === 'string')
    || !(item.totalDeals === null || (Number.isInteger(item.totalDeals) && item.totalDeals >= 0))) throw new Error('CRM cohort workspace is invalid.');
  if (item.populationCoverage.complete && item.nextCursor !== null) throw new Error('Population coverage cannot be complete while more pages remain.');
  parseCrmCohortDefinition(item.definition);
  const ids = new Set(item.contacts.map((contact) => contact.contactId));
  if (ids.size !== item.contacts.length || item.selectedContactIds.some((id) => !ids.has(id))
    || new Set(item.selectedContactIds).size !== item.selectedContactIds.length) throw new Error('CRM cohort identities or selection are invalid.');
  return item;
}

export async function validateSavedCrmCohort(value: CrmCohortWorkspace): Promise<void> {
  const item = validateCrmCohortWorkspace(value);
  if (!item.request) {
    if (item.reviews.length) throw new Error('CRM results require a saved request.');
    return;
  }
  const request = await parseCrmEvidenceRequest(item.request);
  if (request.portalId !== item.definition.portalId || JSON.stringify(request.definition) !== JSON.stringify(item.definition)) throw new Error('The saved request belongs to another CRM definition.');
  for (const review of item.reviews) {
    await parseCrmEvidenceResult(review.result, request);
    if (!Array.isArray(review.current) || !Number.isFinite(Date.parse(review.checkedAt)) || !review.decisions || typeof review.decisions !== 'object') throw new Error('CRM result review is invalid.');
    const allowed = new Set(request.contacts.flatMap((contact) => contact.requestedFields.map((field) => cohortDecisionKey(contact.contactId, field))));
    if (Object.entries(review.decisions).some(([key, decision]) => !allowed.has(key) || !['accepted', 'rejected'].includes(decision))) throw new Error('CRM review decisions are invalid.');
  }
}

export function exportCohortReport(value: CrmCohortWorkspace) {
  const review = value.reviews.at(-1);
  const unselectedContacts = evaluateCrmCohort(value.definition, value.contacts).contacts.filter((contact) => !value.selectedContactIds.includes(contact.contactId));
  return { kind: 'crm-cohort-review', schemaVersion: 1, exportedAt: new Date().toISOString(),
    mode: value.mode, approvalToSend: false, crmWrites: false, definition: value.definition, populationCoverage: value.populationCoverage,
    request: value.request ?? null, review: review ?? null,
    rows: review && value.request ? reviewCohortResult(value.request, review) : [],
    unselectedContacts, unselectedContactIds: unselectedContacts.map((contact) => contact.contactId) };
}

function validCoverage(value: unknown): value is CrmEvidenceCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const coverage = value as CrmEvidenceCoverage;
  return typeof coverage.complete === 'boolean' && Array.isArray(coverage.missing) && Array.isArray(coverage.omittedSourceIds)
    && [...coverage.missing, ...coverage.omittedSourceIds].every((entry) => typeof entry === 'string' && entry.trim().length > 0)
    && (!coverage.complete || (coverage.missing.length === 0 && coverage.omittedSourceIds.length === 0));
}
