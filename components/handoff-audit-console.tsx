'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseHandoffManifest, parseDestinationEvidence, reconcileHandoff } from '@/lib/handoff-audit';
import type { HandoffReport, HandoffRowResult, HandoffStatus, HandoffRoutingStatus } from '@/lib/handoff-audit';
import { createHandoffExample } from '@/lib/handoff-audit-example';

type Manifest = ReturnType<typeof parseHandoffManifest>;
type Evidence = ReturnType<typeof parseDestinationEvidence>;
type Account = { scope: string; provider: 'hubspot' | 'salesforce'; accountId: string };
type Summary = { id: string; name: string; createdAt: string; sourceAccount: string; destinationAccount: string; mode: 'monitor' | 'snapshot' };
type SavedAudit = Summary & { manifest: Manifest; evidence: Evidence; report: HandoffReport; reportId: string; history: { id: string; evaluatedAt: string }[]; relatedIncidents: { id: string; accountId: string; title: string; status: string; kind: string; recordKeys: string[]; href: string }[] };
type Result = { accounts: Account[]; audits: Summary[]; selected: SavedAudit | null };
const button = 'rounded-full border border-white/15 px-4 py-2 text-xs text-[#e0eee5] transition hover:border-[#d8ff67]/50 disabled:opacity-40';
const primary = 'rounded-full bg-[#d8ff67] px-5 py-2.5 text-xs font-semibold text-[#06100d] disabled:opacity-40';
const input = 'w-full min-w-0 rounded-xl border border-white/15 bg-[#081810] px-3 py-2 text-sm text-[#edf8f2]';
const card = 'min-w-0 rounded-2xl border border-white/10 bg-white/[0.025] p-5';
const keyStorage = 'gtm-control-tower-operator-key';
const statusLabels: Record<HandoffStatus, string> = { excluded: 'Intentionally excluded', awaiting_sync: 'Awaiting sync', failed: 'Explicit failure', missing: 'Unexplained missing', present: 'Present in Salesforce', unknown: 'Unknown' };
const routingLabels: Record<HandoffRoutingStatus, string> = { not_applicable: 'Not applicable', awaiting_routing: 'Awaiting routing', unrouted: 'Unrouted', routed: 'Routed', unknown: 'Routing unknown' };
const statuses = Object.keys(statusLabels) as HandoffStatus[];
const routings = Object.keys(routingLabels) as HandoffRoutingStatus[];

export function HandoffAuditConsole() {
  const [accessKey, setAccessKey] = useState('');
  const keyRef = useRef('');
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<Result | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Manifest | null>(null);
  const [draftEvidence, setDraftEvidence] = useState<Evidence | null>(null);
  const [mode, setMode] = useState<'snapshot' | 'monitor'>('snapshot');
  const [manifestText, setManifestText] = useState('');
  const [evidenceText, setEvidenceText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [synthetic, setSynthetic] = useState(false);
  const [preview, setPreview] = useState<HandoffReport | null>(null);
  const [replacement, setReplacement] = useState<Evidence | null>(null);
  const [replacementName, setReplacementName] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [routingFilter, setRoutingFilter] = useState('all');
  const [search, setSearch] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const creationRef = useRef<{ fingerprint: string; requestId: string } | null>(null);

  useEffect(() => {
    const key = window.sessionStorage.getItem(keyStorage) ?? '';
    const id = new URL(window.location.href).searchParams.get('id') ?? '';
    queueMicrotask(() => { keyRef.current = key; setAccessKey(key); setSelectedId(id); setReady(true); });
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await request(keyRef.current, selectedId, undefined, signal);
    if (!signal?.aborted) { setData(result); setError(null); }
  }, [selectedId]);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    void refresh(controller.signal).catch((caught: unknown) => { if (!controller.signal.aborted) setError(message(caught)); });
    return () => controller.abort();
  }, [ready, refresh]);

  function setPrepared(manifest: Manifest, evidence: Evidence | null, isSynthetic = false) {
    creationRef.current = null;
    setDraft(manifest); setDraftEvidence(evidence); setMode(evidence ? 'snapshot' : 'monitor');
    setManifestText(JSON.stringify(manifest, null, 2)); setEvidenceText(evidence ? JSON.stringify(evidence, null, 2) : '');
    setDirty(false); setSynthetic(isSynthetic); setPreview(evidence ? reconcileHandoff(manifest, evidence, new Date().toISOString()) : null);
    setError(null); setNotice(null); setSelectedId(''); setReplacement(null); setReplacementName('');
    setStatusFilter('all'); setRoutingFilter('all'); setSearch('');
  }
  function loadExample() {
    const example = createHandoffExample(new Date().toISOString());
    setPrepared(example.manifest, example.evidence, true);
  }
  async function importFile(file: File) {
    try {
      if (file.size > 5_000_000) throw new Error('Choose a JSON file smaller than 5 MB.');
      const value = JSON.parse(await file.text()) as Record<string, unknown>;
      const manifest = parseHandoffManifest(value.manifest ?? value);
      const evidence = value.evidence ? parseDestinationEvidence(value.evidence) : null;
      setPrepared(manifest, evidence, value.synthetic === true);
      setNotice(`Loaded ${file.name}. Review the cohort, scope and policy before saving.`);
    } catch (caught) { setError(message(caught)); }
  }
  function applyJson() {
    try {
      const manifest = parseHandoffManifest(JSON.parse(manifestText));
      const evidence = evidenceText.trim() ? parseDestinationEvidence(JSON.parse(evidenceText)) : null;
      const currentMode = mode;
      setPrepared(manifest, evidence, synthetic); setMode(currentMode);
      if (currentMode === 'monitor') setPreview(null);
      setNotice('JSON validated. Review the policy and scopes before saving.');
    } catch (caught) { setError(message(caught)); }
  }
  function updateDraft(next: Manifest) {
    setDraft(next); setManifestText(JSON.stringify(next, null, 2)); setError(null);
    try { setPreview(mode === 'snapshot' && draftEvidence ? reconcileHandoff(parseHandoffManifest(next), draftEvidence, new Date().toISOString()) : null); }
    catch (caught) { setPreview(null); setError(message(caught)); }
  }
  function choose(id: string) {
    setSelectedId(id); setDraft(null); setPreview(null); setReplacement(null); setReplacementName(''); setNotice(null); setError(null);
    setData(previous => previous ? { ...previous, selected: null } : previous);
    setStatusFilter('all'); setRoutingFilter('all'); setSearch('');
    const url = new URL(window.location.href); url.searchParams.set('id', id); window.history.replaceState(null, '', url);
  }
  async function save() {
    if (!draft) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const manifest = parseHandoffManifest(draft);
      if (mode === 'monitor' && (!data?.accounts.some(a => a.provider === 'hubspot' && a.scope === manifest.sourceAccount) || !data?.accounts.some(a => a.provider === 'salesforce' && a.scope === manifest.destinationAccount))) throw new Error('Choose an explicit saved HubSpot account and Salesforce account for monitor evidence.');
      if (mode === 'snapshot' && !draftEvidence) throw new Error('Import destination evidence for snapshot mode.');
      const payload = { manifest, ...(mode === 'snapshot' ? { evidence: draftEvidence } : {}) };
      const fingerprint = JSON.stringify(payload);
      if (creationRef.current?.fingerprint !== fingerprint) creationRef.current = { fingerprint, requestId: crypto.randomUUID() };
      const result = await request(keyRef.current, '', { action: 'create', requestId: creationRef.current.requestId, ...payload });
      creationRef.current = null;
      setData(result); setDraft(null); setPreview(null); setSelectedId(result.selected?.id ?? '');
      setNotice('Audit saved locally. The source cohort and policy are fixed; create a new audit to change them.');
      if (result.selected) { const url = new URL(window.location.href); url.searchParams.set('id', result.selected.id); window.history.replaceState(null, '', url); }
    } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  async function reconcile() {
    if (!data?.selected) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await request(keyRef.current, data.selected.id, { action: 'reconcile', id: data.selected.id, ...(replacement && data.selected.mode === 'snapshot' ? { evidence: replacement } : {}) });
      setData(result);
      setNotice(replacement ? 'Reconciled using the replacement snapshot. Source cohort and policy remain fixed.' : data.selected.mode === 'monitor' ? 'Reconciled using retained CRM Monitor evidence. No CRM request or write was made.' : 'Reconciled using the recorded snapshot. Its evidence timestamps have not been refreshed.');
      setReplacement(null); setReplacementName('');
    } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  async function importReplacement(file: File) {
    try {
      if (file.size > 5_000_000) throw new Error('Choose a JSON file smaller than 5 MB.');
      const value = JSON.parse(await file.text()) as Record<string, unknown>;
      setReplacement(parseDestinationEvidence(value.evidence ?? value)); setReplacementName(file.name); setError(null);
      setNotice('Replacement snapshot staged. Reconcile explicitly to use it.');
    } catch (caught) { setError(message(caught)); }
  }

  const selected = !draft && data?.selected?.id === selectedId ? data.selected : null;
  const report = draft ? preview : selected?.report ?? null;
  const manifest = draft ?? selected?.manifest ?? null;
  const evidence = draft ? draftEvidence : selected?.evidence ?? null;
  const visibleRows = report?.rows.filter(row => (statusFilter === 'all' || row.status === statusFilter) && (routingFilter === 'all' || row.routing === routingFilter) && (!search.trim() || `${row.rowId} ${row.sourceId ?? ''} ${row.label ?? ''} ${row.destinationIds.map(id => JSON.stringify(id)).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()))) ?? [];

  return <main className="min-h-screen bg-[#06100d] px-4 py-8 text-[#edf8f2] sm:px-8 lg:py-12"><div className="mx-auto max-w-[1500px]">
    <header className="mb-7 flex flex-wrap items-start justify-between gap-5"><div><p className="text-xs uppercase tracking-[0.2em] text-[#d8ff67]">Control Tower / CRM Monitor</p><h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Follow every handoff.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#a5b9ac]">Account for a fixed HubSpot cohort, verify arrival in Salesforce, and check routing separately. Keep delays, exclusions, explicit failures, and unknowns visible.</p></div><nav aria-label="Related tools" className="flex flex-wrap gap-2"><Link href="/app/incidents" className={button}>Incidents</Link><Link href="/app/monitor" className={button}>Monitor settings</Link><Link href="/app/work" className={button}>Operations Inbox</Link></nav></header>
    <div className="mb-6 rounded-xl border border-[#d8ff67]/20 bg-[#d8ff67]/5 p-4 text-sm leading-6 text-[#c8dccf]"><strong className="text-[#d8ff67]">Read-only audit.</strong> Uses imported snapshots or evidence already retained by CRM Monitor. Saves audit history locally; never replays imports, changes records, or routes leads.</div>
    <form className="mb-6 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); keyRef.current = accessKey; window.sessionStorage.setItem(keyStorage, accessKey); void refresh().catch(caught => setError(message(caught))); }}>
      <label className="w-full text-xs text-[#a5b9ac] sm:w-64">Operator access key<input className={`${input} mt-2`} type="password" value={accessKey} autoComplete="off" onChange={event => setAccessKey(event.target.value)} /></label>
      <button className={button} disabled={busy}>Load saved audits</button>
      <button type="button" className={button} disabled={busy} onClick={loadExample}>Load synthetic example</button>
      <button type="button" className={button} disabled={busy} onClick={() => importRef.current?.click()}>Import audit JSON</button>
      <input ref={importRef} type="file" accept=".json,application/json" aria-label="Import audit JSON file" className="sr-only" onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} />
    </form>
    {error && <p role="alert" className="mb-5 break-words rounded-xl border border-[#ffbb86]/30 bg-[#ffbb86]/5 p-4 text-sm text-[#ffcca5]">{error}</p>}
    {notice && <p role="status" className="mb-5 rounded-xl border border-[#d8ff67]/25 p-4 text-sm leading-6 text-[#d8ff67]">{notice}</p>}
    <div className="grid items-start gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
      <aside className={card}><h2 className="font-medium">Saved audits</h2><p className="mt-2 text-xs leading-5 text-[#a5b9ac]">Cohorts and policy stay fixed. Each explicit reconciliation adds a report.</p><div className="mt-4 space-y-3">{!data?.audits.length && <p className="py-4 text-sm text-[#a5b9ac]">No saved audits loaded. Start with a snapshot or a synthetic example.</p>}{data?.audits.map(audit => <button key={audit.id} className={`w-full break-words rounded-xl border p-4 text-left ${selectedId === audit.id && !draft ? 'border-[#d8ff67]/50 bg-[#d8ff67]/5' : 'border-white/10 hover:border-white/25'}`} disabled={busy} aria-pressed={selectedId === audit.id && !draft} onClick={() => choose(audit.id)}><p className="text-sm font-medium">{audit.name}</p><p className="mt-2 text-xs text-[#a5b9ac]">{audit.mode === 'snapshot' ? 'Imported snapshot' : 'Saved monitor evidence'}</p><p className="mt-2 text-[11px] text-[#82998b]">{date(audit.createdAt)}</p></button>)}</div></aside>
      <div className="min-w-0 space-y-5">
        {!manifest && <section className={`${card} py-14`}><h2 className="text-xl font-medium">Start with the expected source cohort</h2><p className="mt-3 max-w-xl text-sm leading-6 text-[#a5b9ac]">Import a JSON manifest with stable row and source IDs, eligibility evidence, and the expected handoff policy. The synthetic example includes excluded, delayed, failed, missing, arrived, and uncertain records.</p><button className={`${primary} mt-5`} onClick={loadExample}>Explore the synthetic cohort</button><p className="mt-4 text-xs leading-5 text-[#82998b]">No connection or real CRM records are used by the example.</p></section>}
        {draft && <section className={card} aria-label="New audit setup"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">Review a new audit</h2><span className="rounded-full border border-[#d8ff67]/30 px-3 py-1 text-xs text-[#d8ff67]">{synthetic ? 'Synthetic example · no live connection' : 'Unsaved draft'}</span></div><p className="mt-3 text-sm leading-6 text-[#a5b9ac]">Every source row is preserved. Decide what qualifies, when arrival is due, and what counts as completed routing before saving.</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-xs text-[#a5b9ac]">Audit name<input className={`${input} mt-2`} value={draft.name} disabled={dirty} onChange={event => updateDraft({ ...draft, name: event.target.value })} /></label><label className="text-xs text-[#a5b9ac]">Evidence source<select aria-label="Evidence source" className={`${input} mt-2`} value={mode} disabled={dirty} onChange={event => { const next = event.target.value as 'snapshot' | 'monitor'; setMode(next); setPreview(next === 'snapshot' && draftEvidence ? reconcileHandoff(draft, draftEvidence, new Date().toISOString()) : null); }}><option value="snapshot">Imported destination snapshot</option><option value="monitor">Retained CRM Monitor evidence</option></select></label>
          {mode === 'monitor' ? <><ScopeSelect label="Saved HubSpot account" provider="hubspot" value={draft.sourceAccount} accounts={data?.accounts ?? []} disabled={dirty} onChange={value => updateDraft({ ...draft, sourceAccount: value })} /><ScopeSelect label="Saved Salesforce account" provider="salesforce" value={draft.destinationAccount} accounts={data?.accounts ?? []} disabled={dirty} onChange={value => updateDraft({ ...draft, destinationAccount: value })} /></> : <><Field label="Source HubSpot scope" value={draft.sourceAccount} /><Field label="Destination Salesforce scope" value={draft.destinationAccount} /></>}
          {([['syncDeadlineMinutes', 'Sync deadline (minutes)'], ['routingDeadlineMinutes', 'Routing deadline (minutes)'], ['evidenceMaxAgeMinutes', 'Evidence freshness (minutes)']] as const).map(([key, label]) => <label key={key} className="text-xs text-[#a5b9ac]">{label}<input type="number" min="1" step="1" className={`${input} mt-2`} value={draft.policy[key]} disabled={dirty} onChange={event => updateDraft({ ...draft, policy: { ...draft.policy, [key]: Number(event.target.value) } })} /></label>)}</div>
          <p className="mt-4 text-xs text-[#a5b9ac]">{draft.rows.length} preserved source rows · Cohort captured {date(draft.capturedAt)}</p><PolicySummary manifest={draft} />
          {mode === 'snapshot' ? <p className="mt-4 text-xs leading-5 text-[#ffcca5]">Snapshot timestamps and coverage are supplied by the importer. They do not verify a live CRM connection. Edit the scope and matching criteria in the manifest below.</p> : <p className="mt-4 text-xs leading-5 text-[#a5b9ac]">Uses only saved evidence for the two selected accounts. The first report is produced on save. Incomplete monitor coverage remains unknown.</p>}
          <details className="mt-5 rounded-xl border border-white/10 p-4"><summary className="cursor-pointer text-sm">Advanced: manifest and destination evidence JSON</summary><p className="mt-3 text-xs leading-5 text-[#a5b9ac]">Edit eligibility and routing rules, IDs, timestamps, and evidence coverage here. Validate edits to update the preview. To change a saved cohort or policy, create a new audit.</p><label className="mt-4 block text-xs text-[#a5b9ac]">Manifest JSON<textarea aria-label="Manifest JSON" className={`${input} mt-2 font-mono text-xs`} rows={14} spellCheck={false} value={manifestText} onChange={event => { setManifestText(event.target.value); setDirty(true); }} /></label><label className="mt-4 block text-xs text-[#a5b9ac]">Destination evidence JSON<textarea aria-label="Destination evidence JSON" className={`${input} mt-2 font-mono text-xs`} rows={10} spellCheck={false} value={evidenceText} onChange={event => { setEvidenceText(event.target.value); setDirty(true); }} /></label><button type="button" className={`${button} mt-4`} onClick={applyJson}>Validate JSON and preview</button></details>
          <div className="mt-5 flex flex-wrap items-center gap-3"><button className={primary} disabled={busy || dirty || (mode === 'snapshot' && !draftEvidence)} onClick={() => void save()}>Save read-only audit</button><span className="text-xs text-[#a5b9ac]">{dirty ? 'Validate JSON edits before saving.' : 'Saving freezes the cohort and policy.'}</span></div>
        </section>}
        {selected && <section className={card}><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-wider text-[#d8ff67]">Saved read-only audit · {selected.mode === 'snapshot' ? 'Imported snapshot' : 'Retained monitor evidence'}</p><h2 className="mt-3 break-words text-2xl font-semibold">{selected.name}</h2><p className="mt-3 text-xs text-[#a5b9ac]">Created {date(selected.createdAt)} · {selected.history.length} saved reports</p></div><button className={button} disabled={busy} onClick={() => { setPrepared(selected.manifest, selected.mode === 'snapshot' ? selected.evidence : null); setNotice('Copied into a new draft. The saved audit is unchanged.'); }}>Create revised audit</button></div><div className="mt-5 grid gap-4 sm:grid-cols-2"><Field label="Source HubSpot scope" value={selected.sourceAccount} /><Field label="Destination Salesforce scope" value={selected.destinationAccount} /></div><PolicySummary manifest={selected.manifest} /><p className="mt-4 text-xs leading-5 text-[#a5b9ac]">The source cohort and policy are immutable. Reconciliation updates observations against that original expectation.</p>
          {selected.mode === 'snapshot' && <div className="mt-5"><label className="block text-xs text-[#a5b9ac]">Replacement destination snapshot<input type="file" accept=".json,application/json" className="mt-2 block w-full min-w-0 text-xs file:mr-3 file:rounded-full file:border file:border-white/15 file:bg-transparent file:px-3 file:py-2 file:text-[#e0eee5]" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void importReplacement(file); event.target.value = ''; }} /></label><p className="mt-2 break-words text-xs leading-5 text-[#a5b9ac]">{replacement ? `Staged: ${replacementName}. This snapshot is used only when you reconcile.` : 'Without a replacement, reconciliation re-evaluates the existing snapshot and preserves its observation timestamps.'}</p>{replacement && <button className={`${button} mt-2`} onClick={() => { setReplacement(null); setReplacementName(''); }}>Discard staged snapshot</button>}</div>}
          <button className={`${primary} mt-5`} disabled={busy} onClick={() => void reconcile()}>{busy ? 'Reconciling…' : replacement ? 'Reconcile with staged snapshot' : 'Reconcile saved evidence'}</button>
        </section>}
        {report && manifest && <>
          <section className={card} aria-label="Audit results"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">{draft ? 'Snapshot preview' : 'Handoff report'}</h2><p className="mt-2 text-xs leading-5 text-[#a5b9ac]">{report.rows.length} source rows accounted for · Evaluated {date(report.evaluatedAt)}</p></div><div className="flex flex-wrap gap-2"><button className={button} onClick={() => downloadJson({ synthetic: draft ? synthetic : undefined, manifest, evidence, report, ...(selected ? { auditId: selected.id, reportId: selected.reportId } : {}) })}>Export JSON</button><button className={button} onClick={() => downloadCsv(report)}>Export CSV</button></div></div><div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{statuses.map(status => <button key={status} aria-pressed={statusFilter === status} className={`rounded-xl border p-4 text-left ${statusFilter === status ? 'border-[#d8ff67]/60 bg-[#d8ff67]/5' : 'border-white/10'}`} onClick={() => setStatusFilter(statusFilter === status ? 'all' : status)}><p className="text-xs text-[#a5b9ac]">{statusLabels[status]}</p><p className="mt-2 text-2xl font-semibold">{report.counts[status]}</p></button>)}</div><div className="mt-5 border-t border-white/10 pt-4"><h3 className="text-sm font-medium">Routing is checked separately</h3><div className="mt-3 flex flex-wrap gap-2">{routings.map(status => <button key={status} className={button} aria-pressed={routingFilter === status} onClick={() => setRoutingFilter(routingFilter === status ? 'all' : status)}>{routingLabels[status]} · {report.routingCounts[status]}</button>)}</div></div></section>
          <section className={`${card} ${report.evidenceSummary.fresh ? '' : 'border-[#ffbb86]/35'}`} aria-label="Evidence coverage"><h2 className="font-medium">{report.evidenceSummary.fresh ? 'Evidence coverage' : 'Stale or incomplete evidence needs review'}</h2><div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><Field label="Destination observed at" value={date(report.evidenceSummary.observedAt)} /><Field label="Complete through" value={date(report.evidenceSummary.completeThrough)} /><Field label="Coverage" value={`${report.evidenceSummary.coverage} · ${report.evidenceSummary.recordCount} destination records`} /></div><p className="mt-4 text-xs leading-5 text-[#a5b9ac]">{report.evidenceSummary.unmatchedRecordIds.length} destination records have no match in this cohort. They do not change source-row accounting.</p><ul className="mt-4 list-disc space-y-2 pl-5 text-xs leading-5 text-[#ffcca5]">{Array.from(new Set([...report.limitations, ...report.evidenceSummary.limitations])).map((item, index) => <li key={index}>{item}</li>)}</ul></section>
          <section className={card} aria-label="Source row accounting"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-medium">Source row accounting</h2><p className="mt-2 text-xs text-[#a5b9ac]">Showing {visibleRows.length} of {report.rows.length} rows. Open a row for reasons and timestamps.</p></div><button className={button} onClick={() => { setStatusFilter('all'); setRoutingFilter('all'); setSearch(''); }}>Clear filters</button></div><div className="mt-4 grid gap-3 sm:grid-cols-3"><label className="text-xs text-[#a5b9ac]">Arrival status<select aria-label="Arrival status" className={`${input} mt-2`} value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">All arrival statuses</option>{statuses.map(status => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></label><label className="text-xs text-[#a5b9ac]">Routing status<select aria-label="Routing status" className={`${input} mt-2`} value={routingFilter} onChange={event => setRoutingFilter(event.target.value)}><option value="all">All routing statuses</option>{routings.map(status => <option key={status} value={status}>{routingLabels[status]}</option>)}</select></label><label className="text-xs text-[#a5b9ac]">Find row or record ID<input className={`${input} mt-2`} value={search} onChange={event => setSearch(event.target.value)} placeholder="Stable ID or label" /></label></div><div className="mt-5 space-y-3">{visibleRows.map(row => <RowEvidence key={row.rowId} row={row} />)}{!visibleRows.length && <p className="py-8 text-center text-sm text-[#a5b9ac]">No rows match these filters.</p>}</div></section>
        </>}
        {selected && <section className={card}><h2 className="font-medium">Related monitor incidents</h2><p className="mt-2 text-xs leading-5 text-[#a5b9ac]">Related by retained record IDs; an incident is context, not proof of the cause of a missed handoff.</p>{selected.relatedIncidents.length ? <ul className="mt-4 space-y-3">{selected.relatedIncidents.map(incident => <li key={`${incident.accountId}:${incident.id}`}><Link href={incident.href} className="text-sm text-[#d8ff67] underline underline-offset-4">{incident.title}</Link><p className="mt-1 text-xs text-[#a5b9ac]">{incident.status} · {incident.kind.replaceAll('_', ' ')}</p></li>)}</ul> : <p className="mt-4 text-xs text-[#82998b]">No matching retained incidents. This does not establish that no upstream issue occurred.</p>}</section>}
      </div>
    </div>
  </div></main>;
}

function ScopeSelect({ label, provider, accounts, value, disabled, onChange }: { label: string; provider: Account['provider']; accounts: Account[]; value: string; disabled: boolean; onChange: (value: string) => void }) { const available = accounts.filter(account => account.provider === provider); return <label className="text-xs text-[#a5b9ac]">{label}<select aria-label={label} className={`${input} mt-2`} value={available.some(account => account.scope === value) ? value : ''} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="">Choose a saved account</option>{available.map(account => <option key={account.scope} value={account.scope}>{account.accountId} ({account.scope})</option>)}</select></label>; }
function PolicySummary({ manifest }: { manifest: Manifest }) { const policy = manifest.policy; const rule = (item: Manifest['policy']['eligibilityRules'][number]) => `${item.field} ${item.operator.replaceAll('_', ' ')}${item.values.length ? ` ${item.values.map(value => JSON.stringify(value)).join(', ')}` : ''}`; return <div className="mt-5 space-y-3 rounded-xl border border-white/10 p-4 text-xs leading-5 text-[#b9cec0]"><p><strong className="text-[#edf8f2]">Eligibility:</strong> {policy.eligibilityRules.length ? policy.eligibilityRules.map(rule).join(' AND ') : 'No automatic eligibility rules; row-level evidence must establish eligibility.'}</p><p><strong className="text-[#edf8f2]">Destination matching:</strong> explicit Salesforce IDs{policy.destinationMatchField ? ` or the source ID in ${policy.destinationMatchField}` : '; no source-ID matching field configured'}. Ambiguous or missing identifiers remain unknown.</p><p><strong className="text-[#edf8f2]">Routing complete when:</strong> {policy.routingRules.length ? policy.routingRules.map(rule).join(' AND ') : 'No routing criteria configured; completion cannot be established.'}</p><p>Arrival due {policy.syncDeadlineMinutes} minutes after eligibility · Routing due {policy.routingDeadlineMinutes} minutes after the later of eligibility or first retained destination observation · Evidence freshness {policy.evidenceMaxAgeMinutes} minutes.</p></div>; }
function Field({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><p className="text-[11px] text-[#82998b]">{label}</p><p className="mt-1 break-words text-xs leading-5 text-[#c8dccf]">{value}</p></div>; }
function RowEvidence({ row }: { row: HandoffRowResult }) { return <details data-row-id={row.rowId} className="rounded-xl border border-white/10 p-4"><summary className="cursor-pointer"><span className="inline-flex max-w-full flex-wrap items-center gap-2 align-middle"><span className="break-words text-sm font-medium">{row.label || row.rowId}</span><span className="rounded-full border border-white/15 px-2 py-1 text-[10px] text-[#d8ff67]">{statusLabels[row.status]}</span><span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-[#a5b9ac]">{routingLabels[row.routing]}</span></span><span className="mt-2 block break-words pl-4 text-[11px] text-[#82998b]">Row {row.rowId} · HubSpot {row.sourceId || 'ID unknown'}</span></summary><div className="mt-4 border-t border-white/10 pt-4"><ul className="list-disc space-y-2 pl-5 text-xs leading-5 text-[#c8dccf]">{row.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul><div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><Field label="Destination IDs" value={row.destinationIds.length ? row.destinationIds.map(id => typeof id === 'string' ? id : JSON.stringify(id)).join(', ') : 'Not established'} /><Field label="Match method" value={row.evidence.matchMethod.replaceAll('_', ' ')} /><Field label="Eligibility decision" value={row.evidence.eligibility} /><Field label="Eligible at" value={date(row.eligibleAt)} /><Field label="Arrival deadline" value={date(row.deadlineAt)} /><Field label="Routing deadline" value={date(row.routingDeadlineAt)} /><Field label="Source observed at" value={date(row.evidence.sourceObservedAt)} /><Field label="Source updated at" value={date(row.evidence.sourceUpdatedAt)} /><Field label="Destination observed at" value={date(row.evidence.destinationObservedAt)} /><Field label="Destination updated at" value={date(row.evidence.destinationSourceUpdatedAt)} /><Field label="First destination observation" value={date(row.evidence.firstObservedAt)} /><Field label="Last observed status" value={`${row.evidence.lastObservedStatus ? statusLabels[row.evidence.lastObservedStatus] : 'Not established'} / ${row.evidence.lastObservedRouting ? routingLabels[row.evidence.lastObservedRouting] : 'Not established'}`} /></div>{row.evidence.failure && <pre className="mt-4 whitespace-pre-wrap break-words rounded-lg bg-[#081810] p-3 text-xs leading-5 text-[#ffcca5]">{JSON.stringify(row.evidence.failure, null, 2)}</pre>}</div></details>; }
function date(value: string | null | undefined) { return value ? new Date(value).toLocaleString() : 'Not observed'; }
function message(value: unknown) { return value instanceof Error ? value.message : 'The handoff audit could not load.'; }
async function request(key: string, id: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Result> { const query = new URLSearchParams(); if (id) query.set('id', id); const response = await fetch(`/api/control-tower/handoff-audits?${query}`, { method: body ? 'POST' : 'GET', cache: 'no-store', signal, headers: { 'x-control-tower-key': key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); const result = await response.json() as Result & { error?: string }; if (!response.ok) throw new Error(result.error ?? 'Handoff audit request failed.'); return result; }
function downloadFile(text: string, filename: string, type: string) { const url = URL.createObjectURL(new Blob([text], { type })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }
function downloadJson(value: Record<string, unknown>) { downloadFile(JSON.stringify({ exportedAt: new Date().toISOString(), scope: 'Read-only handoff audit. Imported or retained evidence; not a complete CRM history.', ...value }, null, 2), 'handoff-audit.json', 'application/json'); }
function downloadCsv(report: HandoffReport) { const neutralize = (value: unknown) => { const text = String(value ?? ''); return `"${(/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`; }; const columns = ['row_id', 'source_id', 'label', 'arrival_status', 'routing_status', 'destination_ids', 'eligible_at', 'arrival_deadline', 'routing_deadline', 'source_observed_at', 'source_updated_at', 'destination_observed_at', 'destination_updated_at', 'first_observed_at', 'match_method', 'reasons']; const rows = report.rows.map(row => [row.rowId, row.sourceId, row.label, row.status, row.routing, JSON.stringify(row.destinationIds), row.eligibleAt, row.deadlineAt, row.routingDeadlineAt, row.evidence.sourceObservedAt, row.evidence.sourceUpdatedAt, row.evidence.destinationObservedAt, row.evidence.destinationSourceUpdatedAt, row.evidence.firstObservedAt, row.evidence.matchMethod, row.reasons.join(' | ')]); downloadFile([columns, ...rows].map(row => row.map(neutralize).join(',')).join('\r\n'), 'handoff-audit.csv', 'text/csv;charset=utf-8'); }
