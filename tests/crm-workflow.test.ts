import { describe, expect, it } from 'vitest';
import { buildCrmWritePlan, planStillMatches, rollbackFromPlan, rollbackRecordAlreadyRestored, rollbackRecordStillMatches, type NativeCrmRecord, type PortableCrmContact } from '../lib/crm-workflow';
import { sourceContactsToCsv } from '../lib/crm-source';
import { importContactsCsv } from '../lib/csv-control-tower';

const contacts: PortableCrmContact[] = [
  { contactId: 'one', email: 'one@example.com', firstName: 'One', lastName: 'Person', company: 'Example', phone: null, jobTitle: 'RevOps', website: null },
  { contactId: 'two', email: 'two@example.com', firstName: 'Two', lastName: 'Person', company: 'Example', phone: null, jobTitle: 'GTM Engineer', website: null },
  { contactId: 'three', email: 'three@example.com', firstName: 'Three', lastName: 'Person', company: 'Example', phone: null, jobTitle: 'Analyst', website: null },
];

describe('governed CRM source and write-back', () => {
  it('plans creates, exact field updates, unchanged records, and duplicate holds', () => {
    const existing = new Map<string, NativeCrmRecord[]>([
      ['one@example.com', [native('crm-1', 'one@example.com', 'Old title')]],
      ['two@example.com', [native('crm-2', 'two@example.com', 'GTM Engineer')]],
      ['three@example.com', [native('crm-3a', 'three@example.com', 'Analyst'), native('crm-3b', 'three@example.com', 'Analyst')]],
    ]);
    const plan = buildCrmWritePlan('salesforce', 'test.csv', contacts, existing, new Date('2026-08-26T20:00:00Z'));
    expect(plan).toMatchObject({ creates: 0, updates: 1, unchanged: 1, held: 1, requested: 3 });
    expect(plan.records[0].changes).toEqual([{ field: 'jobTitle', before: 'Old title', after: 'RevOps' }]);
    expect(plan.records[2].reason).toMatch(/2 active CRM records/u);
  });

  it('creates a rollback only for updates and detects stale or changed plans', () => {
    const existing = new Map<string, NativeCrmRecord[]>([['one@example.com', [native('crm-1', 'one@example.com', 'Old title')]]]);
    const plan = buildCrmWritePlan('hubspot', 'test.csv', contacts.slice(0, 2), existing, new Date('2026-08-26T20:00:00Z'));
    const rollback = rollbackFromPlan(plan);
    expect(rollback?.records).toHaveLength(1);
    expect(rollback?.createdRecordsSkipped).toBe(1);
    expect(rollback?.records[0]).toMatchObject({ changedFields: ['jobTitle'], after: { jobTitle: 'RevOps' } });
    expect(rollbackRecordStillMatches(rollback!.records[0], native('crm-1', 'one@example.com', 'RevOps'))).toBe(true);
    expect(rollbackRecordAlreadyRestored(rollback!.records[0], native('crm-1', 'one@example.com', 'Old title'))).toBe(true);
    expect(rollbackRecordStillMatches(rollback!.records[0], native('crm-1', 'one@example.com', 'Changed after write'))).toBe(false);
    expect(planStillMatches(plan, { ...plan })).toBe(false);
    const fresh = buildCrmWritePlan('hubspot', 'test.csv', contacts.slice(0, 2), existing, new Date());
    expect(planStillMatches(fresh, { ...fresh })).toBe(true);
    expect(planStillMatches(fresh, { ...fresh, fingerprint: 'changed' })).toBe(false);
  });

  it('round-trips CRM source records through the normal CSV diagnosis path', () => {
    const csv = sourceContactsToCsv('hubspot', [{ nativeId: '123', fullName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: 'ADA@EXAMPLE.COM', company: 'Engines', phone: '', jobTitle: 'Analyst', website: '' }]);
    const imported = importContactsCsv(csv).contacts;
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ contactId: 'hubspot:123', normalizedEmail: 'ada@example.com', company: 'Engines' });
  });
});

function native(nativeId: string, email: string, jobTitle: string | null): NativeCrmRecord {
  const local = email.split('@')[0];
  return { nativeId, email, fields: { firstName: `${local.charAt(0).toUpperCase()}${local.slice(1)}`, lastName: 'Person', company: 'Example', phone: null, jobTitle, website: null } };
}
