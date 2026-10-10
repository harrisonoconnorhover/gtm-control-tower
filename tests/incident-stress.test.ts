import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMessyCrm, DATASET_VERSION, BASE_TIME } from '../fixtures/messy-crm.mjs';
import { configureMonitor, tickMonitor } from '../lib/monitor';
import { claimMonitorRepair, claimMonitorTick, getContactFindings, getMonitorAccount, getMonitorSnapshot, releaseMonitorTick } from '../lib/monitor-store';
import { configureIncidentPolicy, getIncidentPolicy, getIncident, listIncidents, incidentDatabase, getRepairControl, getIncidentCoverage, resumeIncidentRepairs, triageIncident, readIncidentEvidence } from '../lib/crm-incidents';
import { monitorAccountIdentity, monitorRecordKey, type MonitorContact, type MonitorObjectType, type MonitorProvider } from '../lib/monitor-types';
import type { MonitorSource } from '../lib/monitor-hubspot';

const directory = mkdtempSync(join(tmpdir(), 'incident-stress-'));
vi.stubEnv('CONTROL_TOWER_SQLITE_PATH', join(directory, 'stress.db'));
vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
for (const name of ['HUBSPOT_ACCESS_TOKEN', 'SALESFORCE_ACCESS_TOKEN', 'SALESFORCE_INSTANCE_URL', 'CONTROL_TOWER_SLACK_WEBHOOK_URL', 'CONTROL_TOWER_APP_URL', 'OPENAI_API_KEY']) vi.stubEnv(name, '');
const network = vi.fn(() => { throw new Error('Stress qualification forbids network access.'); });
const generatedAt = new Date().toISOString();
const began = performance.now();
type Label = { scenario: string; objectType: MonitorObjectType; recordId: string; detail: string; relatedRecordIds?: string[] };
type Event = { record: MonitorContact; scenario: string; observedAt: string; source: NonNullable<MonitorContact['source']> };
type World = { provider: MonitorProvider; scope: string; records: MonitorContact[]; contacts: MonitorContact[]; companies: MonitorContact[]; deals: MonitorContact[]; leads: MonitorContact[]; events: Event[]; expected: Label[] };
type Check = { name: string; passed: boolean; expected: unknown; actual: unknown };
type Result = { provider: MonitorProvider; scope: string; counts: Record<string, number>; checks: Check[]; incidents?: unknown; observations?: number; writes?: number; ticks?: number; coverage?: unknown; staticCoverage?: unknown; error?: string };
const results: Result[] = [];
const reportDirectory = process.env.CONTROL_TOWER_STRESS_REPORT_DIR;
const at = (minute: number) => new Date(Date.parse(BASE_TIME) + minute * 60_000).toISOString();
function setTime(minute: number) { vi.setSystemTime(new Date(at(minute))); }
function check(result: Result, name: string, actual: unknown, expected: unknown) {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  result.checks.push({ name, passed, expected, actual });
  expect.soft(actual, `${result.provider}: ${name}`).toEqual(expected);
}
function canonical(record: MonitorContact) { return monitorRecordKey(record); }
function fixtureSource(world: World, records = world.records, scope = world.scope) {
  const current = new Map(records.map(record => [canonical(record), structuredClone(record)]));
  const provider = world.provider;
  const accountId = monitorAccountIdentity(scope).accountId;
  let injected: MonitorContact[] | null = null;
  let fail = false;
  const calls = { ticks: 0, pages: [] as number[], writes: [] as { id: string; properties: Record<string, string>; objectType?: MonitorObjectType }[] };
  const find = (id: string, objectType?: MonitorObjectType) => [...current.values()].find(record => record.id === id && (!objectType || objectType === record.objectType))!;
  const page = (records: MonitorContact[], cursor: string | null) => {
    const offset = Number(cursor ?? 0), contacts = structuredClone(records.slice(offset, offset + 50));
    calls.pages.push(contacts.length);
    return { contacts, after: offset + 50 < records.length ? String(offset + 50) : null, total: records.length };
  };
  const source: MonitorSource = {
    provider, accountId,
    capabilities: async () => [...new Set(records.map(record => record.objectType!))].map(objectType => ({ objectType, status: 'available' as const,
      fields: [...new Set(records.filter(record => record.objectType === objectType).flatMap(record => Object.keys(record.properties)))], missingFields: [], detail: 'Fictional readable fixture object.' })),
    list: async cursor => { if (fail) throw new Error('Fictional expired connection'); return page([...current.values()], cursor); },
    changes: async (from, through, cursor) => {
      if (fail) throw new Error('Fictional expired connection');
      if (injected) { const records = injected; injected = null; return page(records, cursor); }
      return page([...current.values()].filter(record => record.updatedAt >= from && record.updatedAt <= through), cursor);
    },
    read: async (id, objectType) => structuredClone(find(id, objectType)),
    patch: async (id, properties, objectType) => {
      calls.writes.push({ id, properties: structuredClone(properties), objectType });
      const old = find(id, objectType);
      current.set(canonical(old), { ...old, updatedAt: new Date().toISOString(), properties: { ...old.properties, ...properties } });
    },
  };
  return { source, current, calls, inject: (records: MonitorContact[]) => { injected = records; }, fail: (value: boolean) => { fail = value; },
    async tick() {
      calls.ticks++;
      return tickMonitor(scope, 'fictional-token-never-sent', { force: true, source });
    },
    async drain() {
      for (let i = 0; i < 100; i++) {
        const report = await this.tick();
        if (report.runs[0]?.status === 'failed') throw new Error(report.runs[0].error ?? 'Fixture tick failed');
        if (!(await getMonitorAccount(scope)).cursor) return report;
      }
      throw new Error('Fixture cursor failed to finish in 100 pages.');
    },
  };
}
async function enable(scope: string, automaticRepairs = false) {
  await configureMonitor(scope, { enabled: true, automaticRepairs, intervalSeconds: 60, defaultAssignee: 'Fixture Operations' });
}
async function count(scope: string, table = 'crm_observations') {
  const db = await incidentDatabase();
  return (await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE account_id=?`).bind(scope).first<{ count: number }>())!.count;
}
async function incidentMembers(scope: string, kind: string, field?: string) {
  const incidents = (await listIncidents(scope, { limit: 200 })).filter(incident => incident.kind === kind && (!field || incident.field === field));
  return { incidents, keys: new Set((await Promise.all(incidents.map(incident => getIncident(scope, incident.id)))).flatMap(detail => detail?.records ?? [])) };
}
function labeledKeys(world: World, scenario: string) {
  return world.expected.filter(label => label.scenario === scenario).flatMap(label => [label.recordId, ...label.relatedRecordIds ?? []].map(id => canonical({ id, objectType: label.objectType, provider: world.provider } as MonitorContact)));
}

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.stubGlobal('fetch', network); });
afterAll(async () => {
  const artifact = { version: DATASET_VERSION, generatedAt, fictional: true, mode: 'Actual tickMonitor, incident storage/correlation, repair executor and SQLite; injected fictional provider, no native CRM requests.',
    elapsedMs: Math.round(performance.now() - began), totalRecords: results.reduce((sum, result) => sum + (result.counts.total ?? 0), 0),
    passed: results.every(result => !result.error && result.checks.every(check => check.passed)) && network.mock.calls.length === 0,
    networkCalls: network.mock.calls.length, policy: { minimumRecords: 10, clearingFraction: 0.05, disallowNegativeAmounts: true, requiredDealCompany: true },
    limitations: ['This run qualifies fictional provider behavior and local SQLite, not native accounts, hosted deployment, throughput or SLA.',
      'Duplicate/delayed polling observations are exercised here; signed webhook/CDC intake and native adapter mappings are covered by separate focused tests.',
      'No arbitrary merging, inferred email, relationship creation, amount restoration, lifecycle rewrite or company/deal write is authorized.',
      'Attribution metadata is fictional source evidence; no cause is inferred from correlation.',
      'The complete generated manifest, world snapshots and event stream are exported separately.'], results };
  if (reportDirectory) {
    mkdirSync(reportDirectory, { recursive: true });
    const db = await incidentDatabase();
    await db.prepare("UPDATE monitor_accounts SET config_json=json_set(config_json, '$.enabled', json('false'), '$.automaticRepairs', json('false'))").run();
    const savedAccounts = (await db.prepare('SELECT account_id FROM monitor_accounts ORDER BY account_id').all<{account_id:string}>()).results;
    await db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
    copyFileSync(join(directory, 'stress.db'), join(reportDirectory, 'fixture.db'));
    writeFileSync(join(reportDirectory, 'fixture-metadata.json'), JSON.stringify({ fictional: true, datasetVersion: DATASET_VERSION, generatedAt,
      database: 'fixture.db', monitoringPausedForInspection: true, source: 'tests/incident-stress.test.ts', accounts: savedAccounts.map(row => ({ ...monitorAccountIdentity(row.account_id), scope: row.account_id })) }, null, 2) + '\n');
    writeFileSync(join(reportDirectory, 'results.json'), JSON.stringify(artifact, null, 2) + '\n');
  }
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

describe('messy CRM qualification through the actual monitor worker', () => {
  for (const provider of ['hubspot', 'salesforce'] as const) it(`handles the full ${provider} world and its labeled event stream`, async () => {
    const world = generateMessyCrm(provider) as unknown as World;
    const result: Result = { provider, scope: world.scope, counts: { contacts: world.contacts.length, companies: world.companies.length, deals: world.deals.length, leads: world.leads.length, total: world.records.length }, checks: [] };
    results.push(result);
    try {
      setTime(3);
      const companyType = provider === 'hubspot' ? 'Company' : 'Account';
      const dealType = provider === 'hubspot' ? 'Deal' : 'Opportunity';
      await configureIncidentPolicy(world.scope, { ...await getIncidentPolicy(world.scope), minimumRecords: 10, clearingFraction: 0.05, disallowNegativeAmounts: true,
        relationships: [{ id: 'contact-company', objectType: 'Contact', field: 'company_id', targetType: companyType, required: true },
          { id: 'deal-company', objectType: dealType, field: 'company_id', targetType: companyType, required: true }] });
      await enable(world.scope);
      const fixture = fixtureSource(world);
      await fixture.drain();
      check(result, 'Complete baseline persists every object', await count(world.scope, 'crm_observed_records'), world.records.length);
      check(result, 'Baseline pages are bounded at 50', Math.max(...fixture.calls.pages), 50);
      check(result, 'Baseline completed before orphan conclusions', (await getMonitorAccount(world.scope)).phase, 'changes');
      // Re-observe after the completed target baseline, within the real five-minute overlap.
      setTime(4); await fixture.drain();
      const db = await incidentDatabase();
      const findings = (await db.prepare('SELECT contact_id,rule,status FROM monitor_findings WHERE account_id=?').bind(world.scope).all<{contact_id:string;rule:string;status:string}>()).results;
      const defectCases = [['missing_email', 'email_missing'], ['invalid_email', 'email_invalid'], ['safe_whitespace', 'text_whitespace'], ['unsafe_empty_trim', 'text_whitespace']] as const;
      for (const [scenario, rule] of defectCases) {
        const expected = labeledKeys(world, scenario);
        const observed = new Set(findings.filter(finding => finding.rule === rule).map(finding => finding.contact_id));
        check(result, `Detect all labeled ${scenario}`, expected.filter(key => !observed.has(key)), []);
      }
      for (const [scenario, kind, field] of [['duplicate_email_candidate', 'duplicate_candidate', undefined], ['duplicate_domain_candidate', 'duplicate_candidate', undefined],
        ['orphan_company', 'relationship', 'deal-company'], ['missing_company', 'relationship', 'deal-company'], ['invalid_amount', 'invalid_value', 'amount'], ['negative_amount_policy', 'invalid_value', 'amount'], ['invalid_close_date', 'invalid_value', 'close_date']] as const) {
        const actual = await incidentMembers(world.scope, kind, field);
        check(result, `Detect all labeled ${scenario}`, labeledKeys(world, scenario).filter(key => !actual.keys.has(key)), []);
      }
      const expectedStatic = new Set(world.expected.filter(label => label.scenario !== 'source_instruction_text').flatMap(label => [label.recordId, ...label.relatedRecordIds ?? []].map(id => canonical({ id, objectType: label.objectType, provider } as MonitorContact))));
      const staticIncidents = await listIncidents(world.scope, { limit: 200 });
      const staticMembers = (await Promise.all(staticIncidents.map(incident => getIncident(world.scope, incident.id)))).flatMap(detail => detail?.records ?? []);
      const actualStatic = new Set([...findings.map(finding => finding.contact_id), ...staticMembers]);
      check(result, 'No clean-control records receive static findings or incidents', [...actualStatic].filter(key => !expectedStatic.has(key)), []);
      check(result, 'No baseline blanks mistaken for a bulk clear', staticIncidents.filter(incident => incident.kind === 'mass_field_clearing').length, 0);
      check(result, 'No automatic CRM writes before opt-in', fixture.calls.writes.length, 0);
      result.staticCoverage = { labeledRecords: expectedStatic.size, actualAffected: actualStatic.size, cleanControls: world.records.length - expectedStatic.size,
        missing: [...expectedStatic].filter(key => !actualStatic.has(key)), falsePositives: [...actualStatic].filter(key => !expectedStatic.has(key)) };
      await enable(world.scope, true);
      setTime(5);
      for (let i = 0; i < 5; i++) await fixture.drain();
      check(result, 'Exactly the 24 supported whitespace repairs execute', fixture.calls.writes.length, 24);
      check(result, 'Repairs change only nonblank trimmed title on labeled contacts', fixture.calls.writes.every(write => labeledKeys(world, 'safe_whitespace').includes(canonical({ id: write.id, objectType: write.objectType, provider } as MonitorContact)) && Object.keys(write.properties).join() === 'jobtitle' && Boolean(write.properties.jobtitle.trim()) && write.properties.jobtitle === write.properties.jobtitle.trim()), true);
      check(result, 'Instruction-like source text stays unchanged', fixture.current.get(canonical(world.contacts[99]))?.properties.jobtitle, world.contacts[99].properties.jobtitle);
      const events = world.events.filter(event => ['bulk_field_clearing', 'company_bulk_clearing', 'deal_bulk_clearing', 'repeated_reversal', 'legitimate_bulk_update'].includes(event.scenario));
      for (const scenario of ['bulk_field_clearing', 'company_bulk_clearing', 'deal_bulk_clearing', 'repeated_reversal', 'legitimate_bulk_update']) {
        // Exact duplicate deliveries remain included in the contact-clear batch.
        const group = events.filter(event => event.scenario === scenario);
        const timestamps = [...new Set(group.map(event => event.record.updatedAt))].sort();
        for (const timestamp of timestamps) {
          for (const event of group.filter(event => event.record.updatedAt === timestamp)) fixture.current.set(canonical(event.record), { ...structuredClone(event.record), source: event.source });
          vi.setSystemTime(new Date(Date.parse(timestamp) + 3 * 60_000));
          await fixture.drain();
        }
        if (scenario.endsWith('clearing')) {
          const objectType = scenario === 'bulk_field_clearing' ? 'Contact' : scenario === 'company_bulk_clearing' ? companyType : dealType;
          const expected = scenario === 'bulk_field_clearing' ? 120 : scenario === 'company_bulk_clearing' ? 30 : 40;
          const incidents = (await listIncidents(world.scope)).filter(incident => incident.kind === 'mass_field_clearing' && incident.objectType === objectType);
          check(result, `Group ${scenario} into one incident`, incidents.length, 1);
          check(result, `Count every affected ${scenario} record`, incidents[0]?.affectedRecords ?? 0, expected);
          const beforeCount = await count(world.scope);
          const beforeNotifications = (await db.prepare('SELECT COUNT(*) AS count FROM operation_notification_outbox').first<{count:number}>())!.count;
          await fixture.drain();
          check(result, `Duplicate ${scenario} observations add no evidence`, await count(world.scope), beforeCount);
          check(result, `Duplicate ${scenario} observations add no notifications`, (await db.prepare('SELECT COUNT(*) AS count FROM operation_notification_outbox').first<{count:number}>())!.count, beforeNotifications);
        }
      }
      const reversal = (await listIncidents(world.scope)).filter(incident => incident.kind === 'value_reversal');
      check(result, 'Repeated reversals create one incident', reversal.length, 1);
      check(result, 'Repeated reversals pause this account repair capability', (await getRepairControl(world.scope)).paused, true);
      check(result, 'Legitimate bulk updates retain the intentional values', world.contacts.slice(450, 470).every(record => fixture.current.get(canonical(record))?.properties.jobtitle === 'Principal Analyst'), true);
      check(result, 'No extra clearing incident for legitimate bulk updates', (await listIncidents(world.scope)).filter(incident => incident.kind === 'mass_field_clearing').length, 3);
      const stale = world.events.find(event => event.scenario === 'out_of_order')!;
      const observations = await count(world.scope);
      fixture.inject([stale.record]); await fixture.drain();
      check(result, 'Delayed observation cannot overwrite a cleared latest value', (await getMonitorSnapshot(world.scope, canonical(stale.record)))?.contact.properties.jobtitle, '');
      check(result, 'Delayed observation creates no extra evidence', await count(world.scope), observations);
      const newlyDirty = structuredClone(world.contacts[549]); newlyDirty.updatedAt = at(145); newlyDirty.properties.jobtitle = ' Director ';
      fixture.current.set(canonical(newlyDirty), newlyDirty); setTime(148); await fixture.drain();
      check(result, 'A new eligible repair remains unsent while account repairs are paused', fixture.current.get(canonical(newlyDirty))?.properties.jobtitle, ' Director ');
      check(result, 'No company/deal/lead/identity updates are invented', fixture.calls.writes.length, 24);
      const firstClear = (await listIncidents(world.scope)).find(incident => incident.kind === 'mass_field_clearing')!;
      const detail = await getIncident(world.scope, firstClear.id);
      check(result, 'Investigation retains before/after evidence without claiming cause', Boolean(detail?.observations.some(observation => observation.changes.some(change => change.before && !change.after))), true);
      const version = (await getIncidentPolicy(world.scope)).version;
      await triageIncident(world.scope, { id: firstClear.id, status: 'resolved', assignee: 'Fixture Human', note: 'Fictional integration owner confirmed repair upstream.', resolution: 'broken_integration' });
      check(result, 'Structured resolution never silently edits policy', (await getIncidentPolicy(world.scope)).version, version);
      check(result, 'Resolved incident remains in source-linked investigation history', (await readIncidentEvidence(world.scope, firstClear.id))?.priorResolutions.some(resolution => resolution.id === firstClear.id), true);
      // A configured planned clear is saved as evidence without adding affected records to an existing incident.
      const planned = { ...await getIncidentPolicy(world.scope), plannedChanges: [{ id: 'known-import', objectType: 'Contact' as const, fields: ['jobtitle'], until: at(180), reason: 'Fictional approved import' }] };
      await configureIncidentPolicy(world.scope, planned);
      for (const record of world.contacts.slice(560, 580)) fixture.current.set(canonical(record), { ...structuredClone(record), updatedAt: at(150), properties: { ...record.properties, jobtitle: '' } });
      setTime(153); await fixture.drain();
      const contactClear = (await listIncidents(world.scope)).find(incident => incident.kind === 'mass_field_clearing' && incident.objectType === 'Contact');
      check(result, 'Planned clears preserve evidence without expanding the unexpected-clear incident', contactClear?.affectedRecords, 120);
      const suppressed = await db.prepare("SELECT COUNT(*) AS count FROM crm_observations WHERE account_id=? AND suppressed_json LIKE '%jobtitle%'").bind(world.scope).first<{count:number}>();
      check(result, 'Every planned clear keeps its suppressed field evidence', suppressed?.count, 20);
      const healthy = await getIncidentCoverage(world.scope);
      fixture.fail(true); setTime(154); await fixture.tick();
      check(result, 'Expired connection becomes degraded coverage', (await getIncidentCoverage(world.scope)).status, 'degraded');
      check(result, 'Coverage failure retains the last successful check', (await getIncidentCoverage(world.scope)).lastSuccessAt, healthy.lastSuccessAt);
      fixture.fail(false); setTime(155); await fixture.drain();
      check(result, 'A successful follow-up restores current connection coverage', (await getIncidentCoverage(world.scope)).status, 'healthy');
      setTime(180);
      check(result, 'Silent runner eventually reports stale coverage', (await getIncidentCoverage(world.scope)).status, 'stale');
      result.incidents = await listIncidents(world.scope, { limit: 200 }); result.observations = await count(world.scope); result.writes = fixture.calls.writes.length; result.ticks = fixture.calls.ticks; result.coverage = await getIncidentCoverage(world.scope);
      check(result, 'No unmocked network operation occurred', network.mock.calls.length, 0);
    } catch (error) { result.error = error instanceof Error ? error.message : String(error); throw error; }
  }, 90_000);

  for (const provider of ['hubspot', 'salesforce'] as const) it(`contains uncertain and recurring ${provider} repairs`, async () => {
    const world = generateMessyCrm(provider) as unknown as World;
    const scope = provider === 'hubspot' ? '4243' : 'salesforce_00D000000000043';
    const result: Result = { provider, scope, counts: { total: 0, supplementalContacts: 19 }, checks: [] };
    results.push(result);
    try {
      setTime(3);
      const records = world.contacts.slice(80, 86).map(record => ({ ...structuredClone(record), properties: { ...record.properties, jobtitle: ' Director ' } }));
      records[5].properties.jobtitle = '   ';
      const fixture = fixtureSource(world, records, scope);
      await enable(scope); await fixture.drain(); await enable(scope, true);
      const patch = fixture.source.patch, read = fixture.source.read;
      fixture.source.read = async (id, objectType) => {
        if (id === records[4].id) {
          const current = fixture.current.get(canonical(records[4]))!;
          fixture.current.set(canonical(current), { ...current, updatedAt: at(4), properties: { ...current.properties, jobtitle: 'Edited by a human' } });
        }
        return read(id, objectType);
      };
      fixture.source.patch = async (id, properties, objectType) => {
        if (id === records[2].id) { fixture.calls.writes.push({ id, properties: structuredClone(properties), objectType }); return; }
        await patch(id, properties, objectType);
        if (id === records[1].id) throw new Error('Fictional response lost after applied PATCH');
        if (id === records[3].id) {
          const current = fixture.current.get(canonical(records[3]))!;
          fixture.current.set(canonical(current), { ...current, properties: { ...current.properties, owner_id: 'Unexpected downstream owner' } });
        }
      };
      setTime(4); await fixture.drain();
      const findings = (await Promise.all(records.map(record => getContactFindings(scope, canonical(record))))).flat();
      check(result, 'Only one ordinary repair is verified', findings.filter(finding => finding.status === 'fixed').length, 1);
      check(result, 'Lost response, mismatched readback and protected changes stay unknown', findings.filter(finding => finding.status === 'unknown').length, 3);
      check(result, 'Concurrent human edit and empty trimming prevent writes', fixture.calls.writes.map(write => write.id).sort(), records.slice(0, 4).map(record => record.id).sort());
      setTime(8); await fixture.drain(); await fixture.drain();
      check(result, 'Uncertain attempts are never replayed on later ticks', fixture.calls.writes.length, 4);
      // Expire an actual durable repair claim before any fictional PATCH begins.
      const crashScope = provider === 'hubspot' ? '4244' : 'salesforce_00D000000000044';
      const crash = fixtureSource(world, [records[0]], crashScope);
      await enable(crashScope); await crash.drain(); await enable(crashScope, true);
      const claim = await claimMonitorTick(crashScope, true);
      const pending = (await getContactFindings(crashScope, canonical(records[0])))[0];
      const repairId = await claimMonitorRepair(crashScope, claim!.lease_id!, pending);
      check(result, 'Crash scenario starts from a durable sending claim', Boolean(repairId), true);
      setTime(13); const recovered = await crash.drain();
      check(result, 'Expired sending lease becomes unknown', recovered.findings[0]?.status, 'unknown');
      check(result, 'Expired sending lease is never resent', crash.calls.writes.length, 0);
      check(result, 'A stale worker cannot reclaim its repair', await claimMonitorRepair(crashScope, claim!.lease_id!, pending), null);
      await releaseMonitorTick(crashScope, claim!.lease_id!);
      // Prove the per-record budget stops an upstream system that repeatedly reintroduces spaces.
      const loopScope = provider === 'hubspot' ? '4245' : 'salesforce_00D000000000045';
      const loopRecord = { ...records[0], id: world.contacts[90].id };
      const loop = fixtureSource(world, [loopRecord], loopScope);
      await configureIncidentPolicy(loopScope, { ...await getIncidentPolicy(loopScope), repairsPerRecordPerDay: 2, reversalsBeforePause: 20 });
      await enable(loopScope, true); await loop.drain();
      for (const minute of [14, 18]) {
        loop.current.set(canonical(loopRecord), { ...structuredClone(loopRecord), updatedAt: at(minute) });
        setTime(minute + 3); await loop.drain();
      }
      check(result, 'Repeated upstream whitespace causes only two permitted repairs', loop.calls.writes.length, 2);
      check(result, 'Repair recurrence budget pauses this account', (await getRepairControl(loopScope)).paused, true);
      check(result, 'Budget pause creates an actionable incident', (await listIncidents(loopScope)).filter(incident => incident.kind === 'repair_pause').length, 1);
      await resumeIncidentRepairs(loopScope); await loop.drain();
      check(result, 'Resuming cannot erase already spent repair budget', loop.calls.writes.length, 2);
      // Competing ticks exercise the actual durable account claim, not a mocked detector lock.
      const concurrentScope = provider === 'hubspot' ? '4246' : 'salesforce_00D000000000046';
      const concurrent = fixtureSource(world, [records[0]], concurrentScope);
      await enable(concurrentScope, true);
      const originalList = concurrent.source.list;
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const list = vi.fn(async (cursor: string | null) => { entered(); await gate; return originalList(cursor); });
      concurrent.source.list = list;
      const first = concurrent.tick(); await started; await concurrent.tick(); release(); await first;
      check(result, 'Concurrent workers list each baseline page once', list.mock.calls.length, 1);
      check(result, 'Concurrent workers apply one repair only', concurrent.calls.writes.length, 1);
      const expectationScope = provider === 'hubspot' ? '4247' : 'salesforce_00D000000000047';
      const qualified = world.contacts.slice(100, 110).map(record => ({ ...structuredClone(record), properties: { ...record.properties, routing_status: 'new' } }));
      const expectation = fixtureSource(world, qualified, expectationScope);
      await configureIncidentPolicy(expectationScope, { ...await getIncidentPolicy(expectationScope),
        expectations: [{ id: 'routing-deadline', objectType: 'Contact', whenField: 'routing_status', whenValues: ['qualified'], requiredField: 'owner_id', deadlineMinutes: 5 }],
        activity: { enabled: true, minimumPreviousRecords: 5, quietMinutes: 5 } });
      setTime(23); await enable(expectationScope); await expectation.drain();
      for (const record of qualified) expectation.current.set(canonical(record), { ...record, updatedAt: at(24), properties: { ...record.properties, routing_status: 'qualified', owner_id: '', jobtitle: 'Senior Director' } });
      setTime(27); await expectation.drain();
      check(result, 'Configured routing grace period avoids premature escalation', (await listIncidents(expectationScope)).filter(incident => incident.kind === 'expectation').length, 0);
      setTime(34); await expectation.drain();
      const late = (await listIncidents(expectationScope)).find(incident => incident.kind === 'expectation');
      check(result, 'Unchanged qualified records miss a five-minute routing deadline', late?.affectedRecords, 10);
      check(result, 'A previously active population going quiet opens an investigation', (await listIncidents(expectationScope)).filter(incident => incident.kind === 'activity_drop').length, 1);
      const missing = structuredClone(expectation.current.get(canonical(qualified[0]))!); delete missing.properties.jobtitle; missing.updatedAt = at(35);
      expectation.current.set(canonical(missing), missing); setTime(38); await expectation.drain();
      check(result, 'An omitted readable field opens coverage investigation', (await listIncidents(expectationScope)).some(incident => incident.kind === 'coverage' && incident.field === 'fields'), true);
      check(result, 'An omitted title is never counted as a title clear', (await listIncidents(expectationScope)).filter(incident => incident.kind === 'mass_field_clearing' && incident.field === 'jobtitle').length, 0);
      check(result, 'The real prior owner clear retains separate evidence', (await listIncidents(expectationScope)).filter(incident => incident.kind === 'mass_field_clearing' && incident.field === 'owner_id').length, 1);
      check(result, 'Routing and coverage expectations cannot authorize owner or schema writes', expectation.calls.writes.length, 0);
      result.writes = fixture.calls.writes.length + crash.calls.writes.length + loop.calls.writes.length + concurrent.calls.writes.length;
      result.ticks = fixture.calls.ticks + crash.calls.ticks + loop.calls.ticks + concurrent.calls.ticks + expectation.calls.ticks;
      check(result, 'Safety scenarios perform no network operations', network.mock.calls.length, 0);
    } catch (error) { result.error = error instanceof Error ? error.message : String(error); throw error; }
  }, 30_000);

});
