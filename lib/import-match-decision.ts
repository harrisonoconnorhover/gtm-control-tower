import { portableCrmFieldNames, type NativeCrmRecord } from './crm-workflow';
import type { LiveContactState } from './live-control-tower';

export type ConfirmedImportMatch = {
  connectorId: 'hubspot' | 'salesforce';
  scanId: string;
  sourceKey: string;
  target: NativeCrmRecord;
  reason: string;
  confirmedAt: string;
  signature: string;
};

// Source edits must never silently reuse an earlier identity decision. Ignore
// operational metadata (skip, timestamps, decisions) that does not change data.
export function importMatchSourceKey(contact: LiveContactState): string {
  return JSON.stringify([contact.contactId, contact.fullName, contact.firstName, contact.lastName,
    contact.rawEmail, contact.normalizedEmail, contact.company, contact.phone, contact.state,
    contact.jobTitle, contact.website].map((value) => value?.trim() || null));
}

export function nativeMatchTargetKey(record: NativeCrmRecord): string {
  return JSON.stringify([record.nativeId, record.objectType, record.email.trim().toLowerCase(),
    Boolean(record.isConverted), ...portableCrmFieldNames.map((field) => record.fields[field]?.trim() || null)]);
}

export function isConfirmedImportMatch(value: unknown): value is ConfirmedImportMatch {
  if (!isRecord(value) || !isRecord(value.target) || !isRecord(value.target.fields)) return false;
  const target = value.target;
  const fields = value.target.fields;
  return (value.connectorId === 'hubspot' || value.connectorId === 'salesforce')
    && typeof value.scanId === 'string' && value.scanId.length > 0 && value.scanId.length <= 120
    && typeof value.sourceKey === 'string' && value.sourceKey.length > 0 && value.sourceKey.length <= 8_000
    && typeof value.reason === 'string' && value.reason === value.reason.trim() && value.reason.length > 0 && value.reason.length <= 500
    && typeof value.confirmedAt === 'string' && Number.isFinite(Date.parse(value.confirmedAt))
    && new Date(value.confirmedAt).toISOString() === value.confirmedAt
    && typeof value.signature === 'string' && /^[a-f0-9]{64}$/.test(value.signature)
    && typeof target.nativeId === 'string' && (value.connectorId === 'hubspot' ? /^\d+$/.test(target.nativeId) : /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/.test(target.nativeId))
    && target.objectType === (value.connectorId === 'hubspot' ? 'contact' : 'lead')
    && (value.connectorId !== 'salesforce' || target.isConverted === false)
    && typeof target.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target.email)
    && portableCrmFieldNames.every((field) => fields[field] === null || typeof fields[field] === 'string');
}

export function validImportMatchDecisions(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.entries(value).every(([key, decision]) =>
    (key === 'hubspot' || key === 'salesforce') && isConfirmedImportMatch(decision) && decision.connectorId === key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
