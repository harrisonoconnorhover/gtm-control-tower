import { resetCrmReadTransportForTests } from '../lib/crm-read-transport';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCrmWritePlan, defaultCrmUpdatePolicy, type NativeCrmRecord, type PortableCrmContact } from '../lib/crm-workflow';
import type { createGovernedCrmPlan } from '../lib/governed-crm-plan';
import type { LiveContactState } from '../lib/live-control-tower';
import { buildSafeImportReview, safeImportWorkspaceFingerprint } from '../lib/safe-import-review-server';
import { emptyWorkspaceState, type SavedWorkspace } from '../lib/workspace';

const now = new Date('2026-10-06T18:00:00.000Z');
const account = { connectorId: 'hubspot' as const, accountId: 'fixture-portal' };

function sourceRow(index: number): LiveContactState {
  return {
    contactId: `row-${index}`, fullName: `Person ${index}`, firstName: 'Person', lastName: String(index),
    rawEmail: `person${index}@example.com`, normalizedEmail: `person${index}@example.com`, company: 'Example',
    phone: '2125550104', jobTitle: 'Operations Director', website: 'example.com', region: 'East', segment: 'SMB',
    lifecycleStage: 'Lead', expectedLifecycleStage: 'Lead', ownerId: 'owner-1', canonicalContactId: null,
    recordStatus: 'active', lastAction: 'imported', qualityFlags: [], updatedAt: now.toISOString(),
  };
}

function workspace(count: number): SavedWorkspace {
  const contacts = Array.from({ length: count }, (_, index) => sourceRow(index + 1));
  return {
    id: 'saved-workspace', name: 'Event attendees', revision: 3, presets: [], createdAt: now.toISOString(), updatedAt: now.toISOString(),
    state: { ...emptyWorkspaceState(), contacts, originalContacts: structuredClone(contacts), fileName: 'attendees.csv',
      mapping: { rawEmail: 'Email', firstName: 'First name', lastName: 'Last name', phone: 'Phone' },
      sourceFileHash: 'a'.repeat(64), destinationType: 'hubspot', importRecipe: 'safe-update-contacts',
      importRecordMode: 'update-existing', crmUpdatePolicy: defaultCrmUpdatePolicy() },
  };
}

function target(contact: PortableCrmContact, nativeId = `native-${contact.contactId}`, phone: string | null = null): NativeCrmRecord {
  return { nativeId, objectType: 'contact', email: contact.email, fields: {
    firstName: contact.firstName, lastName: contact.lastName, company: contact.company,
    phone, jobTitle: 'Head of Operations', website: contact.website,
  } };
}

const createPlan: typeof createGovernedCrmPlan = async (connectorId, file, contacts, saved, policy) =>
  buildCrmWritePlan(connectorId, file, contacts, new Map(contacts.map((row) => [row.email, [target(row)]])),
    now, undefined, policy, undefined, undefined, saved.state.importRecordMode);

describe('whole-file Safe Import review', () => {
  it('holds both independently discovered aliases across a batch boundary before either can be approved', async () => {
    const saved = workspace(101);
    const independentLookup = vi.fn<typeof createGovernedCrmPlan>(async (connectorId, file, contacts, current, policy) => {
      const records = new Map(contacts.map((row) => [row.email, [target(row,
        row.contactId === 'row-1' || row.contactId === 'row-101' ? 'same-native-person' : `native-${row.contactId}`)]]));
      // Neither batch knows the other email is an alias; both independently
      // resolve an existing native ID. Whole-file review must connect them.
      return buildCrmWritePlan(connectorId, file, contacts, records, now, undefined, policy, undefined, undefined, current.state.importRecordMode);
    });
    const review = await buildSafeImportReview(saved, account, { createPlan: independentLookup, now: () => now });

    expect(independentLookup.mock.calls.map((call) => call[2].length)).toEqual([100, 1]);
    expect(review).toMatchObject({ complete: true, counts: { 'proposed-update': 99, held: 2, unresolved: 0 } });
    expect(review.rows).toHaveLength(101);
    for (const id of ['row-1', 'row-101']) {
      const row = review.rows.find((item) => item.contactId === id)!;
      expect(row).toMatchObject({ status: 'held', record: { operation: 'hold', changes: [], after: { phone: null, jobTitle: 'Head of Operations' } } });
      expect(row.reason).toContain('across batches');
      expect(row.record!.fieldDecisions?.find((decision) => decision.field === 'phone')).toMatchObject({
        currentValue: null, importedValue: '2125550104', proposedValue: null, action: 'review',
      });
    }
    expect(review.plans.map((plan) => [plan.updates, plan.held])).toEqual([[99, 1], [0, 1]]);
    expect(review.plans.every((plan) => plan.creates === 0)).toBe(true);
  });

  it('accounts for invalid, merged, explicitly skipped, and removed original rows without reading them as ready contacts', async () => {
    const saved = workspace(5);
    saved.state.contacts[1] = { ...saved.state.contacts[1], rawEmail: 'bad-email', normalizedEmail: null, qualityFlags: ['invalid_email'] };
    saved.state.contacts[2] = { ...saved.state.contacts[2], recordStatus: 'merged', canonicalContactId: 'row-1' };
    saved.state.contacts[3] = { ...saved.state.contacts[3], importExclusion: { reason: 'Duplicate registration reviewed and skipped.', excludedAt: now.toISOString() } };
    saved.state.contacts.pop();
    const onlyValidLookup = vi.fn<typeof createGovernedCrmPlan>(async (connectorId, file, contacts, current, policy) => {
      const existing = new Map(contacts.map((row) => [row.email, [{ ...target(row, undefined, row.phone), fields: {
        ...target(row, undefined, row.phone).fields, jobTitle: row.jobTitle,
      } }]]));
      return buildCrmWritePlan(connectorId, file, contacts, existing, now, undefined, policy, undefined, undefined, current.state.importRecordMode);
    });
    const review = await buildSafeImportReview(saved, account, { createPlan: onlyValidLookup, now: () => now });

    expect(onlyValidLookup).toHaveBeenCalledOnce();
    expect(onlyValidLookup.mock.calls[0][2].map((row) => row.contactId)).toEqual(['row-1']);
    expect(review).toMatchObject({ complete: true, counts: { 'proposed-update': 0, unchanged: 1, held: 1, skipped: 3, unresolved: 0 } });
    expect(review.rows.map((row) => row.contactId).sort()).toEqual(saved.state.originalContacts.map((row) => row.contactId).sort());
    expect(review.rows.find((row) => row.contactId === 'row-2')).toMatchObject({ status: 'held' });
    expect(review.rows.find((row) => row.contactId === 'row-2')).not.toHaveProperty('record');
    expect(review.rows.find((row) => row.contactId === 'row-5')).toMatchObject({ status: 'skipped', reason: expect.stringContaining('removed locally') });
  });

  it('keeps a failed later lookup unresolved and makes the whole review incomplete', async () => {
    const secondBatchFails = vi.fn<typeof createGovernedCrmPlan>(async (...args) => {
      if (args[2][0].contactId === 'row-101') throw new Error('CRM lookup interrupted; no complete response.');
      return createPlan(...args);
    });
    const review = await buildSafeImportReview(workspace(101), account, { createPlan: secondBatchFails, now: () => now });

    expect(secondBatchFails.mock.calls.map((call) => call[2].length)).toEqual([100, 1]);
    expect(review.complete).toBe(false);
    expect(review.rows).toHaveLength(101);
    expect(review.counts).toMatchObject({ 'proposed-update': 100, unresolved: 1, unmatched: 0 });
    expect(review.rows.find((row) => row.contactId === 'row-101')).toMatchObject({ status: 'unresolved', reason: expect.stringContaining('interrupted') });
    expect(review.rows.find((row) => row.contactId === 'row-101')).not.toHaveProperty('record');
  });

  it('rejects create-enabled or replacement policies before any CRM lookup', async () => {
    const lookup = vi.fn(createPlan);
    for (const change of [
      { importRecordMode: 'create-and-update' as const },
      { crmUpdatePolicy: { ...defaultCrmUpdatePolicy(), mode: 'replace' as const } },
      { crmUpdatePolicy: { ...defaultCrmUpdatePolicy(), fields: ['phone'] as const } },
    ]) {
      const saved = workspace(1);
      Object.assign(saved.state, change);
      await expect(buildSafeImportReview(saved, account, { createPlan: lookup, now: () => now })).rejects.toThrow(/protected field policy/);
    }
    expect(lookup).not.toHaveBeenCalled();
  });
});

beforeEach(() => resetCrmReadTransportForTests({ minimumIntervalMs: 0, backoffBaseMs: 0 }));


it('excludes suppressed rows from CRM lookup and invalidates approval when effective suppressions change', async () => {
  const saved = workspace(2);
  const fingerprint = await safeImportWorkspaceFingerprint(saved);
  const original = structuredClone(saved.state.originalContacts);
  saved.state.contacts[0].suppressionMatches = [
    { ruleId: 'vendor', listName: 'Vendors', type: 'email', value: 'person1@example.com', reason: 'Current vendor' },
  ];
  const plan = vi.fn(createPlan);
  const review = await buildSafeImportReview(saved, account, { createPlan: plan, now: () => now });
  expect(review.rows.find((row) => row.contactId === 'row-1')).toMatchObject({ status: 'skipped', reason: 'Suppressed: Vendors: Current vendor' });
  expect(plan.mock.calls.flatMap((call) => call[2].map((row) => row.contactId))).toEqual(['row-2']);
  expect(await safeImportWorkspaceFingerprint(saved)).not.toBe(fingerprint);
  expect(saved.state.originalContacts).toEqual(original);
  delete saved.state.contacts[0].suppressionMatches;
  expect(await safeImportWorkspaceFingerprint(saved)).toBe(fingerprint);
});
