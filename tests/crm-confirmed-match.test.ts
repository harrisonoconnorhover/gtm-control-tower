import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveContactState } from '../lib/live-control-tower';
import { emptyWorkspaceState } from '../lib/workspace';
import { importMatchSourceKey, type ConfirmedImportMatch } from '../lib/import-match-decision';
import { signImportMatch } from '../lib/import-match-decision-server';
import type { CrmWritePlan, CrmWritebackReceipt, NativeCrmRecord, PortableCrmContact } from '../lib/crm-workflow';

const store = vi.hoisted(() => ({ getWorkspace: vi.fn(), getLatestDuplicateScan: vi.fn(), getDuplicateScanRecords: vi.fn() }));
vi.mock('../lib/workspace-store', () => ({ getWorkspace: store.getWorkspace, persistenceEnabled: () => true }));
vi.mock('../lib/duplicate-scan-store', () => ({ getLatestDuplicateScan: store.getLatestDuplicateScan, getDuplicateScanRecords: store.getDuplicateScanRecords }));
import { POST } from '../app/api/control-tower/crm-writeback/route';

type Provider = 'hubspot' | 'salesforce';
const workspaceId = 'confirmed-match-workspace';
const policy = { mode: 'replace' as const, fields: ['jobTitle' as const], clearBlanks: false };
const targetEmail = 'priya.nair@example.com';
let rows: LiveContactState[];

function source(contactId = 'priya', email = 'p.nair@example.com'): LiveContactState {
  return { contactId, fullName: 'Priya Nair', firstName: 'Priya', lastName: 'Nair', rawEmail: email, normalizedEmail: email,
    company: 'Example', phone: '415-555-0123', jobTitle: 'Director', website: null, state: 'CA', recordStatus: 'active',
    qualityFlags: [], region: 'West', segment: '', lifecycleStage: 'Lead', expectedLifecycleStage: 'Lead',
    ownerId: null, canonicalContactId: null, lastAction: '', updatedAt: new Date().toISOString() };
}
function native(connectorId: Provider): NativeCrmRecord {
  return { nativeId: connectorId === 'hubspot' ? '123' : '00Q000000000001EAA',
    objectType: connectorId === 'hubspot' ? 'contact' : 'lead', ...(connectorId === 'salesforce' ? { isConverted: false } : {}),
    email: targetEmail, fields: { firstName: 'Priya', lastName: 'Nair', company: 'Example', phone: '415-555-0123', jobTitle: 'Manager', website: null } };
}
async function confirm(connectorId: Provider, row: LiveContactState, target = native(connectorId)) {
  const unsigned = { connectorId, scanId: 'scan-1', sourceKey: importMatchSourceKey(row), target,
    reason: 'Reviewed name, employer and matching phone.', confirmedAt: new Date().toISOString() };
  const decision: ConfirmedImportMatch = { ...unsigned, signature: await signImportMatch(workspaceId, unsigned) };
  row.crmMatchDecisions = { ...row.crmMatchDecisions, [connectorId]: decision };
  return decision;
}
function proposed(row: LiveContactState): PortableCrmContact {
  return { contactId: row.contactId, email: row.normalizedEmail!, firstName: row.firstName!, lastName: row.lastName!,
    company: row.company, phone: row.phone ?? null, jobTitle: row.jobTitle ?? null, website: row.website ?? null };
}
function request(connectorId: Provider, selected = rows, plan?: CrmWritePlan): Request {
  return new Request('http://localhost/api/control-tower/crm-writeback', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: plan ? 'execute' : 'preview', connectorId, workspaceId, contacts: selected.map(proposed),
      sourceFile: 'fictional.csv', updatePolicy: policy, plan }) });
}

function crm(connectorId: Provider) {
  const state = { current: native(connectorId) as NativeCrmRecord | null, exactConflict: null as NativeCrmRecord | null, writes: [] as Record<string, unknown>[], queriedEmails: [] as string[] };
  const hubspot = (record: NativeCrmRecord) => ({ id: record.nativeId, properties: { email: record.email,
    hs_additional_emails: record.additionalEmails?.join(';'),
    firstname: record.fields.firstName, lastname: record.fields.lastName, company: record.fields.company,
    phone: record.fields.phone, jobtitle: record.fields.jobTitle, website: record.fields.website } });
  const salesforce = (record: NativeCrmRecord) => ({ Id: record.nativeId, Email: record.email, IsConverted: record.isConverted,
    FirstName: record.fields.firstName, LastName: record.fields.lastName, Company: record.fields.company,
    Phone: record.fields.phone, Title: record.fields.jobTitle, Website: record.fields.website });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname.endsWith('/batch/read')) {
      const emails = body.inputs.map((item: { id: string }) => item.id);
      state.queriedEmails.push(...emails);
      return Response.json({ status: 'COMPLETE', results: [state.current, state.exactConflict].filter((record) => record
        && [record.email, ...record.additionalEmails ?? []].some((email) => emails.includes(email))).map((record) => hubspot(record!)) });
    }
    if (url.pathname.endsWith('/query')) {
      const query = url.searchParams.get('q')!;
      state.queriedEmails.push(query);
      return Response.json({ done: true, records: query.includes('FROM Lead')
        ? [state.current, state.exactConflict].filter((record) => record && query.includes(`'${record.email}'`)).map((record) => salesforce(record!)) : [] });
    }
    if (url.searchParams.get('idProperty') === 'email') return new Response(null, { status: 404 });
    if (url.pathname.endsWith(`/contacts/${native('hubspot').nativeId}`) || url.pathname.endsWith(`/sobjects/Lead/${native('salesforce').nativeId}`)) {
      return state.current ? Response.json(connectorId === 'hubspot' ? hubspot(state.current) : salesforce(state.current)) : new Response(null, { status: 404 });
    }
    if (connectorId === 'hubspot') {
      expect(url.pathname).toContain('/batch/update');
      state.writes.push(body);
      state.current!.fields.jobTitle = body.inputs[0].properties.jobtitle;
      return Response.json({ status: 'COMPLETE', results: [{ id: state.current!.nativeId, objectWriteTraceId: body.inputs[0].objectWriteTraceId }] });
    }
    expect(url.pathname).toContain('/composite/sobjects');
    expect(init?.method).toBe('PATCH');
    state.writes.push(body);
    state.current!.fields.jobTitle = body.records[0].Title;
    return Response.json([{ id: state.current!.nativeId, success: true, errors: [] }]);
  });
  return state;
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('CONTROL_TOWER_SYNC_KEY', '');
  vi.stubEnv('SALESFORCE_INSTANCE_URL', 'https://example.my.salesforce.com');
  vi.stubEnv('SALESFORCE_ACCESS_TOKEN', 'fictional-test-token');
  vi.stubEnv('HUBSPOT_ACCESS_TOKEN', 'fictional-test-token');
  rows = [source()];
  store.getWorkspace.mockImplementation(async () => ({ id: workspaceId, state: { ...emptyWorkspaceState(), contacts: rows, crmUpdatePolicy: policy } }));
  store.getLatestDuplicateScan.mockResolvedValue(null);
  store.getDuplicateScanRecords.mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe.each(['hubspot', 'salesforce'] as const)('%s confirmed existing person', (connectorId) => {
  it('updates the selected ID, keeps both emails distinct, and rolls back only the changed field', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const state = crm(connectorId);
    await confirm(connectorId, rows[0]);
    const preview = await POST(request(connectorId));
    expect(preview.status).toBe(200);
    const plan = await preview.json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 0, updates: 1, held: 0, records: [{ email: 'p.nair@example.com', nativeId: native(connectorId).nativeId,
      matchDecision: { email: targetEmail, reason: 'Reviewed name, employer and matching phone.' }, changes: [{ field: 'jobTitle', before: 'Manager', after: 'Director' }] }] });
    expect(state.writes).toEqual([]);
    vi.setSystemTime(new Date(Date.now() + 1_000));
    const execution = await POST(request(connectorId, rows, plan));
    expect(execution.status).toBe(202);
    const receipt = await execution.json() as CrmWritebackReceipt;
    expect(receipt).toMatchObject({ planId: plan.planId, created: 0, updated: 1, failed: 0, records: [{ email: 'p.nair@example.com', nativeId: native(connectorId).nativeId }],
      rollback: { sourcePlanId: plan.planId, records: [{ email: 'p.nair@example.com', targetEmail, changedFields: ['jobTitle'] }] } });
    expect(state.current?.email).toBe(targetEmail);
    expect(state.writes[0]).toMatchObject(connectorId === 'hubspot'
      ? { inputs: [{ id: '123', properties: { jobtitle: 'Director' } }] }
      : { records: [{ Id: native(connectorId).nativeId, Title: 'Director' }] });
    expect(JSON.stringify(state.writes)).not.toMatch(/"[Ee]mail"/);
    const rollback = await POST(new Request('http://localhost/api/control-tower/crm-writeback', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'rollback', connectorId, rollback: receipt.rollback }) }));
    expect(rollback.status).toBe(202);
    expect(await rollback.json()).toMatchObject({ updated: 1, held: 0, failed: 0, records: [{ email: 'p.nair@example.com', status: 'rolled_back' }] });
    expect(state.current?.fields.jobTitle).toBe('Manager');
    expect(state.current?.email).toBe(targetEmail);
    expect(state.queriedEmails.some((email) => email.includes(targetEmail))).toBe(true);
    expect(state.writes).toHaveLength(2);
    expect(JSON.stringify(state.writes)).not.toMatch(/"[Ee]mail"/);
  });

  it.each(['malformed decision', 'invalid signature', 'changed source', 'changed target', 'missing target'] as const)('holds %s without falling back to creating a duplicate', async (change) => {
    const state = crm(connectorId);
    const decision = await confirm(connectorId, rows[0]);
    const plan = await (await POST(request(connectorId))).json() as CrmWritePlan;
    expect(plan.updates).toBe(1);
    if (change === 'invalid signature') decision.signature = '0'.repeat(64);
    if (change === 'malformed decision') decision.signature = '';
    if (change === 'changed source') rows[0].phone = '415-555-0140';
    if (change === 'changed target') state.current!.fields.jobTitle = 'Changed elsewhere';
    if (change === 'missing target') state.current = null;
    expect((await POST(request(connectorId, rows, plan))).status).toBe(409);
    const held = await (await POST(request(connectorId))).json() as CrmWritePlan;
    expect(held).toMatchObject({ creates: 0, updates: 0, held: 1, records: [{ operation: 'hold' }] });
    expect(state.writes).toEqual([]);
  });

  it('holds a confirmed target when the imported email now belongs to another native record', async () => {
    const state = crm(connectorId);
    await confirm(connectorId, rows[0]);
    state.exactConflict = { ...native(connectorId), nativeId: connectorId === 'hubspot' ? '456' : '00Q000000000002EAA', email: rows[0].normalizedEmail! };
    const plan = await (await POST(request(connectorId))).json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 0, updates: 0, held: 1, records: [{ reason: expect.stringContaining('different CRM record') }] });
    expect(state.writes).toEqual([]);
  });

  it.each(['selected same target', 'target email'] as const)('holds both competing rows across batches when another row has %s', async (peerKind) => {
    const state = crm(connectorId);
    await confirm(connectorId, rows[0]);
    const before = await (await POST(request(connectorId))).json() as CrmWritePlan;
    expect(before.updates).toBe(1);
    const peer = source('later-batch', peerKind === 'target email' ? targetEmail : 'priya@example.com');
    if (peerKind === 'selected same target') await confirm(connectorId, peer);
    rows.push(peer);
    expect((await POST(request(connectorId, [rows[0]], before))).status).toBe(409);
    for (const row of rows) {
      const held = await (await POST(request(connectorId, [row]))).json() as CrmWritePlan;
      expect(held).toMatchObject({ creates: 0, updates: 0, held: 1, records: [{ reason: expect.stringContaining('later batches') }] });
    }
    expect(state.writes).toEqual([]);
  });

  it.each(['skipped', 'merged'] as const)('ignores an explicitly %s peer when checking target collisions', async (status) => {
    crm(connectorId);
    await confirm(connectorId, rows[0]);
    const peer = source('other-row', targetEmail);
    await confirm(connectorId, peer);
    if (status === 'skipped') peer.importExclusion = { reason: 'Keep the reviewed row', excludedAt: new Date().toISOString() };
    else peer.recordStatus = 'merged';
    rows.push(peer);
    const plan = await (await POST(request(connectorId, [rows[0]]))).json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 0, updates: 1, held: 0 });
  });
});

it('holds a Salesforce Lead converted after confirmation', async () => {
  const state = crm('salesforce');
  await confirm('salesforce', rows[0]);
  state.current!.isConverted = true;
  const plan = await (await POST(request('salesforce'))).json() as CrmWritePlan;
  expect(plan).toMatchObject({ creates: 0, updates: 0, held: 1 });
  expect(state.writes).toEqual([]);
});

describe('HubSpot secondary-email identities across import batches', () => {
  const aliases = ['priya.events@example.com', 'priya.old@example.com'];

  it.each(['confirmed person', 'primary email', 'another secondary email'] as const)(
    'holds competing later-batch aliases against a row using %s, then releases an explicitly skipped peer', async (identity) => {
      const state = crm('hubspot');
      state.current!.additionalEmails = aliases;
      if (identity !== 'confirmed person') rows = [source('first-batch', identity === 'primary email' ? targetEmail : aliases[1])];
      else await confirm('hubspot', rows[0], structuredClone(state.current!));
      const before = await (await POST(request('hubspot'))).json() as CrmWritePlan;
      expect(before).toMatchObject({ updates: 1, held: 0 });
      const peer = source('later-batch', aliases[0]);
      peer.jobTitle = 'VP';
      rows.push(peer);

      expect((await POST(request('hubspot', [rows[0]], before))).status).toBe(409);
      for (const row of rows) {
        const held = await (await POST(request('hubspot', [row]))).json() as CrmWritePlan;
        expect(held).toMatchObject({ creates: 0, updates: 0, held: 1, records: [{ reason: expect.stringContaining('later batches') }] });
      }
      expect(state.writes).toEqual([]);
      peer.importExclusion = { reason: 'Keep the reviewed first row', excludedAt: new Date().toISOString() };
      const released = await (await POST(request('hubspot', [rows[0]]))).json() as CrmWritePlan;
      expect(released).toMatchObject({ creates: 0, updates: 1, held: 0 });
    },
  );

  it('invalidates a confirmed preview when the current CRM alias set changes', async () => {
    const state = crm('hubspot');
    state.current!.additionalEmails = aliases;
    await confirm('hubspot', rows[0], structuredClone(state.current!));
    const before = await (await POST(request('hubspot'))).json() as CrmWritePlan;
    expect(before.updates).toBe(1);
    state.current!.additionalEmails = [aliases[0]];
    expect((await POST(request('hubspot', rows, before))).status).toBe(409);
    const held = await (await POST(request('hubspot'))).json() as CrmWritePlan;
    expect(held).toMatchObject({ creates: 0, updates: 0, held: 1, records: [{ reason: expect.stringContaining('confirmed CRM record changed') }] });
    expect(state.writes).toEqual([]);
  });

  it.each(['skipped', 'merged'] as const)('ignores a %s alias peer even when both rows are requested together', async (status) => {
    const state = crm('hubspot');
    state.current!.additionalEmails = aliases;
    rows = [source('included', targetEmail), source('excluded', aliases[0])];
    if (status === 'skipped') rows[1].importExclusion = { reason: 'Keep the other row', excludedAt: new Date().toISOString() };
    else rows[1].recordStatus = 'merged';
    const plan = await (await POST(request('hubspot'))).json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 0, updates: 1, held: 1 });
    expect(plan.records.find((record) => record.contactId === 'included')?.operation).toBe('update');
    expect(state.writes).toEqual([]);
  });
});
