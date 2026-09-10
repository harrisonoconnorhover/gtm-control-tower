import { describe, expect, it } from 'vitest';
import { createInboundLab, defaultLabSettings, labMetrics, labScenarios, retryInbound, runSyntheticBatch, submitInbound, syntheticInboundBatch, toWpFormsPayload } from '../lib/inbound-lab';

const preset = (id: string) => structuredClone(labScenarios.find(item => item.id === id)!);
const latest = (state: ReturnType<typeof createInboundLab>) => state.runs.at(-1)!;

describe('inbound routing practice', () => {
  it('maps the observed WPForms fields, normalizes identity, and accepts an omitted phone', () => {
    const initial = createInboundLab();
    const row = preset('existing');
    row.input.email = ' ELENA.FOSTER@CEDARLOOM.EXAMPLE ';
    row.input.firstName = ' Elena ';
    row.input.phone = '';
    expect(toWpFormsPayload(row.input)).toEqual({
      'wpforms[fields][10]': ' Elena ', 'wpforms[fields][11]': 'Foster',
      'wpforms[fields][3]': row.input.email, 'wpforms[fields][4]': '', 'wpforms[fields][5]': 'Cedar & Loom',
    });
    const next = submitInbound(initial, row.input, row.context);
    expect(next.leads[0]).toMatchObject({ firstName: 'Elena', email: 'elena.foster@cedarloom.example', ownerId: 'rep-ava', accountId: 'acct-cedar', phone: '' });
    expect(latest(next).status).toBe('routed');
    expect(initial.leads).toEqual([]);
    expect(initial.reps[0].assigned).toBe(3);
  });

  it('preserves account ownership even at capacity and routes new prospects by region, budget, and utilization', () => {
    const initial = createInboundLab();
    initial.reps[0].assigned = initial.reps[0].capacity;
    const existing = preset('existing');
    let state = submitInbound(initial, existing.input, existing.context);
    expect(latest(state).ownerId).toBe('rep-ava');
    const growth = preset('new');
    state = submitInbound(state, growth.input, growth.context);
    expect(latest(state).ownerId).toBe('rep-jordan');
    const enterprise = preset('enterprise');
    state = submitInbound(state, enterprise.input, enterprise.context);
    expect(latest(state).ownerId).toBe('rep-luca');
    const fresh = createInboundLab();
    for (const rep of fresh.reps) rep.assigned = rep.capacity;
    expect(latest(submitInbound(fresh, growth.input, growth.context))).toMatchObject({ status: 'held', leadId: null });
  });

  it('holds conflicting identity, missing enrichment, invalid email, and an unavailable existing owner before a CRM write', () => {
    for (const id of ['conflict', 'missing', 'invalid', 'unavailable']) {
      const row = preset(id);
      const state = submitInbound(createInboundLab(), row.input, row.context);
      expect(latest(state).status, id).toBe('held');
      expect(state.leads, id).toHaveLength(0);
    }
    const row = preset('unavailable');
    let state = submitInbound(createInboundLab(), row.input, row.context);
    state.reps.find(rep => rep.id === 'rep-sam')!.active = true;
    state = retryInbound(state, latest(state).id);
    expect(latest(state)).toMatchObject({ status: 'routed', ownerId: 'rep-sam' });
  });

  it('reuses a contact across separate requests without repeating assignment or notification', () => {
    const row = preset('existing');
    const first = submitInbound(createInboundLab(), row.input, row.context);
    const second = submitInbound(first, { ...row.input, email: row.input.email.toUpperCase() }, { ...row.context, source: 'webinar' });
    expect(second.runs).toHaveLength(2);
    expect(second.leads).toHaveLength(1);
    expect(second.leads[0].source).toBe('paid-search');
    expect(second.reps).toEqual(first.reps);
    expect(labMetrics(second).notifications).toBe(1);
    expect(retryInbound(second, latest(second).id)).toEqual(second);
  });

  it.each(['before-write', 'after-write'] as const)('recovers a %s CRM failure without creating a duplicate', fault => {
    const row = preset('new');
    const initial = createInboundLab();
    initial.settings.crmFault = fault;
    let state = submitInbound(initial, row.input, row.context);
    expect(latest(state).status).toBe('failed');
    expect(state.leads).toHaveLength(fault === 'after-write' ? 1 : 0);
    expect(state.reps).toEqual(initial.reps);
    state.settings.crmFault = 'none';
    state = retryInbound(state, latest(state).id);
    expect(latest(state).status).toBe('routed');
    expect(latest(state).attempts).toHaveLength(2);
    expect(state.leads).toHaveLength(1);
    expect(state.leads[0]).toMatchObject({ ownerId: 'rep-ava', notified: true });
    expect(state.reps[0].assigned).toBe(initial.reps[0].assigned + 1);
  });

  it('retries a failed notification while preserving the completed CRM assignment', () => {
    const row = preset('new');
    const initial = createInboundLab();
    initial.settings.notificationFault = true;
    let state = submitInbound(initial, row.input, row.context);
    expect(latest(state)).toMatchObject({ status: 'failed', ownerId: 'rep-ava' });
    expect(state.leads[0]).toMatchObject({ ownerId: 'rep-ava', notified: false });
    const repsAfterAssignment = structuredClone(state.reps);
    state.settings.notificationFault = false;
    state = retryInbound(state, latest(state).id);
    expect(latest(state).status).toBe('routed');
    expect(state.reps).toEqual(repsAfterAssignment);
    expect(state.leads).toHaveLength(1);
    expect(labMetrics(state).notifications).toBe(1);
  });

  it('diagnoses a broken mapping and retains original inputs when enrichment is corrected', () => {
    const row = preset('missing');
    const initial = createInboundLab();
    initial.settings.emailMapping = 'broken';
    let state = submitInbound(initial, row.input, row.context);
    expect(latest(state).reason).toContain('field 8');
    state.settings = { ...defaultLabSettings };
    state = retryInbound(state, latest(state).id);
    expect(latest(state).reason).toContain('Region is missing');
    state = retryInbound(state, latest(state).id, { input: row.input, context: { ...row.context, region: 'East' } });
    expect(latest(state).status).toBe('routed');
    expect(latest(state).attempts).toHaveLength(3);
    expect(latest(state).attempts[0].context.region).toBe('');
    expect(latest(state).attempts[2].context.region).toBe('East');
    expect(state.leads).toHaveLength(1);
  });

  it('refuses to change identity after a partial CRM write', () => {
    const row = preset('new');
    const initial = createInboundLab();
    initial.settings.crmFault = 'after-write';
    const failed = submitInbound(initial, row.input, row.context);
    failed.settings.crmFault = 'none';
    const corrected = retryInbound(failed, latest(failed).id, { input: { ...row.input, email: 'another@northstarfitness.example' }, context: row.context });
    expect(corrected.leads).toEqual(failed.leads);
    expect(latest(corrected).reason).toContain('original email');
    expect(latest(corrected).attempts).toHaveLength(1);
  });

  it('provides a reproducible 32-request fictional batch and safely repeats the batch', () => {
    const batch = syntheticInboundBatch();
    expect(batch).toHaveLength(32);
    expect(batch.every(row => row.input.email.endsWith('.example'))).toBe(true);
    expect(batch.every(row => /555-01\d{2}$/.test(row.input.phone))).toBe(true);
    const first = runSyntheticBatch(createInboundLab());
    expect(labMetrics(first)).toEqual({ requests: 32, routed: 28, held: 4, failed: 0, leads: 27, notifications: 27 });
    const second = runSyntheticBatch(first);
    expect(second.runs).toHaveLength(64);
    expect(second.leads).toEqual(first.leads);
    expect(second.reps).toEqual(first.reps);
    expect(runSyntheticBatch(createInboundLab())).toEqual(first);
  });
});
