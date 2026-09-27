import type { LiveContactState } from './live-control-tower';

export type ImportExclusion = { reason: string; excludedAt: string };
export const IMPORT_EXCLUSION_REASON_MAX_LENGTH = 500;

export function isImportExclusion(value: unknown): value is ImportExclusion {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.reason === 'string'
    && candidate.reason.length > 0
    && candidate.reason.length <= IMPORT_EXCLUSION_REASON_MAX_LENGTH
    && candidate.reason === candidate.reason.trim()
    && typeof candidate.excludedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(candidate.excludedAt)
    && Number.isFinite(Date.parse(candidate.excludedAt))
    && new Date(candidate.excludedAt).toISOString() === candidate.excludedAt;
}

export function excludeImportRow(
  contacts: LiveContactState[], contactId: string, reason: string, now = new Date(),
): LiveContactState[] {
  const row = uniqueActiveRow(contacts, contactId);
  if (row.importExclusion) throw new Error('This row is already skipped. Restore it before changing its decision.');
  const exclusion = { reason: reason.trim(), excludedAt: now.toISOString() };
  if (!isImportExclusion(exclusion)) throw new Error(`Enter a reason between 1 and ${IMPORT_EXCLUSION_REASON_MAX_LENGTH} characters for skipping this row.`);
  return recomputeImportDuplicateFlags(contacts.map((contact) => contact === row
    ? { ...contact, importExclusion: exclusion, lastAction: 'import_row_skipped', updatedAt: exclusion.excludedAt }
    : contact));
}

export function restoreImportRow(contacts: LiveContactState[], contactId: string, now = new Date()): LiveContactState[] {
  const row = uniqueActiveRow(contacts, contactId);
  if (!row.importExclusion) throw new Error('This row is already included in the import.');
  return recomputeImportDuplicateFlags(contacts.map((contact) => {
    if (contact !== row) return contact;
    const restored = { ...contact, lastAction: 'import_row_restored', updatedAt: now.toISOString() };
    delete restored.importExclusion;
    return restored;
  }));
}

// A skipped or merged row cannot block an included row with the same email.
// Preserve all other flags and source values, including on the skipped row.
export function recomputeImportDuplicateFlags(contacts: LiveContactState[]): LiveContactState[] {
  const counts = new Map<string, number>();
  for (const contact of contacts) {
    if (contact.recordStatus !== 'active' || contact.importExclusion || !contact.normalizedEmail) continue;
    counts.set(contact.normalizedEmail, (counts.get(contact.normalizedEmail) ?? 0) + 1);
  }
  return contacts.map((contact) => {
    if (contact.recordStatus !== 'active' || contact.importExclusion) return contact;
    const duplicate = Boolean(contact.normalizedEmail && (counts.get(contact.normalizedEmail) ?? 0) > 1);
    if (duplicate === contact.qualityFlags.includes('duplicate_identity')) return contact;
    return { ...contact, qualityFlags: duplicate
      ? [...contact.qualityFlags, 'duplicate_identity']
      : contact.qualityFlags.filter((flag) => flag !== 'duplicate_identity') };
  });
}

function uniqueActiveRow(contacts: LiveContactState[], contactId: string): LiveContactState {
  const rows = contacts.filter((contact) => contact.contactId === contactId);
  if (rows.length !== 1 || rows[0].recordStatus !== 'active') {
    throw new Error('Choose one uniquely identified active import row.');
  }
  return rows[0];
}
