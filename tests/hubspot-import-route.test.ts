import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importContactsCsv } from '../lib/csv-control-tower';
import { defaultNormalizationSettings } from '../lib/import-normalization';
import { emptyWorkspaceState } from '../lib/workspace';
import { validateImportTemplate } from '../lib/import-template';
import { suggestHubSpotBindings, validateHubSpotImportBinding, type HubSpotImportSchema } from '../lib/hubspot-import';

const reader = vi.hoisted(() => ({ schema: vi.fn(), lookups: vi.fn() }));
vi.mock('../lib/hubspot-import-read', () => ({ readHubSpotImportSchema: reader.schema, readHubSpotImportLookups: reader.lookups }));
const directory = mkdtempSync(join(tmpdir(), 'gtm-hubspot-import-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'workspace.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'local-test-key');
vi.stubEnv('HUBSPOT_IMPORT_READ_TOKEN', 'read-only-test-token');
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const schema: HubSpotImportSchema = { portalId: '123', fetchedAt: '2026-10-16T12:00:00.000Z', warnings: [], properties: {
  contact: ['email', 'firstname', 'lastname', 'country', 'company'].map((name) => ({ name, label: name, type: 'string', fieldType: 'text', options: [], readOnly: false, calculated: false, externalOptions: false, hidden: false })), company: [],
} };
const request = (body: unknown, key = 'local-test-key') => new Request('http://localhost/api/control-tower/hubspot-import', { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-tower-key': key }, body: JSON.stringify(body) });
async function fixture() {
  const { createWorkspace, saveWorkspace } = await import('../lib/workspace-store');
  const rows = importContactsCsv('Contact ID,Name,Email,Country,Company\nLOCAL-1,Ada Example,ada@example.test,USA,Example').contacts;
  const settings = defaultNormalizationSettings();
  const binding = suggestHubSpotBindings(schema, 'contact', [], rows);
  // The normalized first/last-name outputs are mapped explicitly too.
  binding.fields.firstName = { object: 'contact', propertyName: 'firstname' };
  binding.fields.lastName = { object: 'contact', propertyName: 'lastname' };
  const empty = await createWorkspace('HubSpot read-only import');
  const workspace = await saveWorkspace(empty.id, { ...emptyWorkspaceState(), contacts: rows, originalContacts: rows, hubspotBinding: binding, normalizationSettings: settings });
  return { workspace, body: { workspaceId: workspace.id, workspaceRevision: workspace.revision, binding, normalizationSettings: settings, policy: 'fill-empty' } };
}
beforeEach(() => {
  reader.schema.mockReset().mockResolvedValue(schema);
  reader.lookups.mockReset().mockResolvedValue({ contacts: { 'LOCAL-1': { status: 'absent', records: [] } }, companies: {} });
});

describe('HubSpot template bindings', () => {
  it('persists actual object/property names without accepting cross-object or duplicate destinations', async () => {
    const { workspace } = await fixture();
    expect(workspace.state.hubspotBinding?.portalId).toBe('123');
    const template = validateImportTemplate({ name: 'HubSpot imports', importObject: 'contact', mapping: { rawEmail: 'Email' }, normalization: defaultNormalizationSettings(), hubspotBinding: workspace.state.hubspotBinding });
    expect(template.hubspotBinding).toEqual(workspace.state.hubspotBinding);
    expect(() => validateHubSpotImportBinding({ portalId: '123', fields: { country: { object: 'company', propertyName: 'country' } } }, 'contact')).toThrow('matching contact');
    expect(() => validateHubSpotImportBinding({ portalId: '123', fields: { firstName: { object: 'contact', propertyName: 'firstname' }, lastName: { object: 'contact', propertyName: 'firstname' } } }, 'contact')).toThrow('only one');
    expect(() => validateHubSpotImportBinding({ portalId: '123', fields: { company: { object: 'contact', propertyName: 'email' } } }, 'contact')).toThrow('email identity');
    expect(() => validateHubSpotImportBinding({ portalId: '123', fields: { rawEmail: { object: 'contact', propertyName: 'company' } } }, 'contact')).toThrow('email identity');
    expect(() => validateHubSpotImportBinding({ portalId: '123', fields: { contactId: { object: 'contact', propertyName: 'company' } } }, 'contact')).toThrow('record IDs');
  });
});

describe('read-only normalized import route', () => {
  it('rejects unauthorized requests and stale revisions before HubSpot reads', async () => {
    const { POST } = await import('../app/api/control-tower/hubspot-import/route');
    const { body } = await fixture();
    expect((await POST(request(body, 'wrong'))).status).toBe(401);
    expect((await POST(request({ ...body, workspaceRevision: 999 }))).status).toBe(409);
    expect(reader.schema).not.toHaveBeenCalled();
    expect(reader.lookups).not.toHaveBeenCalled();
  });
  it('reads fresh schema, normalizes in memory, saves only the preview, and returns it after reload', async () => {
    const { POST, GET } = await import('../app/api/control-tower/hubspot-import/route');
    const { getWorkspace } = await import('../lib/workspace-store');
    const { workspace, body } = await fixture();
    const result = await POST(request(body));
    expect(result.status).toBe(200);
    const { review } = await result.json() as { review: { readOnly: boolean; normalizedChanges: number; objects: { fields: { propertyName: string; normalized: string; original: string }[] }[] } };
    expect(review.readOnly).toBe(true);
    expect(review.normalizedChanges).toBeGreaterThan(0);
    expect(review.objects[0].fields).toContainEqual(expect.objectContaining({ propertyName: 'country', original: 'USA', normalized: 'United States' }));
    expect(reader.lookups.mock.calls[0][1][0].country).toBe('United States');
    expect((await getWorkspace(workspace.id))?.state).toEqual(workspace.state);
    expect((await getWorkspace(workspace.id))?.revision).toBe(workspace.revision);
    const saved = await GET(new Request(`http://localhost/api/control-tower/hubspot-import?workspaceId=${workspace.id}`, { headers: { 'x-control-tower-key': 'local-test-key' } }));
    expect(await saved.json()).toMatchObject({ stale: false, review: { readOnly: true } });
  });
  it('rejects a different connected portal without looking up records', async () => {
    const { POST } = await import('../app/api/control-tower/hubspot-import/route');
    const { body } = await fixture();
    reader.schema.mockResolvedValue({ ...schema, portalId: '456' });
    expect((await POST(request(body))).status).toBe(409);
    expect(reader.lookups).not.toHaveBeenCalled();
  });
  it('marks saved reviews stale when workspace values change and rejects changes during a read', async () => {
    const { POST, GET } = await import('../app/api/control-tower/hubspot-import/route');
    const { saveWorkspace } = await import('../lib/workspace-store');
    const { workspace, body } = await fixture();
    expect((await POST(request(body))).status).toBe(200);
    const next = await saveWorkspace(workspace.id, { ...workspace.state, contacts: workspace.state.contacts.map((row) => ({ ...row, country: 'Canada' })) });
    const stored = await GET(new Request(`http://localhost/api/control-tower/hubspot-import?workspaceId=${workspace.id}`, { headers: { 'x-control-tower-key': 'local-test-key' } }));
    expect(await stored.json()).toMatchObject({ stale: true });
    reader.lookups.mockImplementationOnce(async () => {
      await saveWorkspace(workspace.id, { ...next.state, contacts: next.state.contacts.map((row) => ({ ...row, country: 'France' })) });
      return { contacts: { 'LOCAL-1': { status: 'absent', records: [] } }, companies: {} };
    });
    expect((await POST(request({ ...body, workspaceRevision: next.revision }))).status).toBe(409);
  });
});
