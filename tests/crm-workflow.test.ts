import { describe, expect, it } from 'vitest';
import { buildCrmWritePlan, combineCrmWritebackProgress, reopenCrmWritebackContact, defaultCrmUpdatePolicy, isCrmRollbackPlan, isCrmUpdatePolicy, isSuccessfulCrmWritebackRecord, normalizeCrmUpdatePolicy, planStillMatches, portableCrmFieldNames, rollbackFromPlan, rollbackRecordAlreadyRestored, rollbackRecordStillMatches, type CrmMatchDecision, type CrmUpdatePolicy, type CrmWritebackReceipt, type NativeCrmRecord, type PortableCrmContact } from '../lib/crm-workflow';
import { sourceContactsToCsv } from '../lib/crm-source';
import { importContactsCsv } from '../lib/csv-control-tower';

const contacts: PortableCrmContact[] = [
  { contactId: 'one', email: 'one@example.com', firstName: 'One', lastName: 'Person', company: 'Example', phone: null, jobTitle: 'RevOps', website: null },
  { contactId: 'two', email: 'two@example.com', firstName: 'Two', lastName: 'Person', company: 'Example', phone: null, jobTitle: 'GTM Engineer', website: null },
  { contactId: 'three', email: 'three@example.com', firstName: 'Three', lastName: 'Person', company: 'Example', phone: null, jobTitle: 'Analyst', website: null },
];
const replaceAll: CrmUpdatePolicy = { mode: 'replace', fields: [...portableCrmFieldNames], clearBlanks: true };

describe('governed CRM source and write-back', () => {
  it('plans creates, exact field updates, unchanged records, and duplicate holds', () => {
    const existing = new Map<string, NativeCrmRecord[]>([
      ['one@example.com', [native('crm-1', 'one@example.com', 'Old title')]],
      ['two@example.com', [native('crm-2', 'two@example.com', 'GTM Engineer')]],
      ['three@example.com', [native('crm-3a', 'three@example.com', 'Analyst'), native('crm-3b', 'three@example.com', 'Analyst')]],
    ]);
    const plan = buildCrmWritePlan('salesforce', 'test.csv', contacts, existing, new Date('2026-08-26T20:00:00Z'), undefined, replaceAll);
    expect(plan).toMatchObject({ creates: 0, updates: 1, unchanged: 1, held: 1, requested: 3 });
    expect(plan.records[0].changes).toEqual([{ field: 'jobTitle', before: 'Old title', after: 'RevOps' }]);
    expect(plan.records[2].reason).toMatch(/2 CRM records/u);
  });

  it('creates a rollback only for updates and detects stale or changed plans', () => {
    const existing = new Map<string, NativeCrmRecord[]>([['one@example.com', [native('crm-1', 'one@example.com', 'Old title')]]]);
    const plan = buildCrmWritePlan('hubspot', 'test.csv', contacts.slice(0, 2), existing, new Date('2026-08-26T20:00:00Z'), undefined, replaceAll);
    const rollback = rollbackFromPlan(plan);
    expect(rollback?.records).toHaveLength(1);
    expect(rollback?.createdRecordsSkipped).toBe(1);
    expect(rollback?.records[0]).toMatchObject({ changedFields: ['jobTitle'], after: { jobTitle: 'RevOps' } });
    expect(rollbackRecordStillMatches(rollback!.records[0], native('crm-1', 'one@example.com', 'RevOps'))).toBe(true);
    expect(rollbackRecordAlreadyRestored(rollback!.records[0], native('crm-1', 'one@example.com', 'Old title'))).toBe(true);
    expect(rollbackRecordStillMatches(rollback!.records[0], native('crm-1', 'one@example.com', 'Changed after write'))).toBe(false);
    expect(planStillMatches(plan, { ...plan })).toBe(false);
    const fresh = buildCrmWritePlan('hubspot', 'test.csv', contacts.slice(0, 2), existing, new Date(), undefined, replaceAll);
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

describe('CRM update policy', () => {
  it.each(['hubspot', 'salesforce'] as const)('fills only empty %s fields by default and leaves creates unaffected', (connectorId) => {
    const current = native('crm-1', 'one@example.com', 'Existing title');
    current.fields.phone = '212-555-0101';
    const proposed = [{ ...contacts[0], firstName: 'Overwrite', phone: null, website: 'https://example.com' }, contacts[1]];
    const plan = buildCrmWritePlan(connectorId, 'test.csv', proposed, new Map([['one@example.com', [current]]]));
    expect(plan.updatePolicy).toEqual(defaultCrmUpdatePolicy());
    expect(plan.records[0].changes).toEqual([{ field: 'website', before: null, after: 'https://example.com' }]);
    expect(plan.records[0].after).toEqual({ ...current.fields, website: 'https://example.com' });
    expect(plan.records[1]).toMatchObject({ operation: 'create', after: { firstName: 'Two', jobTitle: 'GTM Engineer' } });
  });

  it('replaces selected fields while preserving unselected fields and blank import values', () => {
    const current = native('crm-1', 'one@example.com', 'Existing title');
    current.fields.phone = '212-555-0101';
    const policy: CrmUpdatePolicy = { mode: 'replace', fields: ['phone', 'jobTitle'], clearBlanks: false };
    const plan = buildCrmWritePlan('hubspot', 'test.csv', [{ ...contacts[0], firstName: 'Overwrite' }], new Map([['one@example.com', [current]]]), new Date(), undefined, policy);
    expect(plan.records[0].changes).toEqual([{ field: 'jobTitle', before: 'Existing title', after: 'RevOps' }]);
    expect(plan.records[0].after).toEqual({ ...current.fields, jobTitle: 'RevOps' });
    const rollback = rollbackFromPlan(plan);
    expect(rollback?.records[0].changedFields).toEqual(['jobTitle']);
    expect(rollback?.records[0].after.phone).toBe('212-555-0101');
  });

  it('clears only explicitly selected fields with an explicit replace-and-clear policy', () => {
    const current = native('crm-1', 'one@example.com', 'Existing title');
    current.fields.phone = '212-555-0101';
    current.fields.website = 'https://example.com';
    const policy: CrmUpdatePolicy = { mode: 'replace', fields: ['phone'], clearBlanks: true };
    const plan = buildCrmWritePlan('salesforce', 'test.csv', [contacts[0]], new Map([['one@example.com', [current]]]), new Date(), undefined, policy);
    expect(plan.records[0].changes).toEqual([{ field: 'phone', before: '212-555-0101', after: null }]);
    expect(plan.records[0].after).toEqual({ ...current.fields, phone: null });
    expect(rollbackFromPlan(plan)?.records[0]).toMatchObject({ changedFields: ['phone'], before: { phone: '212-555-0101' }, after: { phone: null } });
  });

  it('can preserve all existing fields without blocking new records', () => {
    const current = native('crm-1', 'one@example.com', 'Existing title');
    const policy: CrmUpdatePolicy = { mode: 'replace', fields: [], clearBlanks: false };
    const plan = buildCrmWritePlan('hubspot', 'test.csv', contacts.slice(0, 2), new Map([['one@example.com', [current]]]), new Date(), undefined, policy);
    expect(plan).toMatchObject({ creates: 1, unchanged: 1, updates: 0 });
    expect(plan.records[0]).toMatchObject({ after: current.fields, changes: [], reason: 'No update fields are selected. Existing CRM values are preserved.' });
    expect(rollbackFromPlan(plan)).toBeNull();
  });

  it('fingerprints policy changes even when the effective record changes are identical', () => {
    const current = native('crm-1', 'one@example.com', 'RevOps');
    const existing = new Map([['one@example.com', [current]]]);
    const compare = (policy: CrmUpdatePolicy) => buildCrmWritePlan('hubspot', 'test.csv', [contacts[0]], existing, new Date(), undefined, policy);
    const first = compare({ mode: 'replace', fields: ['phone', 'jobTitle'], clearBlanks: false });
    const reordered = compare({ mode: 'replace', fields: ['jobTitle', 'phone'], clearBlanks: false });
    const changed = compare({ mode: 'replace', fields: ['jobTitle'], clearBlanks: false });
    expect(first.records[0].changes).toEqual([]);
    expect(changed.records[0].changes).toEqual([]);
    expect(planStillMatches(first, reordered)).toBe(true);
    expect(planStillMatches(first, changed)).toBe(false);
    expect(planStillMatches(first, compare({ mode: 'replace', fields: ['phone', 'jobTitle'], clearBlanks: true }))).toBe(false);
    expect(planStillMatches(first, compare({ mode: 'fill-empty', fields: ['phone', 'jobTitle'], clearBlanks: false }))).toBe(false);
  });

  it('normalizes supported policies without sharing mutable defaults and rejects malformed inputs', () => {
    const policy = defaultCrmUpdatePolicy();
    policy.fields.pop();
    expect(defaultCrmUpdatePolicy().fields).toEqual(portableCrmFieldNames);
    expect(normalizeCrmUpdatePolicy()).toEqual(defaultCrmUpdatePolicy());
    expect(normalizeCrmUpdatePolicy({ mode: 'replace', fields: ['website', 'phone'], clearBlanks: false }).fields).toEqual(['phone', 'website']);
    for (const invalid of [null, [], {}, { mode: 'merge', fields: [], clearBlanks: false },
      { mode: 'replace', fields: ['email'], clearBlanks: false }, { mode: 'replace', fields: ['phone', 'phone'], clearBlanks: false },
      { mode: 'replace', fields: ['phone'], clearBlanks: 'false' }, { mode: 'fill-empty', fields: ['phone'], clearBlanks: true }]) {
      expect(isCrmUpdatePolicy(invalid)).toBe(false);
      expect(() => normalizeCrmUpdatePolicy(invalid)).toThrow(/Invalid CRM update policy/u);
    }
  });

  it('holds explicitly excluded rows before create, update, and unchanged decisions', () => {
    const existing = new Map([
      ['one@example.com', [native('crm-1', 'one@example.com', 'Old title')]],
      ['two@example.com', [native('crm-2', 'two@example.com', 'GTM Engineer')]],
    ]);
    const exclusions = new Map(contacts.map((contact) => [contact.contactId, 'Excluded from this import: needs owner review.']));
    const plan = buildCrmWritePlan('hubspot', 'test.csv', contacts, existing, new Date(), undefined, replaceAll, exclusions);
    expect(plan).toMatchObject({ held: 3, creates: 0, updates: 0, unchanged: 0 });
    expect(plan.records.every((row) => row.reason === exclusions.get(row.contactId) && row.changes.length === 0)).toBe(true);
    expect(rollbackFromPlan(plan)).toBeNull();
    const ordinary = buildCrmWritePlan('hubspot', 'test.csv', contacts, existing, new Date(), undefined, replaceAll);
    expect(planStillMatches(plan, ordinary)).toBe(false);
  });

  it('allows an included exact match when another row targeting that record is explicitly excluded', () => {
    const record = { ...native('hs-1', 'primary@example.com', 'Old title'), objectType: 'contact' as const };
    const existing = new Map([['one@example.com', [record]], ['two@example.com', [record]]]);
    const plan = buildCrmWritePlan('hubspot', 'test.csv', contacts.slice(0, 2), existing, new Date(), undefined, replaceAll,
      new Map([['two', 'Excluded: another imported row represents this person.']]));
    expect(plan).toMatchObject({ held: 1, updates: 1, creates: 0 });
    expect(plan.records[0]).toMatchObject({ operation: 'update', nativeId: 'hs-1' });
    expect(plan.records[1].operation).toBe('hold');
  });
});

function native(nativeId: string, email: string, jobTitle: string | null): NativeCrmRecord {
  const local = email.split('@')[0];
  return { nativeId, objectType: 'lead', isConverted: false, email, fields: { firstName: `${local.charAt(0).toUpperCase()}${local.slice(1)}`, lastName: 'Person', company: 'Example', phone: null, jobTitle, website: null } };
}

describe('CRM import matching evidence', () => {
  it('retains confirmed-match intent in the fingerprint and supports different-email rollback without breaking historic receipts', () => {
    const current = { ...native('123', 'native@example.com', 'Old title'), objectType: 'contact' as const };
    const decision: CrmMatchDecision = { nativeId: '123', email: 'native@example.com', reason: 'Same name and phone', confirmedAt: new Date().toISOString() };
    const build = (matchDecision: CrmMatchDecision, matches = [current]) => buildCrmWritePlan('hubspot', 'changed-email.csv', [contacts[0]],
      new Map([[contacts[0].email, matches]]), new Date(), undefined, replaceAll, undefined, new Map([[contacts[0].contactId, matchDecision]]));
    const plan = build(decision);
    expect(plan.records[0]).toMatchObject({ operation: 'update', email: contacts[0].email, matchDecision: decision });
    expect(planStillMatches(plan, build({ ...decision, reason: 'New confirmation reason' }))).toBe(false);
    expect(build(decision, []).records[0].operation).toBe('hold');
    const rollback = rollbackFromPlan(plan)!;
    expect(rollback.records[0]).toMatchObject({ email: contacts[0].email, targetEmail: decision.email });
    expect(isCrmRollbackPlan(rollback)).toBe(true);
    const legacy = structuredClone(rollback);
    delete legacy.records[0].targetEmail;
    expect(isCrmRollbackPlan(legacy)).toBe(true);
    rollback.records[0].targetEmail = 'not-an-email';
    expect(isCrmRollbackPlan(rollback)).toBe(false);
  });

  it('holds Salesforce Contacts and converted Leads instead of proposing another Lead', () => {
    const existing = new Map<string, NativeCrmRecord[]>([
      ['one@example.com', [{ ...native('003-1', 'one@example.com', 'RevOps'), objectType: 'contact' }]],
      ['two@example.com', [{ ...native('00Q-2', 'two@example.com', 'GTM Engineer'), isConverted: true }]],
    ]);
    const plan = buildCrmWritePlan('salesforce', 'import.csv', contacts, existing);
    expect(plan).toMatchObject({ creates: 1, updates: 0, held: 2 });
    expect(plan.records[0]).toMatchObject({ operation: 'hold', matches: [{ nativeId: '003-1', objectType: 'contact' }] });
    expect(plan.records[0].reason).toContain('existing Salesforce Contact');
    expect(plan.records[1].reason).toContain('converted Salesforce Lead');
  });

  it('holds two imported emails targeting the same native Contact', () => {
    const record = { ...native('hs-1', 'primary@example.com', 'RevOps'), objectType: 'contact' as const };
    const existing = new Map([['one@example.com', [record]], ['two@example.com', [record]]]);
    const plan = buildCrmWritePlan('hubspot', 'aliases.csv', contacts.slice(0, 2), existing);
    expect(plan).toMatchObject({ creates: 0, updates: 0, held: 2 });
    expect(plan.records.every((row) => row.reason?.includes('Multiple imported rows'))).toBe(true);
    expect(plan.records[0].matches[0]).toMatchObject({ nativeId: 'hs-1', email: 'primary@example.com' });
  });

  it('invalidates held comparisons when the matched CRM record changes', () => {
    const before = new Map([['one@example.com', [{ ...native('003-1', 'one@example.com', 'RevOps'), objectType: 'contact' as const }]]]);
    const after = new Map([['one@example.com', [{ ...native('003-2', 'one@example.com', 'RevOps'), objectType: 'contact' as const }]]]);
    const oldPlan = buildCrmWritePlan('salesforce', 'import.csv', contacts.slice(0, 1), before);
    const newPlan = buildCrmWritePlan('salesforce', 'import.csv', contacts.slice(0, 1), after);
    expect(oldPlan.held).toBe(1);
    expect(newPlan.held).toBe(1);
    expect(planStillMatches(oldPlan, newPlan)).toBe(false);
  });
});

describe('direct CRM writeback progress', () => {
  it.each(['hubspot', 'salesforce'] as const)('retains %s batches, actual outcomes, and the latest retry result', (connectorId) => {
    const row = (id: number, status: CrmWritebackReceipt['records'][number]['status']) => ({
      contactId: String(id), email: `person${id}@example.com`, nativeId: status === 'failed' || status === 'held' ? null : `crm-${id}`,
      status, error: status === 'failed' ? 'Temporary provider error' : status === 'held' ? 'Existing Contact requires review' : null,
    });
    const receipt = (records: CrmWritebackReceipt['records'], runId: string): CrmWritebackReceipt => ({
      accepted: true, connectorId, runId, planId: `plan-${runId}`, status: 'partial',
      requested: records.length,
      created: records.filter((record) => record.status === 'created').length,
      updated: records.filter((record) => record.status === 'updated').length,
      unchanged: records.filter((record) => record.status === 'unchanged').length,
      held: records.filter((record) => record.status === 'held').length,
      failed: records.filter((record) => record.status === 'failed').length,
      completedAt: '2026-09-27T21:00:00.000Z', records, rollback: null,
    });
    const first = receipt(Array.from({ length: 100 }, (_, index) => row(index + 1,
      index === 0 ? 'created' : index === 1 ? 'updated' : index === 99 ? 'failed' : 'unchanged')), 'first');
    const firstProgress = combineCrmWritebackProgress(null, first);
    const pending = (progress: typeof firstProgress) => {
      const complete = new Set(progress.records.filter(isSuccessfulCrmWritebackRecord).map((record) => record.contactId));
      return Array.from({ length: 105 }, (_, index) => String(index + 1)).filter((id) => !complete.has(id));
    };
    expect(pending(firstProgress)).toEqual(['100', '101', '102', '103', '104', '105']);

    const second = receipt([row(100, 'unchanged'), row(101, 'created'), row(102, 'created'), row(103, 'created'), row(104, 'created'), row(105, 'held')], 'second');
    const combined = combineCrmWritebackProgress(firstProgress, second);
    expect(combined).toMatchObject({ requested: 105, created: 5, updated: 1, unchanged: 98, held: 1, failed: 0 });
    expect(pending(combined)).toEqual(['105']);
    expect(combined.records.find((record) => record.contactId === '105')).toEqual(second.records[5]);
    expect(combined.records.find((record) => record.contactId === '100')).toEqual(second.records[0]);
    expect(firstProgress.records[99]).toEqual(first.records[99]);
    expect(firstProgress.failed).toBe(1);

    const resolved = combineCrmWritebackProgress(combined, receipt([row(105, 'unchanged')], 'third'));
    expect(resolved).toMatchObject({ requested: 105, created: 5, updated: 1, unchanged: 99, held: 0, failed: 0 });
    expect(pending(resolved)).toEqual([]);
    expect(isSuccessfulCrmWritebackRecord(row(105, 'rolled_back'))).toBe(false);

    const reopened = reopenCrmWritebackContact(resolved, '2')!;
    expect(reopened).toMatchObject({ requested: 104, created: 5, updated: 0, unchanged: 99, held: 0, failed: 0 });
    expect(pending(reopened)).toEqual(['2']);
    expect(resolved.records.find((record) => record.contactId === '2')?.status).toBe('updated');
    expect(first.records[1].status).toBe('updated');
    expect(reopenCrmWritebackContact(reopened, 'missing')).toBe(reopened);
    expect(reopenCrmWritebackContact(combineCrmWritebackProgress(null, receipt([row(2, 'unchanged')], 'single')), '2')).toBeNull();
    expect(reopenCrmWritebackContact(null, '2')).toBeNull();
  });
});
