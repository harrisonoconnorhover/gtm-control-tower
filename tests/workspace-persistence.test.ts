import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportContactsCsv, importContactsCsv, type CsvContactCorrection } from '../lib/csv-control-tower';
import { defaultCrmUpdatePolicy, type CrmUpdatePolicy } from '../lib/crm-workflow';
import { excludeImportRow, restoreImportRow } from '../lib/import-exclusions';
import type { LiveContactState } from '../lib/live-control-tower';
import { importPomadeHandoff } from '../lib/pomade-handoff';
import { emptyWorkspaceState, validateWorkspaceState } from '../lib/workspace';

const acceptanceDirectory = mkdtempSync(join(tmpdir(), 'gtm-control-tower-corrections-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(acceptanceDirectory, 'workspace.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(acceptanceDirectory, { recursive: true, force: true });
});

describe('workspace correction history', () => {
  it('loads legacy snapshots without correction history as an empty history', async () => {
    expect(emptyWorkspaceState().correctionHistory).toEqual([]);
    const legacyState = { contacts: [], originalContacts: [], repairHistory: [] };
    expect(validateWorkspaceState(legacyState).correctionHistory).toEqual([]);
    expect(validateWorkspaceState(legacyState).crmUpdatePolicy).toEqual(defaultCrmUpdatePolicy());
    expect(validateWorkspaceState(legacyState).crmUpdatePolicy?.mode).toBe('fill-empty');

    const { createWorkspace, getWorkspace } = await import('../lib/workspace-store');
    const { getDatabase } = await import('../db');
    const workspace = await createWorkspace('Legacy snapshot');
    const db = await getDatabase();
    await db.prepare('UPDATE workspace_state_chunks SET payload = ? WHERE workspace_id = ? AND revision = 0')
      .bind(JSON.stringify(legacyState), workspace.id).run();

    const loaded = await getWorkspace(workspace.id);
    expect(loaded?.state.correctionHistory).toEqual([]);
    expect(loaded?.state.crmUpdatePolicy).toEqual(defaultCrmUpdatePolicy());
  });

  it('saves and reloads correction evidence, then restores matching contacts and history on undo', async () => {
    const { createWorkspace, saveWorkspace, getWorkspace, undoWorkspace } = await import('../lib/workspace-store');
    const workspace = await createWorkspace('Reviewed contact correction');
    const before: LiveContactState = {
      contactId: 'held-1', fullName: 'Ada Example', rawEmail: 'ada.example', normalizedEmail: null,
      company: 'Example', region: 'West', segment: 'SMB', lifecycleStage: 'Lead', expectedLifecycleStage: 'Lead',
      ownerId: 'owner-1', canonicalContactId: null, recordStatus: 'active', lastAction: 'imported',
      qualityFlags: ['invalid_email'], updatedAt: '2026-09-27T12:00:00.000Z',
    };
    const after: LiveContactState = {
      ...before, rawEmail: 'ada@example.test', normalizedEmail: 'ada@example.test', qualityFlags: [],
      lastAction: 'reviewed_correction', updatedAt: '2026-09-27T12:01:00.000Z',
    };
    const correction: CsvContactCorrection = {
      id: 'correction-1', contactId: before.contactId, reviewedAt: after.updatedAt,
      reason: 'Corrected the supplied email after review.', before, after,
    };
    const initial = await saveWorkspace(workspace.id, {
      ...emptyWorkspaceState(), contacts: [before], originalContacts: [before],
    });
    const saved = await saveWorkspace(workspace.id, {
      ...initial.state, contacts: [after], correctionHistory: [correction],
    }, 'contact_corrected');

    expect(saved.revision).toBe(initial.revision + 1);
    expect(saved.state.correctionHistory).toEqual([correction]);
    expect((await getWorkspace(workspace.id))?.state).toEqual(saved.state);
    expect(saved.state.originalContacts).toEqual([before]);

    const undone = await undoWorkspace(workspace.id);
    expect(undone.revision).toBe(initial.revision);
    expect(undone.state.contacts).toEqual([before]);
    expect(undone.state.originalContacts).toEqual([before]);
    expect(undone.state.correctionHistory).toEqual([]);
  });
});

describe('persisted import decisions and update policy', () => {
  const now = new Date('2026-09-27T22:00:00.000Z');
  const source = () => importContactsCsv('contact_id,full_name,email,company,owner_id\nKEEP,Nina Shah,nina@costco.example,Costco,owner-1\nSKIP,Nina Shah,nina@costco.example,Costco,owner-1').contacts;

  it('saves, reloads, restores, and undoes skip decisions and the selected CRM policy in SQLite', async () => {
    const { createWorkspace, saveWorkspace, getWorkspace, undoWorkspace } = await import('../lib/workspace-store');
    const workspace = await createWorkspace('Import row decisions');
    const contacts = source();
    const initial = await saveWorkspace(workspace.id, {
      ...emptyWorkspaceState(), contacts, originalContacts: contacts,
    });
    const policy: CrmUpdatePolicy = { mode: 'replace', fields: ['phone'], clearBlanks: true };
    const excluded = excludeImportRow(initial.state.contacts, 'SKIP', 'Duplicate registration; retain KEEP', now);
    const exported = importContactsCsv(exportContactsCsv(excluded)).contacts;
    expect(exported[1].qualityFlags).toEqual(contacts[1].qualityFlags);
    expect(exported[1].qualityFlags).toContain('duplicate_identity');
    expect(exported[0].qualityFlags).not.toContain('duplicate_identity');
    const skipped = await saveWorkspace(workspace.id, {
      ...initial.state, contacts: excluded, crmUpdatePolicy: policy,
    }, 'import_row_skipped');
    expect((await getWorkspace(workspace.id))?.state).toEqual(skipped.state);
    expect(skipped.state.contacts[1].importExclusion).toEqual({ reason: 'Duplicate registration; retain KEEP', excludedAt: now.toISOString() });
    expect(skipped.state.originalContacts).toEqual(contacts);
    expect(skipped.state.crmUpdatePolicy).toEqual(policy);

    const restored = await saveWorkspace(workspace.id, {
      ...skipped.state, contacts: restoreImportRow(skipped.state.contacts, 'SKIP', new Date('2026-09-27T22:01:00.000Z')),
    }, 'import_row_restored');
    const reloaded = await getWorkspace(workspace.id);
    expect(reloaded?.state).toEqual(restored.state);
    expect(reloaded?.state.contacts[1]).not.toHaveProperty('importExclusion');
    expect(reloaded?.state.contacts[0].qualityFlags).toContain('duplicate_identity');
    expect(reloaded?.state.crmUpdatePolicy).toEqual(policy);

    const undoRestore = await undoWorkspace(workspace.id);
    expect(undoRestore.revision).toBe(skipped.revision);
    expect(undoRestore.state).toEqual(skipped.state);
    const undoSkip = await undoWorkspace(workspace.id);
    expect(undoSkip.revision).toBe(initial.revision);
    expect(undoSkip.state).toEqual(initial.state);
    expect(undoSkip.state.crmUpdatePolicy).toEqual(defaultCrmUpdatePolicy());
  });

  it('rejects invalid skip reason, date, or merged status without advancing the saved revision', async () => {
    const { createWorkspace, saveWorkspace, getWorkspace } = await import('../lib/workspace-store');
    const workspace = await createWorkspace('Invalid import decisions');
    const contacts = source();
    const initial = await saveWorkspace(workspace.id, { ...emptyWorkspaceState(), contacts, originalContacts: contacts });
    for (const [field, recordStatus, reason, excludedAt] of [
      ['contacts', 'active', ' ', now.toISOString()],
      ['originalContacts', 'active', 'Duplicate', '2026-02-30T22:00:00.000Z'],
      ['contacts', 'merged', 'Duplicate', now.toISOString()],
    ] as const) {
      const invalid = { ...initial.state, [field]: [{ ...contacts[0], recordStatus, importExclusion: { reason, excludedAt } }] };
      await expect(saveWorkspace(workspace.id, invalid)).rejects.toThrow(/Skipped import rows require/);
      const unchanged = await getWorkspace(workspace.id);
      expect(unchanged?.revision).toBe(initial.revision);
      expect(unchanged?.state).toEqual(initial.state);
    }
  });
});


it('saves and reloads Pomade source context separately from writable contact values in SQLite', async () => {
  const { createWorkspace, saveWorkspace, getWorkspace } = await import('../lib/workspace-store');
  const workspace = await createWorkspace('Optional Pomade proposal');
  const { contacts } = await importPomadeHandoff({ source: 'pomade', schemaVersion: 1,
    exportId: 'export-sqlite', exportedAt: '2026-09-28T12:00:00.000Z', sourceInstanceId: 'fictional-install',
    workspaceId: 'research-table', workspaceName: 'Research table', sourceRevision: null, mode: 'preview',
    destination: { provider: 'hubspot', objectType: 'contact' }, guards: { maxRecords: 100, allowCreate: false }, fieldMappings: [],
    records: [{ rowId: 'row-1', externalKey: 'context-only', sourceStatus: 'Review', reviewReason: 'Review title',
      proposedFields: { fullName: 'Priya Nair', email: 'priya@example.com', jobTitle: 'Director' },
      evidence: [{ field: 'jobTitle', value: 'Director', sourceUrl: null, quote: null, observedAt: null, reference: 'Manual fictional fixture' }] }],
  });
  const saved = await saveWorkspace(workspace.id, { ...emptyWorkspaceState(), contacts, originalContacts: contacts, sourceLabel: 'Pomade · Research table' });
  const reloaded = await getWorkspace(workspace.id);
  expect(reloaded?.state).toEqual(saved.state);
  expect(reloaded?.state.contacts[0].sourceOrigins![0]).toMatchObject({ allowCreate: false, proposedFields: { jobTitle: 'Director' }, evidence: [{ field: 'jobTitle' }] });
  expect(reloaded?.state.contacts[0].importExclusion?.reason).toContain('Review title');
});
