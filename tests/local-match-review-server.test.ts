import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalMatchFinding } from '../lib/local-match';
import type { LocalMatchReviewReport } from '../lib/local-match-review-server';
import type { IdentityRecord } from '../lib/identity-resolution';

const engine = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('../lib/local-match', () => ({ buildLocalMatchReport: engine.build }));
const directory = mkdtempSync(join(tmpdir(), 'gtm-local-match-review-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'workspace.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'test-operator-key');
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => { engine.build.mockReset().mockReturnValue(analysis()); });

function finding(key = 'company', kind: LocalMatchFinding['kind'] = 'company_variant'): LocalMatchFinding {
  return { key, kind, contactId: 'input', title: 'Possible company typo', priority: 'medium', score: 78,
    input: { id: 'input', source: 'import', name: 'Ada Example', email: 'ada@microsoft.example', company: 'Microsfot', website: 'microsoft.example', phone: '', state: '' },
    candidate: { id: 'candidate', source: 'import', name: 'Other Person', email: 'other@microsoft.example', company: 'Microsoft', website: 'microsoft.example', phone: '', state: '' },
    reasons: [{ code: 'typo', message: 'The company names differ by one adjacent transposition.', tone: 'supporting' }] };
}
function analysis(findings = [finding(), finding('person', 'possible_duplicate'), finding('suppression', 'possible_suppression')]) {
  return { ruleVersion: 'fixture-v1', findings, warnings: [],
    coverage: { importRows: 2, crmRecords: 0, suppressionRules: 0, comparedPairs: 1 }, rarity: { sampleSize: 2, available: false } };
}
const getRequest = (workspaceId: string, query = '', authorized = true) => new Request(`http://localhost/api/control-tower/local-matches?workspaceId=${workspaceId}${query}`, {
  headers: authorized ? { 'x-control-tower-key': 'test-operator-key' } : {},
});
const postRequest = (body: unknown, authorized = true) => new Request('http://localhost/api/control-tower/local-matches', {
  method: 'POST', headers: { ...(authorized ? { 'x-control-tower-key': 'test-operator-key' } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body),
});
async function savedWorkspace() {
  const { createWorkspace, saveWorkspace } = await import('../lib/workspace-store');
  const { importContactsCsv } = await import('../lib/csv-control-tower');
  const workspace = await createWorkspace('Local advisory review');
  const contacts = importContactsCsv('contact_id,full_name,email,company,website,owner_id\ninput,Ada Example,ada@microsoft.example,Microsfot,microsoft.example,owner\ncandidate,Other Person,other@microsoft.example,Microsoft,microsoft.example,owner').contacts;
  return saveWorkspace(workspace.id, { ...workspace.state, contacts, originalContacts: contacts });
}

describe('local match review decisions', () => {
  it('authenticates, paginates full-report counts and filters without contacting any provider', async () => {
    const { GET, POST } = await import('../app/api/control-tower/local-matches/route');
    const workspace = await savedWorkspace();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider calls are forbidden.'));
    expect((await GET(getRequest(workspace.id, '', false))).status).toBe(401);
    expect((await POST(postRequest({}, false))).status).toBe(401);
    expect(engine.build).not.toHaveBeenCalled();
    const response = await GET(getRequest(workspace.id, '&limit=1'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const first = await response.json() as LocalMatchReviewReport;
    expect(first).toMatchObject({ workspaceId: workspace.id, workspaceRevision: workspace.revision,
      counts: { pending: 3, confirmed: 0, dismissed: 0 }, total: 3, offset: 0, limit: 1, nextOffset: 1, snapshots: [] });
    expect(first.findings).toHaveLength(1);
    expect(first.findings[0]).toMatchObject({ id: expect.stringMatching(/^[a-f0-9]{64}$/u), fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u), decision: null });
    const page = await (await GET(getRequest(workspace.id, '&offset=1&limit=2'))).json() as LocalMatchReviewReport;
    expect(page.findings.map((item) => item.kind)).toEqual(['possible_duplicate', 'possible_suppression']);
    expect(page.nextOffset).toBeNull();
    const filtered = await (await GET(getRequest(workspace.id, '&kind=possible_suppression&status=pending'))).json() as LocalMatchReviewReport;
    expect(filtered.total).toBe(1);
    expect(filtered.findings[0].kind).toBe('possible_suppression');
    expect(filtered.counts.pending).toBe(3);
    expect(network).not.toHaveBeenCalled();
  });

  it('persists Confirm and Dismiss, replays decisions idempotently, and clears without changing source data', async () => {
    const { GET, POST } = await import('../app/api/control-tower/local-matches/route');
    const { getDatabase } = await import('../db');
    const { getWorkspace } = await import('../lib/workspace-store');
    const workspace = await savedWorkspace();
    const otherWorkspace = await savedWorkspace();
    const db = await getDatabase();
    const sourceTables = ['workspaces', 'workspace_state_chunks', 'connector_runs', 'duplicate_review_decisions'];
    const baseline = await Promise.all(sourceTables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()));
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider calls are forbidden.'));
    const report = await (await GET(getRequest(workspace.id))).json() as LocalMatchReviewReport;
    const target = report.findings[0];
    const command = { workspaceId: workspace.id, id: target.id, fingerprint: target.fingerprint, action: 'confirm' };
    const confirmed = await (await POST(postRequest(command))).json() as LocalMatchReviewReport;
    expect(confirmed.counts).toEqual({ pending: 2, confirmed: 1, dismissed: 0 });
    const firstDecision = confirmed.findings[0].decision;
    expect(firstDecision).toMatchObject({ status: 'confirmed', decidedAt: expect.any(String) });
    const unrelated = await (await GET(getRequest(otherWorkspace.id))).json() as LocalMatchReviewReport;
    expect(unrelated.findings[0]).toMatchObject({ id: target.id, fingerprint: target.fingerprint, decision: null });
    const replay = await (await POST(postRequest(command))).json() as LocalMatchReviewReport;
    expect(replay.findings[0].decision).toEqual(firstDecision);
    vi.resetModules();
    const refreshedRoute = await import('../app/api/control-tower/local-matches/route');
    const reloaded = await (await refreshedRoute.GET(getRequest(workspace.id, '&status=confirmed'))).json() as LocalMatchReviewReport;
    expect(reloaded.findings).toHaveLength(1);
    expect(reloaded.findings[0].decision).toEqual(firstDecision);
    const dismissed = await (await refreshedRoute.POST(postRequest({ ...command, action: 'dismiss' }))).json() as LocalMatchReviewReport;
    expect(dismissed.counts).toEqual({ pending: 2, confirmed: 0, dismissed: 1 });
    const cleared = await (await refreshedRoute.POST(postRequest({ ...command, action: 'clear' }))).json() as LocalMatchReviewReport;
    expect(cleared.counts).toEqual({ pending: 3, confirmed: 0, dismissed: 0 });
    expect(cleared.findings[0].decision).toBeNull();
    expect(await getWorkspace(workspace.id)).toEqual(workspace);
    expect(await Promise.all(sourceTables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()))).toEqual(baseline);
    expect(network).not.toHaveBeenCalled();
  });

  it('runs the real local matcher through the API and stores an assessment without applying the suggestion', async () => {
    const actual = await vi.importActual<typeof import('../lib/local-match')>('../lib/local-match');
    engine.build.mockImplementation(actual.buildLocalMatchReport);
    const { GET, POST } = await import('../app/api/control-tower/local-matches/route');
    const { getWorkspace, saveWorkspace } = await import('../lib/workspace-store');
    const workspace = await savedWorkspace();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider calls are forbidden.'));
    const report = await (await GET(getRequest(workspace.id))).json() as LocalMatchReviewReport;
    const typo = report.findings.find((item) => item.contactId === 'input' && item.kind === 'company_variant');
    expect(typo?.candidate.company).toBe('Microsoft');
    expect(report.coverage).toMatchObject({ importRows: 2, crmRecords: 0, suppressionRules: 0 });
    expect(report.rarity.available).toBe(false);
    const command = { workspaceId: workspace.id, id: typo!.id, fingerprint: typo!.fingerprint, action: 'confirm' };
    expect((await POST(postRequest(command))).status).toBe(200);
    expect(await getWorkspace(workspace.id)).toEqual(workspace);
    await saveWorkspace(workspace.id, { ...workspace.state,
      contacts: workspace.state.contacts.map((row) => row.contactId === 'input' ? { ...row, company: 'Microsoft' } : row) });
    expect((await POST(postRequest(command))).status).toBe(409);
    expect(network).not.toHaveBeenCalled();
  });

  it('rejects invented or stale suggestions and reopens changed evidence, rules and rarity', async () => {
    const { getLocalMatchReview, decideLocalMatch } = await import('../lib/local-match-review-server');
    const workspace = await savedWorkspace();
    const original = await getLocalMatchReview(workspace.id);
    const first = original.findings[0];
    await decideLocalMatch(workspace.id, first.id, first.fingerprint, 'confirm');
    const changed = finding(); changed.candidate.phone = '5551231234';
    engine.build.mockReturnValue(analysis([changed]));
    const current = await getLocalMatchReview(workspace.id);
    expect(current.findings[0].id).toBe(first.id);
    expect(current.findings[0].fingerprint).not.toBe(first.fingerprint);
    expect(current.findings[0].decision).toBeNull();
    await expect(decideLocalMatch(workspace.id, first.id, first.fingerprint, 'confirm')).rejects.toMatchObject({ status: 409 });
    await expect(decideLocalMatch(workspace.id, 'f'.repeat(64), first.fingerprint, 'dismiss')).rejects.toMatchObject({ status: 409 });
    const beforeVersion = current.findings[0];
    await decideLocalMatch(workspace.id, beforeVersion.id, beforeVersion.fingerprint, 'dismiss');
    engine.build.mockReturnValue({ ...analysis([changed]), ruleVersion: 'fixture-v2' });
    expect((await getLocalMatchReview(workspace.id)).findings[0].decision).toBeNull();
    engine.build.mockReturnValue(analysis());
    const person = (await getLocalMatchReview(workspace.id)).findings[1];
    await decideLocalMatch(workspace.id, person.id, person.fingerprint, 'confirm');
    engine.build.mockReturnValue({ ...analysis(), rarity: { sampleSize: 200, available: true } });
    expect((await getLocalMatchReview(workspace.id)).findings[1].decision).toBeNull();
  });

  it('compares only relevant completed saved CRM snapshots and describes partial or missing coverage', async () => {
    const { getDatabase } = await import('../db');
    const { saveWorkspace } = await import('../lib/workspace-store');
    const { getLocalMatchReview } = await import('../lib/local-match-review-server');
    const workspace = await savedWorkspace();
    const db = await getDatabase();
    await saveWorkspace(workspace.id, { ...workspace.state, sourceType: 'hubspot', destinationType: 'salesforce' });
    const records: IdentityRecord[] = [{ recordKey: 'hubspot:contact:1', connectorId: 'hubspot', objectType: 'contact', nativeId: '1', firstName: 'Ada', lastName: 'Example', fullName: 'Ada Example',
      email: 'ada@crm.example', company: 'Microsoft', phone: '', jobTitle: '', website: 'microsoft.example', createdAt: null, updatedAt: null }];
    await db.prepare(`INSERT INTO duplicate_scans (id,workspace_id,connector_id,status,cursor_json,records_scanned,source_complete,rule_version,completed_at,analysis_warnings_json)
      VALUES ('local-hubspot',?,'hubspot','complete',NULL,1,0,'identity-v3','2026-10-15T12:00:00.000Z','["Saved scan reached its row limit."]')`).bind(workspace.id).run();
    await db.prepare('INSERT INTO duplicate_scan_records (scan_id,record_key,payload_json) VALUES (?,?,?)')
      .bind('local-hubspot', records[0].recordKey, JSON.stringify(records[0])).run();
    await db.prepare(`INSERT INTO duplicate_scans (id,workspace_id,connector_id,status,cursor_json,records_scanned,source_complete,rule_version)
      VALUES ('local-salesforce',?,'salesforce','scanning','{}',0,0,'identity-v3')`).bind(workspace.id).run();
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('CRM reads are forbidden.'));
    const report = await getLocalMatchReview(workspace.id);
    expect(report.snapshots).toEqual([{ id: 'local-hubspot', connectorId: 'hubspot', recordsScanned: 1, sourceComplete: false, completedAt: '2026-10-15T12:00:00.000Z' }]);
    expect(report.warnings.join(' ')).toMatch(/HubSpot.*incomplete.*2026-10-15.*row limit.*Salesforce.*scanning/u);
    expect(engine.build).toHaveBeenLastCalledWith(expect.objectContaining({ crmRecords: records }));
    await saveWorkspace(workspace.id, { ...workspace.state, destinationType: 'csv', sourceType: 'csv' });
    expect((await getLocalMatchReview(workspace.id)).snapshots).toEqual([]);
    expect(engine.build).toHaveBeenLastCalledWith(expect.objectContaining({ crmRecords: [] }));
    expect(network).not.toHaveBeenCalled();
  });

  it('validates API inputs, returns missing-workspace and stale-review status, and rejects hosted persistence', async () => {
    const { GET, POST } = await import('../app/api/control-tower/local-matches/route');
    const workspace = await savedWorkspace();
    expect((await GET(getRequest('missing'))).status).toBe(404);
    expect((await GET(getRequest(''))).status).toBe(400);
    for (const query of ['&limit=101', '&limit=0', '&offset=-1', '&offset=0.5', '&status=bad', '&kind=bad']) {
      expect((await GET(getRequest(workspace.id, query))).status).toBe(400);
    }
    for (const body of [null, [], {}, { workspaceId: workspace.id, id: 'bad', fingerprint: 'bad', action: 'confirm' }]) {
      expect((await POST(postRequest(body))).status).toBe(400);
    }
    expect((await POST(postRequest({ workspaceId: workspace.id, id: 'f'.repeat(64), fingerprint: 'a'.repeat(64), action: 'confirm' }))).status).toBe(409);
    vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'false');
    try { expect((await GET(getRequest(workspace.id))).status).toBe(503); }
    finally { vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true'); }
    vi.resetModules();
    const prepare = vi.fn(() => { throw new Error('Hosted mode must not write a local schema.'); });
    vi.doMock('../db', () => ({ getDatabase: async () => ({ kind: 'd1', prepare }), ensureWorkspaceSchema: vi.fn() }));
    try {
      const hosted = await import('../app/api/control-tower/local-matches/route');
      expect((await hosted.GET(getRequest(workspace.id))).status).toBe(503);
      expect((await hosted.POST(postRequest({ workspaceId: workspace.id, id: 'f'.repeat(64), fingerprint: 'a'.repeat(64), action: 'confirm' }))).status).toBe(503);
      expect(prepare).not.toHaveBeenCalled();
    } finally { vi.doUnmock('../db'); vi.resetModules(); }
  });
});
