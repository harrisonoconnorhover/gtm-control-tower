import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureMonitor, getMonitorOverview, tickMonitor, triageMonitorFinding } from '../lib/monitor';
import { claimMonitorRepair, claimMonitorTick, getContactFindings, getPendingMonitorRepairs, getMonitorAccount, releaseMonitorTick } from '../lib/monitor-store';
import type { MonitorContact } from '../lib/monitor-types';
import type { MonitorSource } from '../lib/monitor-hubspot';
import { inspectMonitorContact } from '../lib/monitor-rules';
import { getDatabase } from '../db';

const directory = mkdtempSync(join(tmpdir(), 'gtm-monitor-'));
process.env.CONTROL_TOWER_SQLITE_PATH = join(directory, 'monitor.db');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function contact(id: string, properties: Record<string, string> = {}): MonitorContact {
  return { id, updatedAt: new Date(Date.now() - 600_000).toISOString(), properties: {
    email: `contact${id}@example.com`, firstname: 'Test', lastname: id, company: 'Acme', jobtitle: 'Engineer',
    hubspot_owner_id: '42', lifecyclestage: 'lead', lastmodifieddate: '', ...properties,
  } };
}
function fixture(contacts: MonitorContact[]): MonitorSource & { patch: ReturnType<typeof vi.fn> } {
  const records = new Map(contacts.map((item) => [item.id, structuredClone(item)]));
  return {
    list: vi.fn(async () => ({ contacts: [...records.values()].map((item) => structuredClone(item)), after: null })),
    changes: vi.fn(async () => ({ contacts: [...records.values()].map((item) => structuredClone(item)), after: null, total: records.size })),
    read: vi.fn(async (id: string) => structuredClone(records.get(id)!)),
    patch: vi.fn(async (id: string, properties: Record<string, string>) => {
      const current = records.get(id)!;
      records.set(id, { ...current, updatedAt: new Date(Date.parse(current.updatedAt) + 1000).toISOString(), properties: { ...current.properties, ...properties } });
    }),
  };
}
async function enable(accountId: string, automaticRepairs = false) {
  return configureMonitor(accountId, { enabled: true, automaticRepairs, intervalSeconds: 300, defaultAssignee: 'RevOps' });
}

describe('monitor rules', () => {
  it('reports conservative identity, owner, lifecycle and formatting anomalies without inferring custom stages', () => {
    const initial = inspectMonitorContact(contact('1', { lifecyclestage: 'customer' }), null);
    const later = inspectMonitorContact(contact('1', { email: 'bad email', hubspot_owner_id: '', lifecyclestage: 'salesqualifiedlead', company: ' Acme ' }), initial.snapshot);
    expect(later.issues.map((issue) => issue.rule)).toEqual(['email_invalid', 'owner_missing', 'lifecycle_regression', 'text_whitespace']);
    expect(inspectMonitorContact(later.snapshot.contact, later.snapshot).issues.some((issue) => issue.rule === 'lifecycle_regression')).toBe(true);
    const custom = inspectMonitorContact(contact('1', { lifecyclestage: 'custom-stage' }), initial.snapshot);
    expect(custom.issues).toEqual([]);
    expect(inspectMonitorContact(contact('1'), custom.snapshot).issues).toEqual([]);
    expect(inspectMonitorContact(contact('2', { email: '' }), null).issues[0].rule).toBe('email_missing');
  });
});

describe('durable HubSpot monitor', () => {
  it('starts disabled, force does not enable it, and account settings are isolated', async () => {
    const source = fixture([contact('1')]);
    const untouched = await tickMonitor('disabled', 'fixture', { force: true, source });
    expect(untouched.config).toMatchObject({ enabled: false, automaticRepairs: false, intervalSeconds: 300 });
    expect(source.list).not.toHaveBeenCalled();
    await enable('enabled-account');
    expect((await getMonitorOverview('disabled')).config.enabled).toBe(false);
  });

  it('deduplicates findings, retains human ownership, reopens persistent defects and resolves corrected values', async () => {
    await enable('triage');
    const source = fixture([contact('1', { email: '' })]);
    let report = await tickMonitor('triage', 'fixture', { force: true, source });
    const id = report.findings[0].id;
    await triageMonitorFinding('triage', { id, status: 'resolved', assignee: 'Harrison', note: 'Check source feed' });
    report = await tickMonitor('triage', 'fixture', { force: true, source });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ id, status: 'open', assignee: 'Harrison', note: 'Check source feed', occurrences: 2 });
    await expect(triageMonitorFinding('different-account', { id, status: 'resolved', assignee: '', note: '' })).rejects.toThrow('not found');
    source.changes = async () => ({ contacts: [contact('1')], after: null, total: 1 });
    report = await tickMonitor('triage', 'fixture', { force: true, source });
    expect(report.findings[0].status).toBe('resolved');
    expect(source.patch).not.toHaveBeenCalled();
  });

  it('drains at most five repairs per tick, including saved findings after opt-in', async () => {
    await enable('repair-queue');
    const source = fixture(Array.from({ length: 7 }, (_, index) => contact(String(index + 1), { company: ' Acme ', jobtitle: ' Engineer ' })));
    let report = await tickMonitor('repair-queue', 'fixture', { force: true, source });
    expect(report.totals.open).toBe(7);
    expect(source.patch).not.toHaveBeenCalled();
    // No new source changes: repair opt-in still drains the saved queue.
    source.changes = async () => ({ contacts: [], after: null, total: 0 });
    await enable('repair-queue', true);
    report = await tickMonitor('repair-queue', 'fixture', { force: true, source });
    expect(report.totals).toMatchObject({ fixed: 5, open: 2 });
    expect(source.patch).toHaveBeenCalledTimes(5);
    report = await tickMonitor('repair-queue', 'fixture', { force: true, source });
    expect(report.totals).toMatchObject({ fixed: 7, open: 0 });
    expect(source.patch).toHaveBeenCalledTimes(7);
    for (const call of source.patch.mock.calls) expect(call[1]).toEqual({ company: 'Acme', jobtitle: 'Engineer' });
    const db = await getDatabase();
    const repair = await db.prepare('SELECT before_json, after_json, state FROM monitor_repairs WHERE account_id = ? LIMIT 1').bind('repair-queue')
      .first<{ before_json: string; after_json: string; state: string }>();
    expect(repair).toEqual({ before_json: JSON.stringify({ company: ' Acme ', jobtitle: ' Engineer ' }), after_json: JSON.stringify({ company: 'Acme', jobtitle: 'Engineer' }), state: 'verified' });
  });

  it('rejects stale observations, emptying a field, malformed email, and human in-progress work', async () => {
    await enable('holds');
    const contacts = [contact('1', { company: ' Acme ' }), contact('2', { company: '  ' }), contact('3', { company: ' Acme ', email: 'bad' }), contact('4', { company: ' Acme ' })];
    const source = fixture(contacts);
    let report = await tickMonitor('holds', 'fixture', { force: true, source });
    const human = report.findings.find((finding) => finding.contactId === '4')!;
    await triageMonitorFinding('holds', { id: human.id, status: 'in_progress', assignee: 'Human', note: '' });
    const read = source.read;
    source.read = async (id) => id === '1' ? { ...await read(id), updatedAt: new Date().toISOString() } : read(id);
    source.changes = async () => ({ contacts: [], after: null, total: 0 });
    await enable('holds', true);
    report = await tickMonitor('holds', 'fixture', { force: true, source });
    expect(source.patch).not.toHaveBeenCalled();
    expect(report.findings.find((finding) => finding.contactId === '1')?.repairError).toContain('changed after detection');
    expect(report.findings.find((finding) => finding.contactId === '4')?.status).toBe('in_progress');
    expect(await getPendingMonitorRepairs('holds')).toEqual([]);
    expect(Date.parse(report.nextCheckAt!) - Date.now()).toBeGreaterThan(290_000);
  });

  it('never replays a lost PATCH response, including after human status changes', async () => {
    await enable('unknown', true);
    const source = fixture([contact('1', { company: ' Acme ' })]);
    source.patch.mockRejectedValue(new Error('Fixture lost response'));
    let report = await tickMonitor('unknown', 'fixture', { force: true, source });
    expect(report.findings[0]).toMatchObject({ status: 'unknown', before: { company: ' Acme ' }, after: { company: 'Acme' } });
    await triageMonitorFinding('unknown', { id: report.findings[0].id, status: 'open', assignee: 'Human', note: 'Investigating' });
    report = await tickMonitor('unknown', 'fixture', { force: true, source });
    expect(source.patch).toHaveBeenCalledTimes(1);
    expect(report.findings[0].repairError).toContain('will not be replayed');
  });

  it('requires matching native readback before recording a repair as fixed', async () => {
    await enable('unverified', true);
    const source = fixture([contact('1', { company: ' Acme ' })]);
    source.patch.mockResolvedValue(undefined); // accepted response but native state did not change
    const report = await tickMonitor('unverified', 'fixture', { force: true, source });
    expect(report.totals).toMatchObject({ fixed: 0, unknown: 1 });
    expect(report.findings[0].repairError).toContain('readback did not match');
    await tickMonitor('unverified', 'fixture', { force: true, source });
    expect(source.patch).toHaveBeenCalledTimes(1);
  });

  it('preserves page checkpoints on failure and excludes simultaneous workers', async () => {
    await enable('paging');
    const source = fixture([]);
    source.list = async (after) => {
      if (after) throw new Error('Fixture page unavailable');
      return { contacts: [contact('1')], after: 'next-page' };
    };
    await tickMonitor('paging', 'fixture', { force: true, source });
    const report = await tickMonitor('paging', 'fixture', { force: true, source });
    expect(report.runs[0].status).toBe('failed');
    expect((await getMonitorAccount('paging')).cursor).toBe('next-page');

    await enable('concurrent');
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const one = fixture([]);
    one.list = vi.fn(async () => { entered(); await gate; return { contacts: [], after: null }; });
    const pending = tickMonitor('concurrent', 'fixture', { force: true, source: one });
    await inside;
    await tickMonitor('concurrent', 'fixture', { force: true, source: one });
    expect(one.list).toHaveBeenCalledTimes(1);
    release();
    await pending;
  });

  it('recovers expired sending claims as unknown and fences the old worker', async () => {
    await enable('restart');
    const source = fixture([contact('1', { company: ' Acme ' })]);
    await tickMonitor('restart', 'fixture', { force: true, source });
    await enable('restart', true);
    const claimed = await claimMonitorTick('restart', true);
    const finding = (await getContactFindings('restart', '1'))[0];
    const repairId = await claimMonitorRepair('restart', claimed!.lease_id!, finding);
    expect(repairId).toBeTruthy();
    const db = await getDatabase();
    await db.prepare('UPDATE monitor_accounts SET lease_expires_at = ? WHERE account_id = ?').bind('2000-01-01T00:00:00.000Z', 'restart').run();
    const report = await tickMonitor('restart', 'fixture', { force: true, source });
    expect(report.findings[0].status).toBe('unknown');
    expect(source.patch).not.toHaveBeenCalled();
    expect(await claimMonitorRepair('restart', claimed!.lease_id!, finding)).toBeNull();
    await releaseMonitorTick('restart', claimed!.lease_id!);
  });

  it('falls back at the search cap without advancing the watermark', async () => {
    await enable('search-cap');
    const source = fixture([contact('1')]);
    const baseline = await tickMonitor('search-cap', 'fixture', { force: true, source });
    source.changes = async () => ({ contacts: [contact('2')], after: '2', total: 10_000 });
    const report = await tickMonitor('search-cap', 'fixture', { force: true, source });
    expect(report.phase).toBe('baseline');
    expect(report.watermark).toBe(baseline.watermark);
    expect(report.runs[0]).toMatchObject({ status: 'failed', scanned: 0 });
    expect(report.runs[0].error).toContain('10,000');
    expect((await getMonitorAccount('search-cap')).cursor).toBeNull();
  });
});

function salesforceContact(type: 'Lead' | 'Contact', overrides: Record<string, string> = {}): MonitorContact {
  return { id: `${type === 'Lead' ? '00Q' : '003'}000000000001`, provider: 'salesforce', objectType: type,
    updatedAt: new Date(Date.now() - 600_000).toISOString(), properties: {
      email: 'fixture@example.com', firstname: 'Fictional', lastname: 'Person', jobtitle: ' Engineer ', owner_id: '005000000000001',
      ...(type === 'Lead' ? { company: ' Acme ', status: 'Custom status', is_converted: 'false' } : { account_id: '001000000000001' }), ...overrides,
    } };
}
function salesforceFixture(records: MonitorContact[], org: string) {
  return { ...fixture(records), provider: 'salesforce' as const, accountId: org };
}

describe('durable Salesforce Monitor', () => {
  it('uses Salesforce field semantics without applying HubSpot stage ordering or Account name repairs', () => {
    const record = salesforceContact('Contact', { company: ' Linked Account ', lifecyclestage: 'customer', hubspot_owner_id: '' });
    const previous = { contact: record, lifecycleHighWater: 'customer' };
    const inspected = inspectMonitorContact({ ...record, properties: { ...record.properties, lifecyclestage: 'lead' } }, previous);
    expect(inspected.issues.map((issue) => issue.rule)).toEqual(['text_whitespace']);
    expect(inspected.issues[0].after).toEqual({ jobtitle: 'Engineer' });
    expect(inspected.snapshot.lifecycleHighWater).toBeNull();
  });

  it('keeps provider/org/object scopes isolated and repairs each object through the narrow adapter contract', async () => {
    const org = '00D000000000101';
    const scope = `salesforce_${org}`;
    await enable(scope, true);
    const source = salesforceFixture([salesforceContact('Lead'), salesforceContact('Contact')], org);
    const report = await tickMonitor(scope, '', { source, force: true });
    expect(report).toMatchObject({ provider: 'salesforce', accountId: org, totals: { fixed: 2 }, objectTypes: ['Lead', 'Contact'] });
    expect(report.findings.map((finding) => finding.objectType).sort()).toEqual(['Contact', 'Lead']);
    expect(source.patch.mock.calls).toContainEqual(['00Q000000000001', { company: 'Acme', jobtitle: 'Engineer' }, 'Lead']);
    expect(source.patch.mock.calls).toContainEqual(['003000000000001', { jobtitle: 'Engineer' }, 'Contact']);
    expect((await getMonitorOverview(org)).findings).toEqual([]);
    await expect(triageMonitorFinding(`salesforce_00D000000000102`, { id: report.findings[0].id, status: 'resolved', assignee: 'Human', note: '' })).rejects.toThrow('not found');
    const db = await getDatabase();
    const saved = await db.prepare('SELECT contact_id FROM monitor_snapshots WHERE account_id = ? ORDER BY contact_id').bind(scope).all<{ contact_id: string }>();
    expect(saved.results.map((row) => row.contact_id)).toEqual(['Contact:003000000000001', 'Lead:00Q000000000001']);
  });

  it('rejects a source bound to another org or provider before listing records', async () => {
    const org = '00D000000000103';
    const scope = `salesforce_${org}`;
    await enable(scope, true);
    const wrongOrg = salesforceFixture([salesforceContact('Lead')], '00D000000000104');
    const report = await tickMonitor(scope, '', { source: wrongOrg, force: true });
    expect(report.runs[0]).toMatchObject({ status: 'failed', scanned: 0 });
    expect(wrongOrg.list).not.toHaveBeenCalled();
    const wrongProvider = fixture([contact('1')]);
    await tickMonitor(scope, '', { source: wrongProvider, force: true });
    expect(wrongProvider.list).not.toHaveBeenCalled();
  });

  it('holds converted or stale records before writes and never retries an unknown Salesforce outcome', async () => {
    const org = '00D000000000105';
    const scope = `salesforce_${org}`;
    await enable(scope, true);
    const source = salesforceFixture([salesforceContact('Lead'), salesforceContact('Contact')], org);
    const read = source.read;
    source.read = vi.fn(async (id: string) => {
      if (id.startsWith('00Q')) throw new Error('Salesforce returned a converted Lead.');
      return read(id);
    });
    source.patch.mockRejectedValue(new Error('Fictional lost PATCH response'));
    let report = await tickMonitor(scope, '', { source, force: true });
    expect(report.findings.find((finding) => finding.objectType === 'Lead')?.repairError).toContain('converted');
    expect(report.findings.find((finding) => finding.objectType === 'Contact')?.status).toBe('unknown');
    expect(source.patch).toHaveBeenCalledTimes(1);
    report = await tickMonitor(scope, '', { source, force: true });
    expect(source.patch).toHaveBeenCalledTimes(1);
    expect(report.totals.unknown).toBe(1);
  });
});

it('holds Salesforce readback when a protected owner or account field changes', async () => {
  const org = '00D000000000106';
  const scope = `salesforce_${org}`;
  await enable(scope, true);
  const source = salesforceFixture([salesforceContact('Contact')], org);
  const originalPatch = source.patch;
  source.patch = vi.fn(async (id, properties) => {
    await originalPatch(id, { ...properties, owner_id: '005000000000002' });
  });
  const report = await tickMonitor(scope, '', { source, force: true });
  expect(report.totals).toMatchObject({ unknown: 1, fixed: 0 });
  expect(report.findings[0].repairError).toContain('protected fields changed');
  await tickMonitor(scope, '', { source, force: true });
  expect(source.patch).toHaveBeenCalledTimes(1);
});
