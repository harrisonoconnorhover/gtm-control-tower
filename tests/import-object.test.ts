import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '../db';
import {
  countCsvRepairCandidates, csvFieldLabelsForObject, executeCsvRepair, exportContactsCsv,
  importContactsCsv, isDestinationReadyContact, previewContactsCsv, suggestCsvMapping,
} from '../lib/csv-control-tower';
import { emptyWorkspaceState, validateWorkspaceState } from '../lib/workspace';
import { createWorkspace, getWorkspace, saveMappingPreset, saveWorkspace } from '../lib/workspace-store';

const directory = mkdtempSync(join(tmpdir(), 'gtm-import-object-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'workspace.db'));
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

const companyCsv = 'Company ID,Company name,Domain,Phone,State\nCO-1,Microsfot,microsoft.example,+1 555 0100,WA';
const mixedCsv = 'Contact ID,Name,Email,Company ID,Company,Website,Phone,Company Phone,State,Company State\nP-1,Avery Finch,avery@example.test,CO-1,Microsfot,microsoft.example,+1 555 0101,+1 555 0100,NY,WA';

describe('explicit import object mapping', () => {
  it('keeps old contact mapping and default behavior', () => {
    expect(previewContactsCsv('Name,Email,Company\nAvery Finch,avery@example.test,Example').suggestedMapping)
      .toMatchObject({ fullName: 'Name', rawEmail: 'Email', company: 'Company' });
    const contact = importContactsCsv('Name,Email,Company,Owner ID\nAvery Finch,avery@example.test,Example,OWNER-1').contacts[0];
    expect(contact).toMatchObject({ importObject: 'contact', fullName: 'Avery Finch', company: 'Example' });
    expect(isDestinationReadyContact(contact)).toBe(true);
  });

  it('maps generic Name to company only when company is selected', () => {
    expect(suggestCsvMapping(['Name', 'Domain', 'Contact ID', 'Email'], 'company'))
      .toEqual({ company: 'Name', website: 'Domain' });
    expect(csvFieldLabelsForObject('company')).toMatchObject({ contactId: 'Company ID', company: 'Company name' });
    expect(csvFieldLabelsForObject('company')).not.toHaveProperty('rawEmail');
    expect(csvFieldLabelsForObject('company')).not.toHaveProperty('fullName');
    expect(csvFieldLabelsForObject('contact')).not.toHaveProperty('associatedCompanyName');
  });

  it('parses company fields without inventing a person or requiring email and owner', () => {
    const imported = importContactsCsv(companyCsv, {}, 'company');
    expect(imported.contacts[0]).toMatchObject({ importObject: 'company', contactId: 'CO-1',
      fullName: 'Microsfot', company: 'Microsfot', website: 'microsoft.example', rawEmail: '',
      normalizedEmail: null, lifecycleStage: '', expectedLifecycleStage: '', qualityFlags: [] });
    expect(imported.contacts[0]).not.toHaveProperty('firstName');
    expect(imported.contacts[0]).not.toHaveProperty('jobTitle');
    expect(imported.lifecycleComparedRows).toBe(0);
    expect(isDestinationReadyContact(imported.contacts[0])).toBe(false);
  });

  it('requires a company identifier column and honestly flags missing row values', () => {
    expect(() => importContactsCsv('Email\na@example.test', {}, 'company')).toThrow(/company name or website/);
    expect(() => importContactsCsv(companyCsv, { rawEmail: 'Phone' }, 'company')).toThrow(/another import object/);
    const rows = importContactsCsv('Company,Website\nExample,\n,example.test', {}, 'company').contacts;
    expect(rows[0].qualityFlags).toEqual(['missing_website']);
    expect(rows[1].qualityFlags).toEqual(['missing_company_name']);
  });

  it('exports company columns and preserves company values on round trip', () => {
    const original = importContactsCsv(companyCsv, {}, 'company').contacts;
    const csv = exportContactsCsv(original);
    expect(csv.split('\n')[0]).toContain('company_id,company_name,website');
    expect(csv.split('\n')[0]).not.toMatch(/email|full_name|first_name|contact_id|job_title/);
    const restored = importContactsCsv(csv, {}, 'company').contacts;
    expect(restored.map((row) => ({ ...row, updatedAt: '' })))
      .toEqual(original.map((row) => ({ ...row, updatedAt: '' })));
  });

  it('keeps person and associated-company columns separate in one file', () => {
    const mapping = suggestCsvMapping(mixedCsv.split('\n')[0].split(','), 'contact_company');
    expect(mapping).toMatchObject({ contactId: 'Contact ID', fullName: 'Name', rawEmail: 'Email',
      associatedCompanyId: 'Company ID', associatedCompanyName: 'Company', associatedCompanyWebsite: 'Website',
      phone: 'Phone', associatedCompanyPhone: 'Company Phone', state: 'State', associatedCompanyState: 'Company State' });
    expect(mapping).not.toHaveProperty('company');
    expect(mapping).not.toHaveProperty('website');
    const row = importContactsCsv(mixedCsv, {}, 'contact_company').contacts[0];
    expect(row).toMatchObject({ importObject: 'contact_company', contactId: 'P-1', fullName: 'Avery Finch',
      rawEmail: 'avery@example.test', company: null, website: null, phone: '+1 555 0101', state: 'NY',
      associatedCompany: { recordId: 'CO-1', name: 'Microsfot', website: 'microsoft.example', phone: '+1 555 0100', state: 'WA' } });
    expect(row.qualityFlags).not.toContain('missing_company');
    expect(isDestinationReadyContact(row)).toBe(false);
  });

  it('requires associated-company mapping rather than treating a person name as a company', () => {
    expect(() => importContactsCsv('Name,Email\nAvery Finch,avery@example.test', {}, 'contact_company'))
      .toThrow(/associated company name, website or company ID/);
    const rows = importContactsCsv('Name,Company\nAvery Finch,Example\nBea Ren,', {}, 'contact_company').contacts;
    expect(rows[1].associatedCompany).toEqual({ recordId: null, name: '', website: '', phone: '', state: '' });
    expect(rows[1].qualityFlags).toContain('missing_company');
  });

  it('round trips mixed rows with separate contact company context and associated company', () => {
    const rows = importContactsCsv(mixedCsv, { company: 'State', website: 'Phone' }, 'contact_company').contacts;
    const csv = exportContactsCsv(rows, 'contact_company');
    expect(csv.split('\n')[0]).toContain('associated_company_id,associated_company_name');
    expect(csv.split('\n')[0]).toContain('contact_company');
    const restored = importContactsCsv(csv, {}, 'contact_company').contacts;
    expect(restored.map((row) => ({ ...row, updatedAt: '' })))
      .toEqual(rows.map((row) => ({ ...row, updatedAt: '' })));
  });

  it('blocks person repair actions and mixed object exports', () => {
    const companyRows = importContactsCsv(companyCsv, {}, 'company').contacts;
    const mixedRows = importContactsCsv(mixedCsv, {}, 'contact_company').contacts;
    for (const rows of [companyRows, mixedRows]) {
      expect(countCsvRepairCandidates(rows, 'routing-overload')).toBe(0);
      expect(() => executeCsvRepair(rows, 'routing-overload')).toThrow(/Contact repair actions/);
    }
    expect(() => exportContactsCsv([...companyRows, ...mixedRows])).toThrow(/one import object/);
  });
});

describe('object-aware workspace persistence', () => {
  it('defaults old workspaces and rows to contact while rejecting inconsistent types', () => {
    const [row] = importContactsCsv('Name,Email\nAvery Finch,avery@example.test').contacts;
    delete row.importObject;
    const legacy = { ...emptyWorkspaceState(), contacts: [row], originalContacts: [row] };
    delete legacy.importObject;
    expect(validateWorkspaceState(legacy)).toMatchObject({ importObject: 'contact', contacts: [{ importObject: 'contact' }] });
    expect(() => validateWorkspaceState({ ...legacy, importObject: 'company' })).toThrow(/Every row/);
    expect(() => validateWorkspaceState({ ...legacy, importObject: 'unknown' })).toThrow(/Unsupported import object/);
  });

  it('limits companies and associated companies to local CSV review', () => {
    for (const importObject of ['company', 'contact_company'] as const) {
      const rows = importContactsCsv(importObject === 'company' ? companyCsv : mixedCsv, {}, importObject).contacts;
      const state = { ...emptyWorkspaceState(), importObject, contacts: rows, originalContacts: rows };
      expect(validateWorkspaceState(state).importObject).toBe(importObject);
      for (const override of [{ destinationType: 'hubspot' }, { sourceType: 'salesforce' }, { importRecipe: 'safe-update-contacts' }, { crmCohort: {} }]) {
        expect(() => validateWorkspaceState({ ...state, ...override })).toThrow(/local CSV review/);
      }
    }
  });

  it('rejects malformed associated company data and a person disguised as a company', () => {
    const rows = importContactsCsv(mixedCsv, {}, 'contact_company').contacts;
    const state = { ...emptyWorkspaceState(), importObject: 'contact_company', contacts: rows, originalContacts: rows };
    expect(() => validateWorkspaceState({ ...state, contacts: [{ ...rows[0], associatedCompany: { name: 'Incomplete' } }] }))
      .toThrow(/Associated company fields/);
    const companyRows = importContactsCsv(companyCsv, {}, 'company').contacts;
    expect(() => validateWorkspaceState({ ...emptyWorkspaceState(), importObject: 'company', contacts: [{ ...companyRows[0], rawEmail: 'person@example.test' }], originalContacts: companyRows }))
      .toThrow(/cannot contain person/);
    expect(() => validateWorkspaceState({ ...emptyWorkspaceState(), contacts: [{ ...rows[0], importObject: 'contact' }], originalContacts: [] }))
      .toThrow(/Associated company fields require/);
  });

  it('persists object-aware rows and presets while reading legacy plain mappings', async () => {
    const workspace = await createWorkspace('Synthetic object-aware import test');
    const rows = importContactsCsv(mixedCsv, {}, 'contact_company').contacts;
    const saved = await saveWorkspace(workspace.id, { ...emptyWorkspaceState(), importObject: 'contact_company', contacts: rows, originalContacts: rows });
    expect(saved.state.importObject).toBe('contact_company');
    expect(saved.state.contacts).toEqual(rows);
    await saveMappingPreset(workspace.id, 'Associated companies', { fullName: 'Name', associatedCompanyName: 'Company' }, undefined, 'contact_company');
    await saveMappingPreset(workspace.id, 'Companies', { company: 'Name' }, undefined, 'company');
    const db = await getDatabase();
    await db.prepare('INSERT INTO mapping_presets (id, workspace_id, name, mapping_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('legacy-mapping', workspace.id, 'Legacy contacts', JSON.stringify({ fullName: 'Person', rawEmail: 'Email' }), '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z').run();
    const restored = (await getWorkspace(workspace.id))!;
    expect(restored.presets).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Associated companies', importObject: 'contact_company', mapping: { fullName: 'Name', associatedCompanyName: 'Company' } }),
      expect.objectContaining({ name: 'Companies', importObject: 'company', mapping: { company: 'Name' } }),
      expect.objectContaining({ name: 'Legacy contacts', importObject: 'contact', mapping: { fullName: 'Person', rawEmail: 'Email' } }),
    ]));
  });
});
