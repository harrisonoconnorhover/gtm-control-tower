import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CsvContactCorrection } from '../lib/csv-control-tower';
import type { LiveContactState } from '../lib/live-control-tower';
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

    const { createWorkspace, getWorkspace } = await import('../lib/workspace-store');
    const { getDatabase } = await import('../db');
    const workspace = await createWorkspace('Legacy snapshot');
    const db = await getDatabase();
    await db.prepare('UPDATE workspace_state_chunks SET payload = ? WHERE workspace_id = ? AND revision = 0')
      .bind(JSON.stringify(legacyState), workspace.id).run();

    expect((await getWorkspace(workspace.id))?.state.correctionHistory).toEqual([]);
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
