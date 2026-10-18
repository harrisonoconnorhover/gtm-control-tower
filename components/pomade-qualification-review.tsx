'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveContactState } from '@/lib/live-control-tower';
import { deriveImportReadiness, type ImportReadiness } from '@/lib/import-readiness';
import type { WebsiteReviewSnapshot } from './website-check-review';
import {
  POMADE_QUALIFICATION_LIMIT, qualificationInputs, qualificationMatchesCurrentInputs,
  type PomadeQualificationResponse, type QualificationCheck,
} from '@/lib/pomade-qualification';

type Props = { contacts: LiveContactState[]; workspaceId: string | null; accessKey: string; disabled?: boolean; websites: WebsiteReviewSnapshot; suppressionState?: 'loading' | 'error' | 'ready' };
const buttonClass = 'rounded-full border border-white/20 px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40';
const pageSize = 10;

export function PomadeQualificationReview(props: Props) {
  return <QualificationReview key={`${props.workspaceId}:${props.accessKey}`} {...props} />;
}

function QualificationReview({ contacts, workspaceId, accessKey, disabled = false, websites, suppressionState = 'ready' }: Props) {
  const [response, setResponse] = useState<PomadeQualificationResponse | null>(null);
  const [criteria, setCriteria] = useState('');
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(0);
  const [reload, setReload] = useState(0);
  const [runBusy, setRunBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const receiveResponse = useCallback((result: PomadeQualificationResponse) => { setResponse(result); setLoadFailed(false); }, []);
  const inputs = useMemo(() => qualificationInputs(contacts), [contacts]);
  const qualification = response?.qualification;
  const inputsChanged = Boolean(qualification && workspaceId &&
    !qualificationMatchesCurrentInputs(workspaceId, contacts, qualification.rows, qualification.icpCriteria));
  const criteriaChanged = Boolean(qualification && criteria.trim() !== qualification.icpCriteria);
  const stale = Boolean(qualification?.stale || inputsChanged || criteriaChanged);
  const missing = inputs.filter((row) => !row.company.trim() || !row.website.trim() || !row.email.trim()).length;
  const lastPage = Math.max(0, Math.ceil((qualification?.rows.length ?? 0) / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const rows = qualification?.rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize) ?? [];
  const execution = qualification?.execution;
  const runActive = Boolean(execution && ['starting', 'unknown', 'queued', 'running', 'paused'].includes(execution.status));
  const unavailable = disabled || suppressionState !== 'ready' || loading || busy || runBusy || runActive || !workspaceId || !response?.configured;
  const readiness = deriveImportReadiness({ contacts, workspaceId, websiteChecks: websites.checks, qualification: qualification ?? null,
    suppressionState, qualificationStale: stale, websiteState: websites.state, qualificationState: loading || busy || runBusy ? 'loading' : loadFailed ? 'error' : 'ready', unsaved: disabled });

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const result = await requestQualification(`/api/control-tower/pomade-qualification?workspaceId=${encodeURIComponent(workspaceId!)}`, accessKey, controller.signal);
        if (controller.signal.aborted) return;
        receiveResponse(result);
        setCriteria(result.qualification?.icpCriteria ?? '');
        setError('');
      } catch (failure) {
        if (!controller.signal.aborted) { setLoadFailed(true); setError(message(failure)); }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [workspaceId, accessKey, reload, receiveResponse]);

  async function submit(action: 'send' | 'refresh') {
    if (unavailable) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await requestQualification('/api/control-tower/pomade-qualification', accessKey, undefined,
        { action, workspaceId, ...(action === 'send' ? { icpCriteria: criteria.trim() } : {}) });
      receiveResponse(result);
      if (result.qualification) setCriteria(result.qualification.icpCriteria);
      setPage(0);
      setNotice(action === 'send'
        ? 'List saved in Pomade. Choose rows and checks below, then preview the run.'
        : 'Saved Pomade results refreshed. No checks were rerun.');
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  return <section aria-label="Pomade qualification" className="mb-6 rounded-3xl border border-white/10 bg-[#0c1d17] p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="font-display text-xl">Pomade qualification</h3>
        <p className="mt-2 text-sm text-[#bdcbc4]">Check company identity, fit with your ideal customer profile, and email verification.</p>
      </div>
      <span className="rounded-full bg-[#b8d8ff]/10 px-3 py-1 text-xs font-semibold text-[#b8d8ff]">No CRM changes</span>
    </div>
    <p className="mt-3 text-xs leading-5 text-[#9db1a7]">Send the included rows to Pomade, preview the checks and their providers, then approve the run here. Results appear below as the run progresses. Sending and previewing do not run checks or send email.</p>
    <p className="mt-2 text-xs text-[#9db1a7]">{inputs.length} included rows · {missing} missing a company, website, or email. Skipped, suppressed and merged rows are excluded.</p>
    {!workspaceId && <p className="mt-3 text-sm text-[#e6bd68]">Save this workspace before sending its rows to Pomade.</p>}
    {response && !response.configured && <p className="mt-3 text-sm text-[#e6bd68]">Pomade is not connected on this installation. Your saved results remain available below.</p>}
    <label className="mt-4 block text-sm font-semibold" htmlFor="pomade-icp-criteria">ICP criteria</label>
    <textarea id="pomade-icp-criteria" value={criteria} maxLength={1500} rows={3}
      disabled={loading || busy || runBusy || runActive} onChange={(event) => setCriteria(event.target.value)}
      placeholder="Describe required characteristics and exclusions for your ideal customers."
      className="mt-2 w-full rounded-xl border border-white/15 bg-[#071710] px-3 py-2 text-sm text-[#dce9e2] placeholder:text-[#71877c]" />
    {inputs.length > POMADE_QUALIFICATION_LIMIT && <p className="mt-2 text-sm text-[#e6bd68]">Send up to {POMADE_QUALIFICATION_LIMIT} included rows at a time. Split larger lists into smaller saved workspaces.</p>}
    {disabled && <p className="mt-2 text-xs text-[#e6bd68]">Wait for your workspace changes to finish saving before sending or refreshing.</p>}
    {stale && <p role="status" className="mt-3 rounded-xl border border-[#e6bd68]/30 p-3 text-sm text-[#e6bd68]">The included rows or ICP criteria have changed. The results below belong to the previous list. Save your changes and send the list again before relying on them.</p>}
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button type="button" className={buttonClass} disabled={unavailable || !criteria.trim() || !inputs.length || inputs.length > POMADE_QUALIFICATION_LIMIT}
        onClick={() => void submit('send')}>{busy ? 'Working…' : qualification && stale ? 'Send updated list to Pomade' : 'Send to Pomade'}</button>
      {qualification && <>
        <a href={qualification.tableUrl} target="_blank" rel="noopener noreferrer" className={buttonClass}>Open in Pomade</a>
        <button type="button" className={buttonClass} disabled={unavailable || stale} onClick={() => void submit('refresh')}>Refresh Pomade results</button>
      </>}
      {error && <button type="button" className={buttonClass} disabled={busy || loading} onClick={() => setReload((value) => value + 1)}>Reload saved qualification</button>}
    </div>
    {loading && <p role="status" className="mt-3 text-xs text-[#9db1a7]">Loading saved qualification…</p>}
    {error && <p role="alert" className="mt-3 text-sm text-[#ffb19a]">{error}</p>}
    {notice && <p role="status" className="mt-3 text-sm text-[#b8d8ff]">{notice}</p>}
    <ReadinessReview readiness={readiness} />
    {qualification && workspaceId && <QualificationRunControls key={qualification.qualificationId} workspaceId={workspaceId} accessKey={accessKey}
      response={response!} availableRowIds={inputs.map((row) => row.sourceRowId)} stale={stale} disabled={disabled || suppressionState !== 'ready' || loading || busy || !response?.configured}
      onResponse={receiveResponse} onBusy={setRunBusy} />}
    {qualification && <>
      <p className="mt-4 text-xs text-[#9db1a7]">Sent {formatTime(qualification.sentAt)} · {qualification.refreshedAt ? `Results refreshed ${formatTime(qualification.refreshedAt)}` : 'Results have not been refreshed yet'}.</p>
      <p className="mt-2 text-xs leading-5 text-[#9db1a7]">These observations do not change source values or approve an import. A working website does not establish identity, and an email provider result does not guarantee delivery.</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-xs">
          <thead><tr className="border-b border-white/15 text-[#9db1a7]"><th className="p-3">Company and website</th><th className="p-3">Company identity</th><th className="p-3">ICP fit</th><th className="p-3">Email verification</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.sourceRowId} className="border-b border-white/10 align-top">
            <td className="max-w-60 break-words p-3"><p className="font-semibold text-[#dce9e2]">{row.inputs.company || 'Company missing'}</p><p className="mt-1 break-all text-[#9db1a7]">{row.inputs.website || 'Website missing'}</p><p className="mt-1 text-[#71877c]">Row {row.sourceRowId}</p></td>
            <td className="p-3"><CheckResult check={row.identity} stale={stale} /></td>
            <td className="p-3"><CheckResult check={row.icp} stale={stale} /></td>
            <td className="max-w-64 p-3"><p className="mb-2 break-all text-[#9db1a7]">{row.inputs.email || 'Email missing'}</p><CheckResult check={row.email} stale={stale} /></td>
          </tr>)}</tbody>
        </table>
      </div>
      {qualification.rows.length > pageSize && <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[#9db1a7]">
        <span>{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, qualification.rows.length)} of {qualification.rows.length} rows</span>
        <button type="button" className={buttonClass} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous qualification rows</button>
        <button type="button" className={buttonClass} disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next qualification rows</button>
      </div>}
    </>}
  </section>;
}

const readinessLabels = { ready: 'Ready to import', needs_review: 'Needs review', excluded: 'Excluded' } as const;

function ReadinessReview({ readiness }: { readiness: ImportReadiness }) {
  const [filter, setFilter] = useState<'all' | keyof typeof readinessLabels>('all');
  const [page, setPage] = useState(0);
  const filtered = readiness.rows.filter((row) => filter === 'all' || row.status === filter);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  return <section aria-label="Import readiness" className="mt-5 rounded-2xl border border-white/15 p-4">
    <h4 className="text-sm font-semibold">Import readiness</h4>
    <p className="mt-2 text-xs leading-5 text-[#9db1a7]">Based on saved website, Pomade, suppression and local row checks. CRM matching, field policies and approval still apply.</p>
    <p className="mt-3 text-sm" role="status">{readiness.counts.ready} ready to import · {readiness.counts.needsReview} need review · {readiness.counts.excluded} excluded</p>
    <label className="mt-3 flex flex-wrap items-center gap-2 text-xs">Filter readiness
      <select aria-label="Filter readiness" value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setPage(0); }}
        className="rounded-lg border border-white/20 bg-[#071710] px-3 py-2">
        <option value="all">All rows</option>
        {Object.entries(readinessLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead><tr className="border-b border-white/15 text-[#9db1a7]"><th className="p-3">Company and email</th><th className="p-3">Readiness</th><th className="p-3">Reasons</th></tr></thead>
        <tbody>{filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((row) => <tr key={row.sourceRowId} className="border-b border-white/10 align-top">
          <td className="max-w-64 break-words p-3"><p className="font-semibold">{row.company || 'Company missing'}</p><p className="mt-1 break-all text-[#9db1a7]">{row.email || 'Email missing'}</p><p className="mt-1 text-[#71877c]">Row {row.sourceRowId}</p></td>
          <td className={`p-3 font-semibold ${row.status === 'ready' ? 'text-[#d8ff67]' : 'text-[#e6bd68]'}`}>{readinessLabels[row.status]}</td>
          <td className="max-w-xl p-3 text-[#9db1a7]"><ul className="space-y-1">{row.reasons.map((reason) => <li key={reason.code}>{reason.message}</li>)}</ul></td>
        </tr>)}</tbody>
      </table>
      {!filtered.length && <p className="mt-3 text-xs text-[#9db1a7]">No rows match this filter.</p>}
    </div>
    {filtered.length > pageSize && <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[#9db1a7]">
      <span>{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, filtered.length)} of {filtered.length} rows</span>
      <button type="button" className={buttonClass} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous readiness rows</button>
      <button type="button" className={buttonClass} disabled={(currentPage + 1) * pageSize >= filtered.length} onClick={() => setPage(currentPage + 1)}>Next readiness rows</button>
    </div>}
  </section>;
}

const checkLabels = { identity: 'Company identity', icp: 'ICP fit', email: 'Email verification' } as const;
type CheckKind = keyof typeof checkLabels;
type RunIntent = { action: 'start'; workspaceId: string; sourceRowIds: string[]; checks: CheckKind[];
  previewHash: string; requestId: string; confirmExternalRequests: true };
type RunProps = { workspaceId: string; accessKey: string; availableRowIds: string[]; response: PomadeQualificationResponse; stale: boolean; disabled: boolean;
  onResponse: (response: PomadeQualificationResponse) => void; onBusy: (busy: boolean) => void };

function QualificationRunControls({ workspaceId, accessKey, response, availableRowIds, stale, disabled, onResponse, onBusy }: RunProps) {
  const qualification = response.qualification!;
  const storageKey = `gtm-control-tower-pomade-run-request-${workspaceId}`;
  const [selection, setSelection] = useState<string[] | null>(null);
  const [checks, setChecks] = useState<CheckKind[]>(['identity', 'icp', 'email']);
  const [preview, setPreview] = useState<{ scope: string; value: NonNullable<PomadeQualificationResponse['preview']> } | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollPaused, setPollPaused] = useState(false);
  const [pending, setPending] = useState<RunIntent | null>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || 'null') as RunIntent | null; } catch { return null; }
  });
  const inFlight = useRef(false);
  const rowIds = qualification.rows.map((row) => row.sourceRowId).filter((id) => availableRowIds.includes(id));
  const selectedRows = (selection ?? rowIds).filter((id) => rowIds.includes(id));
  const scope = JSON.stringify([qualification.qualificationId, qualification.requestDigest, selectedRows, checks, stale]);
  const [previousScope, setPreviousScope] = useState(scope);
  if (previousScope !== scope) {
    setPreviousScope(scope);
    setPreview(null);
    setConsent(false);
  }
  const currentPreview = preview?.scope === scope && !stale ? preview.value : null;
  const execution = qualification.execution;
  const active = Boolean(execution && ['starting', 'queued', 'running'].includes(execution.status));
  const recovery: RunIntent | null = pending ?? (execution?.status === 'unknown' ? { action: 'start', workspaceId,
    sourceRowIds: execution.sourceRowIds, checks: execution.checks, previewHash: execution.previewHash,
    requestId: execution.requestId, confirmExternalRequests: true } : null);
  const selectionDisabled = disabled || busy || active || execution?.status === 'paused' || Boolean(recovery);
  const waitingForConfirmation = Boolean(recovery);

  useEffect(() => {
    onBusy(busy || waitingForConfirmation);
    return () => onBusy(false);
  }, [busy, waitingForConfirmation, onBusy]);

  const requestRun = useCallback(async (body: object) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await requestQualification('/api/control-tower/pomade-qualification', accessKey, undefined, { workspaceId, ...body });
      onResponse(result);
      const returned = result.qualification?.execution;
      if (returned && !['unknown', 'starting'].includes(returned.status)) {
        setPending((previous) => {
          if (previous?.requestId === returned.requestId) { localStorage.removeItem(storageKey); return null; }
          return previous;
        });
      }
      return result;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [workspaceId, accessKey, onResponse, storageKey]);

  useEffect(() => {
    if (!active || pollPaused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await requestRun({ action: 'status' }); }
      catch (failure) { if (!stopped) { setError(message(failure)); setPollPaused(true); } return; }
      if (!stopped) timer = setTimeout(() => void poll(), 3_000);
    }
    timer = setTimeout(() => void poll(), 3_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, execution?.requestId, pollPaused, requestRun]);

  function clearPreview() { setPreview(null); setConsent(false); setError(''); }
  async function previewChecks() {
    clearPreview();
    const requestedScope = scope;
    try {
      const result = await requestRun({ action: 'preview', sourceRowIds: selectedRows, checks });
      if (result?.preview) setPreview({ scope: requestedScope, value: result.preview });
    } catch (failure) { setError(message(failure)); }
  }
  async function startChecks(intent?: RunIntent) {
    if (!intent && (!currentPreview?.backgroundAllowed || !consent)) return;
    const body: RunIntent = intent ?? { action: 'start', workspaceId, sourceRowIds: selectedRows, checks,
      previewHash: currentPreview!.previewHash, requestId: crypto.randomUUID(), confirmExternalRequests: true };
    localStorage.setItem(storageKey, JSON.stringify(body));
    setPending(body);
    setPreview(null);
    setConsent(false);
    setPollPaused(false);
    try { await requestRun(body); }
    catch (failure) { setError(`The start response was not confirmed. Check run status before retrying. ${message(failure)}`); }
  }
  async function statusOrCancel(action: 'status' | 'cancel') {
    setPollPaused(false);
    try { await requestRun({ action }); }
    catch (failure) { setError(message(failure)); setPollPaused(true); }
  }

  return <div aria-label="Run Pomade checks" role="region" className="mt-5 rounded-2xl border border-white/15 p-4">
    <h4 className="text-sm font-semibold">Run checks from this review</h4>
    <fieldset disabled={selectionDisabled} className="mt-3">
      <legend className="text-xs text-[#9db1a7]">Choose checks</legend>
      <div className="mt-2 flex flex-wrap gap-4">{(Object.keys(checkLabels) as CheckKind[]).map((kind) => <label key={kind} className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={checks.includes(kind)} onChange={(event) => {
          clearPreview(); setChecks(event.target.checked ? [...checks, kind].sort() : checks.filter((value) => value !== kind));
        }} />{checkLabels[kind]}
      </label>)}</div>
      <details className="mt-4 text-xs">
        <summary className="cursor-pointer">Choose rows · {selectedRows.length} of {rowIds.length} selected</summary>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={() => { clearPreview(); setSelection(null); }}>Select all rows</button>
          <button type="button" className={buttonClass} onClick={() => { clearPreview(); setSelection(rowIds.slice(0, 16)); }}>Select first 16 rows</button>
          <button type="button" className={buttonClass} onClick={() => { clearPreview(); setSelection([]); }}>Clear row selection</button>
        </div>
        <div className="mt-3 grid max-h-56 gap-2 overflow-y-auto sm:grid-cols-2">{qualification.rows.filter((row) => rowIds.includes(row.sourceRowId)).map((row) => <label key={row.sourceRowId} className="flex items-start gap-2 break-words">
          <input type="checkbox" className="mt-0.5" checked={selectedRows.includes(row.sourceRowId)} aria-label={`Check row ${row.sourceRowId}`} onChange={(event) => {
            clearPreview(); setSelection(event.target.checked ? [...selectedRows, row.sourceRowId].sort() : selectedRows.filter((id) => id !== row.sourceRowId));
          }} />{row.inputs.company || row.sourceRowId}<span className="text-[#71877c]">{row.sourceRowId}</span>
        </label>)}</div>
      </details>
    </fieldset>
    <button type="button" className={`${buttonClass} mt-4`} disabled={selectionDisabled || stale || !selectedRows.length || !checks.length}
      onClick={() => void previewChecks()}>Preview checks</button>
    {currentPreview && <div className="mt-4 rounded-xl bg-white/5 p-3" role="region" aria-label="Pomade run preview">
      <p className="text-sm font-semibold">{currentPreview.rowCount} selected rows · up to {currentPreview.maximumSubmissions} provider submissions</p>
      <p className="mt-2 text-xs leading-5 text-[#9db1a7]">These are submission limits, not a price or credit estimate. Your configured providers apply their own credits and subscription limits.</p>
      {currentPreview.warnings.map((warning, index) => <p key={index} className="mt-2 text-xs text-[#e6bd68]">{warning}</p>)}
      {!currentPreview.backgroundAllowed && <p role="alert" className="mt-2 text-sm text-[#e6bd68]">{currentPreview.backgroundIssue || 'This selection cannot run. Choose fewer rows or resolve the setup and input issues below, then preview again.'}</p>}
      <details className="mt-3 text-xs" open>
        <summary className="cursor-pointer">Readiness and provider order</summary>
        <ul className="mt-2 max-h-64 space-y-3 overflow-y-auto">{currentPreview.entries.map((entry) => <li key={`${entry.rowId}:${entry.columnId}`}>
          <p className="font-semibold">{entry.rowLabel} · {entry.columnLabel} · {entry.state}</p>
          <p className="mt-1 text-[#9db1a7]">{entry.steps.length ? entry.steps.join(' → ') : 'No provider steps'} · maximum {entry.maximum}</p>
          {entry.details.map((detail, index) => <p key={index} className="mt-1 text-[#9db1a7]">{detail}</p>)}
        </li>)}</ul>
      </details>
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={consent} disabled={!currentPreview.backgroundAllowed || busy}
          onChange={(event) => setConsent(event.target.checked)} />
        I approve these provider requests and any credits they use.
      </label>
      <button type="button" className={`${buttonClass} mt-3`} disabled={!consent || !currentPreview.backgroundAllowed || busy || disabled || stale}
        onClick={() => void startChecks()}>Run checks</button>
    </div>}
    {execution && <div role="status" className="mt-4 text-sm text-[#b8d8ff]">
      <p className="font-semibold">Run {execution.status}</p>
      {execution.job && <p className="mt-1 text-xs">{execution.job.completedCount} completed · {execution.job.skippedCount} skipped · {execution.job.cursor} of {execution.job.totalRows} rows processed</p>}
      {execution.job?.waitingMessage && <p className="mt-2 text-xs">{execution.job.waitingMessage}</p>}
      {(execution.error || execution.job?.error) && <p className="mt-2 text-[#ffb19a]">{execution.error || execution.job?.error}</p>}
      {active && <p className="mt-2 text-xs">Results update automatically. You can close this page and return to the saved run.</p>}
      {execution.status === 'paused' && <p className="mt-2 text-xs">No automatic retry will run. Review the saved results and cancel the remaining work before starting another run.</p>}
      {['failed', 'cancelled', 'rejected'].includes(execution.status) && <p className="mt-2 text-xs">No automatic retry will run. Review the saved results before previewing another run.</p>}
    </div>}
    {recovery && !active && <p className="mt-3 text-xs text-[#e6bd68]">A start request is awaiting confirmation. Check its saved status or retry that same request. No new request will be created.</p>}
    {(execution || recovery) && <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className={buttonClass} disabled={busy || disabled} onClick={() => void statusOrCancel('status')}>Check run status</button>
      {recovery && !active && <button type="button" className={buttonClass} disabled={busy || disabled || stale} onClick={() => void startChecks(recovery)}>Retry same request</button>}
      {execution && ['starting', 'unknown', 'queued', 'running', 'paused'].includes(execution.status) && <button type="button" className={buttonClass} disabled={busy || disabled}
        onClick={() => void statusOrCancel('cancel')}>Cancel run</button>}
    </div>}
    {active && <p className="mt-2 text-xs text-[#9db1a7]">Cancel stops remaining work. A provider request already in progress may finish and use credits.</p>}
    {pollPaused && <p className="mt-3 text-xs text-[#e6bd68]">Automatic status checks paused. Use Check run status to reconnect; the saved job may still be running.</p>}
    {error && <p role="alert" className="mt-3 text-sm text-[#ffb19a]">{error}</p>}
  </div>;
}

function CheckResult({ check, stale }: { check: QualificationCheck; stale: boolean }) {
  const stateLabel = { not_run: 'Not checked', complete: 'Complete', review: 'Review', error: 'Check failed', stale: 'Stale result' }[check.state];
  const label = stale || check.state === 'stale' ? 'Stale result' : check.assessment || stateLabel;
  const needsReview = stale || check.state !== 'complete' || ['Mismatch', 'Not a fit', 'invalid'].includes(check.assessment ?? '');
  return <div className="max-w-80">
    <p className={`font-semibold ${needsReview ? 'text-[#e6bd68]' : 'text-[#d8ff67]'}`}>{label}</p>
    <details className="mt-2 text-[#9db1a7]">
      <summary className="cursor-pointer">Evidence and check time</summary>
      {(stale || check.state === 'stale') && check.assessment && <p className="mt-2">Previous observation: {check.assessment}</p>}
      <p className="mt-2 whitespace-pre-wrap break-words leading-5">{check.explanation || 'No saved explanation.'}</p>
      {check.checkedAt && <p className="mt-2">Checked {formatTime(check.checkedAt)}{check.provider ? ` · ${check.provider}` : ''}</p>}
      {check.sources.map((source, index) => safeSourceUrl(source.url) && <div key={`${source.url}:${index}`} className="mt-2">
        <a href={source.url} target="_blank" rel="noopener noreferrer" className="break-all text-[#b8d8ff] underline">{source.title || source.url}</a>
        {source.excerpt && <p className="mt-1 break-words">{source.excerpt}</p>}
      </div>)}
    </details>
  </div>;
}

function safeSourceUrl(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function formatTime(value: string) { return new Date(value).toLocaleString(); }
function message(failure: unknown) { return failure instanceof Error ? failure.message : 'Pomade qualification could not be loaded. Reload saved results before retrying.'; }
async function requestQualification(url: string, accessKey: string, signal?: AbortSignal, body?: object): Promise<PomadeQualificationResponse> {
  const headers = new Headers();
  if (accessKey) headers.set('x-control-tower-key', accessKey);
  if (body) headers.set('content-type', 'application/json');
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers, signal, cache: 'no-store', ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json() as PomadeQualificationResponse & { error?: string };
  if (!response.ok) throw new Error(result.error || 'Pomade qualification could not be loaded. Reload saved results before retrying.');
  return result;
}
