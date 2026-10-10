import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { generateMessyCrm } from '../fixtures/messy-crm.mjs';

const key = (record) => `${record.objectType}:${record.nativeId ?? record.id}`;
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

/** Preserve native pagination and reads while giving this qualification no authority outside its manifest. */
export function createOwnedNativeSource(source, { records, verifyOwnership, onObservation = () => {}, onMutation = () => {}, repairPlans = new Map() }) {
  assert.equal(typeof verifyOwnership, 'function', 'Every native read/write needs an ownership verifier.');
  const owned = new Map(Object.values(records).filter((record) => record.nativeId).map((record) => [key(record), record]));
  const checked = new Set();
  const requireOwned = (id, objectType = 'Contact') => {
    const record = owned.get(`${objectType}:${id}`);
    assert(record, 'Native qualification rejected a record outside its manifest.');
    return record;
  };
  async function observe(record) {
    const owner = requireOwned(record.id, record.objectType);
    // First observation verifies the native marker independently of the monitor field selection.
    if (!checked.has(key(owner))) { await verifyOwnership(owner); checked.add(key(owner)); }
    onObservation(structuredClone(record), owner);
    return record;
  }
  async function page(method, args, after) {
    let cursor = after;
    const visited = new Set();
    for (let pages = 0; pages < 2000; pages++) {
      assert(!visited.has(cursor), 'Native qualification encountered a repeated page cursor.');
      visited.add(cursor);
      const result = await source[method](...args, cursor);
      const contacts = [];
      const selected = result.contacts.filter((record) => owned.has(key(record)));
      for (let start = 0; start < selected.length; start += 4) {
        contacts.push(...await Promise.all(selected.slice(start, start + 4).map(observe)));
      }
      if (contacts.length || result.after === null) return { ...result, contacts };
      cursor = result.after;
    }
    throw new Error('Native qualification exceeded its bounded scan; saved native cursor is unchanged.');
  }
  return {
    ...source,
    list: (after) => page('list', [], after),
    changes: (from, through, after) => page('changes', [from, through], after),
    async read(id, objectType = 'Contact') {
      const owner = requireOwned(id, objectType);
      await verifyOwnership(owner);
      return observe(await source.read(id, objectType));
    },
    async patch(id, properties, objectType = 'Contact') {
      const owner = requireOwned(id, objectType);
      const plan = repairPlans.get(key(owner));
      assert(plan, 'No independently recorded native whitespace repair exists for this record.');
      assert.deepEqual(properties, plan.after, 'The native repair differs from the observed, bounded trim.');
      const protectedBefore = await verifyOwnership(owner);
      const fresh = await source.read(id, objectType);
      for (const [field, value] of Object.entries(plan.before)) assert.equal(fresh.properties[field], value, 'Native repair baseline changed.');
      const mutation = { objectType, nativeId: id, properties: structuredClone(properties), sentAt: new Date().toISOString() };
      onMutation(mutation);
      await source.patch(id, properties, objectType);
      if (protectedBefore?.properties && typeof protectedBefore.properties === 'object') {
        const protectedAfter = await verifyOwnership(owner);
        assert(protectedAfter?.properties, 'Protected native readback was not available after sending the repair.');
        assert.equal(protectedBefore.id, id, 'Protected baseline identifies a different native record.');
        assert.equal(protectedAfter.id, id, 'Protected readback identifies a different native record.');
        const nativeChanges = Object.fromEntries(Object.entries(properties).map(([field, value]) => [source.provider === 'salesforce' ? ({ jobtitle: 'Title', company: 'Company' })[field] : field, value]));
        assert(!('undefined' in nativeChanges), 'Protected native readback encountered an unsupported repair field.');
        assert.deepEqual(protectedAfter.properties, { ...protectedBefore.properties, ...nativeChanges }, 'Protected native fields changed outside the approved whitespace repair. Outcome requires review.');
        mutation.protectedReadback = { verified: true, checkedFields: Object.keys(protectedBefore.properties).sort() };
      }
    },
  };
}

/** Real-account harness. Caller verifies test account, seeds marked records, and selects a NEW isolated SQLite path first. */
export async function runNativeMonitor(options) {
  const { root, provider, accountId, token, instanceUrl, apiVersion = '67.0', outputDirectory, records, verifyOwnership,
    applyTemporalChanges, onProgress = () => {} } = options;
  assert(['hubspot', 'salesforce'].includes(provider));
  assert(process.env.CONTROL_TOWER_SQLITE_PATH, 'The caller must select an isolated qualification database before importing production code.');
  assert(process.env.CONTROL_TOWER_SYNC_KEY, 'Native qualification requires an explicit private operator key.');
  assert(!process.env.CONTROL_TOWER_SLACK_WEBHOOK_URL && !process.env.OPENAI_API_KEY, 'Disable notification delivery and paid model calls for this qualification.');
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const save = (name, value) => writeFileSync(resolve(outputDirectory, `${provider}-${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const bundle = resolve(outputDirectory, `${provider}-monitor-runtime.mjs`);
  await build({ stdin: { contents: `export * from './lib/monitor'; export * from './lib/monitor-store'; export * from './lib/monitor-types'; export * from './lib/monitor-hubspot'; export * from './lib/monitor-salesforce'; export * from './lib/crm-incidents'; export { GET as incidentGET, POST as incidentPOST } from './app/api/control-tower/incidents/route';`, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle });
  const modules = await import(pathToFileURL(bundle).href);
  const scope = modules.monitorAccountScope(provider, accountId);
  const db = await modules.incidentDatabase();
  const previous = await db.prepare('SELECT COUNT(*) AS count FROM crm_observed_records WHERE account_id=?').bind(scope).first();
  assert.equal(previous.count, 0, 'Refusing to reuse previously observed account state for a fresh native qualification.');
  const native = provider === 'hubspot' ? modules.hubspotMonitorSource(token)
    : modules.salesforceMonitorSource(`${new URL(instanceUrl).origin}/services/data/v${apiVersion}`, { authorization: `Bearer ${token}` }, accountId);
  const mappings = Object.values(records).filter((record) => record.nativeId);
  assert(mappings.length > 0, 'Seed and reconcile the native cohort first.');
  assert.equal(new Set(mappings.map(key)).size, mappings.length, 'Native mappings must be one-to-one.');
  const observed = new Map(), repairPlans = new Map(), mutations = [];
  const report = { provider, accountId, startedAt: new Date().toISOString(), mode: 'Native adapter, production tickMonitor, isolated SQLite, marked synthetic records only',
    cohort: mappings.length, cohortByObject: Object.fromEntries([...new Set(mappings.map((row) => row.objectType))].map((type) => [type, mappings.filter((row) => row.objectType === type).length])), checks: [], normalization: [], nativeRepairRequests: mutations, limitations: [
      'Rejected or normalized fixture values are reported separately and are not counted as successful monitor detection.',
      'Native polling observes current state, not every intermediate change; event subscription delivery is not implied.',
      'Read-before-write remains separate from the provider mutation and is not an atomic CRM lock.',
      'Triage is an authenticated scripted operator action; browser review can separately verify presentation.',
    ] };
  function check(name, actual, expected) {
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    report.checks.push({ name, passed, expected, actual }); save('monitor-result', report);
    return passed;
  }
  const source = createOwnedNativeSource(native, { records: mappings, verifyOwnership, repairPlans,
    onObservation: (record) => observed.set(key(record), record), onMutation: (mutation) => { mutations.push(mutation); save('monitor-mutations', mutations); } });
  let ticks = 0;
  const tick = async () => {
    const view = await modules.tickMonitor(scope, token ?? '', { force: true, source }); ticks++;
    const run = view.runs[0];
    if (run?.status === 'failed') throw new Error(`Native monitor tick failed: ${run.error}`);
    onProgress({ provider, phase: view.phase, ticks, observed: observed.size, repairRequests: mutations.length });
    return view;
  };
  async function drain() {
    for (let page = 0; page < 2000; page++) {
      const view = await tick();
      if (!(await modules.getMonitorAccount(scope)).cursor) return view;
    }
    throw new Error('Native monitor scan did not finish within its qualification bound.');
  }
  async function drainRecheck() {
    for (let count = 0; count <= Math.ceil(mappings.length / 50) + 2; count++) {
      if (!await modules.hasIncidentRecheck(scope)) return;
      const coverage = await modules.getIncidentCoverage(scope);
      if (coverage.status !== 'healthy') {
        report.limitations.push(`Saved baseline relationship rechecks remain held because native coverage is ${coverage.status}: ${coverage.error ?? 'inspect capability evidence'}`);
        return;
      }
      await tick();
    }
    assert(!await modules.hasIncidentRecheck(scope), 'Native baseline incident recheck did not finish.');
  }
  const config = { enabled: true, automaticRepairs: false, intervalSeconds: 60, defaultAssignee: 'Native qualification operator' };
  await modules.configureMonitor(scope, config);
  const policy = await modules.getIncidentPolicy(scope);
  await modules.configureIncidentPolicy(scope, { ...policy, minimumRecords: 10, clearingFraction: 0.05, disallowNegativeAmounts: true,
    relationships: [{ id: 'deal-company', objectType: provider === 'salesforce' ? 'Opportunity' : 'Deal', field: 'company_id', targetType: provider === 'salesforce' ? 'Account' : 'Company', required: true }] });
  try {
    await drain(); await drainRecheck();
    const baselineCoverage = await modules.getIncidentCoverage(scope);
    check('Native baseline object and field coverage is complete', baselineCoverage.status, 'healthy');
    check('Every seeded native record is observed by production pagination', observed.size, mappings.length);
    check('Baseline performs no automatic native repairs', mutations.length, 0);
    const baseline = new Map([...observed].map(([recordKey, record]) => [recordKey, structuredClone(record)]));
    save('monitor-baseline', [...baseline.values()]);
    const findings = (await db.prepare('SELECT contact_id,rule,status FROM monitor_findings WHERE account_id=?').bind(scope).all()).results;
    const incidents = await modules.listIncidents(scope, { limit: 200 });
    const details = await Promise.all(incidents.map((incident) => modules.getIncident(scope, incident.id)));
    const fixture = generateMessyCrm(provider);
    const mappingByFixture = new Map(mappings.map((row) => [`${row.objectType}:${row.fixtureId}`, row]));
    const scenarioRules = { missing_email: 'email_missing', invalid_email: 'email_invalid', safe_whitespace: 'text_whitespace', unsafe_empty_trim: 'text_whitespace' };
    const applicable = Object.fromEntries(Object.keys(scenarioRules).map((scenario) => [scenario, []]));
    for (const label of fixture.expected) {
      const mapping = mappingByFixture.get(`${label.objectType}:${label.recordId}`);
      if (!mapping) { report.normalization.push({ scenario: label.scenario, fixtureId: label.recordId, result: 'not_seeded' }); continue; }
      const current = baseline.get(key(mapping));
      if (!current) continue;
      const p = current.properties;
      if (label.scenario in scenarioRules) {
        const visible = label.scenario === 'missing_email' ? 'email' in p && !p.email.trim()
          : label.scenario === 'invalid_email' ? Boolean(p.email?.trim()) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(p.email)
          : p.jobtitle !== undefined && p.jobtitle !== p.jobtitle.trim();
        if (visible) applicable[label.scenario].push(modules.monitorRecordKey(current));
        else report.normalization.push({ scenario: label.scenario, fixtureId: label.recordId, nativeId: mapping.nativeId, result: 'provider_normalized_or_not_observable' });
      }
    }
    for (const [scenario, rule] of Object.entries(scenarioRules)) {
      const actual = new Set(findings.filter((finding) => finding.rule === rule).map((finding) => finding.contact_id));
      check(`All natively observable ${scenario} cases detected (${applicable[scenario].length})`, applicable[scenario].filter((id) => !actual.has(id)), []);
    }
    for (const [scenario, kind, field] of [['missing_company', 'relationship', 'deal-company'], ['orphan_company', 'relationship', 'deal-company'],
      ['negative_amount_policy', 'invalid_value', 'amount'], ['invalid_amount', 'invalid_value', 'amount'], ['invalid_close_date', 'invalid_value', 'close_date'],
      ['duplicate_email_candidate', 'duplicate_candidate', null], ['duplicate_domain_candidate', 'duplicate_candidate', null]]) {
      const wanted = fixture.expected.filter((label) => label.scenario === scenario).flatMap((label) => {
        const mapping = mappingByFixture.get(`${label.objectType}:${label.recordId}`), current = mapping && baseline.get(key(mapping));
        if (!current) return [];
        const p = current.properties;
        const value = p[scenario === 'duplicate_email_candidate' ? 'email' : 'domain']?.trim().toLowerCase();
        const visible = scenario === 'missing_company' ? p.company_id === ''
          : scenario === 'orphan_company' ? Boolean(p.company_id) && !baseline.has(`${provider === 'salesforce' ? 'Account' : 'Company'}:${p.company_id}`)
          : scenario === 'negative_amount_policy' ? Number(p.amount) < 0
          : scenario === 'invalid_amount' ? Boolean(p.amount?.trim()) && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(p.amount.trim()) || !Number.isFinite(Number(p.amount)))
          : scenario === 'invalid_close_date' ? Boolean(p.close_date?.trim()) && (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(p.close_date) || !Number.isFinite(Date.parse(p.close_date)) || new Date(p.close_date).toISOString().slice(0, 10) !== p.close_date.slice(0, 10))
          : Boolean(value) && [...baseline.values()].some((other) => other.objectType === current.objectType && other.id !== current.id && other.properties[scenario === 'duplicate_email_candidate' ? 'email' : 'domain']?.trim().toLowerCase() === value);
        if (!visible) { report.normalization.push({ scenario, fixtureId: label.recordId, result: 'provider_normalized_or_not_observable' }); return []; }
        return [modules.monitorRecordKey(current)];
      });
      const actual = new Set(details.filter((detail) => detail.kind === kind && (field === null || detail.field === field)).flatMap((detail) => detail.records));
      check(`All natively observable ${scenario} cases detected (${wanted.length})`, wanted.filter((id) => !actual.has(id)), []);
    }
    check('Baseline blanks are not reported as bulk clears', incidents.filter((incident) => incident.kind === 'mass_field_clearing').length, 0);
    for (const current of baseline.values()) {
      if (!['Lead', 'Contact'].includes(current.objectType)) continue;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(current.properties.email ?? '')) continue;
      const allowed = provider === 'salesforce' && current.objectType === 'Contact' ? ['jobtitle'] : ['company', 'jobtitle'];
      const before = {}, after = {};
      for (const field of allowed) { const value = current.properties[field]; if (typeof value === 'string' && value !== value.trim()) { before[field] = value; after[field] = value.trim(); } }
      if (Object.keys(after).length && Object.values(after).every(Boolean)) repairPlans.set(key(current), { before, after });
    }
    report.nativeEligibleTrims = repairPlans.size;
    await modules.configureMonitor(scope, { ...config, automaticRepairs: true });
    for (let attempt = 0; attempt <= Math.ceil(repairPlans.size / 5) + 2; attempt++) {
      if (!(await modules.getPendingMonitorRepairs(scope)).length) break;
      await tick();
    }
    check('Each native-eligible supported trim is sent exactly once', mutations.length, repairPlans.size);
    for (const [recordKey, plan] of repairPlans) {
      const before = baseline.get(recordKey), after = await source.read(before.id, before.objectType);
      const expected = { ...before.properties, ...plan.after };
      const actual = { ...after.properties };
      delete expected.lastmodifieddate; delete actual.lastmodifieddate;
      check(`Native readback and protected fields: ${recordKey}`, actual, expected);
    }
    const repairRows = (await db.prepare('SELECT state FROM monitor_repairs WHERE account_id=?').bind(scope).all()).results;
    check('Every attempted automatic native repair has verified readback', repairRows.filter((row) => row.state !== 'verified').length, 0);
    check('Every automatic repair preserves the full supplied native protected snapshot', mutations.filter((mutation) => mutation.protectedReadback?.verified).length, mutations.length);
    for (const label of fixture.expected.filter((label) => label.scenario === 'source_instruction_text')) {
      const mapping = mappingByFixture.get(`${label.objectType}:${label.recordId}`);
      if (!mapping) continue;
      const before = baseline.get(key(mapping)), after = await source.read(mapping.nativeId, mapping.objectType);
      check('Instruction-like native CRM text remains data and stays unchanged', after.properties.jobtitle, before.properties.jobtitle);
      check('Instruction-like source text confers no native mutation authority', mutations.filter((mutation) => key(mutation) === key(mapping)).length, 0);
    }
    await modules.configureMonitor(scope, config);
    if (applyTemporalChanges) {
      const changes = [];
      const temporalScenarios = ['bulk_field_clearing', 'company_bulk_clearing', 'deal_bulk_clearing', 'legitimate_bulk_update'];
      const expectedTargets = new Map(temporalScenarios.map((scenario) => [scenario, new Set()]));
      for (const event of fixture.events.filter((event) => temporalScenarios.includes(event.scenario))) {
        const mapping = mappingByFixture.get(`${event.record.objectType}:${event.record.id}`);
        if (mapping) expectedTargets.get(event.scenario).add(key(mapping));
        const current = mapping && baseline.get(key(mapping));
        const field = ['bulk_field_clearing', 'legitimate_bulk_update'].includes(event.scenario) ? 'jobtitle' : event.scenario === 'company_bulk_clearing' ? 'domain' : 'amount';
        if (current?.properties[field] && current.properties[field] !== event.record.properties[field] && !changes.some((change) => change.nativeId === mapping.nativeId && change.objectType === mapping.objectType && change.field === field)) {
          changes.push({ ...mapping, field, before: current.properties[field], after: event.record.properties[field], scenario: event.scenario });
        }
      }
      for (const scenario of temporalScenarios) {
        const expected = [...expectedTargets.get(scenario)].sort();
        const requested = changes.filter((change) => change.scenario === scenario).map(key).sort();
        check(`Temporal ${scenario} has populated native baselines for every mapped target (${expected.length})`, requested, expected);
        if (requested.length !== expected.length) report.limitations.push(`${scenario}: ${expected.length - requested.length} mapped targets lack the populated, different baseline needed for this temporal case; a prior clear or already-applied update is not a new successful detection.`);
      }
      report.temporalRequestedCounts = Object.fromEntries(temporalScenarios.map((scenario) => [scenario, changes.filter((change) => change.scenario === scenario).length]));
      check('Temporal qualification contains native mutations to observe', changes.length > 0, true);
      const result = await applyTemporalChanges(changes);
      assert(Array.isArray(result.applied), 'Temporal writer must return its reconciled applied mutations.');
      check('Every requested native temporal mutation was accepted and reconciled', result.applied.map((change) => `${key(change)}:${change.field}:${change.after}`).sort(), changes.map((change) => `${key(change)}:${change.field}:${change.after}`).sort());
      report.temporal = result; save('monitor-temporal', result);
      const completedAt = result.completedAt ? Date.parse(result.completedAt) : Date.now();
      assert(Number.isFinite(completedAt) && completedAt <= Date.now() + 10_000, 'Temporal completion timestamp is invalid.');
      // Real native timestamps and the production indexing lag, never a fake clock or injected observation.
      while (Date.now() < completedAt + 135_000) { onProgress({ provider, phase: 'waiting_for_native_indexing', remainingSeconds: Math.ceil((completedAt + 135_000 - Date.now()) / 1000) }); await delay(Math.min(15_000, completedAt + 135_000 - Date.now())); }
      let missing = result.applied;
      for (let round = 0; round < 5; round++) {
        await drain();
        missing = result.applied.filter((change) => observed.get(key(change))?.properties[change.field] !== change.after);
        if (!missing.length) break;
        onProgress({ provider, phase: 'waiting_for_native_search', pending: missing.length }); await delay(30_000);
      }
      check('Every accepted temporal mutation is observed through native change search', missing.map(key), []);
      const grouped = await modules.listIncidents(scope, { limit: 200 });
      const groupedDetails = await Promise.all(grouped.filter((incident) => incident.kind === 'mass_field_clearing').map((incident) => modules.getIncident(scope, incident.id)));
      for (const field of ['jobtitle', 'domain', 'amount']) {
        const expected = result.applied.filter((change) => change.field === field && change.after === '').map((change) => modules.monitorRecordKey({ id: change.nativeId, objectType: change.objectType, provider }));
        const actual = [...new Set(groupedDetails.filter((detail) => detail.field === field).flatMap((detail) => detail.records))];
        check(`Native bulk ${field} clearing groups exactly the changed cohort`, actual.sort(), expected.sort());
      }
      const legitimate = new Set(result.applied.filter((change) => change.scenario === 'legitimate_bulk_update').map((change) => modules.monitorRecordKey({ id: change.nativeId, objectType: change.objectType, provider })));
      check('Legitimate native title updates are not classified as bulk clears', [...new Set(groupedDetails.flatMap((detail) => detail.records))].filter((id) => legitimate.has(id)), []);
    } else report.limitations.push('Temporal native changes were not requested by this invocation.');
    const selected = (await modules.listIncidents(scope, { limit: 200 })).find((incident) => incident.kind !== 'coverage');
    if (selected) {
      const request = (body, authenticated = true) => new Request('http://native-qualification.local/api/control-tower/incidents', { method: 'POST',
        headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-control-tower-key': process.env.CONTROL_TOWER_SYNC_KEY } : {}) }, body: JSON.stringify({ provider, account: scope, ...body }) });
      const triage = { action: 'triage', id: selected.id, status: 'investigating', assignee: 'Native qualification operator', note: 'Reviewed live synthetic CRM evidence. Ambiguous business corrections remain assigned for human review.' };
      check('Unauthenticated human triage is rejected', (await modules.incidentPOST(request(triage, false))).status, 401);
      const investigation = await modules.incidentPOST(request({ action: 'investigate', id: selected.id, useModel: false }));
      check('Authenticated investigation reads saved native evidence', investigation.status, 200);
      const response = await modules.incidentPOST(request(triage));
      check('Authenticated human triage is accepted', response.status, 200);
      const reload = await modules.incidentGET(new Request(`http://native-qualification.local/api/control-tower/incidents?provider=${provider}&account=${encodeURIComponent(scope)}&incident=${selected.id}`, { headers: { 'x-control-tower-key': process.env.CONTROL_TOWER_SYNC_KEY } }));
      const saved = await reload.json();
      check('Human triage survives authenticated saved-state reload', [saved.detail?.status, saved.detail?.assignee, saved.detail?.note], [triage.status, triage.assignee, triage.note]);
      check('Investigation and triage introduce no native repair requests', mutations.length, repairPlans.size);
      report.triage = { incidentId: selected.id, status: saved.detail?.status, investigation: saved.investigation?.mode ?? 'saved' }; save('monitor-triage', saved);
    } else check('At least one ambiguous incident is available for human triage', false, true);
    report.coverage = await modules.getIncidentCoverage(scope);
    check('Native final object and field coverage is complete', report.coverage.status, 'healthy');
    report.incidents = await modules.listIncidents(scope, { limit: 200 });
    report.ticks = ticks; report.finishedAt = new Date().toISOString(); report.passed = report.checks.every((item) => item.passed);
    save('monitor-result', report);
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error); report.passed = false; report.finishedAt = new Date().toISOString(); save('monitor-result', report);
    throw error;
  } finally {
    await modules.configureMonitor(scope, { ...config, enabled: false, automaticRepairs: false });
  }
}
