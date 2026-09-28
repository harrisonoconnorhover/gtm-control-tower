import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canVerifyCrmRun, verifyCrmRun } from '../lib/crm-run-verification';
import { verificationFixture } from './fixtures/crm-verification-run';

const store = vi.hoisted(() => ({ getConnectorRun: vi.fn(), saveCrmRunVerification: vi.fn(), persistenceEnabled: vi.fn() }));
vi.mock('../lib/workspace-store', () => store);
import { POST } from '../app/api/control-tower/runs/verify/route';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'verification-key');
  vi.stubEnv('HUBSPOT_ACCESS_TOKEN', 'fictional-token');
  vi.stubEnv('SALESFORCE_ACCESS_TOKEN', 'fictional-token');
  vi.stubEnv('SALESFORCE_INSTANCE_URL', 'https://example.my.salesforce.com');
  store.persistenceEnabled.mockReturnValue(true);
  store.saveCrmRunVerification.mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe.each(['hubspot', 'salesforce'] as const)('%s post-write comparison', (connectorId) => {
  it.each(['create', 'update'] as const)('verifies a %s by native ID without mutating its receipt', async (operation) => {
    const { run, current } = verificationFixture(connectorId, operation);
    const original = structuredClone(run);
    const read = vi.fn().mockResolvedValue(current);
    const checked = await verifyCrmRun(run, read);
    expect(read).toHaveBeenCalledExactlyOnceWith(connectorId, current.nativeId);
    expect(checked).toMatchObject({ runId: run.id, planId: run.details!.plan!.planId, connectorId, verified: 1, different: 0, unavailable: 0,
      records: [{ status: 'verified', differences: [], expected: { email: current.email, ...current.fields }, actual: { email: current.email, ...current.fields }, error: null }] });
    expect(Date.parse(checked.checkedAt)).not.toBeNaN();
    expect(run).toEqual(original);
  });

  it('compares the preserved CRM email of a confirmed person and every approved field', async () => {
    const { run, current } = verificationFixture(connectorId);
    const planned = run.details!.plan!.records[0];
    planned.email = 'priya.new@example.com';
    planned.matchDecision = { nativeId: current.nativeId, email: current.email, reason: 'Name and phone match.', confirmedAt: new Date().toISOString() };
    run.details!.writeback!.records[0].email = planned.email;
    const read = vi.fn().mockResolvedValue({ ...current, email: 'changed@example.com', fields: { ...current.fields, company: 'Changed company', jobTitle: 'Manager' } });
    expect(await verifyCrmRun(run, read)).toMatchObject({ verified: 0, different: 1, unavailable: 0, records: [{ status: 'different', differences: [
      { field: 'email', expected: current.email, actual: 'changed@example.com' },
      { field: 'company', expected: 'Example', actual: 'Changed company' },
      { field: 'jobTitle', expected: 'Director', actual: 'Manager' },
    ] }] });
  });

  it.each(['missing', 'read error', 'wrong ID', 'wrong type', 'missing field'] as const)('reports %s as unavailable rather than a failed write', async (failure) => {
    const { run, current } = verificationFixture(connectorId);
    const read = vi.fn().mockResolvedValue(current);
    if (failure === 'missing') read.mockResolvedValue(null);
    if (failure === 'read error') read.mockRejectedValue(new Error('CRM returned 429'));
    if (failure === 'wrong ID') read.mockResolvedValue({ ...current, nativeId: '999' });
    if (failure === 'wrong type') read.mockResolvedValue({ ...current, objectType: connectorId === 'hubspot' ? 'lead' : 'contact' });
    if (failure === 'missing field') read.mockResolvedValue({ ...current, fields: { ...current.fields, company: undefined } });
    const checked = await verifyCrmRun(run, read);
    expect(checked).toMatchObject({ verified: 0, different: 0, unavailable: 1, records: [{ status: 'unavailable', error: expect.any(String) }] });
    expect(run.details!.writeback!.records[0].status).toBe('updated');
  });

  it('does not make a native request when saved row identities disagree', async () => {
    const { run } = verificationFixture(connectorId);
    run.details!.writeback!.records[0].nativeId = connectorId === 'hubspot' ? '456' : '00Q000000000002EAA';
    const read = vi.fn();
    expect(await verifyCrmRun(run, read)).toMatchObject({ unavailable: 1, records: [{ expected: null, error: expect.stringContaining('target') }] });
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses to invent expected null values when saved plan fields are absent', async () => {
    const { run } = verificationFixture(connectorId, 'create');
    Reflect.deleteProperty(run.details!.plan!.records[0].after, 'website');
    const read = vi.fn();
    expect(await verifyCrmRun(run, read)).toMatchObject({ unavailable: 1, records: [{ expected: null }] });
    expect(read).not.toHaveBeenCalled();
  });
});

it('keeps a HubSpot alias import distinct from its preserved primary email', async () => {
  const { run, current } = verificationFixture();
  run.details!.plan!.records[0].email = 'priya.alias@example.com';
  run.details!.writeback!.records[0].email = 'priya.alias@example.com';
  expect(await verifyCrmRun(run, vi.fn().mockResolvedValue(current))).toMatchObject({ verified: 1, records: [{ expected: { email: current.email } }] });
});

it('holds verification of a now-converted Salesforce Lead', async () => {
  const { run, current } = verificationFixture('salesforce');
  expect(await verifyCrmRun(run, vi.fn().mockResolvedValue({ ...current, isConverted: true }))).toMatchObject({ unavailable: 1,
    records: [{ error: expect.stringContaining('converted') }] });
});

it('excludes held, failed, unchanged, and rollback-only outcomes', async () => {
  const { run } = verificationFixture();
  for (const status of ['held', 'failed', 'unchanged', 'rolled_back'] as const) {
    run.details!.writeback!.records[0].status = status;
    expect(canVerifyCrmRun(run)).toBe(false);
  }
});

it('requires matching provider, run, and plan evidence', () => {
  const { run } = verificationFixture();
  expect(canVerifyCrmRun({ ...run, id: 'another-run' })).toBe(false);
  expect(canVerifyCrmRun({ ...run, connectorId: 'salesforce' })).toBe(false);
  run.details!.writeback!.planId = 'another-plan';
  expect(canVerifyCrmRun(run)).toBe(false);
});

it('bounds provider concurrency to four reads and keeps result order', async () => {
  const { run, current } = verificationFixture('hubspot', 'create');
  const plan = run.details!.plan!;
  const receipt = run.details!.writeback!;
  plan.records = Array.from({ length: 9 }, (_, index) => ({ ...plan.records[0], contactId: `row-${index}` }));
  receipt.records = plan.records.map((row, index) => ({ ...receipt.records[0], contactId: row.contactId, nativeId: String(index + 1) }));
  let active = 0;
  let maximum = 0;
  const checked = await verifyCrmRun(run, async (_provider, nativeId) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return { ...current, nativeId };
  });
  expect(maximum).toBe(4);
  expect(checked.verified).toBe(9);
  expect(checked.records.map((row) => row.contactId)).toEqual(plan.records.map((row) => row.contactId));
});

function request(body: unknown, key = 'verification-key') {
  return new Request('http://localhost/api/control-tower/runs/verify', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-control-tower-key': key }, body: JSON.stringify(body) });
}

describe('saved run verification endpoint', () => {
  it.each(['hubspot', 'salesforce'] as const)('reads %s only with GET and persists before returning a successful check', async (connectorId) => {
    const { run, current } = verificationFixture(connectorId);
    store.getConnectorRun.mockResolvedValue(run);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(init?.method ?? 'GET').toBe('GET');
      return Response.json(connectorId === 'hubspot'
        ? { id: current.nativeId, properties: { email: current.email, firstname: current.fields.firstName, lastname: current.fields.lastName,
          company: current.fields.company, phone: current.fields.phone, jobtitle: current.fields.jobTitle, website: current.fields.website } }
        : { Id: current.nativeId, Email: current.email, IsConverted: false, FirstName: current.fields.firstName, LastName: current.fields.lastName,
          Company: current.fields.company, Phone: current.fields.phone, Title: current.fields.jobTitle, Website: current.fields.website });
    });
    const response = await POST(request({ workspaceId: run.workspaceId, runId: run.id }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verification: { verified: 1 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.getConnectorRun).toHaveBeenCalledWith(run.workspaceId, run.id);
    expect(store.saveCrmRunVerification).toHaveBeenCalledWith(run.workspaceId, run, expect.objectContaining({ runId: run.id, verified: 1 }));
  });

  it('requires the operator key and rejects client-supplied expected values or native IDs', async () => {
    expect((await POST(request({ workspaceId: 'workspace', runId: 'run' }, 'wrong'))).status).toBe(401);
    expect((await POST(request({ workspaceId: 'workspace', runId: 'run', nativeId: '123' }))).status).toBe(400);
    expect(store.getConnectorRun).not.toHaveBeenCalled();
  });

  it('does not read the CRM for an unknown workspace run', async () => {
    store.getConnectorRun.mockResolvedValue(null);
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect((await POST(request({ workspaceId: 'other-workspace', runId: 'run' }))).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['run changed', 'storage error'] as const)('does not claim a saved check after %s', async (failure) => {
    const { run } = verificationFixture();
    store.getConnectorRun.mockResolvedValue(run);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    if (failure === 'run changed') store.saveCrmRunVerification.mockResolvedValue(false);
    else store.saveCrmRunVerification.mockRejectedValue(new Error('Database unavailable'));
    const response = await POST(request({ workspaceId: run.workspaceId, runId: run.id }));
    expect(response.status).toBe(failure === 'run changed' ? 409 : 502);
    expect(await response.json()).not.toHaveProperty('verification');
  });
});
