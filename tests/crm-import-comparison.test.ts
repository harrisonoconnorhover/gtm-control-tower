import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentityRecord } from '../lib/identity-resolution';
import type { LiveContactState } from '../lib/live-control-tower';
import { emptyWorkspaceState } from '../lib/workspace';

const store = vi.hoisted(() => ({ getWorkspace: vi.fn(), getLatestDuplicateScan: vi.fn(), getDuplicateScanRecords: vi.fn() }));
vi.mock('../lib/workspace-store', () => ({ getWorkspace: store.getWorkspace, persistenceEnabled: () => true }));
vi.mock('../lib/duplicate-scan-store', () => ({ getLatestDuplicateScan: store.getLatestDuplicateScan, getDuplicateScanRecords: store.getDuplicateScanRecords }));
import { POST } from '../app/api/control-tower/crm-writeback/route';
import type { CrmWritePlan, PortableCrmContact } from '../lib/crm-workflow';

const contact = (id: string, email: string): PortableCrmContact => ({
  contactId: id, email, firstName: 'Test', lastName: 'Person', company: 'Example',
  phone: null, jobTitle: 'Analyst', website: null,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let savedContacts: LiveContactState[] = [];
let snapshotStartedAt = '';
function request(connectorId: 'salesforce' | 'hubspot', contacts: PortableCrmContact[], plan?: CrmWritePlan, overrides = {}) {
  savedContacts = contacts.map((item) => ({ ...item, fullName: `${item.firstName} ${item.lastName}`, rawEmail: item.email,
    normalizedEmail: item.email, state: 'WA', recordStatus: 'active', qualityFlags: [], region: 'West', segment: '',
    lifecycleStage: 'Lead', expectedLifecycleStage: 'Lead', ownerId: null, canonicalContactId: null, lastAction: '', updatedAt: new Date().toISOString(),
  }));
  return new Request('http://localhost/api/control-tower/crm-writeback', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectorId, contacts, sourceFile: 'synthetic.csv', action: plan ? 'execute' : 'preview', plan, workspaceId: 'workspace-1', ...overrides }),
  });
}
function snapshot(connectorId: 'salesforce' | 'hubspot') {
  return { id: 'snapshot-1', workspaceId: 'workspace-1', connectorId, complete: true, sourceComplete: true,
    recordsScanned: 0, startedAt: snapshotStartedAt };
}
const lead = (Id: string, Email: string, IsConverted = false) => ({
  Id, Email, IsConverted, FirstName: 'Test', LastName: 'Person', Company: 'Example',
  Phone: null, Title: 'Old title', Website: null,
});
const nativeContact = (Id: string, Email: string) => ({ ...lead(Id, Email), Account: { Name: 'Example', Website: null } });

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('CONTROL_TOWER_SYNC_KEY', '');
  vi.stubEnv('SALESFORCE_INSTANCE_URL', 'https://example.my.salesforce.com');
  vi.stubEnv('SALESFORCE_ACCESS_TOKEN', 'synthetic-test-token');
  vi.stubEnv('HUBSPOT_ACCESS_TOKEN', 'synthetic-test-token');
  snapshotStartedAt = new Date(Date.now() - 1000).toISOString();
  store.getWorkspace.mockImplementation(async () => ({ id: 'workspace-1', state: { ...emptyWorkspaceState(), contacts: savedContacts } }));
  store.getLatestDuplicateScan.mockImplementation(async (_workspaceId, connectorId) => snapshot(connectorId));
  store.getDuplicateScanRecords.mockResolvedValue([]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe('import comparison before governed CRM writes', () => {
  it('updates one active Lead, creates one new Lead, and never writes Contact or converted matches', async () => {
    const writes: Array<{ method?: string; body: { records: Array<{ Id?: string; Email?: string }> } }> = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/query')) {
        const query = url.searchParams.get('q')!;
        return response({ done: true, records: query.includes('FROM Lead')
          ? [lead('00Q-existing', 'lead@example.com'), lead('00Q-converted', 'converted@example.com', true)]
          : [nativeContact('003-existing', 'contact@example.com')] });
      }
      expect(url.pathname).toContain('/composite/sobjects');
      const body = JSON.parse(String(init?.body));
      writes.push({ method: init?.method, body });
      return response(body.records.map((record: { Id?: string }) => ({ id: record.Id ?? '00Q-new', success: true, errors: [] })));
    });
    const imported = [contact('one', 'lead@example.com'), contact('two', 'contact@example.com'), contact('three', 'converted@example.com'), contact('four', 'new@example.com')];
    const preview = await POST(request('salesforce', imported));
    expect(preview.status).toBe(200);
    const plan = await preview.json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 1, updates: 1, held: 2 });
    expect(writes).toEqual([]);
    const execution = await POST(request('salesforce', imported, plan));
    expect(execution.status).toBe(202);
    expect(await execution.json()).toMatchObject({ created: 1, updated: 1, held: 2, failed: 0 });
    expect(writes).toHaveLength(2);
    expect(writes.find((write) => write.method === 'POST')?.body.records).toMatchObject([{ Email: 'new@example.com' }]);
    expect(writes.find((write) => write.method === 'PATCH')?.body.records).toMatchObject([{ Id: '00Q-existing' }]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/query?'))).toHaveLength(4);
  });

  it('refuses a previously new Lead after a Contact appears before execution', async () => {
    let appeared = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const query = new URL(String(input)).searchParams.get('q')!;
      return response({ done: true, records: appeared && query.includes('FROM Contact') ? [nativeContact('003-new', 'new@example.com')] : [] });
    });
    const imported = [contact('one', 'new@example.com')];
    const plan = await (await POST(request('salesforce', imported))).json() as CrmWritePlan;
    expect(plan.creates).toBe(1);
    appeared = true;
    const result = await POST(request('salesforce', imported, plan));
    expect(result.status).toBe(409);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/query?'))).toBe(true);
  });

  it('retains the native Salesforce error code when a duplicate rule rejects a create', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (new URL(String(input)).pathname.endsWith('/query')) return response({ done: true, records: [] });
      return response([{ success: false, errors: [{ statusCode: 'DUPLICATES_DETECTED', message: 'Use one of these records?', fields: [] }] }]);
    });
    const imported = [contact('one', 'new@example.com')];
    const plan = await (await POST(request('salesforce', imported))).json() as CrmWritePlan;
    const result = await POST(request('salesforce', imported, plan));
    expect(result.status).toBe(202);
    expect(await result.json()).toMatchObject({ created: 0, updated: 0, failed: 1,
      records: [{ status: 'failed', error: 'DUPLICATES_DETECTED: Use one of these records?' }] });
  });

  it('updates a HubSpot secondary-email match by native ID without changing its primary email', async () => {
    const writes: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/batch/read')) return response({ status: 'COMPLETE', results: [{
        id: 'hs-existing', properties: { email: 'primary@example.com', hs_additional_emails: 'alias@example.com', firstname: 'Test', lastname: 'Person', company: 'Example', phone: null, jobtitle: 'Old title', website: null },
      }] });
      expect(String(input)).toContain('/batch/update');
      const body = JSON.parse(String(init?.body)); writes.push(body);
      return response({ status: 'COMPLETE', results: [{ id: 'hs-existing', objectWriteTraceId: body.inputs[0].objectWriteTraceId }] });
    });
    const imported = [contact('one', 'alias@example.com')];
    const plan = await (await POST(request('hubspot', imported))).json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 0, updates: 1, held: 0 });
    expect(plan.records[0].matches).toMatchObject([{ nativeId: 'hs-existing', email: 'primary@example.com' }]);
    const result = await POST(request('hubspot', imported, plan));
    expect(result.status).toBe(202);
    expect(await result.json()).toMatchObject({ created: 0, updated: 1, failed: 0 });
    expect(writes).toMatchObject([{ inputs: [{ id: 'hs-existing' }] }]);
    expect(JSON.stringify(writes)).not.toContain('"email"');
  });

  it('does not turn a HubSpot create conflict into an unapproved update', async () => {
    const paths: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); paths.push(url.pathname);
      if (url.pathname.endsWith('/batch/read')) return response({ status: 'COMPLETE', results: [] });
      if (init?.method !== 'POST') return response({ category: 'OBJECT_NOT_FOUND' }, 404);
      expect(url.pathname).toContain('/batch/create');
      const body = JSON.parse(String(init?.body));
      return response({ status: 'COMPLETE', results: [], errors: [{ category: 'CONFLICT', message: 'Contact already exists.', context: { objectWriteTraceId: [body.inputs[0].objectWriteTraceId] } }] }, 207);
    });
    const imported = [contact('one', 'new@example.com')];
    const plan = await (await POST(request('hubspot', imported))).json() as CrmWritePlan;
    expect(plan.creates).toBe(1);
    const result = await POST(request('hubspot', imported, plan));
    expect(result.status).toBe(202);
    expect(await result.json()).toMatchObject({ created: 0, updated: 0, failed: 1 });
    expect(paths.some((path) => path.endsWith('/batch/upsert') || path.endsWith('/batch/update'))).toBe(false);
  });

  it('rechecks the latest snapshot before execution and cannot bypass a possible-match hold with a supplied plan', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ done: true, records: [] }));
    const imported = [{ ...contact('one', 'new@example.com'), firstName: 'Jordan', lastName: 'Lee', company: 'Cisco' }];
    const plan = await (await POST(request('salesforce', imported))).json() as CrmWritePlan;
    expect(plan.creates).toBe(1);
    const candidate: IdentityRecord = {
      recordKey: 'salesforce:lead:crm-jordan', nativeId: 'crm-jordan', connectorId: 'salesforce', objectType: 'lead',
      firstName: 'Jordan', lastName: 'Lee', fullName: 'Jordan Lee', email: 'other@example.com',
      company: 'Cisco', state: 'Washington', phone: '', jobTitle: '', website: '', createdAt: null, updatedAt: null,
    };
    store.getLatestDuplicateScan.mockResolvedValue({ ...snapshot('salesforce'), id: 'snapshot-2', recordsScanned: 1 });
    store.getDuplicateScanRecords.mockResolvedValue([candidate]);
    expect((await POST(request('salesforce', imported, plan, { fields: ['email'], possibleMatches: [], warnings: [] }))).status).toBe(409);

    const held = await (await POST(request('salesforce', imported))).json() as CrmWritePlan;
    expect(held).toMatchObject({ creates: 0, held: 1, records: [{ operation: 'hold', possibleMatches: [{ score: 28, nativeId: 'crm-jordan' }] }] });
    // Even a caller who changes the visible plan cannot change the recomputed execution.
    const forged = { ...held, creates: 1, held: 0, records: held.records.map((row) => ({ ...row, operation: 'create', possibleMatches: [] })) } as CrmWritePlan;
    const result = await POST(request('salesforce', imported, forged));
    expect(await result.json()).toMatchObject({ created: 0, held: 1, records: [{ status: 'held' }] });
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/query?'))).toBe(true);
    expect(store.getDuplicateScanRecords).toHaveBeenCalledWith('snapshot-2');
  });

  it('holds creates when workspace context is omitted while exact-email updates still work', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const query = new URL(String(input)).searchParams.get('q')!;
      return response({ done: true, records: query.includes('FROM Lead') ? [lead('00Q-existing', 'lead@example.com')] : [] });
    });
    const imported = [contact('one', 'lead@example.com'), contact('two', 'new@example.com')];
    const plan = await (await POST(request('salesforce', imported, undefined, { workspaceId: undefined }))).json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 0, updates: 1, held: 1 });
    expect(plan.records[1].reason).toContain('Save this import workspace');
    expect(store.getWorkspace).not.toHaveBeenCalled();
  });
});
