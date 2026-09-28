import type { ConnectorRun } from './connector-run';
import {
  portableCrmFieldNames,
  type CrmPlanRecord,
  type CrmWritebackReceipt,
  type NativeCrmRecord,
  type PortableCrmFieldName,
} from './crm-workflow';

export type CrmVerificationValues = { email: string } & Record<PortableCrmFieldName, string | null>;
export type CrmRecordVerification = {
  contactId: string;
  nativeId: string | null;
  status: 'verified' | 'different' | 'unavailable';
  checkedAt: string;
  expected: CrmVerificationValues | null;
  actual: CrmVerificationValues | null;
  differences: { field: 'email' | PortableCrmFieldName; expected: string | null; actual: string | null }[];
  error: string | null;
};
export type CrmRunVerification = {
  runId: string;
  planId: string;
  connectorId: 'hubspot' | 'salesforce';
  checkedAt: string;
  verified: number;
  different: number;
  unavailable: number;
  records: CrmRecordVerification[];
};

type VerificationRun = Pick<ConnectorRun, 'id' | 'connectorId' | 'details'>;
type ReadRecord = (connectorId: 'hubspot' | 'salesforce', nativeId: string) => Promise<NativeCrmRecord | null>;
type WriteResult = CrmWritebackReceipt['records'][number];

/** Historical runs without both an approved plan and its write receipt cannot be compared. */
export function canVerifyCrmRun(run: VerificationRun): boolean {
  const plan = run.details?.plan;
  const receipt = run.details?.writeback;
  return (run.connectorId === 'hubspot' || run.connectorId === 'salesforce')
    && Boolean(plan && receipt && plan.connectorId === run.connectorId && receipt.connectorId === run.connectorId
      && typeof plan.planId === 'string' && plan.planId && plan.planId === receipt.planId
      && receipt.runId === run.id && receipt.accepted === true
      && Array.isArray(plan.records) && plan.records.length <= 100
      && Array.isArray(receipt.records) && receipt.records.length <= 100
      && receipt.records.some(isSuccessfulWrite));
}

/** Read only. A failed check never changes the saved write outcome or retries a write. */
export async function verifyCrmRun(run: VerificationRun, readRecord: ReadRecord): Promise<CrmRunVerification> {
  if (!canVerifyCrmRun(run)) throw new Error('This run has no matching saved plan and successful CRM write receipt to verify.');
  const plan = run.details!.plan!;
  const receipt = run.details!.writeback!;
  const connectorId = plan.connectorId;
  const outcomes = receipt.records.filter(isSuccessfulWrite);
  const records = new Array<CrmRecordVerification>(outcomes.length);
  let nextIndex = 0;
  // Native readers have their own request timeout. Keep pressure on either CRM bounded.
  await Promise.all(Array.from({ length: Math.min(4, outcomes.length) }, async () => {
    while (nextIndex < outcomes.length) {
      const index = nextIndex++;
      const outcome = outcomes[index];
      const result: CrmRecordVerification = {
        contactId: outcome.contactId, nativeId: outcome.nativeId, status: 'unavailable',
        checkedAt: new Date().toISOString(), expected: null, actual: null, differences: [], error: null,
      };
      try {
        const plannedRows = plan.records.filter((row) => row?.contactId === outcome.contactId);
        if (plannedRows.length !== 1 || receipt.records.filter((row) => row?.contactId === outcome.contactId).length !== 1
          || outcomes.filter((row) => row.nativeId === outcome.nativeId).length !== 1) {
          throw new Error('The saved plan and receipt do not identify one unique import row and CRM record.');
        }
        const planned = plannedRows[0];
        result.expected = expectedValues(planned, outcome, connectorId);
        const current = await readRecord(connectorId, outcome.nativeId!);
        if (!current) throw new Error('The CRM record is missing, archived, or no longer accessible.');
        if (current.nativeId !== outcome.nativeId || current.objectType !== (connectorId === 'hubspot' ? 'contact' : 'lead')) {
          throw new Error('The CRM returned a different record ID or unsupported record type.');
        }
        if (connectorId === 'salesforce' && current.isConverted !== false) {
          throw new Error('This Salesforce Lead is converted or its conversion status could not be verified.');
        }
        result.actual = values(current.email, current.fields);
        result.differences = (['email', ...portableCrmFieldNames] as const).flatMap((field) => result.expected![field] === result.actual![field]
          ? [] : [{ field, expected: result.expected![field], actual: result.actual![field] }]);
        result.status = result.differences.length ? 'different' : 'verified';
      } catch (error) {
        result.error = error instanceof Error ? error.message : 'The CRM record could not be read.';
      }
      result.checkedAt = new Date().toISOString();
      records[index] = result;
    }
  }));
  return {
    runId: run.id, planId: plan.planId, connectorId, checkedAt: new Date().toISOString(), records,
    verified: records.filter((row) => row.status === 'verified').length,
    different: records.filter((row) => row.status === 'different').length,
    unavailable: records.filter((row) => row.status === 'unavailable').length,
  };
}

function isSuccessfulWrite(row: WriteResult): boolean {
  return Boolean(row && (row.status === 'created' || row.status === 'updated'));
}

function expectedValues(planned: CrmPlanRecord, outcome: WriteResult, connectorId: 'hubspot' | 'salesforce'): CrmVerificationValues {
  const validId = connectorId === 'hubspot' ? /^\d+$/ : /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/;
  if (typeof outcome.nativeId !== 'string' || !validId.test(outcome.nativeId)
    || typeof outcome.contactId !== 'string' || !outcome.contactId
    || normalizedEmail(planned.email) !== normalizedEmail(outcome.email)
    || !Array.isArray(planned.matches)) {
    throw new Error('The saved plan and receipt disagree about this row or have no usable CRM record ID.');
  }
  if (outcome.status === 'created') {
    if (planned.operation !== 'create' || planned.nativeId !== null || planned.matches.length || planned.matchDecision) {
      throw new Error('The successful create receipt does not match the saved create plan.');
    }
    return values(planned.email, planned.after);
  }
  if (planned.operation !== 'update' || planned.nativeId !== outcome.nativeId || planned.matches.length !== 1) {
    throw new Error('The successful update receipt does not match the saved update target.');
  }
  const target = planned.matches[0];
  if (target.nativeId !== outcome.nativeId || target.objectType !== (connectorId === 'hubspot' ? 'contact' : 'lead')
    || (connectorId === 'salesforce' && target.isConverted !== false)) {
    throw new Error('The saved update plan has no supported target identity.');
  }
  if (planned.matchDecision && (planned.matchDecision.nativeId !== outcome.nativeId
    || normalizedEmail(planned.matchDecision.email) !== normalizedEmail(target.email))) {
    throw new Error('The confirmed CRM identity does not match the saved update target.');
  }
  // Exact-email matches can refer to a HubSpot alias, so keep the target's primary email.
  return values(planned.matchDecision?.email ?? target.email, planned.after);
}

function values(email: string, fields: Record<PortableCrmFieldName, string | null>): CrmVerificationValues {
  if (!fields || typeof fields !== 'object' || portableCrmFieldNames.some((field) => fields[field] !== null && typeof fields[field] !== 'string')) {
    throw new Error('The saved or current CRM record is missing comparable field values.');
  }
  return {
    email: normalizedEmail(email),
    ...Object.fromEntries(portableCrmFieldNames.map((field) => [field, fields[field]?.trim() || null])) as Record<PortableCrmFieldName, string | null>,
  };
}

function normalizedEmail(value: string): string {
  if (typeof value !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value.trim())) {
    throw new Error('The saved or current CRM record has no comparable primary email.');
  }
  return value.trim().toLowerCase();
}
