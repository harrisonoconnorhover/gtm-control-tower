import { describe, expect, it } from 'vitest';
import { deriveImportReadiness, type ImportReadinessInput } from '../lib/import-readiness';
import type { LiveContactState } from '../lib/live-control-tower';
import type { QualificationCheck, QualificationExecution } from '../lib/pomade-qualification';

const checkedAt = '2026-10-16T13:00:00.000Z';
function contact(id = 'row-1'): LiveContactState {
  return { contactId: id, fullName: 'Ada Example', rawEmail: `${id}@example.test`, normalizedEmail: `${id}@example.test`,
    company: 'Example CRM', website: 'https://example.test/', region: '', segment: '', lifecycleStage: 'lead',
    expectedLifecycleStage: 'lead', ownerId: null, canonicalContactId: null, recordStatus: 'active',
    lastAction: 'imported', qualityFlags: [], updatedAt: checkedAt };
}
const check = (assessment: string): QualificationCheck => ({ state: 'complete', assessment, explanation: 'Provider evidence.',
  sources: [], checkedAt, provider: 'fixture', receiptId: 'receipt' });
function fixture(contacts = [contact()]): ImportReadinessInput {
  return { contacts, workspaceId: 'workspace', websiteChecks: [{ url: 'https://example.test/', finalUrl: 'https://example.test/',
    status: 'reachable', method: 'http', httpStatus: 200, title: 'Example CRM', detail: 'HTTP 200', checkedAt }],
    qualification: { qualificationId: 'qualification', requestDigest: 'digest', tableId: 'table', tableUrl: 'http://localhost/?table=table',
      sourceRevision: 1, icpCriteria: 'CRM software companies', sentAt: checkedAt, refreshedAt: checkedAt, stale: false,
      rows: contacts.filter((row) => row.recordStatus === 'active' && !row.importExclusion).map((row) => ({ sourceRowId: row.contactId, pomadeRowId: `pomade-${row.contactId}`,
        inputs: { company: row.company ?? '', website: row.website ?? '', email: row.normalizedEmail || row.rawEmail },
        identity: check('Match'), icp: check('Fit'), email: check('valid') })) } };
}
const codes = (input: ImportReadinessInput, index = 0) => deriveImportReadiness(input).rows[index].reasons.map((reason) => reason.code);

describe('derived import readiness', () => {
  it('requires all four positive observations and permits same-input cached observations without timestamps', () => {
    const input = fixture();
    for (const kind of ['identity', 'icp', 'email'] as const) input.qualification!.rows[0][kind].checkedAt = null;
    input.qualification!.rows[0].email.assessment = ' VALID ';
    expect(deriveImportReadiness(input)).toMatchObject({ counts: { ready: 1, needsReview: 0, excluded: 0 },
      rows: [{ sourceRowId: 'row-1', company: 'Example CRM', email: 'row-1@example.test', status: 'ready', reasons: [{ code: 'checks_passed' }] }] });
    expect(deriveImportReadiness(input).rows[0].reasons[0].message).toContain('no local import holds');
  });

  it('reports explicit exclusions and merged rows first, without converting negative checks into exclusions', () => {
    const included = contact('included');
    included.qualityFlags = ['invalid_email', 'missing_company', 'missing_owner', 'stage_regression', 'duplicate_identity', 'unrelated_flag'];
    const excluded = { ...contact('excluded'), importExclusion: { reason: 'Vendor', excludedAt: checkedAt } };
    const merged = { ...contact('merged'), recordStatus: 'merged' as const };
    const input = fixture([included, excluded, merged]);
    input.unsaved = true;
    const result = deriveImportReadiness(input);
    expect(result.counts).toEqual({ ready: 0, needsReview: 1, excluded: 2 });
    expect(codes(input)).toEqual(['unsaved_changes', 'invalid_email', 'missing_company', 'missing_owner', 'stage_regression', 'duplicate_identity']);
    expect(result.rows[1].reasons).toEqual([{ code: 'import_excluded', message: 'Excluded from import: Vendor' }]);
    expect(codes(input, 2)).toEqual(['record_merged']);
  });

  it('explains identity mismatch, ICP rejection and invalid email while retaining the row for review', () => {
    const input = fixture();
    Object.assign(input.qualification!.rows[0], { identity: check('Mismatch'), icp: check('Not a fit'), email: check('invalid') });
    const row = deriveImportReadiness(input).rows[0];
    expect(row.status).toBe('needs_review');
    expect(row.reasons.map((reason) => reason.code)).toEqual(['identity_needs_review', 'icp_needs_review', 'email_needs_review']);
    expect(row.reasons.map((reason) => reason.message).join(' ')).toMatch(/does not match.*does not meet.*invalid/u);
  });

  it('keeps uncertain, missing, failed and stale checks in review even when their assessment looks positive', () => {
    const input = fixture();
    for (const state of ['not_run', 'review', 'error', 'stale'] as const) {
      for (const kind of ['identity', 'icp', 'email'] as const) input.qualification!.rows[0][kind].state = state;
      expect(codes(input)).toEqual([`identity_${state}`, `icp_${state}`, `email_${state}`]);
    }
    for (const assessment of ['catch_all', 'unknown', 'disposable', 'accept_all', 'blocked', null]) {
      input.qualification!.rows[0].email = { ...check('valid'), assessment };
      expect(codes(input)).toContain('email_needs_review');
    }
    input.qualification = null;
    expect(codes(input)).toEqual(['qualification_not_checked']);
  });

  it('invalidates changed inputs or included list membership, plus explicit server and draft ICP staleness', () => {
    for (const patch of [{ company: 'Different company' }, { website: 'https://different.test/' }, { normalizedEmail: 'new@example.test' }]) {
      const input = fixture();
      Object.assign(input.contacts[0], patch);
      expect(codes(input)).toContain('qualification_stale');
    }
    const input = fixture();
    input.contacts.push(contact('new-row'));
    expect(deriveImportReadiness(input).rows.every((row) => row.reasons.some((reason) => reason.code === 'qualification_stale'))).toBe(true);
    for (const server of [true, false]) {
      const stale = fixture();
      if (server) stale.qualification!.stale = true;
      else stale.qualificationStale = true;
      expect(codes(stale)).toEqual(['qualification_stale']);
    }
    const noIcp = fixture();
    noIcp.qualification!.icpCriteria = ' ';
    expect(codes(noIcp)).toEqual(['icp_not_defined']);
  });

  it('requires a reachable check for the current normalized website and never treats a redirect destination as the original input', () => {
    const input = fixture();
    input.websiteChecks[0].url = 'example.test#ignored';
    expect(deriveImportReadiness(input).rows[0].status).toBe('ready');
    for (const status of ['blocked', 'timed_out', 'failed', 'needs_review', 'invalid'] as const) {
      input.websiteChecks[0].status = status;
      expect(codes(input)).toEqual([`website_${status}`]);
    }
    input.websiteChecks[0] = { ...input.websiteChecks[0], status: 'reachable', url: 'https://other.test/', finalUrl: 'https://example.test/' };
    expect(codes(input)).toEqual(['website_not_checked']);
    const blank = fixture([{ ...contact(), company: ' ', rawEmail: '', normalizedEmail: null, website: '' }]);
    expect(codes(blank)).toEqual(['missing_company', 'missing_email', 'missing_website']);
    const invalid = fixture([{ ...contact(), website: 'javascript:alert(1)' }]);
    expect(codes(invalid)).toEqual(['invalid_website']);
  });

  it('prevents transient loading, load failures, unsaved changes and an unsaved workspace from appearing ready', () => {
    const input = fixture();
    input.websiteState = 'loading'; input.qualificationState = 'loading';
    expect(codes(input)).toEqual(['website_loading', 'qualification_loading']);
    input.websiteState = 'error'; input.qualificationState = 'error';
    expect(codes(input)).toEqual(['website_load_error', 'qualification_load_error']);
    input.websiteState = 'ready'; input.qualificationState = 'ready'; input.unsaved = true; input.workspaceId = null;
    expect(codes(input)).toEqual(['workspace_not_saved', 'unsaved_changes']);
  });

  it('keeps selected rows in review during incomplete or unsuccessful runs without holding unrelated rows', () => {
    const input = fixture([contact('selected'), contact('unselected')]);
    const statuses: QualificationExecution['status'][] = ['starting', 'unknown', 'queued', 'running', 'paused', 'failed', 'cancelled', 'rejected'];
    for (const status of statuses) {
      input.qualification!.execution = { sourceRowIds: ['selected'], checks: ['email'], requestId: 'request', previewHash: 'hash', requestedAt: checkedAt,
        updatedAt: checkedAt, status, job: null, error: null };
      expect(codes(input)).toEqual([`qualification_run_${status}`]);
      expect(deriveImportReadiness(input).rows[1].status).toBe('ready');
    }
    input.qualification!.execution!.status = 'completed';
    expect(deriveImportReadiness(input).counts.ready).toBe(2);
  });

  it('rejects ambiguous row IDs, preserves input data, and ignores row ordering and unrelated fields for qualification binding', () => {
    const input = fixture([contact('first'), contact('second')]);
    input.contacts.reverse();
    input.contacts[0].ownerId = 'new-owner';
    const before = structuredClone(input);
    expect(deriveImportReadiness(input).rows.map((row) => row.sourceRowId)).toEqual(['second', 'first']);
    expect(deriveImportReadiness(input).counts.ready).toBe(2);
    expect(input).toEqual(before);
    const duplicated = fixture([contact('same'), contact('same')]);
    expect(deriveImportReadiness(duplicated).counts.ready).toBe(0);
    expect(codes(duplicated)).toEqual(['duplicate_row_id', 'qualification_missing_row']);
  });
});


describe('suppression readiness', () => {
  it('excludes matched rows with every reason, keeps unchanged observations valid and restores without new checks', () => {
    const input = fixture([contact('included'), contact('suppressed')]);
    const before = structuredClone(input);
    input.contacts[1].suppressionMatches = [
      { ruleId: 'vendor', listName: 'Vendors', type: 'email', value: 'suppressed@example.test', reason: 'Current vendor' },
      { ruleId: 'legal', listName: 'Do not contact', type: 'email_domain', value: 'example.test', reason: 'Requested no outreach' },
    ];
    let result = deriveImportReadiness(input);
    expect(result.counts).toEqual({ ready: 1, needsReview: 0, excluded: 1 });
    expect(result.rows[1].reasons.map((reason) => reason.message).join(' ')).toMatch(/Current vendor.*Requested no outreach/u);
    expect(input.qualification).toEqual(before.qualification);
    delete input.contacts[1].suppressionMatches;
    result = deriveImportReadiness(input);
    expect(result.counts).toEqual({ ready: 2, needsReview: 0, excluded: 0 });
    input.qualification!.rows.pop();
    expect(deriveImportReadiness(input).rows.every((row) => row.status === 'needs_review')).toBe(true);
  });

  it('does not mark rows ready until saved suppression rules load', () => {
    for (const suppressionState of ['loading', 'error'] as const) {
      const input = { ...fixture(), suppressionState };
      expect(deriveImportReadiness(input).counts.ready).toBe(0);
      expect(codes(input)).toContain(suppressionState === 'loading' ? 'suppressions_loading' : 'suppressions_load_error');
    }
  });
});


describe('combined import qualification review', () => {
  function combinedFixture() {
    const row: LiveContactState = { ...contact(), importObject: 'contact_company',
      company: 'Unrelated contact context', website: 'https://contact-context.test/',
      associatedCompany: { recordId: null, name: 'Example CRM', website: 'https://example.test/', phone: '', state: '' } };
    const input = fixture([row]);
    input.qualification!.rows[0].inputs = { company: 'Example CRM', website: 'https://example.test/', email: row.rawEmail };
    return input;
  }

  it('uses associated-company observations and preserves the local-only hold even when every check passes', () => {
    const input = combinedFixture();
    expect(deriveImportReadiness(input)).toMatchObject({ counts: { ready: 0, needsReview: 1, excluded: 0 },
      rows: [{ company: 'Example CRM', status: 'needs_review', reasons: [{ code: 'local_object_review_only' }] }] });
    input.contacts[0].company = 'Another unrelated context';
    input.contacts[0].website = 'https://another-contact-context.test/';
    input.contacts[0].associatedCompany!.recordId = 'new-association-id';
    expect(codes(input)).toEqual(['local_object_review_only']);
    input.websiteChecks[0].url = 'https://another-contact-context.test/';
    expect(codes(input)).toEqual(['local_object_review_only', 'website_not_checked']);
  });

  it('shows negative Pomade results, missing mapped fields and stale associated inputs alongside the local-only hold', () => {
    const input = combinedFixture();
    Object.assign(input.qualification!.rows[0], { identity: check('Mismatch'), icp: check('Not a fit'), email: check('invalid') });
    expect(codes(input)).toEqual(['local_object_review_only', 'identity_needs_review', 'icp_needs_review', 'email_needs_review']);
    input.contacts[0].associatedCompany!.name = '';
    input.contacts[0].associatedCompany!.website = '';
    input.contacts[0].rawEmail = '';
    input.contacts[0].normalizedEmail = null;
    expect(deriveImportReadiness(input).rows[0].company).toBe('');
    expect(codes(input)).toEqual(['local_object_review_only', 'missing_company', 'missing_email', 'missing_website', 'qualification_stale']);
  });
});
