import type { LiveContactState } from './live-control-tower';

export type HubSpotSyncContact = {
  contactId: string;
  email: string;
  firstName: string;
  lastName: string;
  company: string | null;
  phone: string | null;
  jobTitle: string | null;
  website: string | null;
};

export type HubSpotSyncBatch = {
  syncId: string;
  sourceFile: string;
  contacts: HubSpotSyncContact[];
};

export type HubSpotSyncRecord = {
  contactId: string;
  email: string;
  status: 'synced' | 'failed';
  hubSpotId: string | null;
  created: boolean | null;
  error: string | null;
};

export type HubSpotSyncReceipt = {
  accepted: true;
  status: 'complete' | 'partial';
  syncId: string;
  requested: number;
  synced: number;
  failed: number;
  records: HubSpotSyncRecord[];
  completedAt: string;
};

const blockingFlags = new Set([
  'duplicate_identity',
  'invalid_email',
  'stage_regression',
]);

export function isHubSpotEligible(contact: LiveContactState): boolean {
  return contact.recordStatus === 'active'
    && Boolean(contact.normalizedEmail)
    && !contact.qualityFlags.some((flag) => blockingFlags.has(flag));
}

export function toHubSpotSyncContact(contact: LiveContactState): HubSpotSyncContact {
  if (!isHubSpotEligible(contact) || !contact.normalizedEmail) {
    throw new Error(`Contact ${contact.contactId} is not eligible for HubSpot sync.`);
  }
  const splitName = splitFullName(contact.fullName);
  return {
    contactId: bounded(contact.contactId, 120),
    email: bounded(contact.normalizedEmail.toLowerCase(), 254),
    firstName: bounded(contact.firstName || splitName.firstName, 255),
    lastName: bounded(contact.lastName || splitName.lastName, 255),
    company: nullableBounded(contact.company, 255),
    phone: nullableBounded(contact.phone, 50),
    jobTitle: nullableBounded(contact.jobTitle, 255),
    website: nullableBounded(contact.website, 500),
  };
}

export function isHubSpotSyncBatch(value: unknown): value is HubSpotSyncBatch {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value.syncId, 1, 120) || !isBoundedString(value.sourceFile, 1, 255)) return false;
  return Array.isArray(value.contacts)
    && value.contacts.length >= 1
    && value.contacts.length <= 100
    && value.contacts.every(isHubSpotSyncContact);
}

export function isHubSpotSyncReceipt(value: unknown): value is HubSpotSyncReceipt {
  if (!isRecord(value) || value.accepted !== true) return false;
  if (value.status !== 'complete' && value.status !== 'partial') return false;
  if (!isBoundedString(value.syncId, 1, 120) || typeof value.completedAt !== 'string') return false;
  if (![value.requested, value.synced, value.failed].every(isFiniteNonNegativeNumber)) return false;
  if (!Array.isArray(value.records) || !value.records.every(isHubSpotSyncRecord)) return false;
  return value.requested === value.records.length
    && value.synced + value.failed === value.requested;
}

export function combineHubSpotSyncReceipts(
  receipts: HubSpotSyncReceipt[],
  syncId: string,
): HubSpotSyncReceipt {
  const recordByContact = new Map<string, HubSpotSyncRecord>();
  for (const receipt of receipts) {
    for (const record of receipt.records) recordByContact.set(record.contactId, record);
  }
  const records = [...recordByContact.values()];
  const synced = records.filter((record) => record.status === 'synced').length;
  const failed = records.length - synced;
  return {
    accepted: true,
    status: failed ? 'partial' : 'complete',
    syncId,
    requested: records.length,
    synced,
    failed,
    records,
    completedAt: new Date().toISOString(),
  };
}

function isHubSpotSyncContact(value: unknown): value is HubSpotSyncContact {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value.contactId, 1, 120) || !isBoundedString(value.email, 3, 254)) return false;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value.email)) return false;
  if (!isBoundedString(value.firstName, 0, 255) || !isBoundedString(value.lastName, 0, 255)) return false;
  return isNullableBoundedString(value.company, 255)
    && isNullableBoundedString(value.phone, 50)
    && isNullableBoundedString(value.jobTitle, 255)
    && isNullableBoundedString(value.website, 500);
}

function isHubSpotSyncRecord(value: unknown): value is HubSpotSyncRecord {
  return isRecord(value)
    && isBoundedString(value.contactId, 1, 120)
    && isBoundedString(value.email, 3, 254)
    && (value.status === 'synced' || value.status === 'failed')
    && isNullableBoundedString(value.hubSpotId, 120)
    && (value.created === null || typeof value.created === 'boolean')
    && isNullableBoundedString(value.error, 1000);
}

function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? '', lastName: '' };
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
