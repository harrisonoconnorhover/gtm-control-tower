import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET, POST } from '../app/api/control-tower/pomade-qualification/route';
import { getDatabase } from '../db';
import { importContactsCsv } from '../lib/csv-control-tower';
import type { ImportObject } from '../lib/live-control-tower';
import { qualificationInputFingerprint, qualificationInputs, type PomadeQualificationResponse, type PrepareQualificationInput, type QualificationCheck, type QualificationRow, type QualificationRunJob } from '../lib/pomade-qualification';
import { qualificationRequestDigest } from '../lib/pomade-qualification-client';
import { beginPomadeQualification, claimPomadeExecution, getPomadeQualification, refreshPomadeQualification, savePomadeQualification } from '../lib/pomade-qualification-store';
import { createWorkspace, getWorkspace, saveWorkspace } from '../lib/workspace-store';
import { saveWebsiteCheck } from '../lib/website-check-store';
import type { WebsiteCheckResult } from '../lib/website-check-types';

const directory = mkdtempSync(join(tmpdir(), 'gtm-pomade-qualification-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'workspace.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'synthetic-operator-key');
vi.stubEnv('CONTROL_TOWER_POMADE_API_KEY', 'synthetic-pomade-key');
vi.stubEnv('CONTROL_TOWER_POMADE_PUBLIC_URL', 'http://localhost:8798');
const seen: { path: string; body: unknown; authorization?: string }[] = [];
const prepared = new Map<string, PrepareQualificationInput>();
let server: Server;
let apiUrl: string;
let fixtureFailure: number | undefined;
let mismatch = false;
let failDigest = false;
let redirect = false;
let onPrepare: (() => Promise<void>) | undefined;
let observations: ((rows: QualificationRow[]) => QualificationRow[]) | undefined;
const jobs = new Map<string, QualificationRunJob>();
let loseStartResponse = false;
let startRejected = false;
let startReturnsNoJob = false;
let beforeStartReply: (() => Promise<void>) | undefined;
const previewHash = 'a'.repeat(64);
const scope = { sourceRowIds: ['row-0'], checks: ['identity', 'icp', 'email'] };
const startArgs = (requestId = crypto.randomUUID()) => ({ ...scope, requestId, previewHash, confirmExternalRequests: true });
const checkedAt = '2026-10-16T12:00:00.000Z';
const check = (): QualificationCheck => ({ state: 'complete', assessment: 'Match', explanation: 'Synthetic fixture evidence.',
  sources: [{ url: 'https://example.test/about', title: 'About Example', excerpt: 'Example makes CRM software.' }],
  checkedAt, provider: 'fixture', receiptId: 'synthetic-receipt' });

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ path: request.url ?? '', body, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    if (fixtureFailure) { response.writeHead(fixtureFailure); response.end(JSON.stringify({ error: 'synthetic-pomade-key' })); return; }
    if (redirect) { response.writeHead(302, { location: '/unexpected' }); response.end('{}'); return; }
    if (request.url === '/api/v1/prepare_qualification') {
      const digest = qualificationRequestDigest(body);
      const qualificationId = `qualification_${digest}`;
      const created = !prepared.has(qualificationId);
      prepared.set(qualificationId, prepared.get(qualificationId) ?? body);
      await onPrepare?.();
      response.end(JSON.stringify({ qualificationId, tableId: 'table-fixture', tablePath: '/?table=table-fixture',
        created, requestDigest: failDigest ? '0'.repeat(64) : digest, rowCount: body.rows.length }));
    } else if (request.url === '/api/v1/get_qualification') {
      const input = prepared.get(body.qualificationId)!;
      let rows = input.rows.map(({ sourceRowId, ...inputs }): QualificationRow => ({ sourceRowId, pomadeRowId: `pomade_${sourceRowId}`,
        inputs, identity: check(), icp: { ...check(), assessment: 'Fit' }, email: { ...check(), state: 'review', assessment: 'catch_all' } }));
      if (mismatch) rows[0].inputs.email = 'other@example.test';
      if (observations) rows = observations(rows);
      response.end(JSON.stringify({ qualificationId: body.qualificationId, requestDigest: qualificationRequestDigest(input),
        sourceWorkspaceId: input.sourceWorkspaceId, sourceRevision: input.sourceRevision, icpCriteria: input.icpCriteria,
        tableId: 'table-fixture', tablePath: '/?table=table-fixture', updatedAt: Date.parse(checkedAt), rows }));
    } else if (request.url === '/api/v1/preview_qualification_run') {
      response.end(JSON.stringify({ qualificationId: body.qualificationId, previewHash, sourceRowIds: body.sourceRowIds, checks: body.checks,
        rowCount: body.sourceRowIds.length, maximumSubmissions: body.sourceRowIds.length * body.checks.length,
        backgroundAllowed: true, backgroundIssue: '', warnings: ['Existing provider limits apply.'],
        entries: body.sourceRowIds.flatMap((sourceRowId: string) => body.checks.map((kind: string) => ({ rowId: `pomade_${sourceRowId}`,
          rowLabel: sourceRowId, columnId: kind, columnLabel: kind, state: 'ready', details: ['Existing connected provider'], steps: [], maximum: 1 }))),
      }));
    } else if (request.url === '/api/v1/start_qualification_run') {
      if (startRejected) { response.writeHead(409); response.end(JSON.stringify({ error: 'The saved run preview changed. Preview the checks again.' })); return; }
      if (!startReturnsNoJob && !jobs.has(body.requestId)) jobs.set(body.requestId, { id: `qualification_run_${body.requestId}_${'b'.repeat(64)}`,
        status: 'queued', cursor: 0, totalRows: body.sourceRowIds.length, completedCount: 0, skippedCount: 0, error: null, waitingMessage: null });
      await beforeStartReply?.();
      if (loseStartResponse) { response.destroy(); return; }
      response.end(JSON.stringify({ qualificationId: body.qualificationId, requestId: body.requestId, job: jobs.get(body.requestId) ?? null }));
    } else if (['/api/v1/get_qualification_run', '/api/v1/cancel_qualification_run'].includes(request.url ?? '')) {
      const job = jobs.get(body.requestId) ?? null;
      if (job && request.url === '/api/v1/cancel_qualification_run') job.status = 'cancelled';
      response.end(JSON.stringify({ qualificationId: body.qualificationId, requestId: body.requestId, job }));
    } else { response.writeHead(404); response.end('{}'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not listen.');
  apiUrl = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('CONTROL_TOWER_POMADE_API_URL', apiUrl);
});
beforeEach(() => { seen.length = 0; fixtureFailure = undefined; mismatch = false; failDigest = false; redirect = false; onPrepare = undefined; observations = undefined; jobs.clear(); loseStartResponse = false; startRejected = false; startReturnsNoJob = false; beforeStartReply = undefined; });
afterEach(() => { vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true'); vi.stubEnv('CONTROL_TOWER_POMADE_API_URL', apiUrl); vi.stubEnv('CONTROL_TOWER_POMADE_API_KEY', 'synthetic-pomade-key'); });
afterAll(async () => { server?.closeAllConnections(); await new Promise<void>((resolve) => server?.close(() => resolve())); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

const post = (workspaceId: string, action = 'send', extra: Record<string, unknown> = {}, key = 'synthetic-operator-key') => POST(new Request('http://localhost/api/control-tower/pomade-qualification', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-control-tower-key': key },
  body: JSON.stringify({ workspaceId, action, ...(action === 'send' ? { icpCriteria: 'Companies selling CRM software' } : {}), ...extra }),
}));
const get = (workspaceId: string, key = 'synthetic-operator-key') => GET(new Request(`http://localhost/api/control-tower/pomade-qualification?workspaceId=${workspaceId}`, { headers: { 'x-control-tower-key': key } }));
async function workspace(importObject: Exclude<ImportObject, 'company'> = 'contact') {
  const created = await createWorkspace('Synthetic qualification list');
  const contacts = importContactsCsv('full_name,email,company,website\nAda Example,ada@example.test,Example,https://example.test\nBen Excluded,ben@example.test,Excluded,https://excluded.test\nCal Merged,cal@example.test,Merged,https://merged.test\nDee Missing,,,').contacts
    .map((row, index) => ({ ...row, contactId: `row-${index}`, importObject,
      ...(importObject === 'contact_company' ? {
        associatedCompany: { recordId: null, name: row.company ?? '', website: row.website ?? '', phone: '', state: '' },
        company: 'Unrelated contact context', website: 'https://contact-context.test',
      } : {}),
    }));
  contacts[1].importExclusion = { reason: 'Vendor', excludedAt: checkedAt };
  contacts[2].recordStatus = 'merged';
  return saveWorkspace(created.id, { ...created.state, importObject, contacts, originalContacts: contacts });
}

describe('Control Tower and Pomade qualification handoff', () => {

  it('derives readiness before qualification exists using only saved local observations', async () => {
    const saved = await workspace();
    const db = await getDatabase();
    const receipts = await db.prepare('SELECT * FROM connector_runs WHERE workspace_id = ?').bind(saved.id).all();
    const result = await get(saved.id);
    expect(result.status).toBe(200);
    const value = await result.json() as PomadeQualificationResponse;
    expect(value.qualification).toBeNull();
    expect(value.readiness.counts).toEqual({ ready: 0, needsReview: 2, excluded: 2 });
    expect(value.readiness.rows.find((row) => row.sourceRowId === 'row-0')).toMatchObject({ status: 'needs_review',
      reasons: expect.arrayContaining([{ code: 'qualification_not_checked', message: expect.any(String) }]) });
    expect(value.readiness.rows.find((row) => row.sourceRowId === 'row-1')).toMatchObject({ status: 'excluded' });
    expect(value.readiness.rows.find((row) => row.sourceRowId === 'row-2')).toMatchObject({ status: 'excluded' });
    vi.stubEnv('CONTROL_TOWER_POMADE_API_KEY', '');
    expect(await (await get(saved.id)).json()).toMatchObject({ configured: false, qualification: null, readiness: value.readiness });
    expect(seen).toHaveLength(0);
    expect(await getWorkspace(saved.id)).toEqual(saved);
    expect(await getPomadeQualification(saved.id)).toBeNull();
    expect(await db.prepare('SELECT * FROM connector_runs WHERE workspace_id = ?').bind(saved.id).all()).toEqual(receipts);
  });

  it('recomputes readiness on reload from website results and local holds without writing qualification or CRM state', async () => {
    const created = await workspace();
    const saved = await saveWorkspace(created.id, { ...created.state, contacts: [{ ...created.state.contacts[0], qualityFlags: [], ownerId: null }] });
    await post(saved.id);
    observations = (rows) => rows.map((row) => ({ ...row, email: { ...check(), assessment: 'valid' } }));
    const website: WebsiteCheckResult = { url: 'https://example.test/', finalUrl: 'https://example.test/', status: 'reachable',
      method: 'http', httpStatus: 200, title: 'Example', detail: 'Saved website observation.', checkedAt };
    await saveWebsiteCheck(saved.id, website);
    expect(await (await post(saved.id, 'refresh')).json()).toMatchObject({ readiness: { counts: { ready: 1, needsReview: 0, excluded: 0 },
      rows: [{ sourceRowId: 'row-0', status: 'ready' }] } });
    const qualification = await getPomadeQualification(saved.id);
    const db = await getDatabase();
    const receipts = await db.prepare('SELECT * FROM connector_runs WHERE workspace_id = ?').bind(saved.id).all();
    seen.length = 0;
    const firstRead = await (await get(saved.id)).json() as PomadeQualificationResponse;
    expect((await (await get(saved.id)).json() as PomadeQualificationResponse).readiness).toEqual(firstRead.readiness);
    await saveWebsiteCheck(saved.id, { ...website, status: 'failed', httpStatus: 503, checkedAt: '2026-10-16T12:01:00.000Z' });
    expect(await (await get(saved.id)).json()).toMatchObject({ readiness: { counts: { ready: 0, needsReview: 1, excluded: 0 },
      rows: [{ status: 'needs_review', reasons: expect.arrayContaining([{ code: 'website_failed', message: expect.any(String) }]) }] } });
    await saveWebsiteCheck(saved.id, { ...website, checkedAt: '2026-10-16T12:02:00.000Z' });
    expect(await (await get(saved.id)).json()).toMatchObject({ readiness: { counts: { ready: 1, needsReview: 0, excluded: 0 } } });
    expect(await getWorkspace(saved.id)).toEqual(saved);
    expect(await getPomadeQualification(saved.id)).toEqual(qualification);
    expect(await db.prepare('SELECT * FROM connector_runs WHERE workspace_id = ?').bind(saved.id).all()).toEqual(receipts);
    expect(seen).toHaveLength(0);
    const held = await saveWorkspace(saved.id, { ...saved.state, contacts: saved.state.contacts.map((row) => ({ ...row, qualityFlags: ['missing_owner'] })) });
    expect(await (await get(saved.id)).json()).toMatchObject({ qualification: { stale: false }, readiness: {
      counts: { ready: 0, needsReview: 1, excluded: 0 }, rows: [{ status: 'needs_review',
        reasons: expect.arrayContaining([{ code: 'missing_owner', message: expect.any(String) }]) }] } });
    expect(await getWorkspace(saved.id)).toEqual(held);
    expect(await getPomadeQualification(saved.id)).toEqual(qualification);
    expect(seen).toHaveLength(0);
  });


  it('sends only included saved inputs, preserves blanks, and reuses the link without changing revisions or CRM receipts', async () => {
    const saved = await workspace();
    const db = await getDatabase();
    const runs = await db.prepare('SELECT * FROM connector_runs WHERE workspace_id = ?').bind(saved.id).all();
    const result = await post(saved.id);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ configured: true, readiness: { counts: { ready: 0, needsReview: 2, excluded: 2 } }, qualification: { tableUrl: 'http://localhost:8798/?table=table-fixture',
      stale: false, sourceRevision: saved.revision, refreshedAt: null, rows: [
        { sourceRowId: 'row-0', identity: { state: 'not_run' } },
        { sourceRowId: 'row-3', inputs: { company: '', website: '', email: '' } },
      ] } });
    expect(seen).toEqual([{ path: '/api/v1/prepare_qualification', authorization: 'Bearer synthetic-pomade-key', body: {
      sourceWorkspaceId: saved.id, sourceRevision: saved.revision, sourceName: saved.name, icpCriteria: 'Companies selling CRM software',
      rows: [{ sourceRowId: 'row-0', company: 'Example', website: 'https://example.test', email: 'ada@example.test' },
        { sourceRowId: 'row-3', company: '', website: '', email: '' }],
    } }]);
    expect((await post(saved.id)).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(await getWorkspace(saved.id)).toEqual(saved);
    expect(await db.prepare('SELECT * FROM connector_runs WHERE workspace_id = ?').bind(saved.id).all()).toEqual(runs);
    const cached = await (await get(saved.id)).json() as PomadeQualificationResponse;
    expect(cached.qualification).not.toHaveProperty('inputFingerprint');
    expect(JSON.stringify(cached)).not.toContain('synthetic-pomade-key');
    expect(seen).toHaveLength(1);
  });

  it('refreshes saved evidence, retains uncertainty, and repeats without changing observations or workspace state', async () => {
    const saved = await workspace();
    await post(saved.id);
    const result = await post(saved.id, 'refresh');
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ qualification: { stale: false, rows: [{ sourceRowId: 'row-0',
      identity: { state: 'complete', assessment: 'Match', checkedAt, receiptId: 'synthetic-receipt' },
      icp: { assessment: 'Fit' }, email: { state: 'review', assessment: 'catch_all' } }, expect.anything()] } });
    const first = await getPomadeQualification(saved.id);
    await post(saved.id, 'refresh');
    expect(await getPomadeQualification(saved.id)).toEqual(first);
    expect(await getWorkspace(saved.id)).toEqual(saved);
    expect(seen.map((item) => item.path)).toEqual(['/api/v1/prepare_qualification', '/api/v1/get_qualification', '/api/v1/get_qualification']);
    vi.stubEnv('CONTROL_TOWER_POMADE_API_KEY', '');
    expect(await (await get(saved.id)).json()).toMatchObject({ configured: false, qualification: { qualificationId: first!.qualificationId } });
    expect(seen).toHaveLength(3);
  });

  it('ignores unrelated revisions and row order but marks changed inputs stale, including changes during a send', async () => {
    const saved = await workspace();
    await post(saved.id);
    const unrelated = await saveWorkspace(saved.id, { ...saved.state, contacts: [...saved.state.contacts].reverse().map((row) => ({ ...row, ownerId: 'new-owner' })) });
    expect(await (await get(saved.id)).json()).toMatchObject({ qualification: { stale: false } });
    expect((await post(saved.id)).status).toBe(200);
    expect(seen).toHaveLength(1);
    const changed = await saveWorkspace(saved.id, { ...unrelated.state, contacts: unrelated.state.contacts.map((row) => row.contactId === 'row-0' ? { ...row, company: 'Changed company' } : row) });
    expect(await (await get(saved.id)).json()).toMatchObject({ qualification: { stale: true } });
    onPrepare = async () => { await saveWorkspace(saved.id, { ...changed.state, contacts: changed.state.contacts.filter((row) => row.contactId !== 'row-3') }); };
    expect(await (await post(saved.id)).json()).toMatchObject({ qualification: { stale: true } });
    expect(seen).toHaveLength(2);
  });

  it('rejects mismatched result inputs and receipts while retaining the earlier observations', async () => {
    const saved = await workspace();
    failDigest = true;
    expect((await post(saved.id)).status).toBe(502);
    expect(await getPomadeQualification(saved.id)).toBeNull();
    failDigest = false;
    await post(saved.id);
    const previous = await getPomadeQualification(saved.id);
    mismatch = true;
    expect((await post(saved.id, 'refresh')).status).toBe(502);
    expect(await getPomadeQualification(saved.id)).toEqual(previous);
    mismatch = false;
    observations = (rows) => [{ ...rows[0], sourceRowId: 'unrelated-row' }, rows[1]];
    expect((await post(saved.id, 'refresh')).status).toBe(502);
    expect(await getPomadeQualification(saved.id)).toEqual(previous);
  });

  it('prevents late sends and refreshes from replacing a newer transfer', async () => {
    const saved = await workspace();
    await post(saved.id);
    const previous = (await getPomadeQualification(saved.id))!;
    const firstToken = await beginPomadeQualification(saved.id);
    const secondToken = await beginPomadeQualification(saved.id);
    const newer = { ...previous, qualificationId: 'new-qualification', icpCriteria: 'Different ICP' };
    expect(await savePomadeQualification(saved.id, secondToken!, newer)).toBe(true);
    expect(await savePomadeQualification(saved.id, firstToken!, previous)).toBe(false);
    expect(await refreshPomadeQualification(saved.id, previous, { ...previous, refreshedAt: checkedAt })).toBe(false);
    expect(await getPomadeQualification(saved.id)).toEqual(newer);
  });

  it('checks authorization and persistence before transfer and rejects client rows, tools, URLs or oversized lists', async () => {
    const saved = await workspace();
    expect((await get(saved.id, 'wrong')).status).toBe(401);
    expect((await post(saved.id, 'send', {}, 'wrong')).status).toBe(401);
    for (const extra of [{ rows: [] }, { url: 'https://other.test' }, { tool: 'execute_crm_sync' }, { icpCriteria: '' }, { icpCriteria: 'x'.repeat(1501) }]) {
      expect((await post(saved.id, 'send', extra)).status).toBe(400);
    }
    expect((await post(saved.id, 'execute_crm_sync')).status).toBe(400);
    const row = saved.state.contacts[0];
    await saveWorkspace(saved.id, { ...saved.state, contacts: Array.from({ length: 501 }, (_, index) => ({ ...row, contactId: `many-${index}` })) });
    expect((await post(saved.id)).status).toBe(400);
    vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'false');
    expect((await get(saved.id)).status).toBe(503);
    expect((await post(saved.id)).status).toBe(503);
    expect(seen).toHaveLength(0);
  });

  it('keeps credentials on the server and refuses redirects without repeating an uncertain external call', async () => {
    const saved = await workspace();
    fixtureFailure = 401;
    const denied = await post(saved.id);
    expect(denied.status).toBe(502);
    expect(JSON.stringify(await denied.json())).not.toContain('synthetic-pomade-key');
    expect(seen).toHaveLength(1);
    fixtureFailure = undefined; redirect = true;
    expect((await post(saved.id)).status).toBe(502);
    expect(seen).toHaveLength(2);
    vi.stubEnv('CONTROL_TOWER_POMADE_API_URL', `${apiUrl}/arbitrary-path`);
    expect((await post(saved.id)).status).toBe(503);
    expect(seen).toHaveLength(2);
    expect(await getPomadeQualification(saved.id)).toBeNull();
  });



  it('previews only selected saved rows and existing check kinds, without starting a job', async () => {
    const saved = await workspace();
    await post(saved.id);
    seen.length = 0;
    const result = await post(saved.id, 'preview', scope);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ preview: { previewHash, rowCount: 1, maximumSubmissions: 3,
      backgroundAllowed: true, warnings: ['Existing provider limits apply.'], entries: [{ state: 'ready' }, { state: 'ready' }, { state: 'ready' }] } });
    expect(seen.map((call) => call.path)).toEqual(['/api/v1/preview_qualification_run']);
    for (const invalid of [{ ...scope, sourceRowIds: ['row-1'] }, { ...scope, checks: ['crm'] }, { ...scope, sourceRowIds: [] }, { ...scope, checks: ['email', 'email'] }]) {
      expect((await post(saved.id, 'preview', invalid)).status).toBe(400);
    }
    expect(seen).toHaveLength(1);
    expect(jobs.size).toBe(0);
  });

  it('requires explicit confirmation and rejects stale source inputs before starting', async () => {
    const saved = await workspace();
    await post(saved.id);
    const withoutConfirmation: Record<string, unknown> = startArgs();
    delete withoutConfirmation.confirmExternalRequests;
    expect((await post(saved.id, 'start', withoutConfirmation)).status).toBe(400);
    expect((await post(saved.id, 'start', { ...startArgs(), confirmExternalRequests: false })).status).toBe(400);
    expect((await post(saved.id, 'start', { ...startArgs(), sourceRowIds: ['row-1'] })).status).toBe(400);
    await saveWorkspace(saved.id, { ...saved.state, contacts: saved.state.contacts.map((row) => ({ ...row, company: 'Changed' })) });
    expect((await post(saved.id, 'start', startArgs())).status).toBe(409);
    expect(seen.map((call) => call.path)).toEqual(['/api/v1/prepare_qualification']);
    expect(jobs.size).toBe(0);
  });

  it('saves the request before start, reconciles a lost response after reload, and pulls completed results without duplicate jobs', async () => {
    const saved = await workspace();
    await post(saved.id);
    const input = startArgs();
    beforeStartReply = async () => {
      expect(await getPomadeQualification(saved.id)).toMatchObject({ execution: { requestId: input.requestId, status: 'starting', job: null } });
    };
    loseStartResponse = true;
    expect((await post(saved.id, 'start', input)).status).toBe(502);
    expect(await (await get(saved.id)).json()).toMatchObject({ qualification: { execution: { requestId: input.requestId, status: 'unknown' } } });
    expect((await post(saved.id, 'start', startArgs())).status).toBe(409);
    expect(jobs.size).toBe(1);
    loseStartResponse = false;
    expect(await (await post(saved.id, 'status')).json()).toMatchObject({ qualification: { execution: { requestId: input.requestId, status: 'queued', job: { totalRows: 1 } },
      rows: [{ identity: { assessment: 'Match' } }, expect.anything()] } });
    expect((await post(saved.id, 'start', input)).status).toBe(200);
    expect(seen.filter((call) => call.path === '/api/v1/start_qualification_run')).toHaveLength(1);
    const job = jobs.get(input.requestId)!;
    Object.assign(job, { status: 'completed', cursor: 1, completedCount: 3 });
    expect(await (await post(saved.id, 'status')).json()).toMatchObject({ qualification: { execution: { status: 'completed', job: { cursor: 1, completedCount: 3 } } } });
    expect(await getWorkspace(saved.id)).toEqual(saved);
    expect(seen.every((call) => ['/api/v1/prepare_qualification', '/api/v1/start_qualification_run', '/api/v1/get_qualification_run', '/api/v1/get_qualification'].includes(call.path))).toBe(true);
  });

  it('retains an unknown request with no job and permits only an explicit retry using the same identity', async () => {
    const saved = await workspace();
    await post(saved.id);
    const input = startArgs();
    startReturnsNoJob = true;
    expect(await (await post(saved.id, 'start', input)).json()).toMatchObject({ qualification: { execution: { requestId: input.requestId, status: 'unknown', job: null } } });
    expect(await (await post(saved.id, 'status')).json()).toMatchObject({ qualification: { execution: { requestId: input.requestId, status: 'unknown', job: null } } });
    expect((await post(saved.id, 'start', { ...input, checks: ['email'] })).status).toBe(409);
    expect((await post(saved.id, 'start', startArgs())).status).toBe(409);
    startReturnsNoJob = false;
    expect(await (await post(saved.id, 'start', input)).json()).toMatchObject({ qualification: { execution: { requestId: input.requestId, status: 'queued' } } });
    expect(jobs.size).toBe(1);
    expect(seen.filter((call) => call.path === '/api/v1/start_qualification_run').map((call) => (call.body as { requestId: string }).requestId))
      .toEqual([input.requestId, input.requestId]);
  });

  it('retains definite preview rejection without trapping a newly reviewed run, and cancellation never starts work', async () => {
    const saved = await workspace();
    await post(saved.id);
    const input = startArgs();
    startRejected = true;
    expect((await post(saved.id, 'start', input)).status).toBe(409);
    expect(await (await get(saved.id)).json()).toMatchObject({ qualification: { execution: { requestId: input.requestId, status: 'rejected' } } });
    startRejected = false;
    const next = startArgs();
    expect((await post(saved.id, 'start', next)).status).toBe(200);
    expect(await (await post(saved.id, 'cancel')).json()).toMatchObject({ qualification: { execution: { requestId: next.requestId, status: 'cancelled' } } });
    expect(jobs.size).toBe(1);
    expect(seen.at(-2)?.path).toBe('/api/v1/cancel_qualification_run');
    expect(seen.at(-1)?.path).toBe('/api/v1/get_qualification');
  });

  it('does not lose an active request when source rows change or a transfer overlaps the start', async () => {
    const saved = await workspace();
    await post(saved.id);
    const baseline = (await getPomadeQualification(saved.id))!;
    const sendToken = await beginPomadeQualification(saved.id, baseline);
    const input = startArgs();
    await post(saved.id, 'start', input);
    expect(await savePomadeQualification(saved.id, sendToken!, baseline)).toBe(false);
    expect(await beginPomadeQualification(saved.id, baseline)).toBeNull();
    expect(await claimPomadeExecution(saved.id, baseline, baseline)).toBe(false);
    await saveWorkspace(saved.id, { ...saved.state, contacts: saved.state.contacts.map((row) => ({ ...row, company: 'Changed' })) });
    expect((await post(saved.id)).status).toBe(409);
    expect(await (await post(saved.id, 'status')).json()).toMatchObject({ qualification: { stale: true, execution: { requestId: input.requestId, status: 'queued' } } });
    expect(jobs.size).toBe(1);
  });

  it('uses the raw email when a saved normalized field is empty and fingerprints only qualification inputs', async () => {
    const saved = await workspace();
    const contacts = saved.state.contacts.map((row) => ({ ...row, normalizedEmail: '' }));
    expect(qualificationInputs(contacts)[0].email).toBe('ada@example.test');
    const rows = qualificationInputs(contacts);
    expect(qualificationInputFingerprint(saved.id, rows, '  CRM software ')).toBe(qualificationInputFingerprint(saved.id, [...rows].reverse(), 'CRM software'));
    expect(qualificationRequestDigest({ sourceWorkspaceId: saved.id, sourceRevision: 1, sourceName: 'A', icpCriteria: 'CRM software', rows }))
      .toBe(qualificationRequestDigest({ sourceWorkspaceId: saved.id, sourceRevision: 20, sourceName: 'B', icpCriteria: ' CRM software ', rows: [...rows].reverse() }));
  });
});


it.each(['contact', 'contact_company'] as const)('suppresses saved %s rows without invalidating unchanged results or making new Pomade requests', async (importObject) => {
  const { saveSuppressionRule, deleteSuppressionRule } = await import('../lib/suppression-store');
  const initial = await workspace(importObject);
  const saved = await saveWorkspace(initial.id, { ...initial.state, contacts: initial.state.contacts.filter((row) => ['row-0', 'row-3'].includes(row.contactId)) });
  await post(saved.id);
  await post(saved.id, 'refresh');
  const original = await getPomadeQualification(saved.id);
  const rule = (await saveSuppressionRule({ listName: 'Fixture exclusions', type: 'email', value: 'ada@example.test', reason: 'Vendor' })).find((item) => item.listName === 'Fixture exclusions')!;
  seen.length = 0;
  try {
    const response = await (await get(saved.id)).json() as PomadeQualificationResponse;
    expect(response.qualification).toMatchObject({ stale: false });
    expect(response.readiness.rows.find((row) => row.sourceRowId === 'row-0')).toMatchObject({ status: 'excluded' });
    expect(response.readiness.rows.find((row) => row.sourceRowId === 'row-3')!.reasons.some((reason) => reason.code === 'qualification_stale')).toBe(false);
    expect((await post(saved.id, 'preview', scope)).status).toBe(409);
    expect((await post(saved.id, 'start', startArgs())).status).toBe(409);
    expect((await post(saved.id)).status).toBe(200);
    expect(seen).toHaveLength(0);
    expect(await getPomadeQualification(saved.id)).toEqual(original);
  } finally { await deleteSuppressionRule(rule.id); }
  expect((await (await get(saved.id)).json() as PomadeQualificationResponse).qualification?.stale).toBe(false);
  expect(await getPomadeQualification(saved.id)).toEqual(original);
  expect(seen).toHaveLength(0);
});


describe('combined contact and associated-company qualification', () => {
  it('sends associated company inputs and contact emails, then saves and reloads all checks under the existing run controls', async () => {
    const saved = await workspace('contact_company');
    const db = await getDatabase();
    const receipts = await db.prepare('SELECT * FROM connector_runs WHERE workspace_id = ?').bind(saved.id).all();
    const sent = await post(saved.id);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ qualification: { stale: false, rows: [
      { sourceRowId: 'row-0', inputs: { company: 'Example', website: 'https://example.test', email: 'ada@example.test' },
        identity: { state: 'not_run' }, icp: { state: 'not_run' }, email: { state: 'not_run' } },
      { sourceRowId: 'row-3', inputs: { company: '', website: '', email: '' } },
    ] } });
    expect(seen[0]).toMatchObject({ path: '/api/v1/prepare_qualification', body: { rows: [
      { sourceRowId: 'row-0', company: 'Example', website: 'https://example.test', email: 'ada@example.test' },
      { sourceRowId: 'row-3', company: '', website: '', email: '' },
    ] } });
    expect((await post(saved.id)).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(await (await post(saved.id, 'preview', scope)).json()).toMatchObject({
      preview: { rowCount: 1, maximumSubmissions: 3, previewHash },
    });
    const input = startArgs();
    expect((await post(saved.id, 'start', { ...input, confirmExternalRequests: false })).status).toBe(400);
    expect((await post(saved.id, 'start', { ...input, previewHash: 'not-a-preview' })).status).toBe(400);
    expect((await post(saved.id, 'preview', { ...scope, sourceRowIds: ['row-1'] })).status).toBe(400);
    expect(jobs.size).toBe(0);
    startRejected = true;
    expect((await post(saved.id, 'start', input)).status).toBe(409);
    expect(await (await get(saved.id)).json()).toMatchObject({ qualification: { execution: { status: 'rejected' } } });
    expect(jobs.size).toBe(0);
    startRejected = false;
    const accepted = startArgs();
    expect((await post(saved.id, 'start', accepted)).status).toBe(200);
    expect((await post(saved.id, 'start', accepted)).status).toBe(200);
    expect(jobs.size).toBe(1);
    Object.assign(jobs.get(accepted.requestId)!, { status: 'completed', cursor: 1, completedCount: 3 });
    const completed = await (await post(saved.id, 'status')).json() as PomadeQualificationResponse;
    expect(completed.qualification).toMatchObject({ stale: false, execution: { status: 'completed' }, rows: [
      { sourceRowId: 'row-0', identity: { assessment: 'Match' }, icp: { assessment: 'Fit' }, email: { assessment: 'catch_all' } },
      expect.anything(),
    ] });
    expect(completed.readiness.counts).toEqual({ ready: 0, needsReview: 2, excluded: 2 });
    expect(completed.readiness.rows[0].reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['local_object_review_only', 'email_review']));
    expect((await post(saved.id, 'refresh')).status).toBe(200);
    const beforeReload = seen.length;
    expect((await (await get(saved.id)).json() as PomadeQualificationResponse).qualification).toEqual(completed.qualification);
    expect(seen).toHaveLength(beforeReload);
    expect(await getWorkspace(saved.id)).toEqual(saved);
    expect(await db.prepare('SELECT * FROM connector_runs WHERE workspace_id = ?').bind(saved.id).all()).toEqual(receipts);
    expect(seen.every((call) => [
      '/api/v1/prepare_qualification', '/api/v1/preview_qualification_run', '/api/v1/start_qualification_run',
      '/api/v1/get_qualification_run', '/api/v1/get_qualification',
    ].includes(call.path))).toBe(true);
  });

  it('binds results to associated company name and website plus contact email, leaving unrelated mapping fields out', async () => {
    const saved = await workspace('contact_company');
    const initialInputs = qualificationInputs(saved.state.contacts);
    const fingerprint = (contacts: typeof saved.state.contacts) => qualificationInputFingerprint(saved.id, qualificationInputs(contacts), 'CRM software');
    const original = fingerprint(saved.state.contacts);
    const unrelated = saved.state.contacts.map((row) => ({ ...row, ownerId: 'new-owner', company: 'Changed context', website: 'https://changed-context.test',
      associatedCompany: { ...row.associatedCompany!, recordId: 'company-record', phone: '555 0100', state: 'MA' } }));
    expect(fingerprint(unrelated)).toBe(original);
    for (const patch of [{ name: 'Changed company' }, { website: 'https://changed-company.test' }]) {
      expect(fingerprint(saved.state.contacts.map((row) => row.contactId === 'row-0'
        ? { ...row, associatedCompany: { ...row.associatedCompany!, ...patch } } : row))).not.toBe(original);
    }
    expect(fingerprint(saved.state.contacts.map((row) => row.contactId === 'row-0'
      ? { ...row, normalizedEmail: 'different@example.test' } : row))).not.toBe(original);
    const missing = { ...saved.state.contacts[0], associatedCompany: undefined };
    expect(qualificationInputs([missing])[0]).toEqual({ ...initialInputs[0], company: '', website: '' });
    await post(saved.id);
    const sameInputs = await saveWorkspace(saved.id, { ...saved.state, contacts: unrelated });
    expect(await (await get(saved.id)).json()).toMatchObject({ qualification: { stale: false } });
    expect((await post(saved.id)).status).toBe(200);
    expect(seen).toHaveLength(1);
    await saveWorkspace(saved.id, { ...sameInputs.state, contacts: sameInputs.state.contacts.map((row) => ({ ...row,
      associatedCompany: { ...row.associatedCompany!, name: 'Changed associated company' },
    })) });
    expect(await (await get(saved.id)).json()).toMatchObject({ qualification: { stale: true } });
    expect((await post(saved.id, 'preview', scope)).status).toBe(409);
    expect((await post(saved.id, 'start', startArgs())).status).toBe(409);
    expect(seen).toHaveLength(1);
    expect(jobs.size).toBe(0);
  });

  it('transfers and reads back 140 combined rows while retaining the 100-row execution scope limit', async () => {
    const initial = await workspace('contact_company');
    const row = initial.state.contacts[0];
    const contacts = Array.from({ length: 140 }, (_, index) => ({ ...row, contactId: `sample-${String(index).padStart(3, '0')}` }));
    const saved = await saveWorkspace(initial.id, { ...initial.state, contacts, originalContacts: contacts });
    expect((await post(saved.id)).status).toBe(200);
    expect((seen[0].body as PrepareQualificationInput).rows).toHaveLength(140);
    const refreshed = await (await post(saved.id, 'refresh')).json() as PomadeQualificationResponse;
    expect(refreshed.qualification?.rows).toHaveLength(140);
    expect(refreshed.readiness.counts).toEqual({ ready: 0, needsReview: 140, excluded: 0 });
    const beforeRun = seen.length;
    const tooMany = contacts.slice(0, 101).map((contact) => contact.contactId);
    expect((await post(saved.id, 'preview', { ...scope, sourceRowIds: tooMany })).status).toBe(400);
    expect((await post(saved.id, 'start', { ...startArgs(), sourceRowIds: tooMany })).status).toBe(400);
    expect(seen).toHaveLength(beforeRun);
    expect(jobs.size).toBe(0);
    expect(await getWorkspace(saved.id)).toEqual(saved);
  });

  it('retains the 500-row transfer cap for combined imports without preparing or running anything', async () => {
    const saved = await workspace('contact_company');
    const row = saved.state.contacts[0];
    await saveWorkspace(saved.id, { ...saved.state, contacts: Array.from({ length: 501 }, (_, index) => ({ ...row, contactId: `many-${index}` })) });
    const rejected = await post(saved.id);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('between 1 and 500') });
    expect(seen).toHaveLength(0);
    expect(jobs.size).toBe(0);
  });
});
