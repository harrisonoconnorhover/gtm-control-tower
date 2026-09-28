import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeCrmRecord } from '../lib/crm-workflow';
import type { DuplicateScanView } from '../lib/duplicate-scan-store';
import type { IdentityRecord } from '../lib/identity-resolution';
import type { LiveContactState } from '../lib/live-control-tower';
import { emptyWorkspaceState, validateWorkspaceState, type SavedWorkspace } from '../lib/workspace';

const store = vi.hoisted(() => ({
  getWorkspace: vi.fn(), saveWorkspace: vi.fn(), persistenceEnabled: vi.fn(),
  getDuplicateScan: vi.fn(), getDuplicateScanRecords: vi.fn(),
  readHubSpotRecordById: vi.fn(), readSalesforceLeadById: vi.fn(),
}));
vi.mock('../lib/workspace-store', () => ({ getWorkspace: store.getWorkspace, saveWorkspace: store.saveWorkspace, persistenceEnabled: store.persistenceEnabled }));
vi.mock('../lib/duplicate-scan-store', () => ({ getDuplicateScan: store.getDuplicateScan, getDuplicateScanRecords: store.getDuplicateScanRecords }));
vi.mock('../lib/crm-existing-hubspot', () => ({ readHubSpotRecordById: store.readHubSpotRecordById }));
vi.mock('../lib/crm-existing-salesforce', () => ({ readSalesforceLeadById: store.readSalesforceLeadById }));

import { POST } from '../app/api/control-tower/import-match-decision/route';
import { importMatchSourceKey, isConfirmedImportMatch, nativeMatchTargetKey, validImportMatchDecisions, type ConfirmedImportMatch } from '../lib/import-match-decision';
import { signImportMatch, verifyImportMatch } from '../lib/import-match-decision-server';

type Connector = 'hubspot' | 'salesforce';
const now = '2026-09-28T12:00:00.000Z';
const ids = { hubspot: '123456789', salesforce: '00Q000000000001AAA' };
const fields = ['name', 'email', 'phone', 'state', 'company'];
let workspace: SavedWorkspace;
let scan: DuplicateScanView;
let target: NativeCrmRecord;
let candidate: IdentityRecord;

function fixture(connectorId: Connector) {
  const row: LiveContactState = {
    contactId: 'import-priya', fullName: 'Priya Nair', firstName: 'Priya', lastName: 'Nair',
    rawEmail: 'p.nair@salesforce.example.com', normalizedEmail: 'p.nair@salesforce.example.com',
    company: 'Salesforce', phone: '415-555-0123', state: 'CA', jobTitle: 'New title', website: 'https://salesforce.example.com',
    region: 'West', segment: '', lifecycleStage: 'Lead', expectedLifecycleStage: 'Lead', ownerId: null,
    canonicalContactId: null, recordStatus: 'active', lastAction: '', qualityFlags: [], updatedAt: now,
  };
  workspace = { id: 'workspace-1', name: 'Fictional import', revision: 3,
    state: { ...emptyWorkspaceState(), contacts: [row], originalContacts: [structuredClone(row)] }, presets: [], createdAt: now, updatedAt: now };
  candidate = { recordKey: `${connectorId}:${connectorId === 'hubspot' ? 'contact' : 'lead'}:${ids[connectorId]}`,
    connectorId, objectType: connectorId === 'hubspot' ? 'contact' : 'lead', nativeId: ids[connectorId],
    firstName: 'Priya', lastName: 'Nair', fullName: 'Priya Nair', email: 'priya.nair@salesforce.example.com',
    company: 'Salesforce', phone: '415-555-0123', state: 'California', jobTitle: 'Old title', website: 'https://salesforce.example.com',
    createdAt: null, updatedAt: null };
  target = { nativeId: candidate.nativeId, objectType: candidate.objectType, email: candidate.email, isConverted: false,
    fields: { firstName: candidate.firstName, lastName: candidate.lastName, company: candidate.company,
      phone: candidate.phone, jobTitle: candidate.jobTitle, website: candidate.website } };
  scan = { id: 'scan-1', workspaceId: workspace.id, connectorId, status: 'complete', cursor: null,
    recordsScanned: 1, pagesScanned: 1, candidatesCompared: 0, sourceComplete: true, analysisWarnings: [],
    ruleVersion: 'identity-v3', startedAt: '2026-09-28T11:59:00.000Z', updatedAt: now, completedAt: now,
    complete: true, clusterCount: 0, duplicateRecords: 0, highConfidenceClusters: 0, reviewClusters: 0, possibleClusters: 0, clusters: [] };
  store.getWorkspace.mockImplementation(async () => structuredClone(workspace));
  store.getDuplicateScan.mockImplementation(async () => structuredClone(scan));
  store.getDuplicateScanRecords.mockImplementation(async () => [structuredClone(candidate)]);
  store.readHubSpotRecordById.mockImplementation(async () => structuredClone(target));
  store.readSalesforceLeadById.mockImplementation(async () => structuredClone(target));
  store.saveWorkspace.mockImplementation(async (_id, state) => ({ ...workspace, revision: workspace.revision + 1, state }));
}

function request(connectorId: Connector = 'hubspot', overrides: Record<string, unknown> = {}, accessKey: string | null = 'operator-key') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (accessKey !== null) headers['x-control-tower-key'] = accessKey;
  return new Request('http://localhost/api/control-tower/import-match-decision', { method: 'POST', headers,
    body: JSON.stringify({ action: 'confirm', workspaceId: workspace.id, revision: workspace.revision,
      connectorId, contactId: workspace.state.contacts[0].contactId, sourceKey: importMatchSourceKey(workspace.state.contacts[0]),
      scanId: scan.id, nativeId: ids[connectorId], objectType: connectorId === 'hubspot' ? 'contact' : 'lead',
      reason: 'Same name, direct phone, and company; email changed.', fields, ...overrides }) });
}

async function decision(connectorId: Connector = 'hubspot'): Promise<ConfirmedImportMatch> {
  const unsigned: Omit<ConfirmedImportMatch, 'signature'> = { connectorId, scanId: scan.id,
    sourceKey: importMatchSourceKey(workspace.state.contacts[0]), target: structuredClone(target),
    reason: 'Reviewed name and direct phone.', confirmedAt: now };
  return { ...unsigned, signature: await signImportMatch(workspace.id, unsigned) };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now));
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'operator-key');
  vi.stubEnv('HUBSPOT_ACCESS_TOKEN', 'fictional-hubspot-token'); vi.stubEnv('SALESFORCE_ACCESS_TOKEN', 'fictional-salesforce-token');
  vi.stubEnv('SALESFORCE_INSTANCE_URL', 'https://fictional.my.salesforce.com'); vi.stubEnv('SALESFORCE_API_VERSION', '67.0');
  store.persistenceEnabled.mockReturnValue(true);
  fixture('hubspot');
  // Only the two mocked native-ID readers may touch CRM data; confirmation must never make a write request.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe.each(['hubspot', 'salesforce'] as const)('%s human-confirmed import matches', (connectorId) => {
  beforeEach(() => fixture(connectorId));

  it('persists a signed candidate decision while preserving imported and CRM emails separately', async () => {
    const result = await POST(request(connectorId, { reason: '  Reviewed direct phone and name.  ' }));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const saved = (await result.json() as { workspace: SavedWorkspace }).workspace;
    const confirmed = saved.state.contacts[0].crmMatchDecisions![connectorId]!;
    expect(confirmed).toMatchObject({ connectorId, scanId: scan.id, reason: 'Reviewed direct phone and name.', confirmedAt: now, target });
    expect(isConfirmedImportMatch(confirmed)).toBe(true);
    expect(await verifyImportMatch(workspace.id, confirmed)).toBe(true);
    expect(saved.state.contacts[0].normalizedEmail).toBe('p.nair@salesforce.example.com');
    expect(confirmed.target.email).toBe('priya.nair@salesforce.example.com');
    expect(saved.revision).toBe(4);
    expect(store.saveWorkspace).toHaveBeenCalledOnce();
    expect(store.saveWorkspace.mock.calls[0][2]).toBe('import_match_confirmed');
    if (connectorId === 'hubspot') expect(store.readHubSpotRecordById).toHaveBeenCalledWith(ids.hubspot, 'fictional-hubspot-token');
    else expect(store.readSalesforceLeadById).toHaveBeenCalledWith(ids.salesforce, 'https://fictional.my.salesforce.com/services/data/v67.0',
      { authorization: 'Bearer fictional-salesforce-token', accept: 'application/json' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears the saved choice without requiring a snapshot or reading the CRM', async () => {
    workspace.state.contacts[0].crmMatchDecisions = { [connectorId]: await decision(connectorId) };
    const result = await POST(request(connectorId, { action: 'clear', reason: undefined, fields: undefined, sourceKey: undefined, scanId: undefined, nativeId: undefined }));
    expect(result.status).toBe(200);
    const saved = (await result.json() as { workspace: SavedWorkspace }).workspace;
    expect(saved.state.contacts[0]).not.toHaveProperty('crmMatchDecisions');
    expect(store.saveWorkspace.mock.calls[0][2]).toBe('import_match_cleared');
    expect(store.getDuplicateScan).not.toHaveBeenCalled();
    expect(store.readHubSpotRecordById).not.toHaveBeenCalled();
    expect(store.readSalesforceLeadById).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary native ID that was not a suggested candidate', async () => {
    const result = await POST(request(connectorId, { nativeId: connectorId === 'hubspot' ? '99999' : '00Q000000000099AAA' }));
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: expect.stringContaining('not a current candidate') });
    expect(store.saveWorkspace).not.toHaveBeenCalled();
    expect(store.readHubSpotRecordById).not.toHaveBeenCalled();
    expect(store.readSalesforceLeadById).not.toHaveBeenCalled();
  });

  it.each(['missing', 'changed'] as const)('rejects a %s native target and saves nothing', async (condition) => {
    const reader = connectorId === 'hubspot' ? store.readHubSpotRecordById : store.readSalesforceLeadById;
    reader.mockResolvedValue(condition === 'missing' ? null : { ...target, fields: { ...target.fields, jobTitle: 'Changed by CRM user' } });
    expect((await POST(request(connectorId))).status).toBe(409);
    expect(store.saveWorkspace).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a concurrent workspace edit discovered after the native read', async () => {
    store.getWorkspace.mockResolvedValueOnce(structuredClone(workspace)).mockResolvedValueOnce({ ...workspace, revision: 4 });
    const result = await POST(request(connectorId));
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: expect.stringContaining('changed during review') });
    expect(store.saveWorkspace).not.toHaveBeenCalled();
  });
});

describe('confirmation boundaries', () => {
  it('compares the snapshot alias set with the current CRM before saving a confirmation', async () => {
    candidate.additionalEmails = ['events@example.com'];
    target.additionalEmails = ['events@example.com', 'new@example.com'];
    expect((await POST(request())).status).toBe(409);
    expect(store.saveWorkspace).not.toHaveBeenCalled();
    candidate.additionalEmails = ['NEW@example.com', ' events@example.com ', candidate.email];
    const result = await POST(request());
    expect(result.status).toBe(200);
    const saved = (await result.json() as { workspace: SavedWorkspace }).workspace;
    expect(saved.state.contacts[0].crmMatchDecisions?.hubspot?.target.additionalEmails).toEqual(target.additionalEmails);
  });

  it.each([null, 'incorrect-key'])('requires the configured operator key (%s)', async (key) => {
    expect((await POST(request('hubspot', {}, key))).status).toBe(401);
    expect(store.getWorkspace).not.toHaveBeenCalled();
    expect(store.saveWorkspace).not.toHaveBeenCalled();
  });

  it('fails closed when production has no configured operator key', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('CONTROL_TOWER_SYNC_KEY', '');
    expect((await POST(request())).status).toBe(503);
    expect(store.getWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    ['revision', { revision: 2 }], ['source', { sourceKey: 'old-source' }],
  ])('rejects a stale %s', async (_name, overrides) => {
    expect((await POST(request('hubspot', overrides as Record<string, unknown>))).status).toBe(409);
    expect(store.saveWorkspace).not.toHaveBeenCalled();
    expect(store.readHubSpotRecordById).not.toHaveBeenCalled();
  });

  it.each(['too-old', 'incomplete', 'wrong-workspace', 'wrong-provider', 'missing-records'] as const)('rejects a %s snapshot', async (kind) => {
    if (kind === 'too-old') scan.startedAt = '2026-09-28T11:44:59.000Z';
    if (kind === 'incomplete') scan.sourceComplete = false;
    if (kind === 'wrong-workspace') scan.workspaceId = 'other-workspace';
    if (kind === 'wrong-provider') scan.connectorId = 'salesforce';
    if (kind === 'missing-records') scan.recordsScanned = 2;
    expect((await POST(request())).status).toBe(409);
    expect(store.saveWorkspace).not.toHaveBeenCalled();
    expect(store.readHubSpotRecordById).not.toHaveBeenCalled();
  });

  it.each([
    ['empty reason', { reason: '   ' }], ['oversize reason', { reason: 'x'.repeat(501) }],
    ['unsupported object', { objectType: 'lead' }], ['invalid native ID', { nativeId: 'arbitrary' }],
    ['no fields', { fields: [] }], ['unknown field', { fields: ['jobTitle'] }], ['duplicate field', { fields: ['name', 'name'] }],
  ])('rejects %s before native reads', async (_name, overrides) => {
    expect((await POST(request('hubspot', overrides as Record<string, unknown>))).status).toBe(400);
    expect(store.saveWorkspace).not.toHaveBeenCalled();
    expect(store.readHubSpotRecordById).not.toHaveBeenCalled();
  });

  it('holds skipped, merged, and unusable rows instead of confirming them', async () => {
    const original = structuredClone(workspace.state.contacts[0]);
    for (const row of [
      { ...original, importExclusion: { reason: 'Review elsewhere', excludedAt: now } },
      { ...original, recordStatus: 'merged' as const },
      { ...original, qualityFlags: ['invalid_email'] },
    ]) {
      workspace.state.contacts[0] = row;
      expect((await POST(request())).status).toBe(409);
    }
    expect(store.saveWorkspace).not.toHaveBeenCalled();
    expect(store.readHubSpotRecordById).not.toHaveBeenCalled();
  });

  it('does not confirm a Salesforce Contact or a converted Lead', async () => {
    fixture('salesforce');
    expect((await POST(request('salesforce', { objectType: 'contact' }))).status).toBe(400);
    target.isConverted = true;
    expect((await POST(request('salesforce'))).status).toBe(409);
    expect(store.saveWorkspace).not.toHaveBeenCalled();
  });

  it('returns provider failures without recording a confirmation', async () => {
    store.readHubSpotRecordById.mockRejectedValue(new Error('Native read failed'));
    const result = await POST(request());
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({ error: 'Native read failed' });
    expect(store.saveWorkspace).not.toHaveBeenCalled();
  });
});

describe('saved-decision integrity', () => {
  it('binds the canonical alias set while preserving signatures for targets without aliases', async () => {
    const legacy = await decision();
    expect(await verifyImportMatch(workspace.id, { ...legacy, target: { ...target, additionalEmails: [] } })).toBe(true);
    expect(await verifyImportMatch(workspace.id, { ...legacy, target: { ...target, additionalEmails: [target.email.toUpperCase()] } })).toBe(true);
    target.additionalEmails = ['events@example.com', 'old@example.com'];
    const confirmed = await decision();
    expect(await verifyImportMatch(workspace.id, { ...confirmed, target: { ...target,
      additionalEmails: [' OLD@EXAMPLE.COM ', target.email, 'events@example.com', 'old@example.com'] } })).toBe(true);
    expect(await verifyImportMatch(workspace.id, { ...confirmed, target: { ...target, additionalEmails: ['events@example.com'] } })).toBe(false);
    expect(await verifyImportMatch(workspace.id, { ...confirmed, target: { ...target, additionalEmails: undefined } })).toBe(false);
  });

  it('binds an authentic confirmation to its source, target, reason, workspace, and current credential', async () => {
    const confirmed = await decision();
    expect(await verifyImportMatch(workspace.id, confirmed)).toBe(true);
    expect(await verifyImportMatch('another-workspace', confirmed)).toBe(false);
    for (const altered of [
      { ...confirmed, sourceKey: 'changed-source' }, { ...confirmed, reason: 'Changed reason' },
      { ...confirmed, target: { ...confirmed.target, nativeId: '987654321' } },
      { ...confirmed, target: { ...confirmed.target, fields: { ...confirmed.target.fields, jobTitle: 'Tampered title' } } },
      { ...confirmed, signature: '0'.repeat(64) },
    ]) expect(await verifyImportMatch(workspace.id, altered)).toBe(false);
    vi.stubEnv('HUBSPOT_ACCESS_TOKEN', 'rotated-credential');
    expect(await verifyImportMatch(workspace.id, confirmed)).toBe(false);
  });

  it('also binds Salesforce decisions to the configured instance', async () => {
    fixture('salesforce');
    const confirmed = await decision('salesforce');
    vi.stubEnv('SALESFORCE_INSTANCE_URL', 'https://another.my.salesforce.com');
    expect(await verifyImportMatch(workspace.id, confirmed)).toBe(false);
  });

  it('validates persisted decisions and rejects malformed metadata without dropping it silently', async () => {
    const confirmed = await decision();
    expect(validImportMatchDecisions(undefined)).toBe(true);
    expect(validImportMatchDecisions({ hubspot: confirmed })).toBe(true);
    for (const invalid of [
      { hubspot: { ...confirmed, signature: 'unsigned' } }, { salesforce: confirmed }, { unknown: confirmed },
      { hubspot: { ...confirmed, reason: '   ' } }, { hubspot: { ...confirmed, confirmedAt: 'yesterday' } },
      { hubspot: { ...confirmed, target: { ...target, fields: { ...target.fields, phone: 123 } } } },
      { hubspot: { ...confirmed, target: { ...target, additionalEmails: 'events@example.com' } } },
      { hubspot: { ...confirmed, target: { ...target, additionalEmails: ['not-an-email'] } } },
    ]) {
      expect(validImportMatchDecisions(invalid)).toBe(false);
      expect(() => validateWorkspaceState({ ...workspace.state, contacts: [{ ...workspace.state.contacts[0], crmMatchDecisions: invalid }] })).toThrow('Confirmed CRM matches');
    }
    const restored = validateWorkspaceState({ ...workspace.state, contacts: [{ ...workspace.state.contacts[0], crmMatchDecisions: { hubspot: confirmed } }] });
    expect(restored.contacts[0].crmMatchDecisions?.hubspot).toEqual(confirmed);
  });

  it('invalidates source edits while ignoring operational timestamps, skips, and decisions', async () => {
    const row = workspace.state.contacts[0];
    const key = importMatchSourceKey(row);
    expect(importMatchSourceKey({ ...row, updatedAt: '2026-09-29T00:00:00.000Z', lastAction: 'saved',
      importExclusion: { reason: 'Review elsewhere', excludedAt: now }, crmMatchDecisions: { hubspot: await decision() } })).toBe(key);
    for (const field of ['fullName', 'firstName', 'lastName', 'rawEmail', 'normalizedEmail', 'company', 'phone', 'state', 'jobTitle', 'website'] as const) {
      expect(importMatchSourceKey({ ...row, [field]: `${row[field]} changed` })).not.toBe(key);
    }
    expect(nativeMatchTargetKey({ ...target, email: target.email.toUpperCase(), fields: { ...target.fields, phone: ` ${target.fields.phone} ` } })).toBe(nativeMatchTargetKey(target));
  });
});
