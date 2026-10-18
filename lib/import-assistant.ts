import type { CsvColumnMapping } from './csv-control-tower';
import { defaultCrmUpdatePolicy, type CrmUpdatePolicy } from './crm-workflow';
import { SAFE_IMPORT_RECIPE, SAFE_IMPORT_RULES, type SafeImportReview } from './safe-import';

export type ImportIntentInput = { request: string; headers?: string[] };
export type ImportIntentProposal = {
  status: 'supported' | 'needs-decision';
  interpretation: string;
  question?: string;
  settings?: { recipe: typeof SAFE_IMPORT_RECIPE; recordMode: 'update-existing'; updatePolicy: CrmUpdatePolicy };
  suggestedMapping: CsvColumnMapping;
};
export type ImportReviewEvidence = { review: SafeImportReview; question: string };
export type ImportExplanation = { text: string; contactIds: string[]; reviewId: string };

/** Adapters suggest settings and explain saved evidence. Neither method has write authority. */
export interface ImportAssistant {
  proposeIntent(input: ImportIntentInput): Promise<ImportIntentProposal>;
  explainReview(input: ImportReviewEvidence): Promise<ImportExplanation>;
}

const headerAliases: Partial<Record<keyof CsvColumnMapping, string[]>> = {
  rawEmail: ['email', 'email address', 'e-mail'], fullName: ['full name', 'name'],
  firstName: ['first name', 'firstname'], lastName: ['last name', 'lastname'],
  company: ['company', 'company name', 'organization'], phone: ['phone', 'phone number', 'telephone'],
  jobTitle: ['job title', 'title'], website: ['website', 'company website'],
};

/** Works offline. File cells are never parsed as instructions or fabricated values. */
export class NoModelImportAssistant implements ImportAssistant {
  async proposeIntent({ request, headers = [] }: ImportIntentInput): Promise<ImportIntentProposal> {
    const normalized = request.toLowerCase().replace(/[’]/g, "'");
    const suggestedMapping: CsvColumnMapping = {};
    for (const [field, aliases] of Object.entries(headerAliases)) {
      const matches = headers.filter((header) => (aliases ?? []).includes(header.toLowerCase().trim().replaceAll('_', ' ')));
      if (matches.length === 1) suggestedMapping[field as keyof CsvColumnMapping] = matches[0];
    }
    // Negative clauses describe protections, rather than a request to perform those operations.
    const boundedNegations = normalized.replace(/\b(?:do not|don't|never)\s+(?:create|merge|delete|replace|overwrite|erase)(?:\s*(?:,|and|or)\s*(?:or\s+)?(?:create|merge|delete|replace|overwrite|erase))*/g, '');
    const positiveClauses = boundedNegations.split(/[.!;,\n]|\b(?:but|and)\b/).filter((clause) => !/\b(without|do not|don't|never|no)\b/.test(clause)).join(' ');
    if (/\b(outdated|better|latest|most recent)\b/.test(normalized)
      || /\b(replace|overwrite|create|merge|delete|erase)\b/.test(positiveClauses)) {
      return { status: 'needs-decision', interpretation: 'This request needs a field or operation policy decision.',
        question: 'Use Safe Import to fill empty fields and preserve populated CRM values?', suggestedMapping };
    }
    if (!/\bupdate\b/.test(normalized) || (!/\bexisting\b/.test(normalized) && !normalized.includes('safe import'))) {
      return { status: 'needs-decision', interpretation: 'Choose the supported import rules before preparing a review.',
        question: 'Update existing CRM records only, filling empty supported fields?', suggestedMapping };
    }
    return { status: 'supported', interpretation: SAFE_IMPORT_RULES, suggestedMapping,
      settings: { recipe: SAFE_IMPORT_RECIPE, recordMode: 'update-existing', updatePolicy: defaultCrmUpdatePolicy() } };
  }

  async explainReview({ review, question }: ImportReviewEvidence): Promise<ImportExplanation> {
    const normalized = question.toLowerCase();
    let contactIds: string[] = [];
    let text: string;
    if (/title/.test(normalized)) {
      const rows = review.rows.filter((row) => row.record?.fieldDecisions?.some((decision) => decision.field === 'jobTitle'
        && decision.importedValue !== null && decision.importedValue !== decision.currentValue));
      contactIds = rows.map((row) => row.contactId);
      text = `${rows.length} rows have incoming titles that differ from the CRM value. Populated CRM titles are preserved; inspect the field decisions for each row.`;
    } else if (/held|hold|unresolved|match|identity/.test(normalized)) {
      const rows = review.rows.filter((row) => ['held', 'unmatched', 'unresolved'].includes(row.status));
      contactIds = rows.map((row) => row.contactId);
      const reasons = [...new Set(rows.map((row) => row.reason).filter(Boolean))];
      text = rows.length ? `${rows.length} rows have no scheduled update. ${reasons.join(' ')}` : 'No rows are held or unresolved in this saved review.';
    } else {
      text = `${SAFE_IMPORT_RULES} Primary email, ownership, lifecycle stage, consent, subscription status, and external identifiers are outside the writable fields.${review.connectorId === 'salesforce' ? ' Salesforce Contact company and website are Account fields and are also outside this recipe.' : ''} This review accounts for ${review.rows.length} source rows.`;
    }
    return { text, contactIds, reviewId: review.id };
  }
}
