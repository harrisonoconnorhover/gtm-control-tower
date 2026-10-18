import { resetCrmReadTransportForTests } from '../lib/crm-read-transport';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importContactsCsv } from '../lib/csv-control-tower';
import { emptyWorkspaceState } from '../lib/workspace';
import { buildCrmWritePlan, defaultCrmUpdatePolicy, type NativeCrmRecord, type PortableCrmContact } from '../lib/crm-workflow';
import { readSalesforceAccountIdentity } from '../lib/crm-account';
import { readSalesforceRecordById } from '../lib/crm-existing-salesforce';
import { executeSafeImportReview, writeSalesforceSafeImportRecord } from '../lib/safe-import-execution';
import { sha256 } from '../lib/safe-import-review-server';
import type { SafeImportReview, SafeImportExecution } from '../lib/safe-import';
import { importMatchSourceKey } from '../lib/import-match-decision';
import { signImportMatch } from '../lib/import-match-decision-server';
import { toSalesforceUpdateContact } from '../lib/salesforce-sync';

const scans = vi.hoisted(() => ({ latest: vi.fn(), records: vi.fn() }));
vi.mock('../lib/duplicate-scan-store', () => ({ getLatestDuplicateScan: scans.latest, getDuplicateScanRecords: scans.records }));
const directory = mkdtempSync(join(tmpdir(), 'safe-import-salesforce-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'workspace.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
vi.stubEnv('SALESFORCE_ACCESS_TOKEN', 'synthetic-token');
vi.stubEnv('SALESFORCE_INSTANCE_URL', 'https://synthetic.my.salesforce.com');
vi.stubEnv('SALESFORCE_API_VERSION', '67.0');
vi.stubEnv('CONTROL_TOWER_SYNC_KEY', '');
const { POST } = await import('../app/api/control-tower/safe-import/route');
const { createWorkspace, saveWorkspace } = await import('../lib/workspace-store');
const { getSafeImportExecution } = await import('../lib/safe-import-store');
const apiRoot = 'https://synthetic.my.salesforce.com/services/data/v67.0';
const headers = { authorization: 'Bearer synthetic-token' };
const contactId = '003000000000001AAA';
const leadId = '00Q000000000001AAA';
const orgId = '00D000000000001AAA';
const source = 'contact_id,first_name,last_name,email,company,phone,job_title,website\ncontact,Nina,Person,contact@example.com,Imported Company,2125550104,Imported Title,https://example.com\nlead,Nina,Person,lead@example.com,Imported Company,2125550105,Imported Title,https://example.com';
const fieldMap = { FirstName: 'firstName', LastName: 'lastName', Company: 'company', Phone: 'phone', Title: 'jobTitle', Website: 'website' } as const;
let native: Map<string, NativeCrmRecord>;
let organization = orgId;
let writes: Array<{ id: string; object: string; fields: Record<string, string> }>;
let loseResponse = false;
let convertOnRead = false;

function provider(record: NativeCrmRecord) {
  return { Id: record.nativeId, Email: record.email,
    ...(record.objectType === 'lead' ? { IsConverted: record.isConverted } : {}),
    ...Object.fromEntries(Object.entries(fieldMap).filter(([field]) => record.objectType === 'lead' || !['Company', 'Website'].includes(field))
      .map(([key, field]) => [key, record.fields[field]])) };
}
function request(action: string, workspaceId: string, reviewId?: string) {
  return new Request('http://localhost/api/control-tower/safe-import', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, workspaceId, ...(reviewId ? { reviewId } : {}) }) });
}
async function workspace() {
  const saved = await createWorkspace('Synthetic Salesforce import');
  const contacts = importContactsCsv(source).contacts;
  return saveWorkspace(saved.id, { ...emptyWorkspaceState(), contacts, originalContacts: contacts, sourceType: 'csv', destinationType: 'salesforce',
    fileName: 'salesforce.csv', sourceFileHash: await sha256(source), importRecipe: 'safe-update-contacts', importRecordMode: 'update-existing' });
}
async function prepare(workspaceId: string) {
  const response = await POST(request('prepare', workspaceId));
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json() as { review: SafeImportReview }).review;
}

beforeEach(() => {
  resetCrmReadTransportForTests({ minimumIntervalMs: 0, backoffBaseMs: 0 });
  organization = orgId; writes = []; loseResponse = false; convertOnRead = false;
  native = new Map(([['contact', contactId], ['lead', leadId]] as const).map(([objectType, nativeId]) => [nativeId, {
    nativeId, objectType, email: `${objectType}@example.com`, ...(objectType === 'lead' ? { isConverted: false } : {}),
    fields: { firstName: 'Nina', lastName: 'Person', company: null, phone: null, jobTitle: 'Existing Title', website: null },
  }]));
  scans.latest.mockResolvedValue(null); scans.records.mockResolvedValue([]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://synthetic.my.salesforce.com');
    if (url.pathname.endsWith('/query')) {
      const query = url.searchParams.get('q')!;
      if (query.includes('FROM Organization')) return Response.json({ done: true, records: [{ Id: organization }] });
      const objectType = query.includes('FROM Contact') ? 'contact' : 'lead';
      const records = [...native.values()].filter((record) => record.objectType === objectType && query.includes(`'${record.email}'`));
      return Response.json({ done: true, records: records.map(provider) });
    }
    const id = url.pathname.split('/').at(-1)!;
    const object = url.pathname.split('/').at(-2)!;
    const record = native.get(id);
    if (!record) return Response.json({}, { status: 404 });
    expect(object.toLowerCase()).toBe(record.objectType);
    if (init?.method === 'PATCH') {
      const fields = JSON.parse(String(init.body)) as Record<string, string>;
      expect(init.headers).toMatchObject({ 'Sforce-Auto-Assign': 'FALSE' });
      writes.push({ id, object, fields });
      for (const [field, value] of Object.entries(fields)) {
        expect(Object.keys(fieldMap)).toContain(field);
        record.fields[fieldMap[field as keyof typeof fieldMap]] = value;
      }
      if (loseResponse) { loseResponse = false; throw new Error('Lost reply after accepted mutation'); }
      return new Response(null, { status: 204 });
    }
    if (convertOnRead && record.objectType === 'lead') record.isConverted = true;
    return Response.json(provider(record));
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('Salesforce Safe Import through saved workspace, review and execution', () => {
  it('accepts an updates-only CSV without creation-required name/company and never invents a name from its row ID', () => {
    const [row] = importContactsCsv('contact_id,email,phone\nrow-1,contact@example.com,2125550104').contacts;
    expect(toSalesforceUpdateContact(row)).toMatchObject({ contactId: 'row-1', firstName: '', lastName: '', company: null, phone: '2125550104' });
    expect(() => toSalesforceUpdateContact({ ...row, phone: '1'.repeat(41) })).toThrow('field limit');
  });

  it('reviews Leads and Contacts together, preserves Contact Account fields, and executes exact object PATCH once', async () => {
    const saved = await workspace();
    const review = await prepare(saved.id);
    expect(review).toMatchObject({ connectorId: 'salesforce', account: { connectorId: 'salesforce', accountId: orgId }, complete: true, counts: { 'proposed-update': 2 } });
    const contact = review.rows.find((row) => row.contactId === 'contact')!.record!;
    expect(contact.changes.map((change) => change.field)).toEqual(['phone']);
    expect(contact.fieldDecisions?.find((field) => field.field === 'company')).toMatchObject({ action: 'preserve', reasonCode: 'salesforce-contact-account-field-protected' });
    expect(writes).toEqual([]);
    const approved = await POST(request('approve', saved.id, review.id));
    expect(approved.status, await approved.clone().text()).toBe(202);
    const { execution } = await approved.json() as { execution: SafeImportExecution };
    expect(execution.records.map((record) => record.objectType)).toEqual(['contact', 'lead']);
    expect(execution.records.every((record) => record.status === 'accepted' && record.verification?.status === 'verified')).toBe(true);
    expect(writes).toEqual([
      { id: contactId, object: 'Contact', fields: { Phone: '2125550104' } },
      { id: leadId, object: 'Lead', fields: { Company: 'Imported Company', Phone: '2125550105', Website: 'https://example.com' } },
    ]);
    await POST(request('approve', saved.id, review.id));
    await POST(request('recover', saved.id, review.id));
    expect(writes).toHaveLength(2);
  });

  it('holds cross-object duplicate email and converted Leads before approval', async () => {
    native.set('00Q000000000002AAA', { ...structuredClone(native.get(leadId)!), nativeId: '00Q000000000002AAA', email: 'contact@example.com' });
    native.get(leadId)!.isConverted = true;
    const saved = await workspace();
    const review = await prepare(saved.id);
    expect(review.counts).toMatchObject({ 'proposed-update': 0, held: 2 });
    expect(review.rows.map((row) => row.reason).join(' ')).toContain('2 CRM records');
    expect(review.rows.map((row) => row.reason).join(' ')).toContain('converted');
    expect((await POST(request('approve', saved.id, review.id))).status).toBe(409);
    expect(writes).toEqual([]);
  });

  it('uses a signed Contact identity decision when the imported email differs and preserves the native email', async () => {
    const original = await workspace();
    native.get(contactId)!.email = 'native-contact@example.com';
    const row = original.state.contacts.find((record) => record.contactId === 'contact')!;
    const unsigned = { connectorId: 'salesforce' as const, scanId: 'synthetic-reviewed-scan', sourceKey: importMatchSourceKey(row),
      target: structuredClone(native.get(contactId)!), reason: 'Reviewed name and account evidence.', confirmedAt: new Date().toISOString() };
    row.crmMatchDecisions = { salesforce: { ...unsigned, signature: await signImportMatch(original.id, unsigned) } };
    const saved = await saveWorkspace(original.id, original.state);
    const review = await prepare(saved.id);
    expect(review.rows.find((record) => record.contactId === 'contact')).toMatchObject({ status: 'proposed-update',
      record: { nativeId: contactId, matchDecision: { email: 'native-contact@example.com' } } });
    expect((await POST(request('approve', saved.id, review.id))).status).toBe(202);
    expect(native.get(contactId)!.email).toBe('native-contact@example.com');
    expect(writes.find((write) => write.id === contactId)?.fields).toEqual({ Phone: '2125550104' });
  });

  it('blocks a changed organization and a Lead converted between review and native reread', async () => {
    const saved = await workspace();
    const review = await prepare(saved.id);
    organization = '00D000000000002AAA';
    expect((await POST(request('approve', saved.id, review.id))).status).toBe(409);
    expect(writes).toEqual([]);
    organization = orgId; convertOnRead = true;
    const response = await POST(request('approve', saved.id, review.id));
    expect(response.status, await response.clone().text()).toBe(202);
    const { execution } = await response.json() as { execution: SafeImportExecution };
    expect(execution.records.find((record) => record.nativeId === leadId)?.status).toBe('held');
    expect(writes.map((write) => write.id)).toEqual([contactId]);
  });

  it('keeps a lost Salesforce response unknown with verified readback and never replays', async () => {
    const saved = await workspace();
    const review = await prepare(saved.id); loseResponse = true;
    const response = await POST(request('approve', saved.id, review.id));
    expect(response.status).toBe(202);
    expect((await response.json() as { execution: SafeImportExecution }).execution).toMatchObject({ status: 'reconciliation-required', records: [
      { status: 'unknown', objectType: 'contact', verification: { status: 'verified' } }, { status: 'accepted' },
    ] });
    expect((await POST(request('recover', saved.id, review.id))).status).toBe(200);
    expect((await POST(request('approve', saved.id, review.id))).status).toBe(202);
    expect(writes).toHaveLength(2);
    expect((await getSafeImportExecution(saved.id, review.id))?.status).toBe('reconciliation-required');
  });

  it('rejects forged object prefixes and protected fields before any execution or PATCH', async () => {
    const saved = await workspace();
    const review = await prepare(saved.id);
    const wrongPrefix = structuredClone(review);
    wrongPrefix.plans[0].records[0].matches[0].objectType = 'lead';
    wrongPrefix.plans[0].records[0].matches[0].isConverted = false;
    await expect(executeSafeImportReview(wrongPrefix)).rejects.toThrow('fill-empty');
    await expect(readSalesforceRecordById(contactId, 'lead', apiRoot, headers)).rejects.toThrow('record ID');
    const contact = structuredClone(review.rows[0].record!);
    contact.changes.push({ field: 'company', before: null, after: 'Wrong Account' }); contact.after.company = 'Wrong Account';
    await expect(writeSalesforceSafeImportRecord(contact, apiRoot, headers)).rejects.toThrow('supported fields');
    expect(writes).toEqual([]);
  });
});

describe('Salesforce native response contracts', () => {
  it.each([200, 207, 302, 503])('keeps unexpected PATCH status %s unknown', async (status) => {
    const imported: PortableCrmContact = { contactId: 'row', email: 'contact@example.com', firstName: 'Nina', lastName: 'Person',
      company: null, phone: '2125550104', jobTitle: null, website: null };
    const plan = buildCrmWritePlan('salesforce', 'file.csv', [imported], new Map([[imported.email, [native.get(contactId)!]]]),
      new Date(), undefined, defaultCrmUpdatePolicy(), undefined, undefined, 'update-existing', true);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status }));
    expect((await writeSalesforceSafeImportRecord(plan.records[0], apiRoot, headers)).status).toBe('unknown');
  });

  it.each([
    { errorCode: 'REQUEST_LIMIT_EXCEEDED', status: 'pending' },
    { errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY', status: 'failed' },
  ])('distinguishes Salesforce 403 $errorCode from a replayable write', async ({ errorCode, status }) => {
    const imported: PortableCrmContact = { contactId: 'row', email: 'contact@example.com', firstName: 'Nina', lastName: 'Person',
      company: null, phone: '2125550104', jobTitle: null, website: null };
    const plan = buildCrmWritePlan('salesforce', 'file.csv', [imported], new Map([[imported.email, [native.get(contactId)!]]]),
      new Date(), undefined, defaultCrmUpdatePolicy(), undefined, undefined, 'update-existing', true);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([{ errorCode }], { status: 403, headers: { 'Retry-After': '60' } }));
    const outcome = await writeSalesforceSafeImportRecord(plan.records[0], apiRoot, headers);
    expect(outcome.status).toBe(status);
    if (status === 'pending') expect(outcome).toMatchObject({ reason: 'quota', retryAt: expect.any(String) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { done: false, records: [{ Id: orgId }] }, { done: true, records: [{ Id: contactId }] },
    { done: true, records: [{ Id: orgId }, { Id: orgId }] }, { done: true, records: [] },
  ])('rejects incomplete or wrong organization identity %j', async (response) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(response));
    await expect(readSalesforceAccountIdentity(apiRoot, headers)).rejects.toThrow('Salesforce');
  });
});
