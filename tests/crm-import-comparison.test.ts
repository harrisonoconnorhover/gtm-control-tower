import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/control-tower/crm-writeback/route';
import type { CrmWritePlan, PortableCrmContact } from '../lib/crm-workflow';

const contact = (id: string, email: string): PortableCrmContact => ({
  contactId: id, email, firstName: 'Test', lastName: 'Person', company: 'Example',
  phone: null, jobTitle: 'Analyst', website: null,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function request(connectorId: 'salesforce' | 'hubspot', contacts: PortableCrmContact[], plan?: CrmWritePlan) {
  return new Request('http://localhost/api/control-tower/crm-writeback', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectorId, contacts, sourceFile: 'synthetic.csv', action: plan ? 'execute' : 'preview', plan }),
  });
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
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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
});
