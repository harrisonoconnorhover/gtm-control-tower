import type { CsvColumnMapping } from './csv-control-tower';
import { type CrmUpdatePolicy } from './crm-workflow';
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

/** Manual recipe selection remains available without an intent interpreter. */
export class NoModelImportAssistant implements ImportAssistant {
  async proposeIntent(input: ImportIntentInput): Promise<ImportIntentProposal> {
    void input;
    return { status: 'needs-decision', interpretation: 'Select the import recipe manually before preparing review.', suggestedMapping: {} };
  }
  async explainReview(input: ImportReviewEvidence): Promise<ImportExplanation> {
    return { text: SAFE_IMPORT_RULES, contactIds: [], reviewId: input.review.id };
  }
}
