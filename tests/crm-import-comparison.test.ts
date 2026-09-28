import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentityRecord } from '../lib/identity-resolution';
import type { LiveContactState } from '../lib/live-control-tower';
import { importPomadeHandoff } from '../lib/pomade-handoff';
import { emptyWorkspaceState } from '../lib/workspace';

const store = vi.hoisted(() => ({ getWorkspace: vi.fn(), getLatestDuplicateScan: vi.fn(), getDuplicateScanRecords: vi.fn() }));
vi.mock('../lib/workspace-store', () => ({ getWorkspace: store.getWorkspace, persistenceEnabled: () => true }));
vi.mock('../lib/duplicate-scan-store', () => ({ getLatestDuplicateScan: store.getLatestDuplicateScan, getDuplicateScanRecords: store.getDuplicateScanRecords }));
import { POST } from '../app/api/control-tower/crm-writeback/route';
import { defaultCrmUpdatePolicy, type CrmUpdatePolicy, type CrmWritePlan, type PortableCrmContact } from '../lib/crm-workflow';

const replaceTitle: CrmUpdatePolicy = { mode: 'replace', fields: ['jobTitle'], clearBlanks: false };

const contact = (id: string, email: string): PortableCrmContact => ({
  contactId: id, email, firstName: 'Test', lastName: 'Person', company: 'Example',
  phone: null, jobTitle: 'Analyst', website: null,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let savedContacts: LiveContactState[] = [];
let savedPolicy: unknown;
let snapshotStartedAt = '';
function request(connectorId: 'salesforce' | 'hubspot', contacts: PortableCrmContact[], plan?: CrmWritePlan, overrides = {}, workspaceContacts = contacts) {
  savedPolicy = (overrides as { updatePolicy?: unknown }).updatePolicy ?? defaultCrmUpdatePolicy();
  savedContacts = workspaceContacts.map((item) => ({ ...item, fullName: `${item.firstName} ${item.lastName}`, rawEmail: item.email,
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

function mockEmptyCrm(connectorId: 'salesforce' | 'hubspot') {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (connectorId === 'salesforce') {
      expect(url.pathname.endsWith('/query')).toBe(true);
      return response({ done: true, records: [] });
    }
    if (url.pathname.endsWith('/batch/read')) return response({ status: 'COMPLETE', results: [] });
    // Missing batch results are confirmed by an individual read. Any native write fails this assertion.
    expect(init?.method ?? 'GET').toBe('GET');
    return response({ category: 'OBJECT_NOT_FOUND' }, 404);
  });
}

const importIdentity = (id: string, email: string): PortableCrmContact => ({
  ...contact(id, email), firstName: 'Priya', lastName: 'Nair', company: 'Salesforce', phone: '415-555-0123',
});

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('CONTROL_TOWER_SYNC_KEY', '');
  vi.stubEnv('SALESFORCE_INSTANCE_URL', 'https://example.my.salesforce.com');
  vi.stubEnv('SALESFORCE_ACCESS_TOKEN', 'synthetic-test-token');
  vi.stubEnv('HUBSPOT_ACCESS_TOKEN', 'synthetic-test-token');
  snapshotStartedAt = new Date(Date.now() - 1000).toISOString();
  store.getWorkspace.mockImplementation(async () => ({ id: 'workspace-1', state: { ...emptyWorkspaceState(), contacts: savedContacts, crmUpdatePolicy: savedPolicy } }));
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
    const imported = [contact('one', 'lead@example.com'), contact('two', 'contact@example.com'), contact('three', 'converted@example.com'),
      { ...contact('four', 'new@example.com'), firstName: 'Casey', lastName: 'Rivera', company: 'Separate Company' }];
    const preview = await POST(request('salesforce', imported, undefined, { updatePolicy: replaceTitle }));
    expect(preview.status).toBe(200);
    const plan = await preview.json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 1, updates: 1, held: 2 });
    expect(writes).toEqual([]);
    const execution = await POST(request('salesforce', imported, plan, { updatePolicy: replaceTitle }));
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
    const plan = await (await POST(request('hubspot', imported, undefined, { updatePolicy: replaceTitle }))).json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 0, updates: 1, held: 0 });
    expect(plan.records[0].matches).toMatchObject([{ nativeId: 'hs-existing', email: 'primary@example.com' }]);
    const result = await POST(request('hubspot', imported, plan, { updatePolicy: replaceTitle }));
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

  it('requires saved workspace context for creates and updates so row exclusions cannot be bypassed', async () => {
    const native = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const query = new URL(String(input)).searchParams.get('q')!;
      return response({ done: true, records: query.includes('FROM Lead') ? [lead('00Q-existing', 'lead@example.com')] : [] });
    });
    const imported = [contact('one', 'lead@example.com'), contact('two', 'new@example.com')];
    const rejected = await POST(request('salesforce', imported, undefined, { workspaceId: undefined }));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('Save and select this import workspace') });
    expect(store.getWorkspace).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });
});

describe.each(['hubspot', 'salesforce'] as const)('%s import-to-import review before native creates', (connectorId) => {
  it('holds both changed-email rows for one person even when the CRM is empty', async () => {
    const fetchMock = mockEmptyCrm(connectorId);
    const imported = [
      importIdentity('first-row', 'priya.nair@salesforce.example.com'),
      importIdentity('second-row', 'p.nair@salesforce.example.com'),
    ];
    const preview = await POST(request(connectorId, imported));
    expect(preview.status).toBe(200);
    const plan = await preview.json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 0, held: 2 });
    for (const [index, row] of plan.records.entries()) {
      const other = imported[1 - index];
      expect(row).toMatchObject({ operation: 'hold', possibleMatches: [], possibleImportMatches: [{
        contactId: other.contactId, email: other.email, fullName: 'Priya Nair', score: expect.any(Number),
      }] });
      expect(row.possibleImportMatches?.[0]).not.toHaveProperty('nativeId');
    }
    const execution = await POST(request(connectorId, imported, plan));
    expect(execution.status).toBe(202);
    expect(await execution.json()).toMatchObject({ created: 0, updated: 0, held: 2, failed: 0 });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('holds a proposed create when the matching saved row is outside the current request', async () => {
    mockEmptyCrm(connectorId);
    const proposed = importIdentity('current-batch', 'p.nair@salesforce.example.com');
    const outsideBatch = importIdentity('another-batch', 'priya.nair@salesforce.example.com');
    const workspaceContacts = [proposed, outsideBatch];
    const plan = await (await POST(request(connectorId, [proposed], undefined, {}, workspaceContacts))).json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 0, held: 1, records: [{ contactId: proposed.contactId,
      operation: 'hold', possibleImportMatches: [{ contactId: outsideBatch.contactId, email: outsideBatch.email }],
    }] });
    expect(plan.records).toHaveLength(1);
    const execution = await POST(request(connectorId, [proposed], plan, {}, workspaceContacts));
    expect(execution.status).toBe(202);
    expect(await execution.json()).toMatchObject({ created: 0, updated: 0, held: 1, failed: 0 });
  });

  it.each(['added', 'changed'] as const)('requires a new review if another import identity is %s after preview', async (change) => {
    mockEmptyCrm(connectorId);
    const proposed = importIdentity('current-batch', 'p.nair@salesforce.example.com');
    const duplicate = importIdentity('another-batch', 'priya.nair@salesforce.example.com');
    const unrelated = { ...contact(duplicate.contactId, duplicate.email), firstName: 'Renee', lastName: 'Walters', company: 'Adobe' };
    const initialWorkspace = change === 'added' ? [proposed] : [proposed, unrelated];
    const plan = await (await POST(request(connectorId, [proposed], undefined, {}, initialWorkspace))).json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 1, held: 0 });

    const changedWorkspace = [proposed, duplicate];
    const execution = await POST(request(connectorId, [proposed], plan, {}, changedWorkspace));
    expect(execution.status).toBe(409);
    expect(await execution.json()).toMatchObject({ error: expect.stringContaining('preview is stale') });
    const refreshed = await (await POST(request(connectorId, [proposed], undefined, {}, changedWorkspace))).json() as CrmWritePlan;
    expect(refreshed).toMatchObject({ creates: 0, held: 1, records: [{
      operation: 'hold', possibleImportMatches: [{ contactId: duplicate.contactId }],
    }] });
  });
});

function mockExistingCrm(connectorId: 'hubspot' | 'salesforce') {
  const writes: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/query')) return response({ done: true, records: url.searchParams.get('q')!.includes('FROM Lead')
      ? [{ ...lead('native-existing', 'existing@example.com'), Website: 'https://existing.example.com' }] : [] });
    if (url.pathname.endsWith('/batch/read')) return response({ status: 'COMPLETE', results: [{ id: 'native-existing', properties: {
      email: 'existing@example.com', firstname: 'Test', lastname: 'Person', company: 'Example', phone: null,
      jobtitle: 'Old title', website: 'https://existing.example.com',
    } }] });
    const body = JSON.parse(String(init?.body));
    if (connectorId === 'hubspot') {
      expect(url.pathname).toContain('/batch/update');
      writes.push(body.inputs[0].properties);
      return response({ status: 'COMPLETE', results: [{ id: 'native-existing', objectWriteTraceId: body.inputs[0].objectWriteTraceId }] });
    }
    expect(init?.method).toBe('PATCH');
    expect(url.pathname).toContain('/composite/sobjects');
    const fields = { ...body.records[0] };
    delete fields.attributes;
    delete fields.Id;
    writes.push(fields);
    return response([{ id: 'native-existing', success: true, errors: [] }]);
  });
  return writes;
}

describe.each(['hubspot', 'salesforce'] as const)('%s governed import controls', (connectorId) => {
  it.each([
    ['fill-empty', undefined, 'phone'],
    ['replace selected', { mode: 'replace', fields: ['jobTitle', 'website'], clearBlanks: false }, 'jobTitle'],
    ['explicit clear', { mode: 'replace', fields: ['website'], clearBlanks: true }, 'website'],
  ] as const)('sends only approved fields for %s and retains an accurate rollback', async (_label, policy, field) => {
    const writes = mockExistingCrm(connectorId);
    const imported = [{ ...contact('one', 'existing@example.com'), phone: '4155550101' }];
    const overrides = policy ? { updatePolicy: policy } : {};
    const preview = await POST(request(connectorId, imported, undefined, overrides));
    expect(preview.status).toBe(200);
    const plan = await preview.json() as CrmWritePlan;
    expect(plan.records[0].changes.map((change) => change.field)).toEqual([field]);
    expect(plan.records[0].after.website).toBe(field === 'website' ? null : 'https://existing.example.com');
    const execution = await POST(request(connectorId, imported, plan, overrides));
    expect(execution.status).toBe(202);
    expect(await execution.json()).toMatchObject({ updated: 1, failed: 0, rollback: { records: [{ changedFields: [field] }] } });
    const property = connectorId === 'hubspot' ? { phone: 'phone', jobTitle: 'jobtitle', website: 'website' }[field]
      : { phone: 'Phone', jobTitle: 'Title', website: 'Website' }[field];
    const value = field === 'phone' ? '4155550101' : field === 'jobTitle' ? 'Analyst' : connectorId === 'hubspot' ? '' : null;
    expect(writes).toEqual([{ [property]: value }]);
  });

  it('rejects invalid policies and changed policies before a native write', async () => {
    const writes = mockExistingCrm(connectorId);
    const imported = [{ ...contact('one', 'existing@example.com'), phone: '4155550101' }];
    expect((await POST(request(connectorId, imported, undefined, { updatePolicy: { mode: 'replace', fields: ['email'], clearBlanks: false } }))).status).toBe(400);
    const plan = await (await POST(request(connectorId, imported))).json() as CrmWritePlan;
    expect((await POST(request(connectorId, imported, plan, { updatePolicy: replaceTitle }))).status).toBe(409);
    const retry = request(connectorId, imported, plan);
    store.getWorkspace.mockResolvedValue({ id: 'workspace-1', state: { ...emptyWorkspaceState(), contacts: savedContacts, crmUpdatePolicy: replaceTitle } });
    expect((await POST(retry)).status).toBe(409);
    expect(writes).toEqual([]);
  });

  it.each(['create', 'update'] as const)('rechecks a skipped row before an earlier %s preview can execute', async (operation) => {
    const writes = operation === 'create' ? (mockEmptyCrm(connectorId), []) : mockExistingCrm(connectorId);
    const imported = [{ ...contact('one', operation === 'create' ? 'new@example.com' : 'existing@example.com'), phone: '4155550101' }];
    const plan = await (await POST(request(connectorId, imported))).json() as CrmWritePlan;
    expect(plan.records[0].operation).toBe(operation);
    const execution = request(connectorId, imported, plan);
    savedContacts[0].importExclusion = { reason: 'Already handled outside this batch', excludedAt: new Date().toISOString() };
    expect((await POST(execution)).status).toBe(409);
    const preview = request(connectorId, imported);
    savedContacts[0].importExclusion = { reason: 'Already handled outside this batch', excludedAt: new Date().toISOString() };
    const held = await (await POST(preview)).json() as CrmWritePlan;
    expect(held).toMatchObject({ creates: 0, updates: 0, held: 1, records: [{ reason: expect.stringContaining('Skipped for this import') }] });
    expect(writes).toEqual([]);
  });

  it('uses the saved included rows to release a kept identity after its neighbor is skipped', async () => {
    mockEmptyCrm(connectorId);
    const imported = [importIdentity('keep', 'priya.nair@salesforce.example.com'), importIdentity('skip', 'p.nair@salesforce.example.com')];
    const preview = request(connectorId, [imported[0]], undefined, { updatePolicy: defaultCrmUpdatePolicy() }, imported);
    savedContacts[1].importExclusion = { reason: 'Same person, keeping the complete row', excludedAt: new Date().toISOString() };
    const plan = await (await POST(preview)).json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 1, held: 0 });
  });
});


async function pomadeOrigins() {
  return (await importPomadeHandoff({ source: 'pomade', workspaceId: 'table-1', mode: 'preview',
    destination: { provider: 'hubspot', objectType: 'contact' }, fieldMappings: [], guards: { maxRecords: 100, allowCreate: false },
    records: [{ rowId: 'source-row', externalKey: 'context-only', proposedFields: { email: 'new@example.com' } }],
  })).contacts[0].sourceOrigins;
}

describe.each(['hubspot', 'salesforce'] as const)('%s Pomade handoff scope', (connectorId) => {
  it('holds unmatched handoff rows even with a fresh complete snapshot, preserving ordinary CSV creates', async () => {
    mockEmptyCrm(connectorId);
    const imported = [contact('one', 'new@example.com')];
    const normal = await (await POST(request(connectorId, imported))).json() as CrmWritePlan;
    expect(normal.creates).toBe(1);
    const preview = request(connectorId, imported);
    savedContacts[0].sourceOrigins = await pomadeOrigins();
    const held = await (await POST(preview)).json() as CrmWritePlan;
    expect(held).toMatchObject({ creates: 0, held: 1, records: [{ reason: expect.stringContaining('existing-record updates only') }] });
  });

  it('rechecks the saved scope before executing an earlier create plan', async () => {
    mockEmptyCrm(connectorId);
    const imported = [contact('one', 'new@example.com')];
    const plan = await (await POST(request(connectorId, imported))).json() as CrmWritePlan;
    const execute = request(connectorId, imported, plan);
    savedContacts[0].sourceOrigins = await pomadeOrigins();
    expect((await POST(execute)).status).toBe(409);
  });

  it('keeps normal governed updates available for existing matched people', async () => {
    const writes = mockExistingCrm(connectorId);
    const imported = [contact('one', 'existing@example.com')];
    const origins = await pomadeOrigins();
    const preview = request(connectorId, imported, undefined, { updatePolicy: replaceTitle });
    savedContacts[0].sourceOrigins = origins;
    const plan = await (await POST(preview)).json() as CrmWritePlan;
    expect(plan).toMatchObject({ creates: 0, updates: 1, held: 0 });
    const execute = request(connectorId, imported, plan, { updatePolicy: replaceTitle });
    savedContacts[0].sourceOrigins = origins;
    expect((await POST(execute)).status).toBe(202);
    expect(writes).toHaveLength(1);
  });
});
