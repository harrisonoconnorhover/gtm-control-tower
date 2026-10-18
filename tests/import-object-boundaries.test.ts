import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as qualify } from '../app/api/control-tower/pomade-qualification/route';
import { POST as confirmCrmMatch } from '../app/api/control-tower/import-match-decision/route';
import { readHubSpotExisting } from '../lib/crm-existing-hubspot';
import { readSalesforceExisting } from '../lib/crm-existing-salesforce';
import { defaultCrmUpdatePolicy } from '../lib/crm-workflow';
import { createGovernedCrmPlan } from '../lib/governed-crm-plan';
import { isHubSpotEligible, toHubSpotSyncContact } from '../lib/hubspot-sync';
import { readConfirmedTarget } from '../lib/import-match-decision-server';
import { deriveImportReadiness } from '../lib/import-readiness';
import type { ImportObject, LiveContactState } from '../lib/live-control-tower';
import { qualificationInputs } from '../lib/pomade-qualification';
import { preparePomadeQualification, startPomadeQualificationRun } from '../lib/pomade-qualification-client';
import { getPomadeQualification } from '../lib/pomade-qualification-store';
import { buildSafeImportReview } from '../lib/safe-import-review-server';
import { isSalesforceEligible, toSalesforceSyncLead, toSalesforceUpdateContact } from '../lib/salesforce-sync';
import { emptyWorkspaceState, type SavedWorkspace } from '../lib/workspace';
import { getWorkspace, saveWorkspace } from '../lib/workspace-store';

vi.mock('../db', () => ({ getDatabase: vi.fn(async () => ({ kind: 'sqlite' })) }));
vi.mock('../lib/operator-auth', () => ({ operatorAccessError: vi.fn(() => null) }));
vi.mock('../lib/workspace-store', () => ({ getWorkspace: vi.fn(), saveWorkspace: vi.fn(), persistenceEnabled: () => true }));
vi.mock('../lib/crm-existing-hubspot', () => ({ readHubSpotExisting: vi.fn() }));
vi.mock('../lib/crm-existing-salesforce', () => ({ readSalesforceExisting: vi.fn() }));
vi.mock('../lib/import-match-decision-server', () => ({ readConfirmedTarget: vi.fn(), signImportMatch: vi.fn(), verifyImportMatch: vi.fn() }));
vi.mock('../lib/pomade-qualification-store', () => ({ getPomadeQualification: vi.fn(), beginPomadeQualification: vi.fn(),
  claimPomadeExecution: vi.fn(), refreshPomadeQualification: vi.fn(), savePomadeQualification: vi.fn() }));
vi.mock('../lib/pomade-qualification-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/pomade-qualification-client')>(),
  preparePomadeQualification: vi.fn(), startPomadeQualificationRun: vi.fn(),
}));

const checkedAt = '2026-10-16T12:00:00.000Z';
function row(importObject?: ImportObject): LiveContactState {
  return { importObject, contactId: 'row-1', fullName: 'Ada Example', rawEmail: 'ada@example.test',
    normalizedEmail: 'ada@example.test', company: 'Example', website: 'https://example.test', region: '', segment: '',
    lifecycleStage: 'lead', expectedLifecycleStage: 'lead', ownerId: 'owner-1', canonicalContactId: null,
    recordStatus: 'active', qualityFlags: [], lastAction: 'imported', updatedAt: checkedAt,
    ...(importObject === 'contact_company' ? { associatedCompany: {
      recordId: null, name: 'Associated Example', website: 'https://associated.test', phone: '', state: '',
    } } : {}) };
}
function workspace(importObject: ImportObject): SavedWorkspace {
  const contacts = [row(importObject)];
  return { id: 'workspace', name: 'Object review', revision: 1, presets: [], createdAt: checkedAt, updatedAt: checkedAt,
    state: { ...emptyWorkspaceState(), importObject, contacts, originalContacts: contacts,
      fileName: 'fixture.csv', sourceFileHash: 'a'.repeat(64), destinationType: 'hubspot',
      importRecipe: 'safe-update-contacts', importRecordMode: 'update-existing', crmUpdatePolicy: defaultCrmUpdatePolicy() } };
}
const post = (path: string, body: unknown) => new Request(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

describe('local object review boundaries', () => {
  it('preserves legacy contacts while rejecting company and mixed rows even with a valid person email', () => {
    expect(isHubSpotEligible(row())).toBe(true);
    expect(isSalesforceEligible(row())).toBe(true);
    for (const object of ['company', 'contact_company'] as const) {
      const source = row(object);
      expect(isHubSpotEligible(source)).toBe(false);
      expect(isSalesforceEligible(source)).toBe(false);
      expect(() => toHubSpotSyncContact(source)).toThrow(/not eligible/);
      expect(() => toSalesforceSyncLead(source)).toThrow(/not eligible/);
      expect(() => toSalesforceUpdateContact(source)).toThrow(/no usable Salesforce identity/);
    }
    expect(qualificationInputs([row(), row('company'), row('contact_company')])).toEqual([
      { sourceRowId: 'row-1', company: 'Example', website: 'https://example.test', email: 'ada@example.test' },
    ]);
  });

  it.each(['company', 'contact_company'] as const)('rejects %s CRM planning and Safe Import before any lookup', async (object) => {
    const saved = workspace(object);
    const portable = toHubSpotSyncContact(row());
    for (const connector of ['hubspot', 'salesforce'] as const) {
      await expect(createGovernedCrmPlan(connector, 'fixture.csv', [portable], saved, defaultCrmUpdatePolicy()))
        .rejects.toThrow(/local review and export only/);
    }
    const createPlan = vi.fn();
    await expect(buildSafeImportReview(saved, { connectorId: 'hubspot', accountId: 'fixture' }, { createPlan }))
      .rejects.toThrow(/contacts-only/);
    expect(createPlan).not.toHaveBeenCalled();
    expect(readHubSpotExisting).not.toHaveBeenCalled();
    expect(readSalesforceExisting).not.toHaveBeenCalled();
    expect(readConfirmedTarget).not.toHaveBeenCalled();
  });

  it.each(['company', 'contact_company'] as const)('explains %s local-only readiness without requiring person email', (object) => {
    const source = { ...row(object), rawEmail: '', normalizedEmail: null };
    const result = deriveImportReadiness({ contacts: [source, { ...source, contactId: 'skipped',
      importExclusion: { reason: 'Not a prospect', excludedAt: checkedAt } },
    { ...source, contactId: 'merged', recordStatus: 'merged' }], workspaceId: 'workspace', websiteChecks: [], qualification: null });
    expect(result.counts).toEqual({ ready: 0, needsReview: 1, excluded: 2 });
    expect(result.rows[0].reasons).toEqual([{ code: 'local_object_review_only', message: expect.stringContaining('local review and export only') }]);
    expect(result.rows[1].reasons[0].code).toBe('import_excluded');
    expect(result.rows[2].reasons[0].code).toBe('record_merged');
    if (object === 'contact_company') expect(result.rows[0].company).toBe('Associated Example');
  });

  it.each(['company', 'contact_company'] as const)('rejects %s provider actions before preparing or starting checks', async (object) => {
    vi.mocked(getWorkspace).mockResolvedValue(workspace(object));
    const payloads = [
      { action: 'send', icpCriteria: 'CRM software' },
      { action: 'start', sourceRowIds: ['row-1'], checks: ['email'], previewHash: 'a'.repeat(64),
        requestId: crypto.randomUUID(), confirmExternalRequests: true },
    ];
    for (const payload of payloads) {
      const response = await qualify(post('/api/control-tower/pomade-qualification', { workspaceId: 'workspace', ...payload }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('contacts-only') });
    }
    expect(getPomadeQualification).not.toHaveBeenCalled();
    expect(preparePomadeQualification).not.toHaveBeenCalled();
    expect(startPomadeQualificationRun).not.toHaveBeenCalled();
  });

  it.each(['company', 'contact_company'] as const)('rejects %s CRM match confirmation without reading or saving a CRM match', async (object) => {
    vi.mocked(getWorkspace).mockResolvedValue(workspace(object));
    const response = await confirmCrmMatch(post('/api/control-tower/import-match-decision', {
      action: 'confirm', workspaceId: 'workspace', connectorId: 'hubspot', contactId: 'row-1', revision: 1,
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('contacts-only') });
    expect(readConfirmedTarget).not.toHaveBeenCalled();
    expect(saveWorkspace).not.toHaveBeenCalled();
  });
});
