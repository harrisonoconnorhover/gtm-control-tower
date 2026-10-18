import { describe, expect, it } from 'vitest';
import { evaluateCrmCohort, parseCrmCohortDefinition } from '../lib/crm-cohort';
import { FICTIONAL_COHORT_TIME, fictionalCrmCohort } from '../lib/crm-cohort-fixture';

function oneContact() { const fixture = fictionalCrmCohort(); return { ...fixture, contacts: [fixture.contacts[0]] }; }

describe('CRM cohort eligibility', () => {
  it('deduplicates native IDs retaining lost deals and holds distinct IDs with the same email', () => {
    const fixture = fictionalCrmCohort();
    const result = evaluateCrmCohort(fixture.definition, fixture.contacts);
    expect(result.contacts).toHaveLength(7);
    expect(result.contacts[0].dealIds).toEqual(['deal-101', 'deal-101-b']);
    expect(result.contacts[0].assessments).toMatchObject({ state: 'ready_for_review', fit: 'meets', timing: 'eligible', emailVerification: 'unverified' });
    expect(result.contacts.filter((row) => ['104', '105'].includes(row.contactId)).map((row) => row.assessments.state)).toEqual(['held', 'held']);
    expect(result.contacts.find((row) => row.contactId === '103')!.assessments.state).toBe('excluded');
  });

  it('includes exactly 90 elapsed days; excludes recent dates and holds missing, future or unconfirmed dates', () => {
    const fixture = oneContact();
    const evaluate = () => evaluateCrmCohort(fixture.definition, fixture.contacts).contacts[0].assessments;
    expect(evaluate().state).toBe('ready_for_review');
    fixture.contacts[0].properties.last_meaningful_contact = new Date(Date.parse(FICTIONAL_COHORT_TIME) - 89 * 86_400_000).toISOString();
    expect(evaluate()).toMatchObject({ timing: 'not_yet', state: 'excluded' });
    for (const date of [null, 'bad date', '2027-01-01T00:00:00.000Z']) {
      fixture.contacts[0].properties.last_meaningful_contact = date;
      fixture.contacts[0].properties.lastmodifieddate = '2026-01-01T00:00:00.000Z';
      expect(evaluate()).toMatchObject({ timing: 'unknown', state: 'held' });
    }
    fixture.definition.inactivity.confirmed = false;
    expect(evaluate().reasons.join(' ')).toContain('has not been confirmed');
  });

  it('keeps missing evidence fields requestable without treating proposals as approved facts', () => {
    const fixture = oneContact();
    expect(evaluateCrmCohort(fixture.definition, fixture.contacts).contacts[0].requestedFields).toEqual(['jobTitle']);
    fixture.contacts[0].existingValues.jobTitle = 'Populated by the owner';
    expect(evaluateCrmCohort(fixture.definition, fixture.contacts).contacts[0].requestedFields).toEqual([]);
  });

  it('uses exact pipeline/stage/date rules and active deal exclusions', () => {
    const fixture = oneContact();
    fixture.contacts[0].deals[0].properties.pipeline = 'unrelated';
    expect(evaluateCrmCohort(fixture.definition, fixture.contacts).contacts[0].assessments.state).toBe('excluded');
    fixture.contacts[0].deals[0].properties.pipeline = 'sales';
    fixture.contacts[0].deals[0].properties.closedate = '2025-12-31T23:59:59.999Z';
    expect(evaluateCrmCohort(fixture.definition, fixture.contacts).contacts[0].assessments.state).toBe('excluded');
    fixture.contacts[0].deals[0].properties.closedate = '2026-01-01T00:00:00.000Z';
    fixture.contacts[0].deals.push({ dealId: 'active-deal', properties: { pipeline: 'sales', dealstage: 'active' } });
    expect(evaluateCrmCohort(fixture.definition, fixture.contacts).contacts[0].assessments.reasons.join(' ')).toContain('configured active');
  });

  it('holds incomplete coverage, unknown suppression and future promised follow-ups', () => {
    const fixture = oneContact();
    fixture.contacts[0].properties.do_not_contact = null;
    fixture.contacts[0].properties.next_follow_up = '2026-12-01T00:00:00.000Z';
    fixture.contacts[0].coverage = { complete: false, missing: ['Deal association read failed'], omittedSourceIds: [] };
    const row = evaluateCrmCohort(fixture.definition, fixture.contacts).contacts[0];
    expect(row.assessments).toMatchObject({ state: 'held', timing: 'not_yet' });
    expect(row.assessments.reasons.join(' ')).toMatch(/do_not_contact is unknown/);
    expect(row.assessments.reasons.join(' ')).toMatch(/coverage is incomplete/);
  });

  it('keeps fit, timing and dated verification independent', () => {
    const fixture = oneContact();
    const row = fixture.contacts[0];
    row.properties.verification_status = 'valid';
    row.properties.verified_email = row.existingValues.email;
    row.properties.verification_date = FICTIONAL_COHORT_TIME;
    expect(evaluateCrmCohort(fixture.definition, fixture.contacts).contacts[0].assessments.emailVerification).toBe('verified');
    row.properties.verified_email = 'other@northstar.example';
    expect(evaluateCrmCohort(fixture.definition, fixture.contacts).contacts[0].assessments.emailVerification).toBe('unverified');
    row.properties.verified_email = row.existingValues.email;
    row.properties.verification_date = '2026-01-01T00:00:00.000Z';
    row.properties.segment = 'enterprise';
    expect(evaluateCrmCohort(fixture.definition, fixture.contacts).contacts[0].assessments).toMatchObject({ fit: 'does_not_meet', timing: 'eligible', emailVerification: 'unverified', state: 'excluded' });
  });

  it('rejects conflicting stage meanings and invalid configuration', () => {
    const fixture = oneContact();
    fixture.definition.activeStageIds.push('lost');
    expect(() => parseCrmCohortDefinition(fixture.definition)).toThrow('distinct');
    fixture.definition.activeStageIds = ['active'];
    fixture.definition.inactivity.days = 0;
    expect(() => parseCrmCohortDefinition(fixture.definition)).toThrow('threshold');
  });
});
