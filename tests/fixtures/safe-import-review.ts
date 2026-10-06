import { buildCrmWritePlan, defaultCrmUpdatePolicy, type NativeCrmRecord, type PortableCrmContact } from '../../lib/crm-workflow';
import { safeImportCounts, type SafeImportReview } from '../../lib/safe-import';

export const SAFE_IMPORT_TEST_NOW = new Date('2026-10-06T15:00:00.000Z');

export function safeImportReviewFixture(workspaceId = 'test-workspace', count = 1): SafeImportReview {
  const contacts: PortableCrmContact[] = Array.from({ length: count }, (_, index) => ({
    contactId: `row-${index}`, email: `person${index}@example.com`, firstName: 'Nina', lastName: 'Alvarez',
    company: 'Example', phone: `212555${String(index).padStart(4, '0')}`, jobTitle: 'Operations Director', website: null,
  }));
  const existing = new Map(contacts.map((contact, index) => [contact.email, [safeImportNativeFixture(String(index + 1), contact.email)]]));
  const policy = defaultCrmUpdatePolicy();
  const plans = Array.from({ length: Math.ceil(count / 100) }, (_, index) => {
    const plan = buildCrmWritePlan('hubspot', 'attendees.csv', contacts.slice(index * 100, (index + 1) * 100), existing,
      SAFE_IMPORT_TEST_NOW, undefined, policy);
    return { ...plan, recordMode: 'update-existing' as const };
  });
  const rows = plans.flatMap((plan) => plan.records.map((record) => ({
    contactId: record.contactId, email: record.email, status: 'proposed-update' as const, reason: null, record,
  })));
  return {
    id: crypto.randomUUID(), workspaceId, workspaceRevision: 1, connectorId: 'hubspot', account: { connectorId: 'hubspot', accountId: '12345' },
    sourceFile: 'attendees.csv', sourceFileHash: 'a'.repeat(64), workspaceFingerprint: 'b'.repeat(64), mapping: { rawEmail: 'Email', phone: 'Phone' },
    recordMode: 'update-existing', updatePolicy: policy, createdAt: SAFE_IMPORT_TEST_NOW.toISOString(),
    expiresAt: new Date(SAFE_IMPORT_TEST_NOW.getTime() + 15 * 60_000).toISOString(), complete: true, plans, rows, counts: safeImportCounts(rows),
  };
}

export function safeImportNativeFixture(nativeId = '1', email = 'person0@example.com'): NativeCrmRecord {
  return {
    nativeId, objectType: 'contact', email,
    fields: { firstName: 'Nina', lastName: 'Alvarez', company: 'Example', phone: null, jobTitle: 'Head of Operations', website: 'example.com' },
  };
}
