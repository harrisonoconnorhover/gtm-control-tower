import type { LiveContactState } from './live-control-tower';

export type SalesforceSyncLead = {
  contactId: string;
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  phone: string | null;
  jobTitle: string | null;
  website: string | null;
};

export type SalesforceSyncBatch = {
  syncId: string;
  sourceFile: string;
  leads: SalesforceSyncLead[];
};

export type SalesforceSyncRecord = {
  contactId: string;
  email: string;
  status: 'created' | 'updated' | 'failed';
  salesforceId: string | null;
  error: string | null;
};

export type SalesforceSyncReceipt = {
  accepted: true;
  status: 'complete' | 'partial';
  syncId: string;
  requested: number;
  created: number;
  updated: number;
  failed: number;
  records: SalesforceSyncRecord[];
  completedAt: string;
};

const blockingFlags = new Set([
  'duplicate_identity',
  'invalid_email',
  'stage_regression',
]);

export function isSalesforceEligible(contact: LiveContactState): boolean {
  const name = splitFullName(contact.fullName);
  const lastName = contact.lastName?.trim() || name.lastName;
  return contact.recordStatus === 'active'
    && Boolean(contact.normalizedEmail)
    && (contact.normalizedEmail?.length ?? 0) <= 80
    && Boolean(contact.company?.trim())
    && Boolean(lastName)
    && !contact.qualityFlags.some((flag) => blockingFlags.has(flag));
}

export function toSalesforceSyncLead(contact: LiveContactState): SalesforceSyncLead {
  if (!isSalesforceEligible(contact) || !contact.normalizedEmail || !contact.company) {
    throw new Error(`Contact ${contact.contactId} is not eligible for Salesforce sync.`);
  }
  const splitName = splitFullName(contact.fullName);
  return {
    contactId: bounded(contact.contactId, 120),
    email: bounded(contact.normalizedEmail.toLowerCase(), 80),
    firstName: bounded(contact.firstName || splitName.firstName, 40),
    lastName: bounded(contact.lastName || splitName.lastName, 80),
    company: bounded(contact.company, 255),
    phone: nullableBounded(contact.phone, 40),
    jobTitle: nullableBounded(contact.jobTitle, 128),
    website: nullableBounded(contact.website, 255),
  };
}

export function isSalesforceSyncBatch(value: unknown): value is SalesforceSyncBatch {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value.syncId, 1, 120) || !isBoundedString(value.sourceFile, 1, 255)) return false;
  if (!Array.isArray(value.leads) || value.leads.length < 1 || value.leads.length > 100) return false;
  if (!value.leads.every(isSalesforceSyncLead)) return false;
  const contactIds = new Set(value.leads.map((lead) => lead.contactId));
  const emails = new Set(value.leads.map((lead) => lead.email.toLowerCase()));
  return contactIds.size === value.leads.length && emails.size === value.leads.length;
}

export function isSalesforceSyncReceipt(value: unknown): value is SalesforceSyncReceipt {
  if (!isRecord(value) || value.accepted !== true) return false;
  if (value.status !== 'complete' && value.status !== 'partial') return false;
  if (!isBoundedString(value.syncId, 1, 120) || typeof value.completedAt !== 'string') return false;
  if (![value.requested, value.created, value.updated, value.failed].every(isFiniteNonNegativeNumber)) return false;
  if (!Array.isArray(value.records) || !value.records.every(isSalesforceSyncRecord)) return false;
  return value.requested === value.records.length
    && value.created + value.updated + value.failed === value.requested;
}

export function combineSalesforceSyncReceipts(
  receipts: SalesforceSyncReceipt[],
  syncId: string,
): SalesforceSyncReceipt {
  const recordByContact = new Map<string, SalesforceSyncRecord>();
  for (const receipt of receipts) {
    for (const record of receipt.records) recordByContact.set(record.contactId, record);
  }
  const records = [...recordByContact.values()];
  const created = records.filter((record) => record.status === 'created').length;
  const updated = records.filter((record) => record.status === 'updated').length;
  const failed = records.length - created - updated;
  return {
    accepted: true,
    status: failed ? 'partial' : 'complete',
    syncId,
    requested: records.length,
    created,
    updated,
    failed,
    records,
    completedAt: new Date().toISOString(),
  };
}

function isSalesforceSyncLead(value: unknown): value is SalesforceSyncLead {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value.contactId, 1, 120)) return false;
  if (!isBoundedString(value.email, 3, 80) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value.email)) return false;
  if (!isBoundedString(value.firstName, 0, 40) || !isBoundedString(value.lastName, 1, 80)) return false;
  return isBoundedString(value.company, 1, 255)
    && isNullableBoundedString(value.phone, 40)
    && isNullableBoundedString(value.jobTitle, 128)
    && isNullableBoundedString(value.website, 255);
}

function isSalesforceSyncRecord(value: unknown): value is SalesforceSyncRecord {
  return isRecord(value)
    && isBoundedString(value.contactId, 1, 120)
    && isBoundedString(value.email, 3, 80)
    && (value.status === 'created' || value.status === 'updated' || value.status === 'failed')
    && isNullableBoundedString(value.salesforceId, 120)
    && isNullableBoundedString(value.error, 1000);
}

function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: '', lastName: parts[0] ?? '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) ?? '' };
}

function bounded(value: string, maximum: number): string {
  return value.trim().slice(0, maximum);
}

function nullableBounded(value: string | null | undefined, maximum: number): string | null {
  const normalized = value?.trim().slice(0, maximum) ?? '';
  return normalized || null;
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function isNullableBoundedString(value: unknown, maximum: number): value is string | null {
  return value === null || isBoundedString(value, 0, maximum);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
