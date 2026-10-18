import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveImportTemplates, validateImportTemplate, type ImportTemplate } from '../lib/import-template';
import { defaultNormalizationSettings, previewNormalization } from '../lib/import-normalization';
import { importContactsCsv } from '../lib/csv-control-tower';
import { emptyWorkspaceState } from '../lib/workspace';

const directory = mkdtempSync(join(tmpdir(), 'gtm-import-template-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'workspace.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const fields = [{ key: 'favorite_ice_cream', label: 'Fav. Ice Cream', object: 'contact' as const }];
const template = (overrides: Partial<ImportTemplate> = {}): ImportTemplate => ({
  id: 'dessert', name: 'Team event imports', importObject: 'contact', customFields: fields,
  mapping: { rawEmail: 'Business email', fullName: 'Guest', 'custom:contact:favorite_ice_cream': 'Favorite icecream' },
  normalization: defaultNormalizationSettings(), createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z', ...overrides,
});

describe('shared import template matching', () => {
  it('remembers a custom alias across header spelling/punctuation and shows its source', () => {
    const result = resolveImportTemplates(['Guest', 'business_email', 'Favorite Icecream'], 'contact', [template()]);
    expect(result.mapping['custom:contact:favorite_ice_cream']).toBe('Favorite Icecream');
    expect(result.provenance['custom:contact:favorite_ice_cream']).toEqual({ templateId: 'dessert', templateName: 'Team event imports' });
    expect(result.template?.normalization.countryFormat).toBe('name');
    expect(result.customFields).toEqual(fields);
    expect(result.conflicts).toEqual([]);
  });
  it('does not cross objects or silently choose conflicting saved aliases', () => {
    expect(resolveImportTemplates(['Guest'], 'company', [template()]).mapping.fullName).toBeUndefined();
    const result = resolveImportTemplates(['Guest', 'Email'], 'contact', [template(), template({ id: 'other', mapping: { firstName: 'Guest' } })]);
    expect(result.mapping.fullName).toBe('');
    expect(result.mapping.firstName).toBe('');
    expect(result.conflicts.join(' ')).toContain('conflicting saved destinations');
    const imported = importContactsCsv('Guest,Email\nAda Example,ada@example.test', result.mapping, 'contact', result.customFields);
    expect(imported.contacts[0].fullName).toBe('CSV-001');
  });
  it('keeps duplicate aliases and competing normalization templates reviewable', () => {
    const duplicates = resolveImportTemplates(['Business email', 'Business-email'], 'contact', [template()]);
    expect(duplicates.mapping.rawEmail).toBe('');
    expect(duplicates.conflicts.length).toBeGreaterThan(0);
    const settings = resolveImportTemplates(['Guest', 'Business email'], 'contact', [template(), template({ id: 'second', name: 'Other team', normalization: { ...defaultNormalizationSettings(), countryFormat: 'code' } })]);
    expect(settings.template).toBeUndefined();
    expect(settings.conflicts.join(' ')).toContain('normalization rules');
  });
  it('preserves an explicitly ignored destination from a single saved template', () => {
    const result = resolveImportTemplates(['Guest', 'Company'], 'contact', [template({ mapping: { fullName: 'Guest', company: '' } })]);
    expect(result.mapping.fullName).toBe('Guest');
    expect(result.mapping.company).toBe('');
  });
  it('rejects invalid custom destinations and duplicate source assignments', () => {
    expect(() => validateImportTemplate(template({ mapping: { 'custom:contact:unknown': 'Favorite icecream' } }))).toThrow('unsupported');
    expect(() => validateImportTemplate(template({ mapping: { fullName: 'Name', firstName: 'Name' } }))).toThrow('one destination');
    expect(() => validateImportTemplate(template({ importObject: 'company' }))).toThrow('selected import object');
  });
});

describe('saved template and normalization persistence', () => {
  it('shares definitions/rules with another workspace, supports explicit update/delete, and retains legacy presets', async () => {
    const { saveImportTemplate, getImportTemplates, deleteImportTemplate } = await import('../lib/import-template-store');
    const { createWorkspace, saveMappingPreset } = await import('../lib/workspace-store');
    const first = await createWorkspace('First import');
    await saveMappingPreset(first.id, 'Legacy', { rawEmail: 'Email' });
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = template();
    void _id; void _createdAt; void _updatedAt;
    const [saved] = await saveImportTemplate(input);
    await createWorkspace('Another teammate import');
    expect((await getImportTemplates())[0]).toEqual(saved);
    const [updated] = await saveImportTemplate({ ...saved, normalization: { ...saved.normalization, splitFullName: false } });
    expect(updated.id).toBe(saved.id);
    expect(updated.normalization.splitFullName).toBe(false);
    expect(await deleteImportTemplate(saved.id)).toEqual([]);
  });
  it('saves normalized custom values and restores originals and rules with workspace undo', async () => {
    const { createWorkspace, saveWorkspace, getWorkspace, undoWorkspace } = await import('../lib/workspace-store');
    const original = importContactsCsv('Name,Email,Country,Favorite icecream\nAda Example,ada@example.test,USA,vanilla', { 'custom:contact:favorite_ice_cream': 'Favorite icecream' }, 'contact', fields).contacts;
    const workspace = await createWorkspace('Normalization preview');
    const first = await saveWorkspace(workspace.id, { ...emptyWorkspaceState(), customFields: fields, contacts: original, originalContacts: original });
    const settings = { ...defaultNormalizationSettings(), valueRules: [{ field: 'custom:contact:favorite_ice_cream', from: 'vanilla', to: 'Vanilla Bean' }] };
    const preview = previewNormalization(original, settings, fields);
    expect(preview.contacts[0].country).toBe('United States');
    expect(preview.contacts[0].customFields?.favorite_ice_cream).toBe('Vanilla Bean');
    await saveWorkspace(workspace.id, { ...first.state, contacts: preview.contacts, normalizationSettings: settings });
    const loaded = await getWorkspace(workspace.id);
    expect(loaded?.state.originalContacts).toEqual(original);
    expect(loaded?.state.customFields).toEqual(fields);
    expect(loaded?.state.normalizationSettings).toEqual(settings);
    expect((await undoWorkspace(workspace.id)).state).toEqual(first.state);
  });
  it('requires the existing operator key for shared library changes', async () => {
    vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'template-test-key');
    const { POST } = await import('../app/api/control-tower/import-templates/route');
    const response = await POST(new Request('http://localhost/api/control-tower/import-templates', { method: 'POST', body: JSON.stringify({ action: 'save', template: template() }) }));
    expect(response.status).toBe(401);
    vi.stubEnv('CONTROL_TOWER_SYNC_KEY', '');
  });
});
