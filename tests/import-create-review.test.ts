import { describe, expect, it } from 'vitest';
import { buildCrmWritePlan, planStillMatches, type PortableCrmContact } from '../lib/crm-workflow';
import { importContactsCsv } from '../lib/csv-control-tower';
import type { DuplicateScanView } from '../lib/duplicate-scan-store';
import { toHubSpotSyncContact } from '../lib/hubspot-sync';
import { reviewImportCreates } from '../lib/import-create-review';
import { excludeImportRow, restoreImportRow } from '../lib/import-exclusions';
import type { IdentityRecord } from '../lib/identity-resolution';
import type { LiveContactState } from '../lib/live-control-tower';
import { toSalesforceSyncLead } from '../lib/salesforce-sync';
import { emptyWorkspaceState, type SavedWorkspace } from '../lib/workspace';

const now = new Date('2026-09-27T22:00:00Z');
const scan: DuplicateScanView = {
  id: 'scan-1', workspaceId: 'workspace-1', connectorId: 'salesforce', status: 'complete', cursor: null,
  recordsScanned: 0, pagesScanned: 1, candidatesCompared: 0, sourceComplete: true, analysisWarnings: [], ruleVersion: 'identity-v3',
  startedAt: now.toISOString(), updatedAt: now.toISOString(), completedAt: now.toISOString(), complete: true,
  clusterCount: 0, duplicateRecords: 0, highConfidenceClusters: 0, reviewClusters: 0, possibleClusters: 0, clusters: [],
};
function contact(overrides: Partial<PortableCrmContact> = {}): PortableCrmContact {
  return { contactId: 'import-1', firstName: 'Nina', lastName: 'Shah', email: 'nina.shah@costco.example', company: 'Costco',
    phone: null, jobTitle: 'Director of Operations', website: 'https://www.costco.com', ...overrides };
}
function workspace(contacts: PortableCrmContact[], state = 'Washington'): SavedWorkspace {
  return { id: 'workspace-1', name: 'Fictional import', revision: 1, presets: [], createdAt: now.toISOString(), updatedAt: now.toISOString(),
    state: { ...emptyWorkspaceState(), contacts: contacts.map((item): LiveContactState => ({ ...item,
      fullName: `${item.firstName} ${item.lastName}`, rawEmail: item.email, normalizedEmail: item.email, state,
      recordStatus: 'active', qualityFlags: [], region: 'West', segment: '', lifecycleStage: 'Lead', expectedLifecycleStage: 'Lead',
      ownerId: null, canonicalContactId: null, lastAction: '', updatedAt: now.toISOString(),
    })) } };
}
function crm(overrides: Partial<IdentityRecord> = {}): IdentityRecord {
  return { recordKey: 'salesforce:lead:1', nativeId: '1', connectorId: 'salesforce', objectType: 'lead', firstName: 'Priya', lastName: 'Nair',
    fullName: 'Priya Nair', email: 'priya.nair@salesforce.example', company: 'Salesforce', phone: '2065550112', state: 'WA',
    jobTitle: '', website: '', createdAt: null, updatedAt: null, ...overrides };
}
function compare(contacts: PortableCrmContact[], records: IdentityRecord[]) {
  return reviewImportCreates('salesforce', contacts, workspace(contacts), { ...scan, recordsScanned: records.length }, records, now);
}

describe('server-side possible-duplicate create review', () => {
  it.each(['salesforce', 'hubspot'] as const)('excludes a skipped neighbor from %s create review and rejects a proposed skipped row', (connectorId) => {
    const proposed = [contact({ contactId: 'keep', phone: '2065550112' }), contact({ contactId: 'skip', email: 'n.shah@costco.example', phone: '2065550112' })];
    const saved = workspace(proposed);
    saved.state.contacts = excludeImportRow(saved.state.contacts, 'skip', 'Duplicate signup; retain keep', now);
    const review = () => reviewImportCreates(connectorId, proposed, saved, { ...scan, connectorId }, [], now);
    expect(review().get('keep')).toMatchObject({ review: { status: 'clear', importCandidateCount: 0 }, possibleImportMatches: [] });
    expect(review().get('skip')).toMatchObject({ review: { status: 'held' } });
    expect(review().get('skip')?.reason).toContain('usable saved import identity');
    saved.state.contacts = restoreImportRow(saved.state.contacts, 'skip', now);
    expect(review().get('keep')).toMatchObject({ review: { status: 'held', importCandidateCount: 1 } });
  });

  it.each(['salesforce', 'hubspot'] as const)('holds different-email copies of a new person in the same %s import', (connectorId) => {
    const proposed = [contact({ contactId: 'first', phone: '2065550112' }), contact({ contactId: 'second', email: 'n.shah@costco.example', phone: '2065550112' })];
    const results = reviewImportCreates(connectorId, proposed, workspace(proposed), { ...scan, connectorId }, [], now);
    for (const [index, person] of proposed.entries()) {
      expect(results.get(person.contactId)).toMatchObject({ review: { status: 'held', candidateCount: 0, importCandidateCount: 1 },
        possibleMatches: [], possibleImportMatches: [{ contactId: proposed[1 - index].contactId, score: 72 }] });
      expect(results.get(person.contactId)?.possibleImportMatches?.[0]).not.toHaveProperty('nativeId');
    }
    const plan = buildCrmWritePlan(connectorId, 'test.csv', proposed, new Map(), now, results);
    expect(plan).toMatchObject({ creates: 0, held: 2 });
    expect(plan.records[0].possibleImportMatches).toHaveLength(1);
  });

  it.each(['salesforce', 'hubspot'] as const)('uses the effective %s name of an ineligible active neighbor and excludes merged rows', (connectorId) => {
    const proposed = contact({ phone: '2065550112' });
    const neighbor = contact({ contactId: 'neighbor', firstName: 'Priya', lastName: 'Nair', phone: '2065550112', email: 'other.person@costco.example' });
    const saved = workspace([proposed, neighbor]);
    saved.state.contacts[1].fullName = 'Nina Shah';
    saved.state.contacts[1].qualityFlags = ['invalid_email'];
    saved.state.contacts[1].normalizedEmail = null;
    const review = () => reviewImportCreates(connectorId, [proposed], saved, { ...scan, connectorId }, [], now).get('import-1');
    expect(review()?.review.status).toBe('clear');
    Object.assign(saved.state.contacts[1], { firstName: 'Nina', lastName: 'Shah' });
    expect(review()).toMatchObject({ review: { status: 'held', importCandidateCount: 1 }, possibleImportMatches: [{ fullName: 'Nina Shah' }] });
    saved.state.contacts[1].recordStatus = 'merged';
    expect(review()).toMatchObject({ review: { status: 'clear', importCandidateCount: 0 }, possibleImportMatches: [] });
  });

  it('holds incomplete or unusable saved-import identity checks without passing off import IDs as CRM IDs', () => {
    const proposed = contact({ firstName: 'Jordan', lastName: 'Lee', email: 'person@import.example', company: 'Cisco' });
    const saved = workspace([proposed, ...Array.from({ length: 251 }, (_, index) => contact({ ...proposed,
      contactId: `other-${index}`, email: `employee-${index}@other.example` }))]);
    const result = reviewImportCreates('salesforce', [proposed], saved, scan, [], now).get('import-1');
    expect(result).toMatchObject({ review: { status: 'held', candidateCount: 0, importCandidateCount: 0 }, possibleImportMatches: [] });
    expect(result?.review.warnings.join(' ')).toContain('other import rows');
    saved.state.contacts[1].state = 123 as unknown as string;
    expect(reviewImportCreates('salesforce', [proposed], saved, scan, [], now).get('import-1')?.reason)
      .toContain('identity that could not be checked');
  });

  it('includes same-import evidence changes in the plan fingerprint', () => {
    const proposed = [contact(), contact({ contactId: 'other', email: 'other.person@costco.example' })];
    const reviews = compare(proposed, []);
    const plan = buildCrmWritePlan('salesforce', 'test.csv', proposed, new Map(), new Date(), reviews);
    const changed = new Map(reviews);
    const first = changed.get('import-1')!;
    changed.set('import-1', { ...first, possibleImportMatches: [{ ...first.possibleImportMatches![0], score: 31 }] });
    expect(planStillMatches(plan, buildCrmWritePlan('salesforce', 'test.csv', proposed, new Map(), new Date(), changed))).toBe(false);
  });

  it.each(['salesforce', 'hubspot'] as const)('compares the effective %s name when mapped name columns disagree', (connectorId) => {
    const existing = { ...crm(), connectorId, objectType: connectorId === 'hubspot' ? 'contact' as const : 'lead' as const };
    for (const [fullName, firstName, lastName, status] of [
      ['Nina Shah', 'Priya', 'Nair', 'held'],
      ['Priya Nair', 'Nina', 'Shah', 'clear'],
    ] as const) {
      const csv = `contact_id,full_name,first_name,last_name,email,company,state,owner_id\nimport-1,${fullName},${firstName},${lastName},new.person@salesforce.example,Salesforce,Washington,owner-1`;
      const saved = workspace([]);
      saved.state.contacts = importContactsCsv(csv).contacts;
      const proposed = saved.state.contacts.map(connectorId === 'hubspot' ? toHubSpotSyncContact : toSalesforceSyncLead);
      const reviews = reviewImportCreates(connectorId, proposed, saved, { ...scan, connectorId, recordsScanned: 1 }, [existing], now);
      expect(reviews.get('import-1')?.review.status).toBe(status);
      expect(reviews.get('import-1')?.possibleMatches.map((match) => match.score)).toEqual(status === 'held' ? [28] : []);
    }
  });

  it('does not treat a fallback contact ID as a person name', () => {
    const saved = workspace([]);
    saved.state.contacts = importContactsCsv('contact_id,email,company,state,owner_id\nPriya Nair,new.person@salesforce.example,Salesforce,Washington,owner-1').contacts;
    const proposed = saved.state.contacts.map(toSalesforceSyncLead);
    const result = reviewImportCreates('salesforce', proposed, saved, { ...scan, recordsScanned: 1 }, [crm()], now).get('Priya Nair');
    expect(result?.review.status).toBe('clear');
    expect(result?.possibleMatches).toEqual([]);
  });

  it('holds a changed-email person and both sparse coworkers while allowing an unrelated person', () => {
    const priya = contact({ contactId: 'priya', firstName: 'Priya', lastName: 'Nair', email: 'p.nair@salesforce.example', company: 'Salesforce', phone: '2065550112' });
    const jordan = contact({ contactId: 'jordan', firstName: 'Jordan', lastName: 'Lee', email: 'jordan.lee.events@cisco.example', company: 'Cisco', phone: null });
    const nina = contact({ contactId: 'nina' });
    const results = compare([priya, jordan, nina], [crm(), ...['engineering', 'marketing'].map((role) => crm({
      recordKey: `salesforce:lead:${role}`, nativeId: role, firstName: 'Jordan', lastName: 'Lee', fullName: 'Jordan Lee',
      email: `jordan.lee.${role}@cisco.example`, company: 'Cisco', phone: '',
    }))]);
    expect(results.get('priya')).toMatchObject({ review: { status: 'held', candidateCount: 1 }, possibleMatches: [{ score: 72 }] });
    expect(results.get('jordan')).toMatchObject({ review: { status: 'held', candidateCount: 2 }, possibleMatches: [{ score: 28 }, { score: 28 }] });
    expect(results.get('nina')).toMatchObject({ review: { status: 'clear', candidateCount: 0 }, possibleMatches: [] });
    const plan = buildCrmWritePlan('salesforce', 'fixture.csv', [priya, jordan, nina], new Map(), now, results);
    expect(plan).toMatchObject({ creates: 1, held: 2 });
    expect(plan.records[1].matches).toEqual([]);
    expect(plan.records[1].possibleMatches).toHaveLength(2);
  });

  it.each([
    ['missing', null],
    ['unfinished', { ...scan, complete: false }],
    ['partial', { ...scan, sourceComplete: false }],
    ['stale', { ...scan, startedAt: new Date(now.getTime() - 15 * 60_000 - 1).toISOString() }],
    ['invalid timestamp', { ...scan, startedAt: 'invalid' }],
    ['different workspace', { ...scan, workspaceId: 'another' }],
  ])('holds creates with a %s snapshot', (_label, snapshot) => {
    const proposed = [contact()];
    const result = reviewImportCreates('salesforce', proposed, workspace(proposed), snapshot, [], now).get('import-1');
    expect(result?.review.status).toBe('held');
    expect(result?.reason).toMatch(/snapshot/u);
  });

  it('holds missing or changed saved rows instead of trusting caller identity values', () => {
    const proposed = [contact()];
    expect(reviewImportCreates('salesforce', proposed, null, scan, [], now).get('import-1')?.review.status).toBe('held');
    const saved = workspace(proposed);
    saved.state.contacts[0].company = 'Changed after preview';
    const result = reviewImportCreates('salesforce', proposed, saved, scan, [], now).get('import-1');
    expect(result?.reason).toContain('does not match a usable saved import identity');
    expect(result?.review.status).toBe('held');
  });

  it('holds an incomplete candidate search but not informational missing-field or shared-phone warnings', () => {
    const proposed = [contact({ firstName: 'Jordan', lastName: 'Lee', email: 'jordan@import.example', company: 'Cisco' })];
    const broad = Array.from({ length: 251 }, (_, index) => crm({ recordKey: `salesforce:lead:${index}`, nativeId: String(index),
      firstName: 'Jordan', lastName: 'Lee', fullName: 'Jordan Lee', email: 'staff@different.example', company: 'Cisco', phone: '',
    }));
    const result = compare(proposed, broad).get('import-1');
    expect(result).toMatchObject({ review: { status: 'held', candidateCount: 0 }, possibleMatches: [] });
    expect(result?.reason).toContain('search reached a limit');
    const sharedPhone = '4255550119';
    const unrelated = Array.from({ length: 4 }, (_, index) => crm({ recordKey: `salesforce:lead:${index}`, nativeId: String(index),
      phone: sharedPhone, state: '',
    }));
    const allowed = compare([contact({ phone: sharedPhone })], unrelated).get('import-1');
    expect(allowed?.review.status).toBe('clear');
    expect(allowed?.review.warnings.join(' ')).toContain('supporting context');
  });

  it('includes snapshot identity and candidate evidence in the plan fingerprint', () => {
    const proposed = [contact({ firstName: 'Priya', lastName: 'Nair', company: 'Salesforce', phone: '2065550112' })];
    const records = [crm()];
    const firstReviews = compare(proposed, records);
    const first = buildCrmWritePlan('salesforce', 'test.csv', proposed, new Map(), new Date(), firstReviews);
    const changedReviews = reviewImportCreates('salesforce', proposed, workspace(proposed), { ...scan, id: 'scan-2', recordsScanned: 1 }, records, now);
    const changed = buildCrmWritePlan('salesforce', 'test.csv', proposed, new Map(), new Date(), changedReviews);
    expect(planStillMatches(first, changed)).toBe(false);
    const evidence = new Map(firstReviews);
    evidence.set('import-1', { ...evidence.get('import-1')!, possibleMatches: [{ ...evidence.get('import-1')!.possibleMatches[0], score: 40 }] });
    expect(planStillMatches(first, buildCrmWritePlan('salesforce', 'test.csv', proposed, new Map(), new Date(), evidence))).toBe(false);
  });
});
