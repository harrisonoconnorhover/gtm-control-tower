'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { evaluateCrmCohort, parseCrmCohortDefinition, type CrmCohortDefinition } from '@/lib/crm-cohort';
import { fictionalCrmCohort } from '@/lib/crm-cohort-fixture';
import { createCrmEvidenceRequest, parseCrmEvidenceResult, MAX_CRM_EVIDENCE_BYTES, CRM_EVIDENCE_FIELDS, type CrmEvidenceField } from '@/lib/crm-evidence-request';
import { cohortDecisionKey, exportCohortReport, mergeCohortContacts, mergeCohortPopulationCoverage, reviewCohortResult, validateSavedCrmCohort, type CrmCohortWorkspace } from '@/lib/crm-cohort-review';
import { emptyWorkspaceState, type SavedWorkspace } from '@/lib/workspace';
import type { HubSpotCohortMetadata, HubSpotCohortPage } from '@/lib/hubspot-cohort';
import { retryCrmCohortRead, type CrmCohortReadWait } from '@/lib/crm-cohort-read-retry';

const STORAGE_KEY = 'gtm-control-tower-cohort-workspace-id';
const KEY_STORAGE = 'gtm-control-tower-operator-key';
const input = 'min-w-0 w-full rounded-xl border border-white/15 bg-[#06100d] px-3 py-2 text-sm text-[#edf8f2] outline-none focus:border-[#d8ff67]';
const button = 'rounded-full border border-white/20 px-4 py-2.5 text-sm font-semibold hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40';
const primary = `${button} bg-[#d8ff67] text-[#06100d] hover:bg-[#e4ff95]`;
const panel = 'rounded-2xl border border-white/15 bg-[#0b1b19] p-5 sm:p-6';
const readable = (value: string) => value.replaceAll('_', ' ');
const split = (value: string) => value.split(',').map((part) => part.trim()).filter(Boolean);

function initialDefinition(): CrmCohortDefinition {
  const today = new Date();
  return { schemaVersion: 1, name: 'Closed lost contacts', portalId: '', evaluatedAt: today.toISOString(),
    pipelineId: '', lostStageIds: [], closeDateProperty: 'closedate', dateFrom: `${today.getUTCFullYear() - 1}-01-01`, dateTo: today.toISOString().slice(0, 10),
    inactivity: { property: '', meaning: '', confirmed: false, days: 90 }, lossReasonProperty: null,
    exclusions: [], fitRules: [], followUpProperty: null, activeStageIds: [], wonStageIds: [], verification: null,
    fieldProperties: { jobTitle: 'jobtitle', company: 'company', phone: 'phone', website: 'website' },
    evidenceProperties: { contact: [], company: [], deal: [] }, includeNotes: true, requestedFields: ['jobTitle'] };
}

function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function HubSpotCohortPanel() {
  const [workspace, setWorkspace] = useState<SavedWorkspace | null>(null);
  const [metadata, setMetadata] = useState<HubSpotCohortMetadata | null>(null);
  const [definition, setDefinition] = useState<CrmCohortDefinition>(initialDefinition);
  const [selected, setSelected] = useState<string[]>([]);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('Loading saved cohort');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [readWait, setReadWait] = useState<CrmCohortReadWait | null>(null);
  const readController = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const saved = workspace?.state.crmCohort;
  const evaluation = useMemo(() => saved ? evaluateCrmCohort(saved.definition, saved.contacts) : null, [saved]);
  const latest = saved?.reviews.at(-1);
  const rows = saved?.request && latest ? reviewCohortResult(saved.request, latest) : [];

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      setKey(sessionStorage.getItem(KEY_STORAGE) ?? '');
      const id = localStorage.getItem(STORAGE_KEY);
      if (!id) { setBusy(''); return; }
      try {
        const response = await fetch(`/api/control-tower/workspace?id=${encodeURIComponent(id)}`);
        const body = await response.json() as { workspace?: SavedWorkspace; error?: string };
        if (!response.ok || !body.workspace) throw new Error(body.error ?? 'Saved cohort could not be loaded.');
        const next = body.workspace as SavedWorkspace;
        if (next.state.crmCohort) await validateSavedCrmCohort(next.state.crmCohort);
        if (!cancelled) {
          setWorkspace(next);
          if (next.state.crmCohort) { setDefinition(next.state.crmCohort.definition); setSelected(next.state.crmCohort.selectedContactIds); }
        }
      } catch (caught) { if (!cancelled) setError(message(caught)); }
      finally { if (!cancelled) setBusy(''); }
    }
    void restore();
    return () => { cancelled = true; readController.current?.abort(); };
  }, []);

  async function run(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError(null); setNotice(null);
    try { await action(); } catch (caught) {
      if (caught instanceof Error && caught.name === 'AbortError') setNotice('CRM read stopped. The saved cohort and page position are unchanged; retry when ready.');
      else setError(message(caught));
    } finally { setBusy(''); }
  }

  async function api<T = HubSpotCohortPage>(payload?: unknown): Promise<T> {
    const controller = new AbortController();
    readController.current = controller;
    try {
      return await retryCrmCohortRead<T>({ signal: controller.signal, onWait: setReadWait,
        read: (signal) => fetch('/api/control-tower/crm-cohort', { method: payload ? 'POST' : 'GET', signal,
          headers: { 'content-type': 'application/json', ...(key ? { 'x-control-tower-key': key } : {}) },
          ...(payload ? { body: JSON.stringify(payload) } : {}) }) });
    } finally { readController.current = null; setReadWait(null); }
  }

  async function save(cohort: CrmCohortWorkspace, reason: string, fresh = false) {
    let current = fresh ? null : workspace;
    if (!current) {
      const response = await fetch('/api/control-tower/workspace', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create', name: `${cohort.mode === 'fictional' ? 'Fictional · ' : ''}${cohort.definition.name}` }) });
      const body = await response.json() as { workspace?: SavedWorkspace; error?: string };
      if (!response.ok || !body.workspace) throw new Error(body.error ?? 'A cohort workspace could not be created.');
      current = body.workspace as SavedWorkspace;
    }
    const response = await fetch('/api/control-tower/workspace', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', id: current.id, reason,
        state: { ...emptyWorkspaceState(), ...current.state, crmCohort: cohort } }) });
    const body = await response.json() as { workspace?: SavedWorkspace; error?: string };
    if (!response.ok || !body.workspace) throw new Error(body.error ?? 'Cohort save failed. The previous saved review is unchanged.');
    const next = body.workspace as SavedWorkspace;
    localStorage.setItem(STORAGE_KEY, next.id);
    setWorkspace(next); setDefinition(cohort.definition); setSelected(cohort.selectedContactIds);
    return next;
  }

  async function loadFictional() {
    const fixture = fictionalCrmCohort();
    const evaluated = evaluateCrmCohort(fixture.definition, fixture.contacts);
    const selectedContactIds = evaluated.contacts.filter((contact) => contact.assessments.state !== 'excluded').map((contact) => contact.contactId);
    await save({ mode: 'fictional', definition: fixture.definition, contacts: mergeCohortContacts([], fixture.contacts),
      populationCoverage: { complete: true, missing: [], omittedSourceIds: [] },
      nextCursor: null, totalDeals: null, selectedContactIds, reviews: [] }, 'fictional_crm_cohort_loaded', true);
    setNotice('Fictional CRM cohort saved. No connected CRM or model was called.');
  }

  async function connect() {
    const data = await api<{ metadata: HubSpotCohortMetadata }>();
    const next = data.metadata as HubSpotCohortMetadata;
    setMetadata(next);
    setDefinition((current) => ({ ...current, portalId: next.portalId }));
    setNotice('HubSpot definitions loaded. Choose the pipeline, field meanings and exclusions before previewing.');
  }

  async function preview(more = false) {
    const policy = parseCrmCohortDefinition(more && saved ? saved.definition : { ...definition, evaluatedAt: new Date().toISOString() });
    const data = await api({ action: 'preview', definition: policy, ...(more && saved?.nextCursor ? { after: saved.nextCursor } : {}) }) as HubSpotCohortPage;
    const contacts = mergeCohortContacts(more && saved ? saved.contacts : [], data.contacts);
    const evaluated = evaluateCrmCohort(policy, contacts);
    const selectedContactIds = evaluated.contacts.filter((contact) => contact.assessments.state !== 'excluded').slice(0, 100).map((contact) => contact.contactId);
    const populationCoverage = mergeCohortPopulationCoverage(more ? saved?.populationCoverage : undefined, data.coverage, data.nextCursor);
    await save({ mode: 'hubspot', definition: policy, contacts, nextCursor: data.nextCursor, totalDeals: data.totalDeals,
      populationCoverage, selectedContactIds, reviews: [] }, 'crm_cohort_previewed', !more);
    setNotice(`${contacts.length} contacts saved. ${populationCoverage.complete ? 'Configured population read completed.' : 'Population coverage is incomplete; review the reasons below.'} Review individual coverage before selecting contacts.`);
  }

  async function exportRequest() {
    if (!saved || !workspace || !evaluation) return;
    const contacts = evaluation.contacts.filter((contact) => selected.includes(contact.contactId));
    if (!contacts.length || contacts.length > 100) throw new Error('Select between 1 and 100 contacts.');
    if (contacts.some((contact) => contact.assessments.state === 'excluded')) throw new Error('Excluded contacts cannot be selected for extraction.');
    const request = await createCrmEvidenceRequest({ requestId: crypto.randomUUID(), createdAt: new Date().toISOString(),
      workspaceId: workspace.id, workspaceRevision: String(workspace.revision), portalId: saved.definition.portalId,
      definition: saved.definition as unknown as Record<string, unknown>, contacts });
    await save({ ...saved, selectedContactIds: selected, request, reviews: [] }, 'crm_evidence_request_saved');
    download(request, `crm-evidence-request-${request.requestId}.json`);
    setNotice('Request saved and downloaded. Import it in Pomade using “Import CRM evidence request”.');
  }

  async function importResult(file: File) {
    if (!saved?.request) throw new Error('Save and download a request before importing a result.');
    if (file.size > MAX_CRM_EVIDENCE_BYTES) throw new Error('Use a result smaller than 2 MiB.');
    const result = await parseCrmEvidenceResult(await file.text(), saved.request);
    const existing = saved.reviews.find((review) => JSON.stringify(review.result) === JSON.stringify(result));
    if (existing) { setNotice('This unchanged result is already saved. No duplicate review was created.'); return; }
    if (saved.reviews.length >= 10) throw new Error('This request has 10 result revisions. Prepare a new request to continue.');
    const policy = saved.mode === 'fictional' ? saved.definition : { ...saved.definition, evaluatedAt: new Date().toISOString() };
    const fresh = saved.mode === 'fictional' ? saved.contacts : (await api({ action: 'recheck', definition: policy,
      contacts: saved.request.contacts.map((contact) => ({ contactId: contact.contactId, dealIds: contact.dealIds })) }) as HubSpotCohortPage).contacts;
    const current = evaluateCrmCohort(policy, fresh).contacts;
    await save({ ...saved, reviews: [...saved.reviews, { result, checkedAt: new Date().toISOString(), current, decisions: {} }] }, 'crm_evidence_result_reviewed');
    setNotice(saved.mode === 'fictional' ? 'Fictional result saved against the supplied fictional CRM snapshot. Review each proposed fact.' : 'Result saved after a fresh HubSpot comparison. Review each proposed fact.');
  }

  async function decide(contactId: string, field: CrmEvidenceField, decision: 'accepted' | 'rejected') {
    if (!saved || !latest) return;
    const next = { ...latest, decisions: { ...latest.decisions, [cohortDecisionKey(contactId, field)]: decision } };
    await save({ ...saved, reviews: [...saved.reviews.slice(0, -1), next] }, 'crm_evidence_fact_decision');
    setNotice('Review decision saved. No CRM value changed and no message was sent.');
  }

  return <main className="min-h-screen bg-[#06100d] px-4 py-8 text-[#edf8f2] sm:px-8">
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-widest text-[#d8ff67]">Control Tower · CRM-only</p><h1 className="mt-2 text-3xl font-semibold">Prepare a CRM cohort</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#a9bbb2]">Select existing HubSpot contacts, send only missing facts and CRM evidence to Pomade, then review the returned proposals. Nothing here sends emails or writes CRM fields.</p></div><Link className={button} href="/app/lab">Back to workspace</Link></header>
      <div className="flex flex-wrap gap-3"><button className={primary} disabled={Boolean(busy)} onClick={() => void run('Loading fictional cohort', loadFictional)}>Try fictional cohort</button><button className={button} disabled={Boolean(busy)} onClick={() => void run('Reading HubSpot definitions', connect)}>Load HubSpot definitions</button><span className="self-center text-xs text-[#a9bbb2]">{workspace ? `Saved cohort · revision ${workspace.revision}` : 'No cohort saved yet'}</span></div>
      {busy && <p role="status" className="text-sm text-[#d8ff67]">{busy}…</p>}
      {readWait && <div className="rounded-xl border border-amber-200/30 p-4 text-sm" role="status"><p>{readWait.message}</p><p className="mt-2 text-[#a9bbb2]">Waiting to retry CRM read {readWait.attempt + 1} after {new Date(readWait.retryAt).toLocaleTimeString()}. Your saved cohort and page position stay unchanged.</p><button className={`${button} mt-3`} onClick={() => readController.current?.abort()}>Stop waiting</button></div>}
      {error && <p role="alert" className="rounded-xl border border-red-300/40 p-4 text-sm text-red-200">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-[#d8ff67]/30 p-4 text-sm text-[#d8ff67]">{notice}</p>}
      <details className={panel} open={Boolean(metadata)}><summary className="cursor-pointer font-semibold">HubSpot definition and field meanings</summary><p className="my-3 text-sm text-[#a9bbb2]">These rules describe your CRM. A missing suppression flag or unclear contact date stays unknown. The optional access key remains in this browser tab.</p>
        <label className="mb-4 grid max-w-md gap-2 text-sm">Operator access key<input className={input} type="password" autoComplete="off" value={key} onChange={(event) => { setKey(event.target.value); sessionStorage.setItem(KEY_STORAGE, event.target.value); }} /></label>
        <fieldset disabled={Boolean(busy)}><DefinitionEditor value={definition} onChange={setDefinition} metadata={metadata} /></fieldset>
        <button className={`${primary} mt-5`} disabled={Boolean(busy) || !metadata} onClick={() => void run('Reading selected HubSpot deals', () => preview())}>Preview and save new cohort</button>
        {metadata?.warnings?.map((warning) => <p className="mt-2 text-sm text-amber-200" key={warning}>{warning}</p>)}
      </details>
      {saved && evaluation && <>
        <section className={panel} aria-label="CRM cohort selection"><div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-xl font-semibold">{saved.definition.name}</h2><p className="mt-2 text-sm text-[#a9bbb2]">{saved.mode === 'fictional' ? 'Fictional records · no live CRM connection' : `HubSpot portal ${saved.definition.portalId}`} · {evaluation.contacts.length} contacts · {evaluation.counts.excluded} excluded · {selected.length}/100 selected</p><p className="mt-2 text-xs text-[#a9bbb2]">CRM properties and linked notes only. Email/call/meeting objects, attachments and complete relationship history are outside this version.</p></div>{saved.nextCursor && <button disabled={Boolean(busy)} className={button} onClick={() => void run('Reading next deal page', () => preview(true))}>Read next deal page</button>}</div>
          {saved.nextCursor && <p className="mt-3 text-sm text-amber-200">Partial population: more matching deals remain. {saved.totalDeals !== null ? `${saved.totalDeals} deals reported by HubSpot.` : ''}</p>}
          <div className="mt-3 text-sm" aria-label="Population coverage"><p className={saved.populationCoverage.complete ? 'text-[#a9bbb2]' : 'text-amber-200'}>Population coverage: {saved.populationCoverage.complete ? 'complete for configured sources' : 'incomplete'}.</p>{[...saved.populationCoverage.missing, ...saved.populationCoverage.omittedSourceIds.map((id) => `Omitted: ${id}`)].map((reason) => <p key={reason} className="mt-1 break-words text-xs text-amber-200">{reason}</p>)}</div>
          <div className="mt-5 space-y-3">{evaluation.contacts.map((contact) => <article key={contact.contactId} className="rounded-xl border border-white/15 p-4"><div className="flex items-start gap-3"><input className="mt-1" type="checkbox" aria-label={`Select ${contact.existingValues.fullName ?? contact.contactId}`} checked={selected.includes(contact.contactId)} disabled={Boolean(busy) || contact.assessments.state === 'excluded' || (!selected.includes(contact.contactId) && selected.length >= 100)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, contact.contactId] : current.filter((id) => id !== contact.contactId))} /><div className="min-w-0 flex-1"><h3 className="break-words font-semibold">{contact.existingValues.fullName ?? contact.contactId} <span className="text-xs font-normal text-[#a9bbb2]">· {readable(contact.assessments.state)}</span></h3><p className="mt-1 break-words text-sm text-[#a9bbb2]">{contact.existingValues.email ?? 'Missing email'} · Fit: {readable(contact.assessments.fit)} · Timing: {readable(contact.assessments.timing)} · Email: {contact.assessments.emailVerification}</p><p className="mt-2 text-xs">Missing requested facts: {contact.requestedFields.join(', ') || 'None'}</p>{contact.assessments.reasons.map((reason) => <p key={reason} className="mt-1 break-words text-xs text-amber-200">{reason}</p>)}<details className="mt-3 text-xs"><summary className="cursor-pointer text-[#d8ff67]">CRM evidence and coverage</summary><p className="mt-2">Native contact {contact.contactId}; deal(s) {contact.dealIds.join(', ')}. Coverage: {contact.coverage.complete ? 'complete for configured sources' : 'incomplete'}.</p>{[...contact.coverage.missing, ...contact.coverage.omittedSourceIds.map((id) => `Omitted source: ${id}`)].map((reason) => <p key={reason} className="mt-1 text-amber-200">{reason}</p>)}{contact.evidence.map((source) => <blockquote key={source.id} className="mt-3 break-words border-l-2 border-white/20 pl-3"><p>{source.text}</p><p className="mt-1 text-[#a9bbb2]">{source.objectType} {source.recordId} · {source.eventAt ?? 'Unknown event date'}</p></blockquote>)}</details></div></div></article>)}</div>
          <div className="mt-5 flex flex-wrap gap-3"><button className={primary} disabled={Boolean(busy) || !selected.length} onClick={() => void run('Saving evidence request', exportRequest)}>Save and download evidence request</button>{saved.request && <button className={button} disabled={Boolean(busy)} onClick={() => download(saved.request, `crm-evidence-request-${saved.request!.requestId}.json`)}>Download saved request again</button>}</div><p className="mt-3 text-xs text-[#a9bbb2]">Import the file in Pomade. Only configured missing fields are requested; existing values and contact eligibility remain protected.</p>
        </section>
        {saved.request && <section className={panel} aria-label="Pomade result review"><h2 className="text-xl font-semibold">Review Pomade results</h2><p className="mt-2 text-sm text-[#a9bbb2]">Returned excerpts support review, not automatic approval. {saved.mode === 'fictional' ? 'This example compares against its fictional snapshot.' : 'Import rereads the selected CRM contacts and their eligibility before saving the review.'}</p><input ref={fileInput} type="file" accept=".json,application/json" className="sr-only" aria-label="CRM evidence result file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void run('Checking result and current CRM values', () => importResult(file)); event.currentTarget.value = ''; }} /><button className={`${button} mt-4`} disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>Import Pomade evidence result</button>
          {latest && <div className="mt-5 space-y-4">{rows.map((row) => { const original = saved.request!.contacts.find((contact) => contact.contactId === row.contactId)!; const result = latest.result.contacts.find((contact) => contact.contactId === row.contactId)!; return <article key={row.contactId} className="rounded-xl border border-white/15 p-4" aria-label={`Review ${original.existingValues.fullName ?? row.contactId}`}><h3 className="font-semibold">{original.existingValues.fullName ?? row.contactId} · {readable(row.state)}</h3>{row.reasons.map((reason) => <p key={reason} className="mt-2 text-xs text-amber-200">{reason}</p>)}{result.fields.map((field) => <div key={field.field} className="mt-3 border-t border-white/10 pt-3"><p className="break-words text-sm"><strong>{field.field}</strong>: {field.value ?? readable(field.status)}</p><p className="mt-1 text-xs text-[#a9bbb2]">{field.rationale}</p>{field.evidence.map((evidence) => <blockquote key={`${evidence.sourceId}:${evidence.quote}`} className="mt-2 break-words border-l-2 border-[#d8ff67]/40 pl-3 text-sm">{evidence.quote}<span className="mt-1 block text-xs text-[#a9bbb2]">{evidence.sourceId}</span></blockquote>)}{row.proposals.some((proposal) => proposal.field === field.field) && <div className="mt-3 flex flex-wrap gap-2"><button className={button} disabled={Boolean(busy)} onClick={() => void run('Saving field decision', () => decide(row.contactId, field.field, 'accepted'))}>Accept {field.field} for review</button><button className={button} disabled={Boolean(busy)} onClick={() => void run('Saving field decision', () => decide(row.contactId, field.field, 'rejected'))}>Reject {field.field}</button><span className="self-center text-xs text-[#d8ff67]">{latest.decisions[cohortDecisionKey(row.contactId, field.field)] ?? 'Needs review'}</span></div>}</div>)}</article>; })}<button className={primary} disabled={Boolean(busy)} onClick={() => download(exportCohortReport(saved), `crm-cohort-review-${saved.request!.requestId}.json`)}>Download cohort review</button><p className="text-xs text-[#a9bbb2]">The report includes held contacts and source evidence. It is not permission to send and performs no CRM writes.</p></div>}
        </section>}
      </>}
    </div>
  </main>;
}

function message(error: unknown) { return error instanceof Error ? error.message : 'The operation could not complete.'; }

function DefinitionEditor({ value, onChange, metadata }: { value: CrmCohortDefinition; onChange: (value: CrmCohortDefinition) => void; metadata: HubSpotCohortMetadata | null }) {
  const set = <K extends keyof CrmCohortDefinition>(key: K, next: CrmCohortDefinition[K]) => onChange({ ...value, [key]: next });
  const property = (label: string, current: string, change: (value: string) => void, object: 'contact' | 'deal' | 'company' = 'contact') => <label className="grid gap-2 text-sm">{label}<input className={input} value={current} list={`cohort-${object}-properties`} onChange={(event) => change(event.target.value)} /></label>;
  const stages = metadata?.pipelines.flatMap((pipeline) => pipeline.stages.map((stage) => ({ ...stage, pipelineId: pipeline.id, pipelineLabel: pipeline.label }))) ?? [];
  return <div className="space-y-5">
    {(['contact', 'deal', 'company'] as const).map((object) => <datalist key={object} id={`cohort-${object}-properties`}>{metadata?.properties[object].map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}</datalist>)}
    <div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2 text-sm">Cohort name<input className={input} value={value.name} onChange={(event) => set('name', event.target.value)} /></label><label className="grid gap-2 text-sm">Pipeline<select className={input} value={value.pipelineId} onChange={(event) => set('pipelineId', event.target.value)}><option value="">Choose a pipeline</option>{metadata?.pipelines.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.label}</option>)}</select></label>
      {property('Deal close date property', value.closeDateProperty, (next) => set('closeDateProperty', next), 'deal')}{property('Deal loss reason property', value.lossReasonProperty ?? '', (next) => set('lossReasonProperty', next || null), 'deal')}
      <label className="grid gap-2 text-sm">Closed from<input type="date" className={input} value={value.dateFrom.slice(0, 10)} onChange={(event) => set('dateFrom', event.target.value)} /></label><label className="grid gap-2 text-sm">Closed through<input type="date" className={input} value={value.dateTo.slice(0, 10)} onChange={(event) => set('dateTo', event.target.value)} /></label>
    </div>
    <fieldset><legend className="mb-2 text-sm">Lost stages to include</legend><div className="flex flex-wrap gap-4">{stages.filter((stage) => stage.pipelineId === value.pipelineId).map((stage) => <label key={stage.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.lostStageIds.includes(stage.id)} onChange={(event) => set('lostStageIds', event.target.checked ? [...value.lostStageIds, stage.id] : value.lostStageIds.filter((id) => id !== stage.id))} />{stage.label}</label>)}</div></fieldset>
    <div className="grid gap-4 sm:grid-cols-2">{property('Last meaningful contact property', value.inactivity.property, (next) => set('inactivity', { ...value.inactivity, property: next }))}<label className="grid gap-2 text-sm">Days without meaningful contact<input className={input} type="number" min="1" value={value.inactivity.days} onChange={(event) => set('inactivity', { ...value.inactivity, days: Number(event.target.value) })} /></label><label className="grid gap-2 text-sm sm:col-span-2">What updates this date?<input className={input} placeholder="For example: logged one-to-one calls, emails and meetings" value={value.inactivity.meaning} onChange={(event) => set('inactivity', { ...value.inactivity, meaning: event.target.value })} /></label></div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.inactivity.confirmed} onChange={(event) => set('inactivity', { ...value.inactivity, confirmed: event.target.checked })} />I have confirmed what this CRM date measures.</label>
    {property('Next promised follow-up property (optional)', value.followUpProperty ?? '', (next) => set('followUpProperty', next || null))}
    <fieldset><legend className="mb-2 text-sm">Related deal stages that exclude a contact</legend><div className="flex flex-wrap gap-4">{stages.map((stage) => <label key={`${stage.pipelineId}:${stage.id}`} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={[...value.activeStageIds, ...value.wonStageIds].includes(stage.id)} onChange={(event) => { const name = stage.won ? 'wonStageIds' : 'activeStageIds'; set(name, event.target.checked ? [...value[name], stage.id] : value[name].filter((id) => id !== stage.id)); }} />{stage.pipelineLabel} / {stage.label}</label>)}</div></fieldset>
    <div><h3 className="mb-3 text-sm font-semibold">CRM exclusions</h3>{value.exclusions.map((rule, index) => <div key={index} className="mb-3 grid gap-3 rounded-xl border border-white/10 p-3 sm:grid-cols-3">{property('Exclusion property', rule.property, (next) => set('exclusions', value.exclusions.map((item, i) => i === index ? { ...item, property: next, label: next } : item)))}<label className="grid gap-2 text-sm">Excluded values (comma separated)<input className={input} value={rule.blockedValues.join(', ')} onChange={(event) => set('exclusions', value.exclusions.map((item, i) => i === index ? { ...item, blockedValues: split(event.target.value) } : item))} /></label><label className="grid gap-2 text-sm">Missing value<select className={input} value={rule.missing} onChange={(event) => set('exclusions', value.exclusions.map((item, i) => i === index ? { ...item, missing: event.target.value as 'hold' | 'allow' } : item))}><option value="hold">Hold for review</option><option value="allow">Blank is allowed by this CRM rule</option></select></label><button className={button} onClick={() => set('exclusions', value.exclusions.filter((_, i) => i !== index))}>Remove exclusion</button></div>)}<button className={button} onClick={() => set('exclusions', [...value.exclusions, { property: '', label: 'CRM exclusion', blockedValues: ['true'], missing: 'hold' }])}>Add exclusion</button></div>
    <div><h3 className="mb-3 text-sm font-semibold">Required fit criteria</h3>{value.fitRules.map((rule, index) => <div key={index} className="mb-3 grid gap-3 rounded-xl border border-white/10 p-3 sm:grid-cols-2">{property('Fit property', rule.property, (next) => set('fitRules', value.fitRules.map((item, i) => i === index ? { ...item, property: next, label: next } : item)))}<label className="grid gap-2 text-sm">Allowed values (comma separated)<input className={input} value={rule.allowedValues?.join(', ') ?? ''} onChange={(event) => set('fitRules', value.fitRules.map((item, i) => i === index ? { ...item, allowedValues: event.target.value.trim() ? split(event.target.value) : undefined } : item))} /></label>{(['minimum', 'maximum'] as const).map((bound) => <label key={bound} className="grid gap-2 text-sm">Optional {bound}<input type="number" className={input} value={rule[bound] ?? ''} onChange={(event) => set('fitRules', value.fitRules.map((item, i) => i === index ? { ...item, [bound]: event.target.value === '' ? undefined : Number(event.target.value) } : item))} /></label>)}<button className={button} onClick={() => set('fitRules', value.fitRules.filter((_, i) => i !== index))}>Remove criterion</button></div>)}<button className={button} onClick={() => set('fitRules', [...value.fitRules, { property: '', label: 'Fit criterion', allowedValues: [] }])}>Add fit criterion</button></div>
    <details><summary className="cursor-pointer text-sm font-semibold">Email verification already recorded in CRM</summary><label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(value.verification)} onChange={(event) => set('verification', event.target.checked ? { statusProperty: '', addressProperty: '', dateProperty: '', acceptedValues: ['valid'], maxAgeDays: 30 } : null)} />Map an existing verification result</label>{value.verification && <div className="mt-3 grid gap-4 sm:grid-cols-2">{(['statusProperty', 'addressProperty', 'dateProperty'] as const).map((field) => <div key={field}>{property(({ statusProperty: 'Verification status property', addressProperty: 'Verified address property', dateProperty: 'Verification date property' })[field], value.verification![field], (next) => set('verification', { ...value.verification!, [field]: next }))}</div>)}<label className="grid gap-2 text-sm">Accepted statuses<input className={input} value={value.verification.acceptedValues.join(', ')} onChange={(event) => set('verification', { ...value.verification!, acceptedValues: split(event.target.value) })} /></label><label className="grid gap-2 text-sm">Accepted age in days<input type="number" min="1" className={input} value={value.verification.maxAgeDays} onChange={(event) => set('verification', { ...value.verification!, maxAgeDays: Number(event.target.value) })} /></label></div>}</details>
    <fieldset><legend className="mb-3 text-sm font-semibold">Missing facts to request from Pomade</legend><div className="grid gap-3 sm:grid-cols-2">{CRM_EVIDENCE_FIELDS.map((field) => <div key={field} className="rounded-xl border border-white/10 p-3"><label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={value.requestedFields.includes(field)} onChange={(event) => set('requestedFields', event.target.checked ? [...value.requestedFields, field] : value.requestedFields.filter((item) => item !== field))} />{field}</label>{property(`${field} CRM property`, value.fieldProperties[field], (next) => set('fieldProperties', { ...value.fieldProperties, [field]: next }))}</div>)}</div></fieldset>
    <details><summary className="cursor-pointer text-sm font-semibold">Additional CRM evidence</summary><div className="mt-3 grid gap-4 sm:grid-cols-3">{(['contact', 'company', 'deal'] as const).map((object) => <label key={object} className="grid gap-2 text-sm">{object} text properties (comma separated)<input className={input} value={value.evidenceProperties[object].join(', ')} onChange={(event) => set('evidenceProperties', { ...value.evidenceProperties, [object]: split(event.target.value) })} /></label>)}</div><label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={value.includeNotes} onChange={(event) => set('includeNotes', event.target.checked)} />Include associated CRM notes</label></details>
  </div>;
}
