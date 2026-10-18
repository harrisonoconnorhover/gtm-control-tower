import { afterEach, describe, expect, it, vi } from 'vitest';
import { importContactsCsv, exportContactsCsv, isDestinationReadyContact } from '../lib/csv-control-tower';
import { recomputeImportDuplicateFlags } from '../lib/import-exclusions';
import { isHubSpotEligible } from '../lib/hubspot-sync';
import { isSalesforceEligible } from '../lib/salesforce-sync';
import { applySuppressionRules, type SuppressionRule } from '../lib/suppression';
import { getSuppressionRules } from '../lib/suppression-store';
import { syncDirectlyToHubSpot, createHubSpotContacts, POST as hubSpotPost } from '../app/api/control-tower/hubspot-sync/route';
import { syncDirectlyToSalesforce } from '../app/api/control-tower/salesforce-sync/route';
import { createGovernedCrmPlan } from '../lib/governed-crm-plan';
import { defaultCrmUpdatePolicy } from '../lib/crm-workflow';
import { emptyWorkspaceState, validateWorkspaceState } from '../lib/workspace';

vi.mock('../lib/suppression-store', () => ({ getSuppressionRules: vi.fn(async () => []) }));
const rules: SuppressionRule[] = [{ id: 'vendor', listName: 'Vendors', type: 'website_domain', value: 'vendor.example',
  reason: 'Current vendor', enabled: true, includeSubdomains: false, createdAt: '2026-10-16T12:00:00.000Z', updatedAt: '2026-10-16T12:00:00.000Z' }];
const portable = { contactId: 'sample', email: 'person@example.com', firstName: 'Sample', lastName: 'Person', company: 'Vendor',
  website: 'https://www.vendor.example/about', phone: null, jobTitle: null };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.mocked(getSuppressionRules).mockResolvedValue([]); });

describe('suppression import enforcement', () => {
  it('recomputes duplicate holds without changing raw values or manual decisions and exports the reasons', () => {
    const rows = importContactsCsv('contact_id,full_name,email,company,website,owner_id\nKEEP,Sample Person,person@example.com,Other,https://other.example,owner\nVENDOR,Sample Person,person@example.com,Vendor,https://vendor.example,owner').contacts;
    const original = structuredClone(rows);
    const effective = recomputeImportDuplicateFlags(applySuppressionRules(rows, rules));
    expect(effective[0].qualityFlags).not.toContain('duplicate_identity');
    expect([isDestinationReadyContact(effective[1]), isHubSpotEligible(effective[1]), isSalesforceEligible(effective[1])]).toEqual([false, false, false]);
    expect(effective[1]).toMatchObject({ rawEmail: original[1].rawEmail, website: original[1].website, lastAction: original[1].lastAction });
    expect(rows).toEqual(original);
    const csv = exportContactsCsv(effective);
    expect(csv).toContain('suppression_reasons');
    expect(csv).toContain('Current vendor');
    const restored = recomputeImportDuplicateFlags(applySuppressionRules(effective, []));
    expect(restored.every((row) => row.qualityFlags.includes('duplicate_identity'))).toBe(true);
    expect(restored.every((row) => !row.suppressionMatches)).toBe(true);
    const state = validateWorkspaceState({ ...emptyWorkspaceState(), contacts: effective, originalContacts: effective });
    expect([...state.contacts, ...state.originalContacts].every((row) => !row.suppressionMatches)).toBe(true);
  });

  it('holds suppressed saved rows in governed CRM plans with the saved reason', async () => {
    vi.stubEnv('HUBSPOT_ACCESS_TOKEN', 'fixture');
    const contacts = applySuppressionRules(importContactsCsv('contact_id,full_name,email,company,website,owner_id\n' +
      'sample,Sample Person,person@example.com,Vendor,https://www.vendor.example/about,owner').contacts, rules);
    const network = vi.fn(async () => Response.json({ status: 'COMPLETE', results: [{ id: '123', properties: { email: portable.email } }] }));
    vi.stubGlobal('fetch', network);
    const workspace = { id: 'fixture', name: 'Fixture', revision: 1, presets: [], createdAt: '2026-10-16', updatedAt: '2026-10-16',
      state: { ...emptyWorkspaceState(), contacts, originalContacts: contacts, importRecordMode: 'update-existing' as const } };
    const plan = await createGovernedCrmPlan('hubspot', 'fixture.csv', [portable], workspace, defaultCrmUpdatePolicy());
    expect(plan).toMatchObject({ held: 1, creates: 0, updates: 0, records: [{ operation: 'hold', reason: 'Suppressed: Vendors: Current vendor' }] });
    expect(network.mock.calls).toHaveLength(1);
  });

  it('blocks direct HubSpot create/sync and Salesforce sync before any provider lookup or write', async () => {
    vi.mocked(getSuppressionRules).mockResolvedValue(rules);
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    const batch = { syncId: 'fixture', sourceFile: 'fixture.csv', contacts: [portable] };
    await expect(syncDirectlyToHubSpot(batch, 'fixture')).rejects.toThrow('Vendors: Current vendor');
    await expect(createHubSpotContacts(batch, 'fixture')).rejects.toThrow('Suppressed rows');
    await expect(syncDirectlyToSalesforce({ syncId: 'fixture', sourceFile: 'fixture.csv', leads: [portable] }, 'https://fixture.my.salesforce.com', 'fixture', '67.0')).rejects.toThrow('Suppressed rows');
    expect(network).not.toHaveBeenCalled();
  });

  it('blocks the legacy webhook before sending its batch, even with no client match metadata', async () => {
    vi.stubEnv('HUBSPOT_ACCESS_TOKEN', ''); vi.stubEnv('N8N_HUBSPOT_SYNC_WEBHOOK_URL', 'http://localhost:5678/fixture');
    vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'fixture');
    vi.mocked(getSuppressionRules).mockResolvedValue(rules);
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    const response = await hubSpotPost(new Request('http://localhost/api/control-tower/hubspot-sync', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-control-tower-key': 'fixture' },
      body: JSON.stringify({ syncId: 'fixture', sourceFile: 'fixture.csv', contacts: [portable] }) }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Suppressed rows') });
    expect(network).not.toHaveBeenCalled();
  });
});
