'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImportObject, LiveContactState } from '@/lib/live-control-tower';
import type { LocalMatchReviewFinding, LocalMatchReviewReport } from '@/lib/local-match-review-server';

type Props = {
  workspaceId: string | null;
  workspaceRevision: number | null;
  contacts: LiveContactState[];
  importObject?: ImportObject;
  accessKey: string;
  disabled?: boolean;
  suppressionRulesRevision: string;
};
type DecisionStatus = 'all' | 'pending' | 'confirmed' | 'dismissed';
type KindFilter = 'all' | LocalMatchReviewFinding['kind'];
const pageSize = 50;
const buttonClass = 'rounded-full border border-white/20 px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40';
const selectClass = 'mt-1 block w-full rounded-lg border border-white/20 bg-[#071710] px-3 py-2 text-sm';
const kindLabels: Record<LocalMatchReviewFinding['kind'], string> = {
  company_variant: 'Company name suggestion', possible_duplicate: 'Possible duplicate', possible_suppression: 'Possible suppression match',
};
const sourceLabels = { import: 'Imported row', crm: 'Saved CRM record', suppression: 'Suppression rule' };
const fieldLabels = { name: 'Name', email: 'Email', company: 'Company', website: 'Website', phone: 'Phone', state: 'State / region' };
const fields = Object.keys(fieldLabels) as (keyof typeof fieldLabels)[];

function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Local suggestions are unavailable. Try reloading.'; }
function dateLabel(value: string | null) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
}
function exportPage(report: LocalMatchReviewReport) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), scope: 'Current filtered page only', ...report }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = `local-match-review-page-${Math.floor(report.offset / report.limit) + 1}.json`; link.click(); URL.revokeObjectURL(url);
}

export function LocalMatchReview(props: Props) {
  // Any input change discards old findings and cancels pending action responses.
  const reviewKey = JSON.stringify([props.workspaceId, props.workspaceRevision, props.contacts, props.suppressionRulesRevision, props.accessKey, props.disabled, props.importObject]);
  return <LocalMatchPanel key={reviewKey} {...props} />;
}

function LocalMatchPanel({ workspaceId, workspaceRevision, accessKey, disabled = false, importObject = 'contact' }: Props) {
  const [report, setReport] = useState<LocalMatchReviewReport | null>(null);
  const [loading, setLoading] = useState(Boolean(workspaceId && workspaceRevision !== null && !disabled));
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const [status, setStatus] = useState<DecisionStatus>('pending');
  const [kind, setKind] = useState<KindFilter>('all');
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const requestGeneration = useRef(0);
  const actionController = useRef<AbortController | null>(null);
  const activeAction = useRef(false);
  const headers = useMemo(() => {
    const value: Record<string, string> = {};
    if (accessKey) value['x-control-tower-key'] = accessKey;
    return value;
  }, [accessKey]);

  const reload = useCallback(() => { setStale(false); setLoading(true); setError(''); setReport(null); setRefresh((value) => value + 1); }, []);
  function changePage(nextOffset: number) { setLoading(true); setReport(null); setOffset(nextOffset); }

  useEffect(() => () => { actionController.current?.abort(); requestGeneration.current++; }, []);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    if (!workspaceId || workspaceRevision === null || disabled) {
      return () => controller.abort();
    }
    const query = new URLSearchParams({ workspaceId, offset: String(offset), limit: String(pageSize), status, kind });
    void fetch(`/api/control-tower/local-matches?${query}`, { cache: 'no-store', signal: controller.signal, headers })
      .then(async (response) => {
        const payload = await response.json() as LocalMatchReviewReport & { error?: string };
        if (!response.ok) throw new Error(payload.error || 'Local suggestions could not be loaded.');
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        if (!Array.isArray(payload.findings)) throw new Error('The local review returned an incomplete response. Reload to try again.');
        if (payload.workspaceId !== workspaceId || payload.workspaceRevision !== workspaceRevision) {
          setStale(true); throw new Error('The saved workspace changed. Reload the workspace before reviewing suggestions.');
        }
        if (offset && !payload.findings.length) { setOffset(Math.max(0, offset - pageSize)); return; }
        setReport(payload); setStale(false);
      })
      .catch((failure: unknown) => { if (!controller.signal.aborted && generation === requestGeneration.current) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted && generation === requestGeneration.current) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, workspaceRevision, disabled, offset, status, kind, refresh, headers]);

  async function decide(finding: LocalMatchReviewFinding, action: 'confirm' | 'dismiss' | 'clear') {
    if (activeAction.current || disabled || loading || stale || !workspaceId) return;
    const controller = new AbortController();
    actionController.current = controller;
    activeAction.current = true; setSaving(finding.id); setError(''); setNotice('');
    try {
      const response = await fetch('/api/control-tower/local-matches', { method: 'POST', signal: controller.signal,
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, id: finding.id, fingerprint: finding.fingerprint, action }) });
      const payload = await response.json() as { error?: string };
      if (controller.signal.aborted) return;
      if (!response.ok) {
        if (response.status === 409) { setStale(true); setReport(null); }
        throw new Error(payload.error || 'The assessment could not be saved. Reload to see the saved state.');
      }
      setNotice(action === 'clear' ? 'Assessment removed. The suggestion is pending again.' : `${action === 'confirm' ? 'Confirmed' : 'Dismissed'} assessment saved. Imported fields and suppression rules are unchanged.`);
      reload();
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (actionController.current === controller) { activeAction.current = false; actionController.current = null; setSaving(null); }
    }
  }

  const companyMode = (report?.importObject ?? importObject) === 'company';
  const busy = disabled || loading || Boolean(saving) || stale;
  return <section aria-label="Local matching suggestions" className="mb-6 rounded-3xl border border-white/10 bg-[#0c1d17] p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-display text-xl">Local matching suggestions</h3>
        <p className="mt-2 text-sm text-[#bdcbc4]">{companyMode ? 'Find company name variations and close suppression matches using company names and websites already saved here.' : 'Find company name variations, possible duplicate people and close suppression matches using evidence already saved here.'}</p></div>
      <span className="rounded-full bg-[#b8d8ff]/10 px-3 py-1 text-xs font-semibold text-[#b8d8ff]">Local only · no paid checks</span>
    </div>
    <p className="mt-3 text-xs leading-5 text-[#9db1a7]">Confirm records your assessment. Use row editing or suppression controls to apply changes. {companyMode ? 'Suggestions do not rename, merge or associate companies, or write to the CRM.' : 'Suggestions do not merge people, change emails, choose CRM targets or write to the CRM.'}</p>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="text-xs">Assessment status<select aria-label="Assessment status" className={selectClass} value={status} disabled={disabled || loading || Boolean(saving)} onChange={(event) => { setLoading(true); setReport(null); setError(''); setStatus(event.target.value as DecisionStatus); setOffset(0); }}>
        <option value="pending">Pending assessments</option><option value="all">All assessments</option><option value="confirmed">Confirmed</option><option value="dismissed">Dismissed</option>
      </select></label>
      <label className="text-xs">Suggestion type<select aria-label="Suggestion type" className={selectClass} value={kind} disabled={disabled || loading || Boolean(saving)} onChange={(event) => { setLoading(true); setReport(null); setError(''); setKind(event.target.value as KindFilter); setOffset(0); }}>
        <option value="all">All suggestion types</option>{Object.entries(kindLabels).filter(([value]) => !companyMode || value !== 'possible_duplicate').map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className={buttonClass} disabled={disabled || loading || Boolean(saving) || !workspaceId} onClick={reload}>Reload local suggestions</button>
      <button type="button" className={buttonClass} disabled={busy || !report?.findings.length} onClick={() => report && exportPage(report)}>Export this page (JSON)</button>
    </div>
    {loading && <p role="status" className="mt-3 text-sm text-[#9db1a7]">Comparing saved evidence locally…</p>}
    {disabled && <p role="status" className="mt-3 text-sm text-[#9db1a7]">Save the workspace and finish pending changes to review current suggestions.</p>}
    {!workspaceId && <p className="mt-3 text-sm text-[#9db1a7]">Save this import to review local suggestions.</p>}
    {error && <p role="alert" className="mt-3 break-words text-sm text-[#ffb19a]">{error}</p>}
    {stale && <p role="status" className="mt-2 text-sm text-[#e6bd68]">The evidence changed. Reload current suggestions before confirming or dismissing.</p>}
    {notice && <p role="status" className="mt-3 text-sm text-[#b8d8ff]">{notice}</p>}
    {report && <>
      <p role="status" className="mt-4 text-sm">{report.counts.pending} pending · {report.counts.confirmed} confirmed · {report.counts.dismissed} dismissed</p>
      <details className="mt-3 rounded-xl border border-white/10 p-3">
        <summary className="cursor-pointer text-xs font-semibold">Evidence coverage and matching limits</summary>
        <p className="mt-3 text-xs leading-5 text-[#9db1a7]">Compared {report.coverage.importRows.toLocaleString()} imported rows, {report.coverage.crmRecords.toLocaleString()} saved CRM records and {report.coverage.suppressionRules.toLocaleString()} suppression rules across {report.coverage.comparedPairs.toLocaleString()} candidate pairs. Priority indicates review order, not a probability that two records are the same.</p>
        {!companyMode && <p className="mt-2 text-xs leading-5 text-[#9db1a7]">{report.rarity.available ? `Name frequency is estimated from ${report.rarity.sampleSize.toLocaleString()} records in your available data; it is not population-wide name rarity.` : `There is not enough data to estimate name rarity (${report.rarity.sampleSize.toLocaleString()} records). Names alone receive limited weight.`}</p>}
        {report.snapshots.length ? <ul className="mt-2 space-y-1 text-xs text-[#9db1a7]">{report.snapshots.map((snapshot) => <li key={snapshot.id} className="break-words">{snapshot.connectorId} snapshot · {snapshot.recordsScanned.toLocaleString()} records · {dateLabel(snapshot.completedAt)} · {snapshot.sourceComplete ? 'Saved scan complete' : 'Partial saved scan'}</li>)}</ul>
          : <p className="mt-2 text-xs text-[#9db1a7]">No saved CRM snapshots were available. No CRM lookup was requested.</p>}
        <p className="mt-2 text-xs text-[#9db1a7]">Missing values are not evidence of agreement. {companyMode ? 'Companies with similar names may be unrelated.' : 'Multiple people may share a name or employer.'} Saved assessments return to pending when their supporting evidence changes.</p>
      </details>
      {report.warnings.length > 0 && <ul aria-label="Matching limitations" className="mt-3 space-y-1 text-xs leading-5 text-[#e6bd68]">{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <div className="mt-4 space-y-3">{report.findings.map((finding) => <article key={finding.id} aria-label={`Local suggestion ${finding.id}`} className="rounded-xl border border-white/10 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0"><p className="break-words text-sm font-semibold">{finding.title}</p><p className="mt-1 break-words text-xs text-[#9db1a7]">{kindLabels[finding.kind]} · Row {finding.contactId}</p></div>
          <span className={`rounded-full px-2 py-1 text-xs ${finding.priority === 'high' ? 'bg-[#e6bd68]/10 text-[#e6bd68]' : 'bg-white/5 text-[#9db1a7]'}`}>{finding.priority === 'high' ? 'Higher' : finding.priority === 'medium' ? 'Medium' : 'Low'} priority</span>
        </div>
        <ul className="mt-3 space-y-2 text-xs leading-5">{finding.reasons.map((reason, index) => <li key={`${reason.code}:${index}`} className={reason.tone === 'conflict' ? 'text-[#e6bd68]' : reason.tone === 'caution' ? 'text-[#9db1a7]' : 'text-[#bdcbc4]'}><span className="font-semibold">{reason.tone === 'conflict' ? 'Conflict: ' : reason.tone === 'caution' ? 'Note: ' : 'Evidence: '}</span>{reason.message}</li>)}</ul>
        <details className="mt-3 rounded-lg border border-white/10 p-3">
          <summary className="cursor-pointer text-xs font-semibold">Compare fields and sources</summary>
          <div className="mt-3 grid grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 text-xs">
            <span>Field</span><span className="break-words font-semibold">{sourceLabels[finding.input.source]} · {finding.input.id}</span><span className="break-words font-semibold">{sourceLabels[finding.candidate.source]} · {finding.candidate.id}</span>
            {fields.filter((field) => (!companyMode || (field !== 'name' && field !== 'email')) && (finding.input[field] || finding.candidate[field])).map((field) => <FieldComparison key={field} label={fieldLabels[field]} input={finding.input[field]} candidate={finding.candidate[field]} />)}
          </div>
        </details>
        {finding.decision && <p className="mt-3 text-xs text-[#b8d8ff]">{finding.decision.status === 'confirmed' ? 'Confirmed' : 'Dismissed'} · {dateLabel(finding.decision.decidedAt)}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {finding.decision ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void decide(finding, 'clear')}>Undo assessment</button> : <>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void decide(finding, 'confirm')}>Confirm</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void decide(finding, 'dismiss')}>Dismiss</button>
          </>}
          {saving === finding.id && <span role="status" className="self-center text-xs text-[#9db1a7]">Saving assessment…</span>}
        </div>
      </article>)}</div>
      {!report.findings.length && <p className="mt-4 text-sm text-[#9db1a7]">No suggestions match these filters. This does not prove every row is unique or correct.</p>}
      {report.total > 0 && <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[#9db1a7]">
        <span>{report.offset + 1}–{Math.min(report.offset + report.findings.length, report.total)} of {report.total} suggestions</span>
        <button type="button" className={buttonClass} disabled={busy || offset === 0} onClick={() => changePage(Math.max(0, offset - pageSize))}>Previous suggestions</button>
        <button type="button" className={buttonClass} disabled={busy || report.nextOffset === null} onClick={() => report.nextOffset !== null && changePage(report.nextOffset)}>Next suggestions</button>
      </div>}
    </>}
  </section>;
}

function FieldComparison({ label, input, candidate }: { label: string; input?: string | null; candidate?: string | null }) {
  return <><span className="border-t border-white/10 pt-2 text-[#9db1a7]">{label}</span><span className="break-words border-t border-white/10 pt-2">{input || 'Not provided'}</span><span className="break-words border-t border-white/10 pt-2">{candidate || 'Not provided'}</span></>;
}
