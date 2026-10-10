import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

// Offline presentation only. Never reads credentials, calls a CRM, or serializes
// full native manifests, account identities, or provider metadata into the page.
const args = process.argv.slice(2);
const runId = args[args.indexOf('--run-id') + 1];
assert(args.includes('--run-id') && /^[a-z0-9-]{6,50}$/.test(runId ?? ''), 'Use --run-id with an existing native qualification run.');
const runRoot = resolve(import.meta.dirname, '..', 'outputs/native-incidents', runId);
assert(existsSync(runRoot), 'The native qualification output directory does not exist.');
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const number = (value) => Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : 'Not finished';
function read(path) {
  if (!existsSync(path)) return { path, data: null, missing: true };
  try { return { path, data: JSON.parse(readFileSync(path, 'utf8')) }; }
  catch { return { path, data: null, unreadable: true }; }
}
function link(file, label) {
  if (!file || !existsSync(file)) return '';
  const path = relative(runRoot, file);
  assert(!path.startsWith('..'), 'Evidence links must stay within this run.');
  return `<a href="${escape(path.split('/').map(encodeURIComponent).join('/'))}">${escape(label)} ↗</a>`;
}
function newestMonitor(directory, provider) {
  if (!existsSync(directory)) return read(resolve(directory, 'monitor', `${provider}-monitor-result.json`));
  const candidates = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^monitor(?:-\d+)?$/.test(entry.name))
    .map((entry) => ({ path: resolve(directory, entry.name), started: /^monitor-(\d+)$/.exec(entry.name)?.[1] }))
    .sort((left, right) => (Number(right.started) || statSync(right.path).birthtimeMs) - (Number(left.started) || statSync(left.path).birthtimeMs));
  return read(resolve(candidates[0]?.path ?? resolve(directory, 'monitor'), `${provider}-monitor-result.json`));
}
const checkRows = (data) => Array.isArray(data?.checks) ? data.checks.filter((check) => typeof check.name === 'string') : [];
function phase(data, required = true) {
  if (!data) return required ? 'missing' : 'unverified';
  if (data.passed === false || checkRows(data).some((check) => check.passed === false)) return 'failed';
  if (data.passed === true) return 'passed';
  return 'partial';
}
function monitorPhase(data) {
  const state = phase(data);
  if (state !== 'passed') return state;
  if (data.coverage?.status && data.coverage.status !== 'healthy') return 'failed';
  const complete = typeof data.finishedAt === 'string' && Number.isFinite(Date.parse(data.finishedAt))
    && data.coverage?.status === 'healthy' && data.coverage.phase === 'changes'
    && checkRows(data).length > 0 && checkRows(data).every((check) => check.passed === true)
    && Number.isFinite(Date.parse(data.temporal?.completedAt)) && Array.isArray(data.temporal?.applied) && data.temporal.applied.length > 0
    && !data.temporal.pending?.length && typeof data.triage?.incidentId === 'string';
  return complete ? 'passed' : 'partial';
}
// Optional ui-result.json (run root or provider directory):
// { version: 1, runId, providers: ['hubspot', 'salesforce'],
//   evidenceSource: 'native-qualification-sqlite', finishedAt: ISO_TIMESTAMP,
//   passed: boolean, checks: [{name, passed, provider?, expected?, actual?}],
//   artifacts: [{label, path: 'relative-to-ui-result-directory.png'}],
//   limitations: ['Browser checks used saved native evidence; no hosted proof.'] }
// A provider-level file needs only that provider in its providers array.
function uiPhase(file, expectedProviders, monitorByProvider) {
  if (!file.data) return 'unverified';
  const status = phase(file.data, false);
  if (status !== 'passed') return status;
  const complete = file.data.runId === runId && file.data.evidenceSource === 'native-qualification-sqlite'
    && typeof file.data.finishedAt === 'string' && Number.isFinite(Date.parse(file.data.finishedAt)) && Array.isArray(file.data.providers)
    && expectedProviders.every((provider) => file.data.providers.includes(provider))
    && expectedProviders.every((provider) => {
      const monitor = monitorByProvider.get(provider);
      return monitorPhase(monitor) === 'passed' && Date.parse(file.data.finishedAt) >= Date.parse(monitor.finishedAt);
    })
    && checkRows(file.data).length > 0 && checkRows(file.data).every((check) => check.passed === true);
  return complete ? 'passed' : 'partial';
}
const badge = (status, label) => `<span class="badge ${status === 'passed' ? 'good' : status === 'failed' ? 'bad' : 'pending'}">${escape(label ?? ({ passed: 'Passed', failed: 'Needs attention', partial: 'In progress', missing: 'Not run', unverified: 'Unverified' })[status])}</span>`;
function valueSummary(value) {
  if (Array.isArray(value)) return value.length ? `${number(value.length)} items; inspect linked evidence` : 'None';
  if (value && typeof value === 'object') return `${Object.keys(value).length} fields; inspect linked evidence`;
  if (typeof value === 'string') return value.length <= 100 ? value : 'Saved text; inspect linked evidence';
  return value === undefined ? 'Not recorded' : String(value);
}
function loadProvider(provider) {
  const directory = resolve(runRoot, provider);
  const manifest = read(resolve(directory, 'manifest.json'));
  const monitor = newestMonitor(directory, provider);
  const safeImport = read(resolve(directory, 'import/safe-import/result.json'));
  const importFailure = read(resolve(directory, 'import/safe-import/failure.json'));
  const formatting = read(resolve(directory, 'formatting-probes.json'));
  const formattingProbes = Array.isArray(formatting.data) ? formatting.data : [];
  const extraCompanies = read(resolve(directory, 'extra-company-inventory.json'));
  const ui = read(resolve(directory, 'ui-result.json'));
  const records = Object.values(manifest.data?.records ?? {}).filter((record) => record.nativeId && record.status === 'created');
  const types = provider === 'hubspot' ? ['Contact', 'Company', 'Deal'] : ['Contact', 'Account', 'Opportunity', 'Lead'];
  const counts = Object.fromEntries(types.map((type) => [type, records.filter((record) => record.objectType === type).length]));
  const rejections = Array.isArray(manifest.data?.rejected) ? manifest.data.rejected : [];
  // Compare only fields actually returned by native readback. Blank/null
  // representation alone is not counted as a material value normalization.
  const normalized = records.filter((record) => {
    const returned = record.readback?.properties ?? record.readback;
    return returned && Object.entries(record.seedPayload ?? {}).some(([field, sent]) => Object.hasOwn(returned, field)
      && (sent === null || ['string', 'number', 'boolean'].includes(typeof sent))
      && (returned[field] === null || ['string', 'number', 'boolean'].includes(typeof returned[field]))
      && String(sent ?? '') !== String(returned[field] ?? ''));
  });
  const detections = checkRows(monitor.data).flatMap((check) => {
    const match = /^All natively observable (.+) cases detected \((\d+)\)$/.exec(check.name);
    if (!match) return [];
    const observable = Number(match[2]);
    const missing = Array.isArray(check.actual) ? check.actual.length : null;
    return [{ scenario: match[1], observable, detected: missing === null ? null : Math.max(0, observable - missing), passed: check.passed === true }];
  });
  const pending = Object.keys(manifest.data?.pending ?? {}).length;
  const seedState = !manifest.data ? 'missing' : manifest.data.seedCompletedAt && pending === 0 ? 'passed' : 'partial';
  const monitorState = monitorPhase(monitor.data);
  const importState = safeImport.data ? phase(safeImport.data) : importFailure.data ? 'failed' : 'missing';
  const formattingComplete = formatting.missing || (formattingProbes.length === 3 && formattingProbes.every((probe) => probe.status === 'readback'
    && (probe.normalizedByProvider === true || (probe.normalizedByProvider === false && probe.nativeValue === probe.proposed))));
  const nativeComplete = seedState === 'passed' && monitorState === 'passed' && importState === 'passed' && formattingComplete;
  const failed = [monitorState, importState].includes('failed');
  const autoVerified = checkRows(monitor.data).some((check) => check.name === 'Every attempted automatic native repair has verified readback' && check.passed === true)
    && checkRows(monitor.data).some((check) => check.name === 'Every automatic repair preserves the full supplied native protected snapshot' && check.passed === true)
    && Array.isArray(monitor.data?.nativeRepairRequests) && monitor.data.nativeRepairRequests.every((request) => request.protectedReadback?.verified === true)
    && checkRows(monitor.data).filter((check) => check.name.startsWith('Native readback and protected fields:')).every((check) => check.passed === true)
    ? (Array.isArray(monitor.data?.nativeRepairRequests) ? monitor.data.nativeRepairRequests.length : 0) : null;
  return { provider, name: provider === 'hubspot' ? 'HubSpot' : 'Salesforce', directory, manifest, monitor, safeImport, importFailure, formatting, formattingProbes, formattingComplete, extraCompanies, ui, records, types, counts,
    rejections, normalized, detections, pending, seedState, monitorState, importState, nativeComplete, failed, autoVerified };
}
const providers = ['hubspot', 'salesforce'].map(loadProvider);
const runUi = read(resolve(runRoot, 'ui-result.json'));
const monitorByProvider = new Map(providers.map((provider) => [provider.provider, provider.monitor.data]));
const uiState = runUi.data ? uiPhase(runUi, ['hubspot', 'salesforce'], monitorByProvider) : providers.every((provider) => uiPhase(provider.ui, [provider.provider], monitorByProvider) === 'passed') ? 'passed'
  : providers.some((provider) => uiPhase(provider.ui, [provider.provider], monitorByProvider) === 'failed') ? 'failed'
    : providers.some((provider) => provider.ui.data) ? 'partial' : 'unverified';
const allChecks = providers.flatMap((provider) => {
  const checks = checkRows(provider.monitor.data).map((check) => ({ ...check, provider: provider.name, path: provider.monitor.path }));
  const imported = provider.safeImport.data;
  if (imported) {
    const importedChecks = [
      ['Safe Import native fills accepted and verified', imported.acceptedAndVerified, imported.nativePhoneFills],
      ['Safe Import protected native fields preserved', imported.protectedFieldsPreserved, true],
      ['Safe Import repeated approval sends no requests', imported.repeatedApprovalSentNoRequests, true],
      ['Safe Import saved execution reload', imported.durableReloadVerified, true],
      ['Safe Import unauthenticated request rejected', imported.unauthenticatedRequestRejected, true],
      ['Safe Import mutations outside the selected cohort', imported.outsideCohortMutationRequests, 0],
    ];
    checks.push(...importedChecks.map(([name, actual, expected]) => ({ name, actual, expected, passed: actual !== undefined && actual === expected,
      provider: provider.name, path: provider.safeImport.path })));
  }
  checks.push(...checkRows(provider.ui.data).map((check) => ({ ...check, provider: provider.name, path: provider.ui.path })));
  return checks;
});
allChecks.push(...checkRows(runUi.data).map((check) => ({ ...check,
  provider: check.provider === 'hubspot' ? 'HubSpot browser' : check.provider === 'salesforce' ? 'Salesforce browser' : 'Browser', path: runUi.path })));
const failed = providers.some((provider) => provider.failed) || uiState === 'failed' || allChecks.some((check) => check.passed === false);
const nativeComplete = providers.every((provider) => provider.nativeComplete);
const overall = failed ? 'failed' : nativeComplete && uiState === 'passed' ? 'passed' : 'partial';
const overallLabel = failed ? 'Needs attention' : nativeComplete ? uiState === 'passed' ? 'Native qualification passed' : 'Native checks passed · browser unverified' : 'Partial native qualification';
const accepted = providers.reduce((sum, provider) => sum + provider.records.length, 0);
const verifiedFills = providers.reduce((sum, provider) => sum + (Number.isFinite(provider.safeImport.data?.acceptedAndVerified) ? provider.safeImport.data.acceptedAndVerified : 0), 0);
const generatedAt = new Date().toISOString();
const cards = providers.map((provider) => {
  const monitor = provider.monitor.data, imported = provider.safeImport.data;
  const detectionsKnown = provider.detections.length > 0;
  const observable = provider.detections.reduce((sum, row) => sum + row.observable, 0);
  const detected = provider.detections.reduce((sum, row) => sum + (row.detected ?? 0), 0);
  const links = [link(provider.manifest.path, 'Native manifest'), link(provider.monitor.path, 'Monitor checks'), link(provider.safeImport.path, 'Safe Import receipt'),
    link(provider.importFailure.path, 'Import failure'), link(resolve(dirname(provider.monitor.path), 'qualification.db'), 'SQLite evidence')].filter(Boolean).join('');
  const objectCounts = provider.types.map((type) => `<div><dt>${escape(({ Contact: 'Contacts', Company: 'Companies', Deal: 'Deals', Account: 'Accounts', Opportunity: 'Opportunities', Lead: 'Leads' })[type])}</dt><dd>${number(provider.counts[type])}</dd></div>`).join('');
  const rejectionGroups = Object.entries(provider.rejections.reduce((groups, rejection) => {
    const label = `${rejection.step ?? 'native request'} · ${(rejection.codes ?? []).join(', ') || 'native rejection'}`;
    groups[label] = (groups[label] ?? 0) + 1; return groups;
  }, {})).map(([label, count]) => `<li>${number(count)} × ${escape(label)}</li>`).join('');
  const detectionRows = provider.detections.map((row) => `<tr><td>${escape(row.scenario.replaceAll('_', ' '))}</td><td>${number(row.detected)} / ${number(row.observable)}</td><td>${badge(row.passed ? 'passed' : 'failed', row.observable ? undefined : 'No native case')}</td></tr>`).join('');
  const phaseRows = [['Native seed', provider.seedState], ['Detection & triage', provider.monitorState], ['Reviewed safe fills', provider.importState]];
  const formattingNormalized = provider.formattingProbes.filter((probe) => probe.status === 'readback' && probe.normalizedByProvider === true).length;
  const formattingRetained = provider.formattingProbes.filter((probe) => probe.status === 'readback' && probe.normalizedByProvider === false && probe.nativeValue === probe.proposed).length;
  const formattingNote = provider.formatting.missing ? '' : `<details><summary>Supplemental Unicode-space probes · ${number(provider.formattingProbes.length)} / 3</summary><p>Separate from the original seed-42 dataset: nonbreaking space, thin space and byte-order-mark boundaries were applied to three existing Contacts. No records were added.</p><p>${number(formattingNormalized)} normalized by the provider; ${number(formattingRetained)} retained for monitor detection and eligible repair. ${provider.formattingComplete ? 'All three native probe readbacks are saved.' : 'Probe readback is incomplete; inspect pending evidence before retrying.'} Automatic trim counts above can include these supplemental cases.</p>${link(provider.formatting.path, 'Supplemental formatting evidence')}</details>`;
  const temporalCounts = Array.isArray(monitor?.temporal?.applied) ? Object.entries(monitor.temporal.applied.reduce((counts, change) => {
    const label = ({ bulk_field_clearing: 'contact title clears', company_bulk_clearing: 'company domain clears', deal_bulk_clearing: 'deal amount clears', legitimate_bulk_update: 'legitimate title updates' })[change.scenario] ?? 'other fixture changes';
    counts[label] = (counts[label] ?? 0) + 1; return counts;
  }, {})).map(([label, count]) => `${number(count)} ${label}`).join(', ') : '';
  const temporalNote = temporalCounts ? `<details><summary>Deliberately injected temporal changes · ${number(monitor.temporal.applied.length)}</summary><p>${escape(temporalCounts)}. The qualification harness made these native fixture changes to test detection. They are excluded from the automatic-repair and Safe Import counts.</p>${link(resolve(dirname(provider.monitor.path), `${provider.provider}-monitor-temporal.json`), 'Temporal mutation evidence')}</details>` : '';
  const failure = provider.failed ? '<p class="notice bad-text">A native phase failed. Inspect the linked phase evidence before retrying any write.</p>' : '';
  return `<article class="card"><div class="card-heading"><h2>${provider.name}</h2>${badge(provider.failed ? 'failed' : provider.nativeComplete ? 'passed' : 'partial')}</div>
    <p class="large">${number(provider.records.length)} <span>native records accepted</span></p><dl class="objects">${objectCounts}</dl>
    <div class="phases">${phaseRows.map(([label, state]) => `<div><span>${label}</span>${badge(state)}</div>`).join('')}</div>${failure}
    <dl class="facts"><div><dt>Rejected native requests</dt><dd>${number(provider.rejections.length)} <small>across ${number(new Set(provider.rejections.map((row) => row.key)).size)} targets</small></dd></div>
    <div><dt>Records normalized by provider</dt><dd>${number(provider.normalized.length)}</dd></div>
    <div><dt>Observable anomaly cases detected</dt><dd>${detectionsKnown ? `${number(detected)} / ${number(observable)}` : 'Not yet measured'}</dd></div>
    <div><dt>Labels not observable after ingestion</dt><dd>${Array.isArray(monitor?.normalization) ? number(monitor.normalization.length) : 'Not yet measured'}</dd></div>
    <div><dt>Automatic trims with native readback</dt><dd>${provider.autoVerified === null ? 'Not yet verified' : number(provider.autoVerified)}</dd></div>
    <div><dt>Safe Import fills accepted & verified</dt><dd>${Number.isFinite(imported?.acceptedAndVerified) ? number(imported.acceptedAndVerified) : 'Not yet verified'}</dd></div>
    <div><dt>Injected temporal test changes</dt><dd>${Array.isArray(monitor?.temporal?.applied) ? number(monitor.temporal.applied.length) : 'Not yet recorded'}</dd></div>
    <div><dt>Human triage saved</dt><dd>${monitor?.triage?.status ? escape(monitor.triage.status) : 'Not yet verified'}</dd></div>
    <div><dt>Pending seed operations</dt><dd>${number(provider.pending)}</dd></div></dl>
    ${formattingNote}${temporalNote}${provider.detections.length ? `<details><summary>Detection by scenario</summary><div class="table-wrap"><table><thead><tr><th>Scenario</th><th>Detected / observable</th><th>Check</th></tr></thead><tbody>${detectionRows}</tbody></table></div></details>` : ''}
    ${rejectionGroups ? `<details><summary>Provider rejection breakdown</summary><ul>${rejectionGroups}</ul></details>` : ''}
    <p class="small">Native seed: ${escape(timestamp(provider.manifest.data?.seedCompletedAt))}<br>Monitor: ${escape(timestamp(monitor?.finishedAt))}<br>Safe Import: ${escape(timestamp(imported?.finishedAt))}</p>
    <div class="links">${links || '<span>No phase artifacts yet.</span>'}</div></article>`;
}).join('');
const checks = allChecks.map((check) => `<tr class="${check.passed === true ? 'passed' : 'failed'}"><td>${badge(check.passed === true ? 'passed' : 'failed')}</td><td>${escape(check.provider)}</td><td>${escape(check.name)}<details><summary>Expected and observed</summary><p>Expected: ${escape(valueSummary(check.expected))}<br>Observed: ${escape(valueSummary(check.actual))}</p>${link(check.path, 'Complete saved evidence')}</details></td></tr>`).join('');
const companySideEffects = providers.filter((provider) => provider.extraCompanies.data).map((provider) => {
  const inventory = provider.extraCompanies.data;
  const counts = inventory.counts ?? {};
  const confirmed = Number.isInteger(counts.confirmedProviderCreated) && counts.confirmedProviderCreated >= 0 ? counts.confirmedProviderCreated : null;
  const unmatched = Number.isInteger(counts.unmatchedCandidates) && counts.unmatchedCandidates >= 0 ? counts.unmatchedCandidates : null;
  const complete = inventory.coverage?.complete === true;
  const attribution = confirmed > 0 && provider.provider === 'hubspot'
    ? `Native source metadata attributes ${number(confirmed)} additional companies to HubSpot’s “Create and associate companies with contacts” setting.${runId === 'native-20261010' ? ' This run’s setup used .example.com Contact email domains while seeded Companies used .example, which triggered native company creation. This is a setup-induced automation side effect found by manual qualification, not a Monitor detection.' : ''} The inventory requires matching fixture email domains, creation during this run, and the native setting source label and identifier.`
    : 'The saved inventory does not report a confirmed provider-created company count above zero.';
  return `<h2>${provider.name} company side effects</h2><div class="notice"><p><strong>${number(confirmed)} additional provider-created companies</strong> are reported separately from the ${number(accepted)} explicitly seeded records above. They carry no fixture ownership marker and are excluded from the qualified monitor cohort.</p><p>${escape(attribution)}</p><p>${number(unmatched)} candidates lack that attribution. ${complete ? 'The saved read-only company inventory completed.' : 'The saved inventory is partial; counts are lower bounds.'} Detection or repair of these excluded companies was not qualified. A later setup correction does not change this run’s evidence or establish the outcome of a future native rerun.</p>${link(provider.extraCompanies.path, 'Private company inventory')}</div>`;
}).join('');
const artifacts = providers.flatMap((provider) => [
  link(resolve(provider.directory, 'import/safe-import/review.json'), `${provider.name} exact import review`),
  link(resolve(provider.directory, 'import/safe-import/native-readback.json'), `${provider.name} import readback`),
  link(resolve(dirname(provider.monitor.path), `${provider.provider}-monitor-triage.json`), `${provider.name} saved triage`),
  link(provider.ui.path, `${provider.name} browser result`),
]).filter(Boolean);
if (runUi.data) artifacts.push(link(runUi.path, 'Browser results'));
const uiFiles = [runUi, ...providers.map((provider) => provider.ui)].filter((file) => file.data);
const browserEvidence = uiFiles.length ? `<h2>Browser evidence</h2>${uiFiles.map((file) => {
  const data = file.data;
  const covered = Array.isArray(data.providers) ? data.providers.filter((provider) => ['hubspot', 'salesforce'].includes(provider)) : [];
  const expectedProviders = file.path === runUi.path ? ['hubspot', 'salesforce'] : providers.filter((provider) => provider.ui.path === file.path).map((provider) => provider.provider);
  const currentStatus = uiPhase(file, expectedProviders, monitorByProvider);
  const source = data.evidenceSource === 'native-qualification-sqlite' ? 'Saved native qualification database' : 'Evidence source not specified as native qualification data';
  const evidenceLinks = (Array.isArray(data.artifacts) ? data.artifacts : []).flatMap((artifact) => {
    if (typeof artifact?.path !== 'string' || typeof artifact.label !== 'string' || /^(?:[a-z]+:|\/)/i.test(artifact.path)) return [];
    const target = resolve(dirname(file.path), artifact.path);
    if (relative(runRoot, target).startsWith('..')) return [];
    const rendered = link(target, artifact.label);
    return rendered ? [rendered] : [];
  });
  return `<div class="notice"><p>${escape(covered.length ? covered.join(' + ') : 'Provider coverage not recorded')} · ${escape(timestamp(data.finishedAt))} · ${badge(currentStatus)}<br>${escape(source)} · ${checkRows(data).filter((check) => check.passed === true).length} / ${checkRows(data).length} browser checks passed.${currentStatus === 'partial' ? '<br>Provider coverage, metadata, or timing does not yet qualify the latest completed native monitor evidence.' : ''}</p><div class="links">${link(file.path, 'Browser result')}${evidenceLinks.join('')}</div></div>`;
}).join('')}` : '';
const limits = [...new Set([
  'This report uses marked synthetic records in real test accounts and a local Control Tower runtime with isolated SQLite. It does not certify production or hosted deployment.',
  'Native accepted counts are created records, including documented legal fallbacks after rejection. A provider rejection is prevention at ingestion, not a Control Tower detection.',
  'Provider normalization counts compare submitted fields with native readback. Unobservable labels also include rejected values and unsupported observations; these categories can overlap and are not added together.',
  'A zero-case detection check has no native case to exercise. It must not be read as proof that the CRM accepted or Control Tower detected the original planted defect.',
  'Temporal test writes are deliberate fixture mutations performed by the qualification harness, not automatic corrections. Browser success must finish after the latest completed monitor run; an older browser result does not qualify a newer database.',
  'Ambiguous fixes stay assigned to a person. Verified phone fills and eligible whitespace trims are distinct supported operations; no merge or general restoration is implied.',
  'Native webhook/CDC delivery, Slack delivery and paid model behavior are not established by these polling and local route checks.',
  'Fixtures and safe updates remain in the test accounts for inspection. Report generation is offline and performs no cleanup or CRM operations.',
  ...providers.some((provider) => provider.extraCompanies.data) ? ['Provider-created company side effects remain outside the marked monitoring cohort. The separate inventory is read-only and does not establish that Control Tower detected or repaired them.'] : [],
  ...providers.flatMap((provider) => Array.isArray(provider.monitor.data?.limitations) ? provider.monitor.data.limitations : []),
  ...uiFiles.flatMap((file) => Array.isArray(file.data.limitations) ? file.data.limitations.filter((limit) => typeof limit === 'string') : []),
])];
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Native CRM qualification · Control Tower</title><style>
:root{color-scheme:dark;--bg:#09130f;--card:#11221a;--line:#2d4537;--ink:#eff8f2;--muted:#abc0b2;--green:#c6f86d;--red:#ffb8a6;--amber:#efd493}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1160px;padding:42px 24px 70px;margin:auto}nav{display:flex;justify-content:space-between;gap:20px;font:11px/1.5 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}h1{font-size:clamp(38px,5.4vw,64px);line-height:1.08;letter-spacing:-.045em;margin:30px 0 18px}h2{font-size:24px;letter-spacing:-.02em;margin:34px 0 15px}.lead{max-width:810px;font-size:18px;color:var(--muted)}.badge{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:99px;padding:3px 10px;font-size:11px;white-space:nowrap}.good{color:var(--green);border-color:#536a35}.bad{color:var(--red);border-color:#734a3e}.pending{color:var(--amber);border-color:#6c5d38}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:27px 0}.stat,.card{background:var(--card);border:1px solid var(--line);border-radius:17px;padding:22px}.stat b{display:block;font-size:31px;line-height:1.2;color:var(--green)}.stat span{font-size:12px;color:var(--muted)}.worlds{display:grid;grid-template-columns:1fr 1fr;gap:16px}.card-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.card-heading h2{margin:0}.large{font-size:30px;margin:16px 0 12px}.large span{font-size:13px;color:var(--muted)}dl{margin:0}.objects{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.objects dt{font-size:11px;color:var(--muted)}dd{margin:0}.objects dd{font-size:21px}.phases{margin:20px 0;padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.phases>div{display:flex;align-items:center;justify-content:space-between;padding:5px 0;font-size:13px}.facts>div{display:grid;grid-template-columns:1.5fr 1fr;gap:14px;padding:7px 0}.facts dt{font-size:12px;color:var(--muted)}.facts dd{text-align:right;font-size:13px}.facts small{display:block;color:var(--muted);font-size:10px}.small{font-size:11px;color:var(--muted)}a{color:#bad8fc;text-decoration:none}a:hover{text-decoration:underline}.links{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:12px}.notice{border-left:3px solid var(--green);background:#c6f86d06;padding:11px 18px;color:var(--muted)}.bad-text{color:var(--red);border-color:var(--red)}details{margin:12px 0;font-size:12px;color:var(--muted)}summary{cursor:pointer}.filter{display:flex;gap:12px;align-items:center;margin:16px 0}input[type=search]{flex:1;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:9px;padding:11px;color:var(--ink);font:inherit}.filter label{font-size:12px;color:var(--muted)}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--muted);font-size:11px;font-weight:500}th,td{padding:12px 8px;vertical-align:top;border-bottom:1px solid var(--line)}td details{margin:5px 0}li{color:var(--muted);margin:8px 0}.footer{margin-top:30px;padding-top:18px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)}@media(max-width:750px){main{padding:28px 16px 45px}.worlds{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.stat,.card{padding:18px}.filter{flex-wrap:wrap}nav{font-size:9px}.facts>div{grid-template-columns:1.4fr 1fr}}
</style></head><body><main><nav><span>Control Tower / CRM Monitor</span><span>Private evidence · ${escape(runId)}</span></nav><h1>Messy data.<br>Real CRM results.</h1><p class="lead">The same synthetic CRM world, loaded into real HubSpot and Salesforce test accounts. This report separates what the providers accepted, what Control Tower detected, what was safely changed, and what reached human review.</p>${badge(overall, overallLabel)}<section class="stats"><div class="stat"><b>${number(accepted)}</b><span>Explicitly seeded native records</span></div><div class="stat"><b>${allChecks.filter((check) => check.passed === true).length} / ${allChecks.length}</b><span>Recorded checks passed</span></div><div class="stat"><b>${number(verifiedFills)}</b><span>Safe Import fills with native readback</span></div><div class="stat"><b>${providers.filter((provider) => provider.nativeComplete).length} / 2</b><span>Providers with all native phases passed</span></div></section><p class="notice">Missing phases stay visibly incomplete. Counts come from saved native evidence, not the earlier in-memory stress test. Browser presentation: ${badge(uiState)}.</p><section class="worlds">${cards}</section>${companySideEffects}${browserEvidence}<h2>Every recorded check</h2>${allChecks.length ? `<div class="filter"><input id="query" type="search" placeholder="Filter checks by provider or scenario" aria-label="Filter checks"><label><input id="failures" type="checkbox"> Failed checks only</label></div><div class="table-wrap"><table><thead><tr><th>Result</th><th>Provider</th><th>Check</th></tr></thead><tbody id="checks">${checks}</tbody></table></div>` : '<p class="notice">No monitor result has been saved yet. Seeding alone does not verify detection, fixes or triage.</p>'}<h2>Evidence and boundaries</h2><div class="links">${artifacts.join('') || 'Phase artifacts will appear as native checks finish.'}</div><ul>${limits.map((limit) => `<li>${escape(limit)}</li>`).join('')}</ul><div class="footer">Generated ${escape(generatedAt)} · Offline snapshot; rerun the report command after additional phases finish. Private JSON and database links remain local.</div></main><script>const query=document.querySelector('#query'),failures=document.querySelector('#failures');function filter(){for(const row of document.querySelectorAll('#checks tr'))row.hidden=!row.textContent.toLowerCase().includes(query.value.toLowerCase())||(failures.checked&&!row.classList.contains('failed'));}if(query){query.addEventListener('input',filter);failures.addEventListener('change',filter);}</script></body></html>`;
const output = resolve(runRoot, 'report.html');
writeFileSync(output, html, { mode: 0o600 });
console.log(JSON.stringify({ report: output, status: overallLabel, nativeRecords: accepted, nativeProvidersComplete: providers.filter((provider) => provider.nativeComplete).length, generatedAt }));
