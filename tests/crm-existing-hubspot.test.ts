import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHubSpotExisting, readHubSpotRecordById } from '../lib/crm-existing-hubspot';
import type { PortableCrmContact } from '../lib/crm-workflow';

const contact = (email: string): PortableCrmContact => ({
  contactId: email, email, firstName: 'Alex', lastName: 'Morgan',
  company: 'Example', phone: null, jobTitle: null, website: null,
});
const native = (email = 'primary@example.com', aliases = 'secondary@example.com; OTHER@example.com ') => ({
  id: '123', properties: { email, hs_additional_emails: aliases, firstname: 'Alex', lastname: 'Morgan', company: 'Example' },
});
const batchResponse = (results: unknown[], extra = {}, status = 200) => Response.json({ status: 'COMPLETE', results, ...extra }, { status });

afterEach(() => vi.unstubAllGlobals());

describe('HubSpot selected-record reads', () => {
  it('reads the requested ID with its primary email and portable fields, without an imported-email constraint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(native(' Primary@Example.com ', 'secondary@example.com; OTHER@example.com ;SECONDARY@example.com;primary@example.com')));
    vi.stubGlobal('fetch', fetchMock);
    expect(await readHubSpotRecordById('123', 'test-token')).toEqual({
      nativeId: '123', objectType: 'contact', email: 'primary@example.com',
      additionalEmails: ['other@example.com', 'secondary@example.com'],
      fields: { firstName: 'Alex', lastName: 'Morgan', company: 'Example', phone: null, jobTitle: null, website: null },
    });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/crm/objects/2026-03/contacts/123');
    expect(url.searchParams.has('idProperty')).toBe(false);
    expect(url.searchParams.get('properties')).toContain('hs_additional_emails');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store', redirect: 'manual' });
  });

  it('returns null for missing and archived requested contacts', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ ...native(), archived: true })));
    expect(await readHubSpotRecordById('123', 'test-token')).toBeNull();
    expect(await readHubSpotRecordById('123', 'test-token')).toBeNull();
  });

  it.each(['', ' 123', '../123', '123?archived=true', 'abc'])('rejects a malformed requested ID before reading: %s', async (id) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(readHubSpotRecordById(id, 'test-token')).rejects.toThrow('contact ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong ID', { ...native(), id: '456' }, 200],
    ['wrong archived ID', { ...native(), id: '456', archived: true }, 200],
    ['missing ID', { properties: native().properties }, 200],
    ['invalid primary email', native('invalid-email'), 200],
    ['invalid alias', native('primary@example.com', 'invalid-email'), 200],
    ['invalid property', { ...native(), properties: { ...native().properties, firstname: 42 } }, 200],
    ['invalid archive flag', { ...native(), archived: 'false' }, 200],
    ['service error', { message: 'Unavailable' }, 503],
    ['partial result', native(), 207],
    ['redirect', native(), 302],
  ])('rejects %s instead of establishing an update target', async (_label, payload, status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload, { status: status as number })));
    await expect(readHubSpotRecordById('123', 'test-token')).rejects.toThrow('HubSpot');
  });
});

describe('HubSpot exact-email lookup', () => {
  it('requests additional emails and maps exact primary and secondary identities to the same native contact', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(batchResponse([native(), native()]));
    vi.stubGlobal('fetch', fetchMock);
    const found = await readHubSpotExisting(['PRIMARY@example.com', 'secondary@example.com', 'other@example.com'].map(contact), 'test-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      idProperty: 'email', properties: expect.arrayContaining(['email', 'hs_additional_emails', 'company']),
    });
    for (const key of ['primary@example.com', 'secondary@example.com', 'other@example.com']) {
      expect(found.get(key)).toEqual([expect.objectContaining({ nativeId: '123', objectType: 'contact', email: 'primary@example.com',
        additionalEmails: ['other@example.com', 'secondary@example.com'] })]);
    }
  });

  it('checks unresolved aliases individually and only records absence after an explicit 404', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(batchResponse([]))
      .mockResolvedValueOnce(Response.json(native()))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const found = await readHubSpotExisting(['secondary@example.com', 'other@example.com', 'missing+event@example.com'].map(contact), 'test-token');
    expect(found.get('secondary@example.com')?.[0].nativeId).toBe('123');
    expect(found.get('other@example.com')?.[0].nativeId).toBe('123');
    expect(found.get('missing+event@example.com')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toContain('/missing%2Bevent%40example.com?idProperty=email&properties=');
  });

  it('confirms a batch not-found error individually rather than trusting the batch error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(batchResponse([], { numErrors: 1, errors: [{ category: 'OBJECT_NOT_FOUND' }] }, 207))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await readHubSpotExisting([contact('missing@example.com')], 'test-token')).get('missing@example.com')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['malformed body', {}, 200],
    ['pending batch', { status: 'PENDING', results: [] }, 200],
    ['malformed contact', { status: 'COMPLETE', results: [{ properties: { email: 'primary@example.com' } }] }, 200],
    ['partial permission error', { status: 'COMPLETE', results: [native()], errors: [{ category: 'MISSING_SCOPES' }] }, 207],
    ['unexplained errors', { status: 'COMPLETE', results: [], numErrors: 1 }, 207],
    ['malformed errors', { status: 'COMPLETE', results: [], errors: {} }, 200],
    ['unrelated identity', { status: 'COMPLETE', results: [native('unrelated@example.com', '')] }, 200],
  ])('rejects %s without interpreting it as absence', async (_label, payload, status) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(payload, { status: status as number }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readHubSpotExisting([contact('primary@example.com')], 'test-token')).rejects.toThrow('HubSpot');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['service error', { message: 'Unavailable' }, 503],
    ['multi-status response', native(), 207],
    ['unrelated contact', native('not-secondary@example.com', ''), 200],
    ['malformed alias value', { ...native(), properties: { email: 'primary@example.com', hs_additional_emails: ['secondary@example.com'] } }, 200],
  ])('rejects an individual %s instead of approving a create', async (_label, payload, status) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(batchResponse([]))
      .mockResolvedValueOnce(Response.json(payload, { status: status as number }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(readHubSpotExisting([contact('secondary@example.com')], 'test-token')).rejects.toThrow('HubSpot');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps multiple native matches visible for the planner to hold', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(batchResponse([native(), { ...native(), id: '456' }])));
    const found = await readHubSpotExisting([contact('secondary@example.com')], 'test-token');
    expect(found.get('secondary@example.com')?.map((record) => record.nativeId)).toEqual(['123', '456']);
  });
});
