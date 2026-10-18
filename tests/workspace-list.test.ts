import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET } from '../app/api/control-tower/workspaces/route';
import { createWorkspace, listSavedWorkspaces } from '../lib/workspace-store';

const directory = mkdtempSync(join(tmpdir(), 'gtm-workspace-list-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'workspace.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'synthetic-list-key');
const request = (query = '', key = 'synthetic-list-key') => new Request(`http://localhost/api/control-tower/workspaces${query}`, {
  headers: { 'x-control-tower-key': key },
});
beforeAll(async () => {
  await createWorkspace('First saved CSV');
  await createWorkspace('Second saved CSV');
  await createWorkspace('Third saved CSV');
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('saved workspace metadata listing', () => {
  it('lists workspaces independently of Inbox uploads with stable pagination and no row data', async () => {
    const first = await listSavedWorkspaces({ limit: 2 });
    const second = await listSavedWorkspaces({ limit: 2, offset: 2 });
    expect(first.pagination).toEqual({ total: 3, offset: 0, limit: 2, nextOffset: 2 });
    expect(second.pagination).toEqual({ total: 3, offset: 2, limit: 2, nextOffset: null });
    expect(new Set([...first.workspaces, ...second.workspaces].map((workspace) => workspace.id)).size).toBe(3);
    expect(first.workspaces[0]).toMatchObject({ revision: 0, sourceType: 'csv', destinationType: 'csv' });
    expect(first.workspaces[0]).not.toHaveProperty('state');
    expect(await listSavedWorkspaces({ offset: 20 })).toMatchObject({ workspaces: [], pagination: { total: 3, nextOffset: null } });
  });

  it('requires the operator key and returns uncached metadata through the real route', async () => {
    expect((await GET(request('', 'wrong-key'))).status).toBe(401);
    const response = await GET(request('?limit=1&offset=1'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ pagination: { total: 3, limit: 1, offset: 1, nextOffset: 2 } });
  });

  it('rejects out-of-range pagination in the route and direct helper', async () => {
    for (const query of ['?limit=101', '?limit=0', '?offset=-1', '?offset=1.5', '?limit=wrong']) {
      expect((await GET(request(query))).status).toBe(400);
    }
    await expect(listSavedWorkspaces({ limit: 101 })).rejects.toThrow(/limit/);
    await expect(listSavedWorkspaces({ offset: -1 })).rejects.toThrow(/offset/);
  });
});
