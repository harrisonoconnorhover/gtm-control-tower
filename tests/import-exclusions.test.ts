import { describe, expect, it } from 'vitest';
import { correctCsvContact, countCsvRepairCandidates, executeCsvRepair, exportContactsCsv, importContactsCsv, isDestinationReadyContact } from '../lib/csv-control-tower';
import { isHubSpotEligible, toHubSpotSyncContact } from '../lib/hubspot-sync';
import { excludeImportRow, isImportExclusion, restoreImportRow } from '../lib/import-exclusions';
import { isSalesforceEligible, toSalesforceSyncLead } from '../lib/salesforce-sync';

const now = new Date('2026-09-27T22:00:00.000Z');
function contacts() {
  return importContactsCsv('contact_id,full_name,email,company,owner_id,region,segment,lifecycle_stage,expected_lifecycle_stage\nKEEP,Nina Shah,nina@costco.example,Costco,owner-1,Northeast,Enterprise,customer,customer\nSKIP,Nina Shah,nina@costco.example,Costco,owner-1,Northeast,Enterprise,lead,customer\nOTHER,Priya Nair,priya@salesforce.example,Salesforce,owner-2,West,SMB,lead,lead').contacts;
}

describe('persistent import row exclusions', () => {
  it('skips without changing source identity, releases the included exact-email duplicate, and restores the hold', () => {
    const original = contacts();
    const snapshot = structuredClone(original);
    const skipped = excludeImportRow(original, 'SKIP', '  Duplicate event registration; retain KEEP.  ', now);
    expect(original).toEqual(snapshot);
    expect(skipped).not.toBe(original);
    expect(skipped[1]).toEqual({ ...original[1], importExclusion: { reason: 'Duplicate event registration; retain KEEP.', excludedAt: now.toISOString() },
      lastAction: 'import_row_skipped', updatedAt: now.toISOString() });
    expect(skipped[2]).toEqual(original[2]);
    expect(skipped[0].qualityFlags).not.toContain('duplicate_identity');
    expect(isDestinationReadyContact(skipped[0])).toBe(true);
    expect(isHubSpotEligible(skipped[0])).toBe(true);
    expect(isSalesforceEligible(skipped[0])).toBe(true);
    for (const eligible of [isDestinationReadyContact, isHubSpotEligible, isSalesforceEligible]) expect(eligible(skipped[1])).toBe(false);
    for (const convert of [toHubSpotSyncContact, toSalesforceSyncLead]) expect(() => convert(skipped[1])).toThrow(/not eligible/);
    const restored = restoreImportRow(skipped, 'SKIP', new Date('2026-09-27T22:01:00.000Z'));
    expect(restored[1]).not.toHaveProperty('importExclusion');
    expect(restored[1]).toMatchObject({ lastAction: 'import_row_restored', recordStatus: 'active', rawEmail: original[1].rawEmail });
    expect(restored[0].qualityFlags).toContain('duplicate_identity');
    expect(restored[1].qualityFlags).toContain('duplicate_identity');
    expect(skipped[1].importExclusion).toBeDefined();
  });

  it('round-trips explicit skip metadata and permits the retained row to remain eligible', () => {
    const skipped = excludeImportRow(contacts(), 'SKIP', 'Duplicate, reviewed with "event team"', now);
    const csv = exportContactsCsv(skipped);
    expect(csv.split('\n')[0]).toContain('import_skip_reason,import_skipped_at');
    const imported = importContactsCsv(csv).contacts;
    expect(imported[1].importExclusion).toEqual(skipped[1].importExclusion);
    expect(imported[1].recordStatus).toBe('active');
    expect(imported[1].canonicalContactId).toBeNull();
    expect(imported[0].qualityFlags).not.toContain('duplicate_identity');
    expect(isHubSpotEligible(imported[0])).toBe(true);
    expect(isHubSpotEligible(imported[1])).toBe(false);
    expect(importContactsCsv('full_name,email\nNina Shah,nina@costco.example').contacts[0]).not.toHaveProperty('importExclusion');
  });

  it('preserves skipped rows across merge, routing, lifecycle repair, and rejects field correction until restored', () => {
    const skipped = excludeImportRow(contacts(), 'SKIP', 'Review later', now);
    expect(countCsvRepairCandidates(skipped, 'duplicate-surge')).toBe(0);
    expect(countCsvRepairCandidates(skipped, 'stage-regression')).toBe(0);
    expect(countCsvRepairCandidates(skipped, 'routing-overload')).toBe(1);
    for (const scenario of ['duplicate-surge', 'routing-overload', 'stage-regression'] as const) {
      expect(executeCsvRepair(skipped, scenario).contacts[1]).toEqual(skipped[1]);
    }
    expect(() => correctCsvContact(skipped, 'SKIP', { rawEmail: 'different@costco.example', company: 'Costco', ownerId: 'owner-1', lifecycleStage: 'lead' }, 'Change')).toThrow(/Restore this skipped/);
  });

  it('requires one unique active row and a bounded nonempty reason', () => {
    const original = contacts();
    for (const reason of ['', ' \n ', 'a'.repeat(501)]) expect(() => excludeImportRow(original, 'KEEP', reason, now)).toThrow(/reason/);
    for (const invalid of [original, [...original, { ...original[0] }], [{ ...original[0], recordStatus: 'merged' as const }]]) {
      const id = invalid === original ? 'missing' : 'KEEP';
      expect(() => excludeImportRow(invalid, id, 'Skip', now)).toThrow(/uniquely identified active/);
      expect(() => restoreImportRow(invalid, id, now)).toThrow(/uniquely identified active/);
    }
    expect(() => restoreImportRow(original, 'KEEP', now)).toThrow(/already included/);
    const skipped = excludeImportRow(original, 'KEEP', 'Skip', now);
    expect(() => excludeImportRow(skipped, 'KEEP', 'Replace reason', now)).toThrow(/already skipped/);
  });

  it.each([
    { reason: '', excludedAt: now.toISOString() },
    { reason: ' padded ', excludedAt: now.toISOString() },
    { reason: 'a'.repeat(501), excludedAt: now.toISOString() },
    { reason: 'Skip', excludedAt: '' },
    { reason: 'Skip', excludedAt: '2026-02-30T22:00:00.000Z' },
    { reason: 'Skip', excludedAt: '2026-09-27' },
    null,
  ])('rejects invalid persisted metadata %j', (metadata) => {
    expect(isImportExclusion(metadata)).toBe(false);
  });

  it.each([
    ['Skip', ''], ['', now.toISOString()], ['a'.repeat(501), now.toISOString()], ['Skip', '2026-02-30T22:00:00.000Z'],
  ])('rejects incomplete or invalid CSV skip metadata', (reason, date) => {
    expect(() => importContactsCsv(`full_name,email,import_skip_reason,import_skipped_at\nNina Shah,nina@costco.example,${reason},${date}`)).toThrow(/invalid skip metadata/);
  });

  it('rejects CSV skip metadata on a merged row', () => {
    expect(() => importContactsCsv(`full_name,email,record_status,import_skip_reason,import_skipped_at\nNina Shah,nina@costco.example,merged,Skip,${now.toISOString()}`)).toThrow(/invalid skip metadata/);
  });
});
