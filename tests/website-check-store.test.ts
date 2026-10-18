import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importContactsCsv } from '../lib/csv-control-tower';
import type { WebsiteCheckResult } from '../lib/website-check-types';

const directory = mkdtempSync(join(tmpdir(), 'gtm-website-checks-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'workspace.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

const check: WebsiteCheckResult = {
  url: 'https://example.com/', finalUrl: 'https://www.example.com/', status: 'reachable', method: 'http',
  httpStatus: 200, title: 'Example', detail: 'Page retrieved after redirect.', checkedAt: '2026-10-16T12:00:00.000Z',
};

describe('persistent website observations', () => {
  it('survives reload and older autosaves without changing workspace rows, revision, or CRM receipts', async () => {
    const { createWorkspace, getWorkspace, saveWorkspace } = await import('../lib/workspace-store');
    const { getWebsiteChecks, saveWebsiteCheck } = await import('../lib/website-check-store');
    const { getDatabase } = await import('../db');
    const created = await createWorkspace('Website review');
    const contacts = importContactsCsv('full_name,email,company,website\nAda Example,ada@example.com,Example,example.com').contacts;
    const saved = await saveWorkspace(created.id, { ...created.state, contacts, originalContacts: contacts });
    const db = await getDatabase();
    const runsBefore = await db.prepare('SELECT id, receipt_json FROM connector_runs WHERE workspace_id = ?').bind(created.id).all();
    await saveWebsiteCheck(created.id, check);
    expect(await getWebsiteChecks(created.id)).toEqual([check]);
    expect(await getWorkspace(created.id)).toEqual(saved);
    expect(await db.prepare('SELECT id, receipt_json FROM connector_runs WHERE workspace_id = ?').bind(created.id).all()).toEqual(runsBefore);
    await saveWorkspace(created.id, saved.state);
    expect(await getWebsiteChecks(created.id)).toEqual([check]);
    vi.resetModules();
    const reloadedStore = await import('../lib/website-check-store');
    expect(await reloadedStore.getWebsiteChecks(created.id)).toEqual([check]);
  });

  it('isolates workspaces and keeps only the newest result for each normalized URL', async () => {
    const { createWorkspace } = await import('../lib/workspace-store');
    const { getWebsiteChecks, saveWebsiteCheck } = await import('../lib/website-check-store');
    const first = await createWorkspace('First');
    const second = await createWorkspace('Second');
    await saveWebsiteCheck(first.id, check);
    const newer = { ...check, method: 'browser' as const, checkedAt: '2026-10-16T12:01:00.000Z' };
    await saveWebsiteCheck(first.id, newer);
    await saveWebsiteCheck(first.id, check);
    expect(await getWebsiteChecks(first.id)).toEqual([newer]);
    expect(await getWebsiteChecks(second.id)).toEqual([]);
  });
});
