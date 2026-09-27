import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentityRecord } from '../lib/identity-resolution';
import type { ImportMatchReport } from '../lib/import-match';

const store = vi.hoisted(() => ({ getDuplicateScan: vi.fn(), getDuplicateScanRecords: vi.fn() }));
vi.mock('../lib/duplicate-scan-store', () => store);
vi.mock('../lib/workspace-store', () => ({ persistenceEnabled: () => true }));
import { POST } from '../app/api/control-tower/import-matches/route';

const input = { contactId: 'CSV-1', fullName: 'Alex Example', email: 'new@example.test', phone: '2025550123', state: 'TX', company: 'Example' };
const crm: IdentityRecord = {
  recordKey: 'hubspot:contact:101', connectorId: 'hubspot', objectType: 'contact', nativeId: '101',
  firstName: 'Alex', lastName: 'Example', fullName: 'Alex Example', email: 'old@example.test',
  company: 'Example', phone: '+1 202 555 0123', state: 'Texas', jobTitle: '', website: '', createdAt: null, updatedAt: null,
};
const scan = { id: 'scan-1', workspaceId: 'workspace-1', connectorId: 'hubspot', complete: true, recordsScanned: 1,
  sourceComplete: true, startedAt: '2026-09-27T12:00:00.000Z', completedAt: '2026-09-27T12:01:00.000Z', analysisWarnings: [] };
type ComparisonResponse = { report: ImportMatchReport; scan: Omit<typeof scan, 'analysisWarnings'> & { analysisWarnings: string[] } };
const request = (overrides = {}, headers = {}) => new Request('http://localhost/api/control-tower/import-matches', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ workspaceId: 'workspace-1', scanId: 'scan-1', connectorId: 'hubspot', contacts: [input], fields: ['name', 'phone', 'state'], ...overrides }),
});

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CONTROL_TOWER_SYNC_KEY', '');
  store.getDuplicateScan.mockResolvedValue(scan); store.getDuplicateScanRecords.mockResolvedValue([crm]);
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe('read-only approximate import comparison', () => {
  it('ranks a different-email CRM candidate with native ID, evidence and snapshot coverage', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    const body = await response.json() as ComparisonResponse;
    expect(body.scan).toMatchObject({ id: scan.id, sourceComplete: true, completedAt: scan.completedAt });
    expect(body.report.rows[0]).toMatchObject({ contactId: input.contactId, candidates: [{ record: { nativeId: '101' } }] });
    expect(body.report.rows[0].candidates[0].score).toBeGreaterThan(0);
    expect(body.report.rows[0].candidates[0].comparisons).toHaveLength(3);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('retains partial coverage instead of presenting no suggestion as account-wide absence', async () => {
    store.getDuplicateScan.mockResolvedValue({ ...scan, sourceComplete: false, analysisWarnings: ['Scan record ceiling reached.'] });
    store.getDuplicateScanRecords.mockResolvedValue([]);
    const body = await (await POST(request())).json() as ComparisonResponse;
    expect(body.scan).toMatchObject({ sourceComplete: false, analysisWarnings: ['Scan record ceiling reached.'] });
    expect(body.report.rows[0].candidates).toEqual([]);
  });

  it.each([{ workspaceId: 'different' }, { connectorId: 'salesforce' }])('refuses a snapshot from a different workspace or connector', async (overrides) => {
    expect((await POST(request(overrides))).status).toBe(404);
    expect(store.getDuplicateScanRecords).not.toHaveBeenCalled();
  });

  it('does not compare an unfinished scan', async () => {
    store.getDuplicateScan.mockResolvedValue({ ...scan, complete: false });
    expect((await POST(request())).status).toBe(409);
    expect(store.getDuplicateScanRecords).not.toHaveBeenCalled();
  });

  it.each([
    { fields: ['unknown'] }, { fields: [] }, { fields: ['name', 'name'] },
    { contacts: [input, input] }, { contacts: Array.from({ length: 101 }, (_, index) => ({ ...input, contactId: `${index}` })) },
    { contacts: [{ ...input, state: 'x'.repeat(101) }] },
  ])('rejects invalid selections and oversized or ambiguous imported rows', async (overrides) => {
    expect((await POST(request(overrides))).status).toBe(400);
    expect(store.getDuplicateScanRecords).not.toHaveBeenCalled();
  });

  it('enforces the existing operator key before reading stored CRM records', async () => {
    vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'local-test-key');
    expect((await POST(request())).status).toBe(401);
    expect(store.getDuplicateScan).not.toHaveBeenCalled();
    expect((await POST(request({}, { 'x-control-tower-key': 'local-test-key' }))).status).toBe(200);
  });
});
