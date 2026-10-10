import { describe, expect, it, vi } from 'vitest';
import { createOwnedNativeSource } from '../scripts/native-incident-monitor.mjs';

function setup() {
  const nativeRecord = { id: '42', objectType: 'Contact', provider: 'hubspot', properties: { jobtitle: ' Director ', email: 'fictional@example.com' }, updatedAt: '2026-10-10T10:00:00Z' };
  const source = {
    provider: 'hubspot', accountId: 'fixture', capabilities: vi.fn(),
    list: vi.fn(), changes: vi.fn(), read: vi.fn(async () => nativeRecord), patch: vi.fn(async () => {}),
  };
  const verifyOwnership = vi.fn(async (record: { nativeId: string; objectType: string }) => { void record; }), onObservation = vi.fn(), onMutation = vi.fn();
  const repairPlans = new Map([['Contact:42', { before: { jobtitle: ' Director ' }, after: { jobtitle: 'Director' } }]]);
  const owned = createOwnedNativeSource(source, { records: [{ fixtureId: '100025', nativeId: '42', objectType: 'Contact' }], verifyOwnership, onObservation, onMutation, repairPlans });
  return { source, owned, nativeRecord, verifyOwnership, onObservation, onMutation, repairPlans };
}

describe('native qualification cohort boundary', () => {
  it('drains unrelated native pages while preserving cursor, totals, and native record shape', async () => {
    const { source, owned, nativeRecord, verifyOwnership } = setup();
    source.list.mockResolvedValueOnce({ contacts: [{ ...nativeRecord, id: '7' }], after: 'Contact:7', total: 31 });
    source.list.mockResolvedValueOnce({ contacts: [nativeRecord], after: 'Company:1', total: 31 });
    expect(await owned.list(null)).toEqual({ contacts: [nativeRecord], after: 'Company:1', total: 31 });
    expect(source.list.mock.calls).toEqual([[null], ['Contact:7']]);
    expect(verifyOwnership).toHaveBeenCalledTimes(1);
    expect(verifyOwnership.mock.calls[0][0]).toMatchObject({ nativeId: '42', objectType: 'Contact' });
  });

  it('preserves native change window and terminates an entirely unrelated scan', async () => {
    const { source, owned, nativeRecord } = setup();
    source.changes.mockResolvedValueOnce({ contacts: [{ ...nativeRecord, id: '7' }], after: 'Contact:7', total: 1 });
    source.changes.mockResolvedValueOnce({ contacts: [], after: null, total: 1 });
    expect(await owned.changes('from', 'through', null)).toEqual({ contacts: [], after: null, total: 1 });
    expect(source.changes.mock.calls).toEqual([['from', 'through', null], ['from', 'through', 'Contact:7']]);
  });

  it('checks page ownership in batches of four while preserving native order', async () => {
    const { source, nativeRecord } = setup();
    const records = Array.from({ length: 6 }, (_, index) => ({ nativeId: String(index + 40), objectType: 'Contact' }));
    const contacts = records.map((record) => ({ ...nativeRecord, id: record.nativeId }));
    source.list.mockResolvedValueOnce({ contacts: [contacts[0], { ...nativeRecord, id: 'outside' }, ...contacts.slice(1)], after: 'next-native-page' });
    const releases: (() => void)[] = [];
    let active = 0, maximum = 0;
    const verifyOwnership = vi.fn(async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => { releases.push(() => { active--; resolve(); }); });
    });
    const owned = createOwnedNativeSource(source, { records, verifyOwnership });
    const page = owned.list(null);
    await vi.waitFor(() => expect(releases.length).toBe(4));
    releases.slice(0, 4).reverse().forEach((release) => release());
    await vi.waitFor(() => expect(releases.length).toBe(6));
    releases.slice(4).reverse().forEach((release) => release());
    expect(await page).toEqual({ contacts, after: 'next-native-page' });
    expect(maximum).toBe(4);
    expect(verifyOwnership).toHaveBeenCalledTimes(6);
  });

  it('rejects repeated native cursors and never returns a filtered empty continuation', async () => {
    const { source, owned } = setup();
    source.list.mockResolvedValue({ contacts: [], after: 'same' });
    await expect(owned.list(null)).rejects.toThrow('repeated page cursor');
    expect(source.list).toHaveBeenCalledTimes(2);
  });

  it('rejects unowned reads, writes, and object-type collisions before native calls', async () => {
    const { source, owned, verifyOwnership } = setup();
    await expect(owned.read('7', 'Contact')).rejects.toThrow('outside its manifest');
    await expect(owned.patch('42', { name: 'Changed' }, 'Company')).rejects.toThrow('outside its manifest');
    expect(verifyOwnership).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();
    expect(source.patch).not.toHaveBeenCalled();
  });

  it('checks ownership and fresh state before sending the exact supported repair', async () => {
    const { source, owned, verifyOwnership, onMutation } = setup();
    await owned.patch('42', { jobtitle: 'Director' }, 'Contact');
    expect(verifyOwnership).toHaveBeenCalledTimes(1);
    expect(source.read).toHaveBeenCalledWith('42', 'Contact');
    expect(source.patch).toHaveBeenCalledWith('42', { jobtitle: 'Director' }, 'Contact');
    expect(onMutation).toHaveBeenCalledTimes(1);
    await expect(owned.patch('42', { jobtitle: 'VP' }, 'Contact')).rejects.toThrow('differs');
    expect(source.patch).toHaveBeenCalledTimes(1);
  });

  it('holds a repair when its marker is lost or its fresh native value changes', async () => {
    const { source, owned, verifyOwnership, nativeRecord } = setup();
    verifyOwnership.mockRejectedValueOnce(new Error('Ownership marker missing'));
    await expect(owned.patch('42', { jobtitle: 'Director' }, 'Contact')).rejects.toThrow('Ownership marker missing');
    source.read.mockResolvedValueOnce({ ...nativeRecord, properties: { ...nativeRecord.properties, jobtitle: 'VP' } });
    await expect(owned.patch('42', { jobtitle: 'Director' }, 'Contact')).rejects.toThrow('baseline changed');
    expect(source.patch).not.toHaveBeenCalled();
  });

  it('verifies native protected fields absent from monitor observations after the real patch', async () => {
    const { source, nativeRecord } = setup();
    const before = { id: '42', properties: { jobtitle: ' Director ', phone: '+12025550101', email: 'fictional@example.com', message: 'owned marker' } };
    const after = { ...before, properties: { ...before.properties, jobtitle: 'Director' } };
    const verifyOwnership = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after), onMutation = vi.fn();
    const owned = createOwnedNativeSource(source, { records: [{ nativeId: '42', objectType: 'Contact' }], verifyOwnership, onMutation,
      repairPlans: new Map([['Contact:42', { before: { jobtitle: nativeRecord.properties.jobtitle }, after: { jobtitle: 'Director' } }]]) });
    await owned.patch('42', { jobtitle: 'Director' }, 'Contact');
    expect(source.patch).toHaveBeenCalledTimes(1);
    expect(verifyOwnership).toHaveBeenCalledTimes(2);
    expect(onMutation.mock.calls[0][0].protectedReadback).toEqual({ verified: true, checkedFields: ['email', 'jobtitle', 'message', 'phone'] });
  });

  it('reports uncertain outcome when a native protected phone changes during a supported repair', async () => {
    const { source } = setup();
    const before = { id: '42', properties: { Title: ' Director ', Phone: '+12025550101', Description: 'owned marker' } };
    const after = { ...before, properties: { ...before.properties, Title: 'Director', Phone: '+12025550102' } };
    source.provider = 'salesforce';
    const verifyOwnership = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const owned = createOwnedNativeSource(source, { records: [{ nativeId: '42', objectType: 'Contact' }], verifyOwnership,
      repairPlans: new Map([['Contact:42', { before: { jobtitle: ' Director ' }, after: { jobtitle: 'Director' } }]]) });
    await expect(owned.patch('42', { jobtitle: 'Director' }, 'Contact')).rejects.toThrow('Protected native fields changed');
    expect(source.patch).toHaveBeenCalledTimes(1);
  });
});
