import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importContactsCsv } from '../lib/csv-control-tower';
import { emptyWorkspaceState } from '../lib/workspace';
import type { NativeCrmRecord } from '../lib/crm-workflow';
import type { IdentityRecord } from '../lib/identity-resolution';
import type { SafeImportReview, SafeImportExecution } from '../lib/safe-import';
import { sha256 } from '../lib/safe-import-review-server';

const scans = vi.hoisted(() => ({ latest: vi.fn(), records: vi.fn() }));
vi.mock('../lib/duplicate-scan-store', () => ({ getLatestDuplicateScan: scans.latest, getDuplicateScanRecords: scans.records }));
const directory = mkdtempSync(join(tmpdir(), 'safe-import-route-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'workspace.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
vi.stubEnv('HUBSPOT_ACCESS_TOKEN', 'synthetic-token');
vi.stubEnv('CONTROL_TOWER_SYNC_KEY', '');
const { POST } = await import('../app/api/control-tower/safe-import/route');
const { POST: governedPOST } = await import('../app/api/control-tower/crm-writeback/route');
const { createWorkspace, saveWorkspace, getWorkspace } = await import('../lib/workspace-store');
const { getSafeImportExecution, getSafeImportReview } = await import('../lib/safe-import-store');
const source = readFileSync(new URL('../fixtures/safe-import-contacts.csv', import.meta.url), 'utf8');
let native: Map<string, NativeCrmRecord>;
let portalId = 12345;
let writes: Array<{ id: string; properties: Record<string, string> }>;
let loseResponse = false;
let failLookup = false;
let snapshotStartedAt = '';
const propertyMap = { firstname: 'firstName', lastname: 'lastName', company: 'company', phone: 'phone', jobtitle: 'jobTitle', website: 'website' } as const;
const json = (value: unknown, status = 200) => Response.json(value, { status });
function providerContact(record: NativeCrmRecord) {
  return { id: record.nativeId, archived: false, properties: { email: record.email,
    hs_additional_emails: record.additionalEmails?.join(';') ?? '',
    ...Object.fromEntries(Object.entries(propertyMap).map(([key, field]) => [key, record.fields[field]])) } };
}
async function workspace() {
  const created = await createWorkspace('Safe event contacts');
  const contacts = importContactsCsv(source).contacts;
  contacts[105] = { ...contacts[105], importExclusion: { reason: 'Skip this attendee', excludedAt: new Date().toISOString() } };
  return saveWorkspace(created.id, { ...emptyWorkspaceState(), contacts, originalContacts: contacts,
    sourceType: 'csv', destinationType: 'hubspot', fileName: 'safe-import-contacts.csv', sourceFileHash: await sha256(source),
    importRecipe: 'safe-update-contacts', importRecordMode: 'update-existing' });
}
function request(action: string, workspaceId: string, reviewId?: string, extras = {}) {
  return new Request('http://localhost/api/control-tower/safe-import', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, workspaceId, ...(reviewId ? { reviewId } : {}), ...extras }) });
}
async function prepare(workspaceId: string) {
  const response = await POST(request('prepare', workspaceId));
  expect(response.status).toBe(200);
  return (await response.json() as { review: SafeImportReview }).review;
}

beforeEach(() => {
  portalId = 12345; writes = []; loseResponse = false; failLookup = false; snapshotStartedAt = new Date(Date.now() - 1000).toISOString();
  native = new Map(Array.from({ length: 102 }, (_, index): [string, NativeCrmRecord] => {
    const nativeId = String(1000 + index);
    return [nativeId, { nativeId, objectType: 'contact', email: `nina${index}@attendees.example`,
      ...(index === 0 ? { additionalEmails: ['nina104@attendees.example'] } : {}),
      fields: { firstName: 'Nina', lastName: `Person${index}`, company: index === 101 ? 'Different CRM Company' : 'Example',
        phone: index >= 100 ? '303-555-0100' : null, jobTitle: index === 99 ? 'N/A' : 'Existing Title', website: 'example.com' } }];
  }));
  native.get('1100')!.fields.phone = '212-555-0104';
  scans.latest.mockImplementation(async (workspaceId: string) => ({ id: 'scan-1', workspaceId, connectorId: 'hubspot',
    complete: true, sourceComplete: true, recordsScanned: 1, startedAt: snapshotStartedAt }));
  scans.records.mockResolvedValue([{ recordKey: 'hubspot:contact:2000', connectorId: 'hubspot', objectType: 'contact', nativeId: '2000',
    firstName: 'Nina', lastName: 'Person102', fullName: 'Nina Person102', email: 'changed102@attendees.example', company: 'Example',
    phone: '212-555-0104', jobTitle: '', website: '', createdAt: null, updatedAt: null } satisfies IdentityRecord]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.hubapi.com');
    if (url.pathname === '/account-info/v3/details') return json({ portalId });
    if (url.pathname.endsWith('/batch/read')) {
      if (failLookup) return json({ status: 'PENDING', results: [] });
      const body = JSON.parse(String(init?.body)) as { inputs: { id: string }[] };
      const emails = new Set(body.inputs.map((item) => item.id));
      return json({ status: 'COMPLETE', results: [...native.values()].filter((row) => [row.email, ...row.additionalEmails ?? []].some((email) => emails.has(email))).map(providerContact) });
    }
    const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
    const record = native.get(id) ?? [...native.values()].find((row) => row.email === id || row.additionalEmails?.includes(id));
    if (init?.method === 'PATCH') {
      expect(record).toBeDefined();
      const properties = JSON.parse(String(init.body)).properties as Record<string, string>;
      writes.push({ id, properties });
      for (const [property, value] of Object.entries(properties)) record!.fields[propertyMap[property as keyof typeof propertyMap]] = value;
      if (loseResponse) { loseResponse = false; throw new Error('Simulated lost response after applied write'); }
      return json(providerContact(record!));
    }
    expect(init?.method ?? 'GET').toBe('GET');
    return record ? json(providerContact(record)) : json({ category: 'OBJECT_NOT_FOUND' }, 404);
  });
});
afterEach(() => { vi.restoreAllMocks(); scans.latest.mockReset(); scans.records.mockReset(); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('Safe Import whole-file route with AI disabled and simulated HubSpot', () => {
  it('enforces saved general update-only mode even when a browser requests create-and-update', async () => {
    const saved = await workspace();
    await saveWorkspace(saved.id, { ...saved.state, importRecipe: undefined });
    const contacts = [{ contactId: 'event-103', email: 'nina103@attendees.example', firstName: 'Theo', lastName: 'Absent',
      company: 'Separate Company', phone: '646-555-0149', jobTitle: 'Imported Title', website: null }];
    const payload = { action: 'preview', workspaceId: saved.id, connectorId: 'hubspot', updatePolicy: saved.state.crmUpdatePolicy,
      recordMode: 'create-and-update', sourceFile: 'safe-import-contacts.csv', contacts };
    const request = (body: unknown) => new Request('http://localhost/api/control-tower/crm-writeback', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const preview = await governedPOST(request(payload));
    expect(preview.status).toBe(200);
    const plan = await preview.json();
    expect(plan).toMatchObject({ recordMode: 'update-existing', creates: 0, updates: 0, held: 1 });
    const execution = await governedPOST(request({ ...payload, action: 'execute', plan }));
    expect(execution.status).toBe(202);
    expect(await execution.json()).toMatchObject({ created: 0, updated: 0, held: 1 });
    expect(writes).toEqual([]);
  });

  it('accounts for 106 source rows across a batch boundary before writes, then approves once and verifies', async () => {
    const saved = await workspace();
    const review = await prepare(saved.id);
    expect(review.rows).toHaveLength(106);
    expect(review.plans.map((plan) => plan.requested)).toEqual([100, 5]);
    expect(review.counts).toEqual({ 'proposed-update': 99, unchanged: 1, held: 4, unmatched: 1, skipped: 1, unresolved: 0 });
    expect(review.complete).toBe(true);
    expect(writes).toEqual([]);
    const first = review.rows.find((row) => row.contactId === 'event-1')!.record!;
    expect(first.changes.map((change) => change.field)).toEqual(['phone']);
    expect(first.fieldDecisions?.find((field) => field.field === 'jobTitle')).toMatchObject({ importedValue: 'Imported Title', proposedValue: 'Existing Title', action: 'preserve' });
    expect(first.fieldDecisions?.find((field) => field.field === 'website')).toMatchObject({ importedValue: null, proposedValue: 'example.com', action: 'preserve' });
    expect(review.rows.find((row) => row.contactId === 'event-99')!.record!.fieldDecisions?.find((field) => field.field === 'jobTitle')?.action).toBe('review');
    expect((await getSafeImportReview(saved.id, review.id))?.sourceFileHash).toBe(await sha256(source));
    const approved = await POST(request('approve', saved.id, review.id));
    expect(approved.status, await approved.clone().text()).toBe(202);
    const { execution } = await approved.json() as { execution: SafeImportExecution };
    expect(execution.records).toHaveLength(99);
    expect(execution.records.every((row) => row.status === 'accepted' && row.verification?.status === 'verified')).toBe(true);
    expect(writes).toHaveLength(99);
    expect(writes.every((write) => Object.keys(write.properties).join() === 'phone')).toBe(true);
    expect(native.get('1001')!.fields).toMatchObject({ jobTitle: 'Existing Title', website: 'example.com', phone: '212-555-0104' });
    const duplicate = await POST(request('approve', saved.id, review.id));
    expect(duplicate.status).toBe(202);
    expect((await duplicate.json() as { execution: SafeImportExecution }).execution.id).toBe(execution.id);
    expect(writes).toHaveLength(99);
    expect((await getSafeImportExecution(saved.id, review.id))?.id).toBe(execution.id);
    const reloaded = await POST(request('load', saved.id));
    expect((await reloaded.json() as { execution: SafeImportExecution }).execution.id).toBe(execution.id);
  });

  it('blocks failed lookups as unresolved and rejects arbitrary browser plans', async () => {
    const saved = await workspace(); failLookup = true;
    const review = await prepare(saved.id);
    expect(review.complete).toBe(false);
    expect(review.counts.unresolved).toBe(105);
    expect((await POST(request('approve', saved.id, review.id))).status).toBe(409);
    expect((await POST(request('approve', saved.id, review.id, { plan: {} }))).status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('invalidates review after saved mapping/selection changes, CRM changes, or an account switch', async () => {
    const saved = await workspace();
    const changedCrm = await prepare(saved.id);
    native.get('1001')!.fields.phone = 'New CRM phone';
    expect((await POST(request('approve', saved.id, changedCrm.id))).status).toBe(409);
    const newReview = await prepare(saved.id);
    portalId = 88888;
    expect((await POST(request('approve', saved.id, newReview.id))).status).toBe(409);
    expect((await POST(request('load', saved.id, newReview.id))).status).toBe(409);
    portalId = 12345;
    await saveWorkspace(saved.id, { ...saved.state, mapping: { phone: 'other_phone' } });
    expect((await POST(request('approve', saved.id, newReview.id))).status).toBe(409);
    expect(writes).toEqual([]);
  });

  it('keeps a lost response unknown, observes approved values, and never resends on approve or recover', async () => {
    const saved = await workspace();
    const review = await prepare(saved.id); loseResponse = true;
    const response = await POST(request('approve', saved.id, review.id));
    expect(response.status, await response.clone().text()).toBe(202);
    const { execution } = await response.json() as { execution: SafeImportExecution };
    expect(execution.status).toBe('reconciliation-required');
    expect(execution.records.filter((row) => row.status === 'unknown')).toHaveLength(1);
    expect(execution.records.find((row) => row.status === 'unknown')?.verification?.status).toBe('verified');
    expect((await POST(request('recover', saved.id, review.id))).status).toBe(200);
    expect((await POST(request('approve', saved.id, review.id))).status).toBe(202);
    expect(writes).toHaveLength(99);
  });

  it('prevents executing a client batch through the older governed endpoint for the named recipe', async () => {
    const saved = await workspace();
    const response = await governedPOST(new Request('http://localhost/api/control-tower/crm-writeback', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'execute', workspaceId: saved.id,
        connectorId: 'hubspot', updatePolicy: saved.state.crmUpdatePolicy, contacts: [{ contactId: 'event-1', email: 'nina1@attendees.example',
          firstName: 'Nina', lastName: 'Person1', company: 'Example', phone: '212-555-0104', jobTitle: 'Imported Title', website: null }] }) }));
    expect(response.status).toBe(409);
    expect(writes).toEqual([]);
    expect((await getWorkspace(saved.id))?.state.importRecordMode).toBe('update-existing');
  });
});
