import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importContactsCsv } from '../lib/csv-control-tower';
import { emptyWorkspaceState, type SavedWorkspace } from '../lib/workspace';
import type { WebsiteCheckResult } from '../lib/website-check-types';

const dependencies = vi.hoisted(() => ({
  getDatabase: vi.fn(), getWorkspace: vi.fn(), persistenceEnabled: vi.fn(),
  getWebsiteChecks: vi.fn(), saveWebsiteCheck: vi.fn(), checkWebsite: vi.fn(),
}));
vi.mock('../db', () => ({ getDatabase: dependencies.getDatabase }));
vi.mock('../lib/workspace-store', () => ({ getWorkspace: dependencies.getWorkspace, persistenceEnabled: dependencies.persistenceEnabled }));
vi.mock('../lib/website-check-store', () => ({ getWebsiteChecks: dependencies.getWebsiteChecks, saveWebsiteCheck: dependencies.saveWebsiteCheck }));
vi.mock('../lib/website-checker', () => ({ checkWebsite: dependencies.checkWebsite }));
import { GET, POST } from '../app/api/control-tower/website-checks/route';

const url = 'https://example.com/';
const check: WebsiteCheckResult = {
  url, finalUrl: url, status: 'reachable', method: 'http', httpStatus: 200,
  title: 'Example', detail: 'Page retrieved.', checkedAt: '2026-10-16T12:00:00.000Z',
};
const contacts = importContactsCsv('full_name,email,company,website\nAda Example,ada@example.com,Example,example.com').contacts;
const workspace: SavedWorkspace = {
  id: 'workspace-1', name: 'Event list', revision: 4, presets: [],
  createdAt: check.checkedAt, updatedAt: check.checkedAt,
  state: { ...emptyWorkspaceState(), contacts, originalContacts: contacts },
};
const request = (overrides: Record<string, unknown> = {}, headers = {}) => new Request('http://localhost/api/control-tower/website-checks', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ workspaceId: workspace.id, urls: [url], ...overrides }),
});
const getRequest = (headers = {}) => new Request(`http://localhost/api/control-tower/website-checks?workspaceId=${workspace.id}`, { headers });

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CONTROL_TOWER_SYNC_KEY', '');
  dependencies.getDatabase.mockResolvedValue({ kind: 'sqlite' });
  dependencies.getWorkspace.mockResolvedValue(workspace);
  dependencies.persistenceEnabled.mockReturnValue(true);
  dependencies.getWebsiteChecks.mockResolvedValue([]);
  dependencies.saveWebsiteCheck.mockResolvedValue(undefined);
  dependencies.checkWebsite.mockResolvedValue(check);
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe('saved website check endpoint', () => {
  it('normalizes a saved website, checks it, and persists the observation before responding', async () => {
    const response = await POST(request({ urls: ['example.com'] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ checks: [check] });
    expect(dependencies.checkWebsite).toHaveBeenCalledExactlyOnceWith(url);
    expect(dependencies.saveWebsiteCheck).toHaveBeenCalledExactlyOnceWith(workspace.id, check);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('reuses saved results unless an explicit recheck is requested', async () => {
    dependencies.getWebsiteChecks.mockResolvedValue([check]);
    expect(await (await POST(request())).json()).toEqual({ checks: [check] });
    expect(dependencies.checkWebsite).not.toHaveBeenCalled();
    expect(dependencies.saveWebsiteCheck).not.toHaveBeenCalled();
    expect((await POST(request({ recheck: true }))).status).toBe(200);
    expect(dependencies.checkWebsite).toHaveBeenCalledOnce();
  });

  it('reloads only checks for current active, included rows', async () => {
    dependencies.getWebsiteChecks.mockResolvedValue([check, { ...check, url: 'https://old.example.com/' }]);
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ checks: [check] });
    expect(dependencies.checkWebsite).not.toHaveBeenCalled();
  });

  it.each([
    { urls: ['https://unrelated.example.com/'] }, { urls: ['file:///etc/passwd'] },
    { urls: [] }, { urls: [url, url] }, { urls: [url, 'example.com'] },
    { urls: ['a.com', 'b.com', 'c.com', 'd.com'] }, { urls: ['x'.repeat(2049)] },
    { urls: [42] }, { recheck: 'yes' }, { workspaceId: '' },
  ])('rejects arbitrary or malformed fetch requests without making a network call', async (overrides) => {
    expect([400, 409]).toContain((await POST(request(overrides))).status);
    expect(dependencies.checkWebsite).not.toHaveBeenCalled();
  });

  it.each([
    { recordStatus: 'merged' },
    { importExclusion: { reason: 'Not a prospect', excludedAt: check.checkedAt } },
  ])('does not fetch websites belonging only to merged or skipped rows', async (rowOverride) => {
    dependencies.getWorkspace.mockResolvedValue({ ...workspace, state: { ...workspace.state, contacts: [{ ...contacts[0], ...rowOverride }] } });
    expect((await POST(request())).status).toBe(409);
    expect(dependencies.checkWebsite).not.toHaveBeenCalled();
  });

  it('does not save an obsolete result after its website is removed during the request', async () => {
    dependencies.getWorkspace.mockResolvedValueOnce(workspace).mockResolvedValue({ ...workspace, state: emptyWorkspaceState() });
    expect((await POST(request())).status).toBe(409);
    expect(dependencies.saveWebsiteCheck).not.toHaveBeenCalled();
  });

  it('reports a persistence failure instead of claiming the check was saved', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    dependencies.saveWebsiteCheck.mockRejectedValue(new Error('disk full'));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/completed and saved/) });
    consoleError.mockRestore();
  });

  it('requires the operator key before reading data or checking websites', async () => {
    vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'local-test-key');
    expect((await GET(getRequest())).status).toBe(401);
    expect((await POST(request())).status).toBe(401);
    expect(dependencies.getWorkspace).not.toHaveBeenCalled();
    expect(dependencies.checkWebsite).not.toHaveBeenCalled();
    expect((await POST(request({}, { 'x-control-tower-key': 'local-test-key' }))).status).toBe(200);
  });

  it('refuses the public preview and non-SQLite deployments', async () => {
    dependencies.persistenceEnabled.mockReturnValue(false);
    expect((await GET(getRequest())).status).toBe(503);
    expect((await POST(request())).status).toBe(503);
    expect(dependencies.getDatabase).not.toHaveBeenCalled();
    dependencies.persistenceEnabled.mockReturnValue(true);
    dependencies.getDatabase.mockResolvedValue({ kind: 'd1' });
    expect((await GET(getRequest())).status).toBe(503);
    expect((await POST(request())).status).toBe(503);
    expect(dependencies.getWorkspace).not.toHaveBeenCalled();
    expect(dependencies.checkWebsite).not.toHaveBeenCalled();
  });

  it('returns not found for an unavailable workspace', async () => {
    dependencies.getWorkspace.mockResolvedValue(null);
    expect((await GET(getRequest())).status).toBe(404);
    expect((await POST(request())).status).toBe(404);
    expect(dependencies.checkWebsite).not.toHaveBeenCalled();
  });
});


it('refuses a new check for a suppressed-only website while retaining its saved observation', async () => {
  dependencies.getWorkspace.mockResolvedValue({ ...workspace, state: { ...workspace.state, contacts: [{ ...contacts[0],
    suppressionMatches: [{ ruleId: 'vendor', listName: 'Vendors', type: 'website_domain', value: 'example.com', reason: 'Vendor' }],
  }] } });
  dependencies.getWebsiteChecks.mockResolvedValue([check]);
  expect((await POST(request({ recheck: true }))).status).toBe(409);
  expect(await (await GET(getRequest())).json()).toEqual({ checks: [check] });
  expect(dependencies.checkWebsite).not.toHaveBeenCalled();
  expect(dependencies.saveWebsiteCheck).not.toHaveBeenCalled();
});
