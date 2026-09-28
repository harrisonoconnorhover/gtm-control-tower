import { describe, expect, it } from 'vitest';
import { importPomadeHandoff, isPomadeContactId, validPomadeOrigins } from '../lib/pomade-handoff';
import { correctCsvContact, executeCsvRepair, importContactsCsv } from '../lib/csv-control-tower';
import { emptyWorkspaceState, validateWorkspaceState } from '../lib/workspace';
import { restoreImportRow } from '../lib/import-exclusions';
import { isHubSpotEligible, toHubSpotSyncContact } from '../lib/hubspot-sync';

function handoff() {
  return { source: 'pomade', schemaVersion: 1, exportId: 'export-1', exportedAt: '2026-09-28T10:00:00.000Z', sourceInstanceId: 'install-a',
    workspaceId: 'table-1', workspaceName: 'Research', sourceRevision: null, mode: 'preview', destination: { provider: 'hubspot', objectType: 'contact' },
    fieldMappings: [{ sourceColumnId: 'email', sourceColumnTitle: 'Email', contactField: 'email', destinationFields: ['email'] }],
    guards: { maxRecords: 100, allowCreate: false }, records: [{ rowId: 'row-1', externalKey: 'hubspot:123',
      sourceStatus: 'Ready', reviewReason: null as string | null,
      proposedFields: { fullName: 'Priya Nair', email: ' PRIYA@example.com ', company: 'Example', jobTitle: '', phone: null },
      evidence: [{ field: 'email', value: ' PRIYA@example.com ', sourceUrl: 'https://example.com/team', quote: null, observedAt: null, reference: 'manual input' }] }] };
}

it('normalizes all proposals through the CSV path, preserves context, and imports no approvals or native IDs', async () => {
  const input = handoff();
  const parsed = await importPomadeHandoff(JSON.stringify(input));
  const row = parsed.contacts[0];
  expect(row).toMatchObject({ fullName: 'Priya Nair', normalizedEmail: 'priya@example.com', company: 'Example', phone: null, jobTitle: null,
    sourceOrigins: [{ source: 'pomade', allowCreate: false, rowId: 'row-1', externalKey: 'hubspot:123', proposedFields: { phone: null, jobTitle: null }, evidence: input.records[0].evidence }] });
  expect(row).not.toHaveProperty('crmMatchDecisions');
  expect(row).not.toHaveProperty('nativeId');
  expect(row.contactId.length).toBeLessThanOrEqual(120);
  expect(isPomadeContactId(row.contactId)).toBe(true);
  expect(validPomadeOrigins(row.sourceOrigins)).toBe(true);
  expect(parsed).toMatchObject({ sourceRows: 1, workspaceName: 'Research', warnings: [] });
});

it('uses stable source identities across exports but separates installations', async () => {
  const first = await importPomadeHandoff(handoff());
  const next = handoff();
  next.exportId = 'export-2';
  expect((await importPomadeHandoff(next)).contacts[0].contactId).toBe(first.contacts[0].contactId);
  next.sourceInstanceId = 'install-b';
  expect((await importPomadeHandoff(next)).contacts[0].contactId).not.toBe(first.contacts[0].contactId);
});

it('labels legacy unknowns and namespaces every loaded legacy import independently', async () => {
  const input = handoff();
  const legacy = { source: input.source, workspaceId: input.workspaceId, mode: input.mode, destination: input.destination,
    fieldMappings: input.fieldMappings, guards: input.guards,
    records: input.records.map(({ rowId, externalKey, proposedFields }) => ({ rowId, externalKey, proposedFields })) };
  const first = await importPomadeHandoff(legacy);
  const second = await importPomadeHandoff(legacy);
  expect(first.contacts[0].contactId).not.toBe(second.contacts[0].contactId);
  expect(first.contacts[0].sourceOrigins![0]).toMatchObject({ schemaVersion: null, exportedAt: null, sourceInstanceId: null, sourceStatus: null, evidence: [] });
  expect(first.warnings[0]).toContain('unknown');
});

it('keeps company-only and entirely empty source rows visible without inventing contact identity', async () => {
  const input = handoff();
  input.records = input.records.map((row) => ({ ...row, proposedFields: { fullName: '', email: '', company: 'Example', jobTitle: '', phone: null } }));
  input.records.push({ ...input.records[0], rowId: 'empty', proposedFields: { fullName: '', email: '', company: '', jobTitle: '', phone: null } });
  const imported = await importPomadeHandoff(input);
  expect(imported.sourceRows).toBe(2);
  for (const row of imported.contacts) {
    expect(row.fullName).toBe('');
    expect(row.normalizedEmail).toBeNull();
    expect(isHubSpotEligible(row)).toBe(false);
    expect(() => toHubSpotSyncContact(row)).toThrow();
  }
});

it.each(['Review', 'Failed', 'Stale', 'Error'])('preserves %s as an existing review exclusion until explicitly restored', async (status) => {
  const input = handoff();
  input.records[0].sourceStatus = status;
  input.records[0].reviewReason = 'Identity needs review';
  const { contacts } = await importPomadeHandoff(input);
  expect(contacts[0].importExclusion?.reason).toContain('Identity needs review');
  expect(isHubSpotEligible(contacts[0])).toBe(false);
  const restored = restoreImportRow(contacts, contacts[0].contactId);
  expect(restored[0].importExclusion).toBeUndefined();
  expect(restored[0].sourceOrigins).toEqual(contacts[0].sourceOrigins);
});

it('preserves contributing origins through correction, local merge, and workspace serialization', async () => {
  const input = handoff();
  input.records.push({ ...input.records[0], rowId: 'row-2', externalKey: 'another-key' });
  const { contacts } = await importPomadeHandoff(input);
  const merged = executeCsvRepair(contacts, 'duplicate-surge').contacts;
  const canonical = merged.find((row) => row.recordStatus === 'active')!;
  expect(canonical.sourceOrigins!.map((origin) => origin.rowId).sort()).toEqual(['row-1', 'row-2']);
  const corrected = correctCsvContact(merged, canonical.contactId, { rawEmail: 'priya.changed@example.com', company: canonical.company ?? '', ownerId: 'OWNER-1', lifecycleStage: canonical.lifecycleStage }, 'Reviewed changed address').contacts;
  const saved = validateWorkspaceState(JSON.parse(JSON.stringify({ ...emptyWorkspaceState(), contacts: corrected, originalContacts: contacts })));
  expect(saved.contacts.find((row) => row.recordStatus === 'active')!.sourceOrigins).toEqual(canonical.sourceOrigins);
  expect(canonical.sourceOrigins![0].proposedFields.email).toBe(' PRIYA@example.com ');
});

it('leaves old CSV workspaces without Pomade metadata unchanged and rejects malformed scope metadata', async () => {
  const contacts = importContactsCsv('full_name,email,company\nPriya Nair,priya@example.com,Example').contacts;
  expect(validateWorkspaceState({ ...emptyWorkspaceState(), contacts }).contacts[0]).not.toHaveProperty('sourceOrigins');
  const parsed = await importPomadeHandoff(handoff());
  Reflect.set(parsed.contacts[0].sourceOrigins![0], 'allowCreate', true);
  expect(() => validateWorkspaceState({ ...emptyWorkspaceState(), contacts: parsed.contacts })).toThrow('updates-only');
});

describe('whole-package failures', () => {
  it.each(['version', 'duplicate rows', 'oversized rows', 'control field', 'normalized override', 'creation scope', 'invalid evidence'])(
    'rejects %s without partial results', async (failure) => {
      const input = handoff();
      if (failure === 'version') input.schemaVersion = 99;
      if (failure === 'duplicate rows') input.records.push(structuredClone(input.records[0]));
      if (failure === 'oversized rows') input.records = Array.from({ length: 101 }, (_, index) => ({ ...input.records[0], rowId: String(index) }));
      if (failure === 'control field') Reflect.set(input.records[0], 'nativeId', '123');
      if (failure === 'normalized override') Reflect.set(input.records[0].proposedFields, 'normalizedEmail', 'override@example.com');
      if (failure === 'creation scope') input.guards.allowCreate = true;
      if (failure === 'invalid evidence') input.records[0].evidence[0].sourceUrl = 'javascript:alert(1)';
      await expect(importPomadeHandoff(input)).rejects.toThrow();
    });
});
