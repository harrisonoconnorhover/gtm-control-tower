import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SuppressionRule } from '../lib/suppression';

const directory = mkdtempSync(join(tmpdir(), 'gtm-suppression-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'workspace.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'test-operator-key');
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const request = (body?: unknown, authorized = true) => new Request('http://localhost/api/control-tower/suppressions', {
  method: body ? 'POST' : 'GET', headers: { ...(authorized ? { 'x-control-tower-key': 'test-operator-key' } : {}), 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const responseRules = async (response: Response) => (await response.json() as { rules: SuppressionRule[] }).rules;

describe('saved suppression lists', () => {
  it('requires operator access and saves reusable rules without touching workspace revisions or CRM receipts', async () => {
    const { GET, POST } = await import('../app/api/control-tower/suppressions/route');
    const { createWorkspace, getWorkspace } = await import('../lib/workspace-store');
    const { getDatabase } = await import('../db');
    expect((await GET(request(undefined, false))).status).toBe(401);
    expect((await POST(request({ action: 'save', rule: { type: 'domain', value: 'example.com', reason: 'Vendor' } }, false))).status).toBe(401);
    const workspace = await createWorkspace('Local suppression sample');
    const db = await getDatabase();
    const beforeReceipts = await db.prepare('SELECT * FROM connector_runs').all();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('External calls are forbidden in this test.'); });
    try {
      const response = await POST(request({ action: 'save', rule: { listName: 'Vendors', type: 'domain', value: 'EXAMPLE.com', reason: 'Current vendor' } }));
      expect(response.status).toBe(200);
      expect(await responseRules(response)).toHaveLength(1);
      expect(await getWorkspace(workspace.id)).toEqual(workspace);
      expect(await db.prepare('SELECT * FROM connector_runs').all()).toEqual(beforeReceipts);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
    vi.resetModules();
    const { getSuppressionRules } = await import('../lib/suppression-store');
    expect(await getSuppressionRules()).toMatchObject([{ listName: 'Vendors', value: 'example.com', reason: 'Current vendor' }]);
  });

  it('reuses repeated imports unchanged, edits rules explicitly and removes only the selected rule', async () => {
    const { GET, POST } = await import('../app/api/control-tower/suppressions/route');
    const original = (await responseRules(await GET(request())))[0];
    const imported = await POST(request({ action: 'import', rules: [
      { listName: 'Vendors', type: 'domain', value: 'example.com', reason: 'Updated vendor reason' },
      { listName: 'Competitors', type: 'company_name', value: 'Other Company', reason: 'Competitor', enabled: false },
    ] }));
    expect(imported.status).toBe(200);
    const rules = await responseRules(imported);
    expect(rules).toHaveLength(2);
    const updated = rules.find((rule: { id: string }) => rule.id === original.id);
    expect(updated).toEqual(original);
    const edited = await POST(request({ action: 'save', rule: { ...updated, value: 'new.example.com', enabled: false } }));
    expect(edited.status).toBe(200);
    const disabled = (await responseRules(edited)).find((rule) => rule.id === original.id);
    expect(disabled).toMatchObject({ id: original.id, createdAt: original.createdAt, value: 'new.example.com', enabled: false });
    const reimported = await POST(request({ action: 'import', rules: [
      { listName: 'Vendors', type: 'domain', value: 'new.example.com', reason: 'Do not replace the reviewed reason', enabled: true },
      { listName: 'Vendors', type: 'domain', value: 'new.example.com', reason: 'Repeated within the CSV', enabled: true },
    ] }));
    expect((await responseRules(reimported)).find((rule) => rule.id === original.id)).toEqual(disabled);
    const deleted = await POST(request({ action: 'delete', id: original.id }));
    expect(deleted.status).toBe(200);
    expect(await responseRules(deleted)).toMatchObject([{ listName: 'Competitors' }]);
  });

  it('validates an entire import before writing and refuses stale edits or duplicate identities', async () => {
    const { GET, POST } = await import('../app/api/control-tower/suppressions/route');
    const before = await responseRules(await GET(request()));
    const failed = await POST(request({ action: 'import', rules: [
      { type: 'email', value: 'ada@example.com', reason: 'No outreach' },
      { type: 'email', value: 'broken', reason: 'No outreach' },
    ] }));
    expect(failed.status).toBe(400);
    expect(await responseRules(await GET(request()))).toEqual(before);
    expect((await POST(request({ action: 'save', rule: { id: 'missing', type: 'email', value: 'ada@example.com', reason: 'No outreach' } }))).status).toBe(400);
    const added = await responseRules(await POST(request({ action: 'save', rule: { listName: 'Competitors', type: 'company_name', value: 'Another Company', reason: 'Competitor' } })));
    const another = added.find((rule: { value: string }) => rule.value === 'another company');
    expect((await POST(request({ action: 'save', rule: { ...another, value: 'Other Company' } }))).status).toBe(400);
    expect(await responseRules(await GET(request()))).toEqual(added);
  });

  it('rejects unsupported persistence while keeping hosted reads compatible', async () => {
    vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'false');
    let route = await import('../app/api/control-tower/suppressions/route');
    expect((await route.GET(request())).status).toBe(503);
    vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
    vi.resetModules();
    const prepare = vi.fn(() => { throw new Error('Hosted reads must not create a SQLite table.'); });
    vi.doMock('../db', () => ({ getDatabase: async () => ({ kind: 'd1', prepare }), ensureWorkspaceSchema: async () => {} }));
    try {
      const { getSuppressionRules } = await import('../lib/suppression-store');
      expect(await getSuppressionRules()).toEqual([]);
      route = await import('../app/api/control-tower/suppressions/route');
      expect((await route.GET(request())).status).toBe(503);
      expect((await route.POST(request({ action: 'import', rules: [] }))).status).toBe(503);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../db');
      vi.resetModules();
    }
  });
});
