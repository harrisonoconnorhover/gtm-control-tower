import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readHubSpotImportLookups, readHubSpotImportSchema } from '../lib/hubspot-import-read';
import { CrmReadDeferredError, resetCrmReadTransportForTests } from '../lib/crm-read-transport';
import type { HubSpotImportBinding } from '../lib/hubspot-import';
import type { LiveContactState } from '../lib/live-control-tower';

const binding: HubSpotImportBinding = { portalId: '12345', fields: {
  country: { object: 'contact', propertyName: 'country' },
  'custom:contact:favorite_icecream': { object: 'contact', propertyName: 'favorite_icecream' },
  associatedCompanyName: { object: 'company', propertyName: 'name' },
} };
function row(id = 'csv-1', email = 'ada@example.test', company = 'example.test'): LiveContactState {
  return { contactId: id, importObject: 'contact_company', fullName: 'Ada Example', rawEmail: email, normalizedEmail: email,
    company: null, associatedCompany: { recordId: null, name: 'Example', website: `https://${company}`, phone: '', state: '' },
    region: '', segment: '', lifecycleStage: '', expectedLifecycleStage: '', ownerId: null, canonicalContactId: null,
    recordStatus: 'active', lastAction: '', qualityFlags: [], updatedAt: '2026-10-16T12:00:00.000Z' };
}
const contact = (id = '10', email = 'ada@example.test', aliases = '') => ({ id, properties: { email, hs_additional_emails: aliases, country: 'United States', favorite_icecream: 'vanilla' } });
const company = (id = '20', domain = 'example.test') => ({ id, properties: { name: 'Example', domain } });
const property = (extra = {}) => ({ name: 'country', label: 'Country', type: 'enumeration', fieldType: 'select',
  options: [{ value: 'US', label: 'United States', hidden: false }], ...extra });
type Handler = (url: URL, init: RequestInit) => Response | unknown | undefined;
function mockReads(handler?: Handler) {
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    // Reject accidental writes even in fixtures. These are the complete allowed routes for this module.
    if (url.origin !== 'https://api.hubapi.com' || !((!init.method || init.method === 'GET')
      && (/^\/account-info\/v3\/details$/.test(url.pathname) || /^\/crm\/v3\/properties\/(contacts|companies)$/.test(url.pathname)
        || /^\/crm\/v3\/objects\/(contacts|companies)\/[^/]+$/.test(url.pathname))
      || init.method === 'POST' && /^\/crm\/v3\/objects\/(contacts\/batch\/read|companies\/search)$/.test(url.pathname))) throw new Error(`Unexpected route ${init.method} ${url.pathname}`);
    const override = handler?.(url, init);
    if (override !== undefined) return override instanceof Response ? override : Response.json(override);
    if (url.pathname === '/account-info/v3/details') return Response.json({ portalId: 12345 });
    if (url.pathname.startsWith('/crm/v3/properties/')) return Response.json({ results: [property()] });
    if (url.pathname === '/crm/v3/objects/contacts/batch/read') return Response.json({ status: 'COMPLETE', results: [contact()] });
    if (url.pathname === '/crm/v3/objects/companies/search') return Response.json({ total: 1, results: [company()] });
    throw new Error(`Unhandled read ${url.pathname}`);
  });
  vi.stubGlobal('fetch', mock); return mock;
}
beforeEach(() => resetCrmReadTransportForTests({ minimumIntervalMs: 0, defaultBudgetMs: 30, backoffBaseMs: 1 }));
afterEach(() => vi.unstubAllGlobals());

describe('HubSpot import property metadata', () => {
  it('reads verified portal and only contact/company schema, retaining native option values and permissions', async () => {
    const fetch = mockReads((url) => url.pathname.endsWith('/properties/contacts') ? { results: [property({ hidden: true, externalOptions: true,
      calculated: true, modificationMetadata: { readOnlyValue: true, readOnlyDefinition: false },
      options: [{ value: 'US', label: 'United States', hidden: true }] })] } : undefined);
    const schema = await readHubSpotImportSchema('token');
    expect(schema.portalId).toBe('12345');
    expect(schema.properties.contact[0]).toEqual({ name: 'country', label: 'Country', type: 'enumeration', fieldType: 'select',
      readOnly: true, calculated: true, externalOptions: true, hidden: true, options: [{ value: 'US', label: 'United States', hidden: true }] });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([, init]) => init?.redirect === 'manual' && init.cache === 'no-store')).toBe(true);
  });
  it('does not confuse a protected property definition with a read-only value', async () => {
    mockReads((url) => url.pathname.includes('/properties/') ? { results: [property({ modificationMetadata: { readOnlyDefinition: true, readOnlyValue: false } })] } : undefined);
    expect((await readHubSpotImportSchema('token')).properties.contact[0].readOnly).toBe(false);
  });
  it.each([
    ['permission', () => Response.json({}, { status: 403 })],
    ['malformed option', () => ({ results: [property({ options: [{ value: 1, label: 'one' }] })] })],
    ['malformed flag', () => ({ results: [property({ calculated: 'true' })] })],
  ])('fails clearly when company metadata is %s', async (_label, result) => {
    mockReads((url) => url.pathname.endsWith('/properties/companies') ? result() : undefined);
    await expect(readHubSpotImportSchema('token')).rejects.toThrow('company');
  });
});

describe('HubSpot normalized-import identity reads', () => {
  it('projects bound properties, matches additional emails, and reads each shared company once', async () => {
    const fetch = mockReads((url) => url.pathname.endsWith('/contacts/batch/read') ? { status: 'COMPLETE', results: [contact('10', 'primary@example.test', 'ada@example.test; second@example.test')] } : undefined);
    const result = await readHubSpotImportLookups('token', [row(), row('csv-2', 'second@example.test')], binding);
    expect(result.contacts['csv-1']).toMatchObject({ status: 'matched', records: [{ id: '10' }] });
    expect(result.contacts['csv-2']).toEqual(result.contacts['csv-1']);
    expect(result.companies['csv-2']).toMatchObject({ status: 'matched', records: [{ id: '20' }] });
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/companies/search'))).toHaveLength(1);
    const request = fetch.mock.calls.find(([url]) => String(url).endsWith('/contacts/batch/read'))![1]!;
    expect(JSON.parse(String(request.body))).toMatchObject({ idProperty: 'email', properties: expect.arrayContaining(['country', 'favorite_icecream', 'email', 'hs_additional_emails']) });
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('csv-'))).toBe(true);
  });
  it('batches 120 contact identities in at most100 per read', async () => {
    const fetch = mockReads((url, init) => url.pathname.endsWith('/contacts/batch/read') ? { status: 'COMPLETE', results: JSON.parse(String(init.body)).inputs.map(({ id }: { id: string }, index: number) => contact(String(index + 100), id)) } : undefined);
    const rows = Array.from({ length: 120 }, (_, index) => ({ ...row(`csv-${index}`, `person${index}@example.test`), importObject: 'contact' as const }));
    const result = await readHubSpotImportLookups('token', rows, binding);
    expect(Object.values(result.contacts).every((lookup) => lookup.status === 'matched')).toBe(true);
    const batches = fetch.mock.calls.filter(([url]) => String(url).endsWith('/contacts/batch/read'));
    expect(batches.map(([, init]) => JSON.parse(String(init?.body)).inputs.length)).toEqual([100, 20]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('uses source record ID only with an explicit hs_object_id binding', async () => {
    const fetch = mockReads((url) => url.pathname.endsWith('/contacts/batch/read') ? { status: 'COMPLETE', results: [contact('99', 'other@example.test')] } : undefined);
    const result = await readHubSpotImportLookups('token', [{ ...row('99'), importObject: 'contact' }], { ...binding, fields: { contactId: { object: 'contact', propertyName: 'hs_object_id' } } });
    expect(result.contacts['99']).toMatchObject({ status: 'matched', records: [{ id: '99' }] });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({ inputs: [{ id: '99' }] });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).idProperty).toBeUndefined();
  });
  it('does not use a coincidentally numeric source row ID as native identity', async () => {
    const fetch = mockReads();
    await readHubSpotImportLookups('token', [{ ...row('99'), importObject: 'contact' }], binding);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({ idProperty: 'email', inputs: [{ id: 'ada@example.test' }] });
  });
  it('confirms batch omissions individually before absence and preserves omitted properties', async () => {
    const fetch = mockReads((url) => url.pathname.endsWith('/contacts/batch/read') ? { status: 'COMPLETE', results: [], errors: [{ category: 'OBJECT_NOT_FOUND' }], numErrors: 1 }
      : url.pathname.startsWith('/crm/v3/objects/contacts/') ? new Response(null, { status: 404 }) : undefined);
    const result = await readHubSpotImportLookups('token', [{ ...row(), importObject: 'contact' }], binding);
    expect(result.contacts['csv-1']).toEqual({ status: 'absent', records: [] });
    expect(fetch.mock.calls[2][0]).toContain('ada%40example.test?idProperty=email');
    vi.unstubAllGlobals();
    mockReads((url) => url.pathname.endsWith('/contacts/batch/read') ? { status: 'COMPLETE', results: [{ id: '10', properties: { email: 'ada@example.test' } }] } : undefined);
    const incomplete = await readHubSpotImportLookups('token', [{ ...row(), importObject: 'contact' }], binding);
    expect(Object.hasOwn(incomplete.contacts['csv-1'].records[0].properties, 'country')).toBe(false);
  });
  it.each([
    ['incomplete', { status: 'PENDING', results: [] }],
    ['permission errors', { status: 'COMPLETE', results: [], errors: [{ category: 'MISSING_SCOPES' }] }],
    ['unrelated record', { status: 'COMPLETE', results: [contact('10', 'someoneelse@example.test')] }],
    ['invalid aliases', { status: 'COMPLETE', results: [contact('10', 'ada@example.test', 'invalid')] }],
    ['archived', { status: 'COMPLETE', results: [{ ...contact(), archived: true }] }],
  ])('keeps %s batch results unresolved without asserting absence', async (_label, payload) => {
    const fetch = mockReads((url) => url.pathname.endsWith('/contacts/batch/read') ? payload : undefined);
    const result = await readHubSpotImportLookups('token', [{ ...row(), importObject: 'contact' }], binding);
    expect(result.contacts['csv-1'].status).toBe('unresolved');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('preserves multiple matches as ambiguous', async () => {
    mockReads((url) => url.pathname.endsWith('/contacts/batch/read') ? { status: 'COMPLETE', results: [contact(), contact('11')] } : undefined);
    const result = await readHubSpotImportLookups('token', [row()], binding);
    expect(result.contacts['csv-1']).toMatchObject({ status: 'ambiguous', records: [{ id: '10' }, { id: '11' }] });
  });
  it('checks explicit company IDs and holds wrong returned IDs', async () => {
    const input = row(); input.associatedCompany!.recordId = '77';
    const fetch = mockReads((url) => url.pathname.endsWith('/companies/77') ? company('88') : undefined);
    const result = await readHubSpotImportLookups('token', [input], binding);
    expect(result.companies['csv-1']).toMatchObject({ status: 'unresolved', reason: expect.stringContaining('unrequested') });
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/companies/search'))).toBe(false);
  });
  it.each([
    ['multiple', { total: 2, results: [company(), company('21')] }, 'ambiguous'],
    ['truncated', { total: 3, results: [company()], paging: { next: { after: '1' } } }, 'ambiguous'],
    ['missing coverage', { results: [] }, 'unresolved'],
    ['wrong domain', { total: 1, results: [company('20', 'other.test')] }, 'unresolved'],
    ['confirmed absent', { total: 0, results: [] }, 'absent'],
  ])('treats %s company search correctly', async (_label, payload, status) => {
    mockReads((url) => url.pathname.endsWith('/companies/search') ? payload : undefined);
    expect((await readHubSpotImportLookups('token', [row()], binding)).companies['csv-1'].status).toBe(status);
  });
  it('does not repeatedly call a forbidden company read for different domains', async () => {
    const fetch = mockReads((url) => url.pathname.endsWith('/companies/search') ? Response.json({}, { status: 403 }) : undefined);
    const rows = [row(), row('two', 'ada@example.test', 'second.test'), row('three', 'ada@example.test', 'third.test')];
    const result = await readHubSpotImportLookups('token', rows, binding);
    expect(Object.values(result.companies).every((lookup) => lookup.status === 'unresolved')).toBe(true);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/companies/search'))).toHaveLength(1);
  });
  it('rejects portal changes before record reads and propagates deferred reads', async () => {
    const fetch = mockReads((url) => url.pathname === '/account-info/v3/details' ? { portalId: 54321 } : undefined);
    await expect(readHubSpotImportLookups('token', [row()], binding)).rejects.toThrow('portal differs');
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    mockReads((url) => url.pathname.endsWith('/contacts/batch/read') ? Response.json({}, { status: 429, headers: { 'retry-after': '120' } }) : undefined);
    await expect(readHubSpotImportLookups('token', [row()], binding)).rejects.toBeInstanceOf(CrmReadDeferredError);
  });
  it('does not dispatch any native request after cancellation', async () => {
    const fetch = mockReads(); const controller = new AbortController(); controller.abort();
    await expect(readHubSpotImportLookups('token', [row()], binding, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
