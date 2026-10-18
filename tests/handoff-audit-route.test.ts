import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET, POST } from '../app/api/control-tower/handoff-audits/route';
import { createHandoffExample } from '../lib/handoff-audit-example';
import { incidentDatabase } from '../lib/crm-incidents';
import { HANDOFF_BODY_LIMIT, type HandoffAuditOverview } from '../lib/handoff-audit-store';

const directory = mkdtempSync(join(tmpdir(), 'handoff-route-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'audit.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'synthetic-operator-key');
vi.stubEnv('CONTROL_TOWER_INVESTIGATOR_KEY', 'synthetic-investigator-key');
const now = '2026-10-16T12:00:00.000Z';
const fetchSpy = vi.fn(() => Promise.reject(new Error('Audit must not fetch.')));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal('fetch', fetchSpy); fetchSpy.mockClear(); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

function request(body?: unknown, role: 'operator' | 'investigator' | 'invalid' = 'operator', query = '') {
  return new Request(`http://localhost/api/control-tower/handoff-audits${query}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(role === 'investigator'
      ? { 'x-control-tower-investigator-key': 'synthetic-investigator-key' }
      : { 'x-control-tower-key': role === 'operator' ? 'synthetic-operator-key' : 'invalid' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function createBody(requestId = 'route-create-request') { return { action: 'create', requestId, ...createHandoffExample(now) }; }

describe('read-only handoff audit endpoint', () => {
  it('authenticates every request and lets investigators read but not save local reports', async () => {
    expect((await GET(request(undefined, 'invalid'))).status).toBe(401);
    expect((await POST(request(createBody(), 'invalid'))).status).toBe(401);
    expect((await POST(request(createBody(), 'investigator'))).status).toBe(403);
    expect((await POST(request({ action: 'reconcile', id: 'nonexistent' }, 'investigator'))).status).toBe(403);
    const result = await GET(request(undefined, 'investigator'));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toMatchObject({ accounts: [], audits: [], selected: null });
  });

  it('saves a synthetic import, retries idempotently, and GET returns the saved report without updating its evidence or history', async () => {
    const body = createBody();
    const created = await POST(request(body));
    expect(created.status).toBe(200);
    const initial = await created.json() as HandoffAuditOverview;
    expect(initial.selected?.mode).toBe('snapshot');
    expect(initial.selected?.report.rows).toHaveLength(body.manifest.rows.length);
    expect(initial.selected?.history).toHaveLength(1);
    expect(initial.selected?.report.counts).toMatchObject({ present: 3, excluded: 1, failed: 1, missing: 1, awaiting_sync: 1, unknown: 5 });
    const id = initial.selected!.id;
    const duplicate = await (await POST(request(body))).json() as HandoffAuditOverview;
    expect(duplicate.selected?.id).toBe(id);
    expect(duplicate.selected?.history).toHaveLength(1);
    vi.setSystemTime('2026-10-16T14:00:00.000Z');
    const viewed = await (await GET(request(undefined, 'investigator', `?id=${id}`))).json() as HandoffAuditOverview;
    expect(viewed.selected).toEqual(initial.selected);
    expect((await (await GET(request())).json() as HandoffAuditOverview).selected?.id).toBe(id);
    const next = await (await POST(request({ action: 'reconcile', id }))).json() as HandoffAuditOverview;
    expect(next.selected?.history).toHaveLength(2);
    expect(next.selected?.evidence.observedAt).toBe(initial.selected?.evidence.observedAt);
    expect(next.selected?.manifest).toEqual(initial.selected?.manifest);
    expect(next.selected?.report.evidenceSummary.fresh).toBe(false);
  });

  it('rejects malformed payloads, unknown actions, account mismatch, mutated cohort and request collisions', async () => {
    for (const body of [null, [], 'string', { action: 'replay' }, { action: 'tick' }, { action: 'create' }, { action: 'reconcile' }, { action: 'create', requestId: 'valid-request', manifest: {} }]) {
      expect((await POST(request(body))).status, JSON.stringify(body)).toBe(400);
    }
    const malformed = new Request('http://localhost/api/control-tower/handoff-audits', {
      method: 'POST', headers: { 'x-control-tower-key': 'synthetic-operator-key' }, body: '{unclosed',
    });
    expect((await POST(malformed)).status).toBe(400);
    const mismatch = createBody('account-mismatch');
    mismatch.evidence.accountId = 'other-account';
    expect((await POST(request(mismatch))).status).toBe(400);
    const created = await (await POST(request(createBody('immutable-request')))).json() as HandoffAuditOverview;
    expect((await POST(request({ action: 'reconcile', id: created.selected!.id, manifest: createBody().manifest }))).status).toBe(400);
    const colliding = createBody('immutable-request');
    colliding.manifest.name = 'Different cohort';
    expect((await POST(request(colliding))).status).toBe(409);
    expect((await POST(request({ action: 'reconcile', id: 'unknown-audit' }))).status).toBe(404);
    expect((await GET(request(undefined, 'operator', '?id=unknown-audit'))).status).toBe(404);
    expect((await GET(request(undefined, 'operator', '?id=%27%20OR%201%3D1'))).status).toBe(400);
  });

  it('bounds request bytes even when Content-Length is omitted or false, and rejects more than 5,000 source rows', async () => {
    const oversized = JSON.stringify({ action: 'create', padding: 'x'.repeat(HANDOFF_BODY_LIMIT) });
    for (const declared of [undefined, '1', String(HANDOFF_BODY_LIMIT + 1)]) {
      const tooLarge = new Request('http://localhost/api/control-tower/handoff-audits', {
        method: 'POST', headers: { 'x-control-tower-key': 'synthetic-operator-key', ...(declared ? { 'content-length': declared } : {}) }, body: oversized,
      });
      expect((await POST(tooLarge)).status).toBe(413);
    }
    const many = createBody('too-many-source-rows');
    many.manifest.rows = Array.from({ length: 5001 }, (_, index) => ({ ...many.manifest.rows[0], rowId: `source-${index}`, sourceId: String(index) }));
    expect((await POST(request(many))).status).toBe(400);
  });

  it('does not reinterpret supplied accounts as saved connections or run legacy notification migrations', async () => {
    const body = createBody('monitor-without-accounts');
    const { evidence: unused, ...monitor } = body;
    void unused;
    expect((await POST(request(monitor))).status).toBe(400);
    const db = await incidentDatabase();
    await db.prepare('CREATE TABLE IF NOT EXISTS slack_notification_events(id TEXT PRIMARY KEY,path TEXT,title TEXT,state TEXT,provider TEXT)').run();
    await db.prepare("INSERT INTO slack_notification_events(id,path,title,state,provider) VALUES('synthetic-pending','/app/watchdog?account=fixture','Watchdog finding needs review','pending','salesforce')").run();
    const before = await db.prepare('SELECT * FROM slack_notification_events').all();
    const outboxBefore = await db.prepare('SELECT * FROM operation_notification_outbox').all();
    const cacheBefore = await db.prepare('SELECT * FROM crm_observed_records').all();
    const saved = await (await POST(request(createBody('read-only-cache-proof')))).json() as HandoffAuditOverview;
    expect((await GET(request(undefined, 'investigator', `?id=${saved.selected!.id}`))).status).toBe(200);
    expect((await POST(request({ action: 'reconcile', id: saved.selected!.id }))).status).toBe(200);
    expect(await db.prepare('SELECT * FROM slack_notification_events').all()).toEqual(before);
    expect(await db.prepare('SELECT * FROM operation_notification_outbox').all()).toEqual(outboxBefore);
    expect(await db.prepare('SELECT * FROM crm_observed_records').all()).toEqual(cacheBefore);
  });
});
