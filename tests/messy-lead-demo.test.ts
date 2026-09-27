import { describe, expect, it } from 'vitest';
import { importContactsCsv, isDestinationReadyContact, previewContactsCsv } from '../lib/csv-control-tower';
import { messyLeadDemoCsv, previewMessyLeadDemo, runMessyLeadDemo } from '../lib/messy-lead-demo';

describe('64-row messy lead demonstration', () => {
  it('ships a deterministic, importable batch with multiple failure families', () => {
    const contacts = importContactsCsv(messyLeadDemoCsv()).contacts;
    const preview = previewMessyLeadDemo();

    expect(contacts).toHaveLength(64);
    expect(preview.duplicateRows).toBeGreaterThanOrEqual(7);
    expect(preview.routingExceptions).toBeGreaterThanOrEqual(5);
    expect(preview.lifecycleRegressions).toBeGreaterThanOrEqual(7);
    expect(preview.initiallyFlagged).toBeGreaterThanOrEqual(20);
  });

  it('uses shared raw-email normalization without supplying identity answers', () => {
    const csv = messyLeadDemoCsv();
    const contacts = importContactsCsv(csv).contacts;
    const byId = new Map(contacts.map((contact) => [contact.contactId, contact]));

    expect(previewContactsCsv(csv).headers).not.toContain('normalized_email');
    expect(byId.get('LAB-042')).toMatchObject({
      rawEmail: 'signal@mañana.example',
      normalizedEmail: 'signal@xn--maana-pta.example',
    });
    expect(byId.get('LAB-008')).toMatchObject({
      rawEmail: 'LEAD7+ROADSHOW@ACME.EXAMPLE',
      normalizedEmail: 'lead7+roadshow@acme.example',
    });
    expect(byId.get('LAB-008')?.qualityFlags).not.toContain('duplicate_identity');
    expect(byId.get('LAB-008')?.normalizedEmail).not.toBe(byId.get('LAB-007')?.normalizedEmail);
    expect(byId.get('LAB-016')?.normalizedEmail).toBe(byId.get('LAB-015')?.normalizedEmail);
    expect(byId.get('LAB-016')?.qualityFlags).toContain('duplicate_identity');
  });

  it('executes merge, reroute, and replay while holding unresolved rows', () => {
    const result = runMessyLeadDemo();

    expect(result).toMatchObject({
      rawRows: 64,
      mergedRows: 7,
      reroutedRows: 11,
      replayedRows: 8,
      activeRows: 57,
      readyRows: 46,
      heldRows: 11,
    });
    expect(result.mergedRows).toBe(result.duplicateRows);
    expect(result.reroutedRows).toBeGreaterThan(0);
    expect(result.replayedRows).toBe(result.lifecycleRegressions);
    expect(result.activeRows).toBe(64 - result.mergedRows);
    expect(result.readyRows + result.heldRows).toBe(result.activeRows);
    expect(result.afterQuality).toBeGreaterThan(result.beforeQuality);
    expect(result.initialContacts).toHaveLength(64);
    expect(result.repairedContacts).toHaveLength(64);
    expect(result.initialContacts.every((contact) => contact.recordStatus === 'active')).toBe(true);
    expect(result.repairedContacts.map((contact) => contact.contactId))
      .toEqual(result.initialContacts.map((contact) => contact.contactId));
    expect(result.repairedContacts.filter(isDestinationReadyContact)).toHaveLength(result.readyRows);
  });
});
