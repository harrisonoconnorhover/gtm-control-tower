import { destinationHoldFlags, isDestinationReadyContact } from './csv-control-tower';
import type { LiveContactState } from './live-control-tower';
import type { DemoPipelineResult } from './messy-lead-demo';

export type DemoDecisionStatus = 'Ready' | 'Held' | 'Merged';
export type DemoFieldChange = {
  field: keyof LiveContactState;
  label: string;
  before: string | null;
  after: string | null;
  changed: boolean;
};
export type DemoDecision = {
  contactId: string;
  fullName: string;
  status: DemoDecisionStatus;
  lastAction: string;
  before: LiveContactState;
  after: LiveContactState;
  fields: DemoFieldChange[];
  inputNormalization: { rawEmail: string; normalizedEmail: string | null; changed: boolean };
  holdReasons: { flag: string; explanation: string }[];
  informationalFlags: string[];
  explanations: string[];
  canonicalContactId: string | null;
  mergedContactIds: string[];
};

const inspectedFields = [
  ['rawEmail', 'Original email'],
  ['normalizedEmail', 'Normalized email'],
  ['company', 'Company'],
  ['region', 'Region'],
  ['segment', 'Segment'],
  ['ownerId', 'Owner'],
  ['lifecycleStage', 'Lifecycle stage'],
  ['expectedLifecycleStage', 'Supplied expected stage'],
  ['recordStatus', 'Record state'],
  ['canonicalContactId', 'Canonical record'],
] as const;

const holdExplanations: Record<string, string> = {
  invalid_email: 'No valid normalized email is available. Supply a valid identity before destination use.',
  missing_company: 'Company is missing. Cleanup does not invent a company.',
  missing_owner: 'Owner is missing. No applicable example routing rule assigned one.',
  stage_regression: 'Lifecycle stage is behind the supplied expected stage.',
  duplicate_identity: 'The active record still has an unresolved duplicate identity.',
};

export function demoDecisionStatus(contact: LiveContactState): DemoDecisionStatus {
  if (contact.recordStatus === 'merged') return 'Merged';
  return isDestinationReadyContact(contact) ? 'Ready' : 'Held';
}

export function buildDemoDecisionReport(result: DemoPipelineResult, originalCsv: string) {
  const initialById = new Map(result.initialContacts.map((contact) => [contact.contactId, contact]));
  const mergedByCanonical = new Map<string, string[]>();
  for (const contact of result.repairedContacts) {
    if (contact.recordStatus === 'merged' && contact.canonicalContactId) {
      const ids = mergedByCanonical.get(contact.canonicalContactId) ?? [];
      ids.push(contact.contactId);
      mergedByCanonical.set(contact.canonicalContactId, ids);
    }
  }

  const decisions = result.repairedContacts.map<DemoDecision>((contact) => {
    const original = initialById.get(contact.contactId);
    if (!original) throw new Error(`Missing input snapshot for ${contact.contactId}.`);
    const before = { ...original, qualityFlags: [...original.qualityFlags] };
    const after = { ...contact, qualityFlags: [...contact.qualityFlags] };
    const status = demoDecisionStatus(after);
    const blockers = destinationHoldFlags(after);
    const fields = inspectedFields.map(([field, label]) => ({
      field, label, before: before[field], after: after[field], changed: before[field] !== after[field],
    }));
    const inputNormalization = {
      rawEmail: before.rawEmail,
      normalizedEmail: before.normalizedEmail,
      changed: before.normalizedEmail !== null && before.rawEmail !== before.normalizedEmail,
    };
    const mergedContactIds = mergedByCanonical.get(contact.contactId) ?? [];
    const explanations: string[] = [];

    if (!before.normalizedEmail) {
      explanations.push('Import could not produce a valid normalized email; the original text is retained.');
    } else if (inputNormalization.changed) {
      explanations.push('Import standardized email case and domain encoding before repair. The original email is retained separately.');
    } else {
      explanations.push('The supplied email already matched its normalized identity; import did not change it.');
    }
    if (status === 'Merged') {
      explanations.push(`Matched normalized email ${after.normalizedEmail} with ${after.canonicalContactId}. The example prefers an already lowercase raw spelling, then the lower contact ID. This row remains as merge evidence.`);
    } else if (mergedContactIds.length) {
      explanations.push(`Retained as the canonical record for ${mergedContactIds.join(', ')} using normalized-email matching, lowercase raw spelling preference and contact-ID tie-break. No source row is deleted.`);
    }
    if (before.ownerId !== after.ownerId) {
      explanations.push(`Example routing policy matched ${before.region} / ${before.segment} and changed owner from ${before.ownerId || 'blank'} to ${after.ownerId || 'blank'}. It does not measure rep capacity.`);
    }
    if (before.lifecycleStage !== after.lifecycleStage) {
      explanations.push(`Replayed lifecycle from ${before.lifecycleStage} to the supplied expected stage ${before.expectedLifecycleStage}. The CSV provides this expected state; it is not inferred from activity.`);
    }
    if (status === 'Ready') {
      explanations.push('The active record has no remaining destination-blocking flags. Ready is a local rule result, not a CRM write or factual verification.');
    } else if (status === 'Held') {
      explanations.push('The active record remains held despite any successful repairs. Every remaining destination-blocking flag is listed below.');
    }

    return {
      contactId: after.contactId,
      fullName: after.fullName,
      status,
      lastAction: after.lastAction,
      before,
      after,
      fields,
      inputNormalization,
      holdReasons: status === 'Held' ? blockers.map((flag) => ({ flag, explanation: holdExplanations[flag] ?? flag.replaceAll('_', ' ') })) : [],
      informationalFlags: after.qualityFlags.filter((flag) => !blockers.includes(flag)),
      explanations,
      canonicalContactId: after.canonicalContactId,
      mergedContactIds,
    };
  });

  return {
    format: 'gtm-control-tower-browser-decisions',
    version: 1,
    scope: {
      data: 'Bundled fictional 64-row CSV',
      execution: 'Browser only',
      crmWrites: 0,
      originalInputModified: false,
      readiness: 'Local rule checks; not factual verification or CRM acceptance',
    },
    originalCsv,
    summary: {
      inputRows: result.rawRows,
      activeRows: result.activeRows,
      readyRows: result.readyRows,
      heldRows: result.heldRows,
      mergedRows: result.mergedRows,
      reroutedRows: result.reroutedRows,
      replayedRows: result.replayedRows,
      normalizedInputs: decisions.filter((decision) => decision.inputNormalization.changed).length,
    },
    decisions,
  };
}

export type DemoDecisionReport = ReturnType<typeof buildDemoDecisionReport>;
