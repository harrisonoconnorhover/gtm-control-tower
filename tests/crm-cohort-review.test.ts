import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCrmCohort } from '../lib/crm-cohort';
import { fictionalCrmCohort, fictionalCrmCohortRequest } from '../lib/crm-cohort-fixture';
import { blankCrmEvidenceResult, createCrmEvidenceRequest, createCrmEvidenceResult } from '../lib/crm-evidence-request';
import { cohortDecisionKey, exportCohortReport, mergeCohortContacts, mergeCohortPopulationCoverage, reviewCohortResult, validateCrmCohortWorkspace, validateSavedCrmCohort, type CohortReview, type CrmCohortWorkspace } from '../lib/crm-cohort-review';
import { emptyWorkspaceState } from '../lib/workspace';

const directory = mkdtempSync(join(tmpdir(), 'crm-cohort-review-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'workspace.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

async function example() {
  const request = await fictionalCrmCohortRequest();
  const fixture = fictionalCrmCohort();
  const blank = await blankCrmEvidenceResult(request);
  const result = await createCrmEvidenceResult(request, blank.contacts.map((contact) => contact.contactId === '101' ? {
    ...contact, fields: [{ field: 'jobTitle', status: 'supported', value: 'Revenue Operations Director',
      rationale: 'The contact-specific CRM note states this title. Review the recorded date.',
      evidence: [{ sourceId: 'note-101', quote: 'Maya Stone is Revenue Operations Director at Northstar Demo.' }] }],
  } : contact));
  const current = evaluateCrmCohort(fixture.definition, fixture.contacts).contacts;
  const review: CohortReview = { result, current, checkedAt: fixture.definition.evaluatedAt, decisions: {} };
  return { request, fixture, review };
}

describe('CRM cohort result review', () => {
  it('requires interpretation review, keeps unknown fields held and never grants send/write authority', async () => {
    const { request, fixture, review } = await example();
    expect(reviewCohortResult(request, review).find((row) => row.contactId === '101')?.state).toBe('held');
    review.decisions[cohortDecisionKey('101', 'jobTitle')] = 'accepted';
    expect(reviewCohortResult(request, review).find((row) => row.contactId === '101')?.state).toBe('ready_for_review');
    expect(reviewCohortResult(request, review).find((row) => row.contactId === '106')?.state).toBe('held');
    const cohort: CrmCohortWorkspace = { mode: 'fictional', definition: fixture.definition,
      contacts: mergeCohortContacts([], fixture.contacts), populationCoverage: { complete: true, missing: [], omittedSourceIds: [] }, nextCursor: null, totalDeals: null,
      selectedContactIds: request.contacts.map((contact) => contact.contactId), request, reviews: [review] };
    await validateSavedCrmCohort(cohort);
    expect(exportCohortReport(cohort)).toMatchObject({ approvalToSend: false, crmWrites: false });
  });

  it('preserves changed CRM values, changed source text and new exclusions even after an acceptance', async () => {
    const { request, review } = await example();
    review.decisions[cohortDecisionKey('101', 'jobTitle')] = 'accepted';
    const changed = structuredClone(review);
    changed.current.find((contact) => contact.contactId === '101')!.existingValues.jobTitle = 'New CRM title';
    const row = reviewCohortResult(request, changed).find((contact) => contact.contactId === '101')!;
    expect(row.state).toBe('held'); expect(row.proposals).toHaveLength(0);
    expect(row.reasons.join(' ')).toContain('current value is preserved');
    const missingSource = structuredClone(review);
    missingSource.current.find((contact) => contact.contactId === '101')!.evidence = [];
    expect(reviewCohortResult(request, missingSource).find((contact) => contact.contactId === '101')?.state).toBe('held');
    const excluded = structuredClone(review);
    excluded.current.find((contact) => contact.contactId === '101')!.assessments.state = 'excluded';
    expect(reviewCohortResult(request, excluded).find((contact) => contact.contactId === '101')?.state).toBe('excluded');
  });

  it('keeps repeated native identities deduplicated and conflicting snapshots held', () => {
    const fixture = fictionalCrmCohort();
    const merged = mergeCohortContacts([], fixture.contacts);
    expect(merged).toHaveLength(7);
    expect(merged[0].dealIds).toHaveLength(2);
    const changed = structuredClone(merged[0]); changed.properties.jobtitle = 'Changed while paging';
    const next = mergeCohortContacts(merged, [changed]);
    expect(evaluateCrmCohort(fixture.definition, next).contacts[0].assessments.state).toBe('held');
  });

  it('uses matching unambiguous company evidence during fresh review and holds a changed association', async () => {
    const { request: original, review: initial } = await example();
    const contact = structuredClone(original.contacts[0]);
    contact.existingValues.company = null;
    contact.requestedFields = ['company'];
    contact.evidence = [{ id: 'company-name', objectType: 'company', recordId: 'company-northstar', property: 'name', noteId: null,
      text: 'Northstar Demo', eventAt: null, retrievedAt: original.createdAt, contactIds: [], url: null }];
    const request = await createCrmEvidenceRequest({ requestId: 'company-example', createdAt: original.createdAt, workspaceId: original.workspaceId,
      workspaceRevision: original.workspaceRevision, portalId: original.portalId, definition: original.definition, contacts: [contact] });
    const result = await createCrmEvidenceResult(request, [{ contactId: '101', fields: [{ field: 'company', status: 'supported', value: 'Northstar Demo',
      rationale: 'The only associated company record supplies this name.', evidence: [{ sourceId: 'company-name', quote: 'Northstar Demo' }] }] }]);
    const review: CohortReview = { ...initial, result, current: [structuredClone(contact)], decisions: { [cohortDecisionKey('101', 'company')]: 'accepted' } };
    expect(reviewCohortResult(request, review)[0]).toMatchObject({ state: 'ready_for_review', proposals: [{ field: 'company', value: 'Northstar Demo' }] });
    review.current[0].companyIds.push('second-company');
    expect(reviewCohortResult(request, review)[0]).toMatchObject({ state: 'held', proposals: [] });
  });

  it('clears only transient paging warnings and preserves durable omissions across later pages', () => {
    const clean = { complete: true, missing: [], omittedSourceIds: [] };
    const first = mergeCohortPopulationCoverage(undefined, clean, '20');
    expect(first.complete).toBe(false);
    expect(first.missing).toHaveLength(1);
    expect(mergeCohortPopulationCoverage(first, clean, null)).toEqual(clean);
    const incomplete = mergeCohortPopulationCoverage(first, { complete: false, missing: ['Deal association read failed'], omittedSourceIds: ['contact:999'] }, '40');
    const last = mergeCohortPopulationCoverage(incomplete, clean, null);
    expect(last).toEqual({ complete: false, missing: ['Deal association read failed'], omittedSourceIds: ['contact:999'] });
  });

  it('validates population coverage and exports evaluated unselected records with their reasons', async () => {
    const { fixture } = await example();
    const cohort: CrmCohortWorkspace = { mode: 'fictional', definition: fixture.definition, contacts: mergeCohortContacts([], fixture.contacts),
      populationCoverage: { complete: false, missing: ['An earlier association read failed'], omittedSourceIds: ['contact:999'] },
      nextCursor: null, totalDeals: null, selectedContactIds: ['101'], reviews: [] };
    expect(validateCrmCohortWorkspace(cohort)).toBe(cohort);
    const report = exportCohortReport(cohort);
    expect(report.populationCoverage).toEqual(cohort.populationCoverage);
    expect(report.unselectedContactIds).toContain('103');
    expect(report.unselectedContacts.find((contact) => contact.contactId === '103')!.assessments).toMatchObject({ state: 'excluded', reasons: expect.arrayContaining([expect.stringContaining('do_not_contact')]) });
    expect(report.unselectedContacts.find((contact) => contact.contactId === '104')!.assessments).toMatchObject({ state: 'held', reasons: expect.arrayContaining([expect.stringContaining('possible duplicates')]) });
    const falseComplete = { ...cohort, populationCoverage: { ...cohort.populationCoverage, complete: true } };
    expect(() => validateCrmCohortWorkspace(falseComplete)).toThrow('invalid');
    expect(() => validateCrmCohortWorkspace({ ...cohort, populationCoverage: { complete: true, missing: [], omittedSourceIds: [] }, nextCursor: '20' })).toThrow('more pages');
  });

  it('saves and reloads source evidence and field decisions using existing SQLite workspace revisions', async () => {
    const { request, fixture, review } = await example();
    const { createWorkspace, saveWorkspace, getWorkspace } = await import('../lib/workspace-store');
    const workspace = await createWorkspace('Fictional cohort review test');
    const cohort: CrmCohortWorkspace = { mode: 'fictional', definition: fixture.definition,
      contacts: mergeCohortContacts([], fixture.contacts), populationCoverage: { complete: true, missing: [], omittedSourceIds: [] }, nextCursor: null, totalDeals: null,
      selectedContactIds: request.contacts.map((contact) => contact.contactId), request, reviews: [review] };
    const saved = await saveWorkspace(workspace.id, { ...emptyWorkspaceState(), crmCohort: cohort });
    expect((await getWorkspace(workspace.id))?.state.crmCohort).toEqual(cohort);
    const invalid = structuredClone(cohort); invalid.reviews[0].result.portalId = 'wrong';
    await expect(saveWorkspace(workspace.id, { ...saved.state, crmCohort: invalid })).rejects.toThrow(/portal/);
    expect((await getWorkspace(workspace.id))?.revision).toBe(saved.revision);
  });
});
