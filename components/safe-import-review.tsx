'use client';

import { useEffect, useRef, useState } from 'react';
import { ImportMatchReview, type ImportMatchDecisionAction } from './import-match-review';
import { NoModelImportAssistant, type ImportIntentProposal } from '@/lib/import-assistant';
import type { ImportFieldDecision, PortableCrmFieldName } from '@/lib/crm-workflow';
import type { LiveContactState } from '@/lib/live-control-tower';
import { SAFE_IMPORT_RULES, type SafeImportExecution, type SafeImportReview } from '@/lib/safe-import';

const assistant = new NoModelImportAssistant();
const secondary = 'rounded-full border border-white/20 px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40';
const primary = 'rounded-full bg-[#cdfc54] px-5 py-3 text-sm font-semibold text-[#10221a] disabled:cursor-not-allowed disabled:opacity-40';
const labels: Record<PortableCrmFieldName, string> = { firstName: 'First name', lastName: 'Last name', company: 'Company', phone: 'Phone', jobTitle: 'Job title', website: 'Website' };
const reasons: Record<string, string> = {
  'fill-empty-field': 'Fill the empty field', 'populated-crm-value-preserved': 'Preserve the CRM value; incoming value differs',
  'blank-import-preserved': 'Preserve the CRM value; imported cell is empty', 'same-value': 'No change',
  'field-not-selected': 'Preserve the CRM value; field is outside the selected policy',
  'salesforce-contact-account-field-protected': 'Preserve the Contact account relationship; company and website are outside this recipe',
  'suspicious-existing-value-preserved': 'Preserve the CRM value; questionable existing value needs review',
  'invalid-import-value': 'Preserve the CRM value; imported value needs review', 'record-held': 'No update scheduled; identity is held',
};
const rowLabels = { 'proposed-update': 'Proposed update', unchanged: 'No changes', held: 'Identity review', unmatched: 'No confirmed existing match', skipped: 'Skipped', unresolved: 'Lookup unresolved' };

export function SafeImportRecipeSelector({ active, disabled, destinationType = 'hubspot', onAdopt, onOrdinary }: {
  active: boolean; disabled: boolean; destinationType?: 'hubspot' | 'salesforce'; onAdopt: () => Promise<void>; onOrdinary: () => Promise<void>;
}) {
  const isSalesforce = destinationType === 'salesforce';
  const recordsLabel = isSalesforce ? 'Salesforce Leads and Contacts' : 'HubSpot Contacts';
  const [request, setRequest] = useState('');
  const [proposal, setProposal] = useState<ImportIntentProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function adopt() {
    setError(null);
    try { await onAdopt(); setProposal(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The workflow setting could not be saved.'); }
  }
  return <section aria-label="Import workflow" className="mb-6 rounded-3xl border border-[#cdfc54]/20 bg-[#0c1d17] p-5 sm:p-6">
    <p className="font-mono text-[10px] uppercase tracking-wider text-[#cdfc54]">Import workflow · no AI model needed</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <h3 className="mr-auto text-xl font-semibold">Safe Import: Update existing {isSalesforce ? 'Leads and Contacts' : 'contacts'}</h3>
      {!active ? <button type="button" onClick={() => void adopt()} disabled={disabled} className={primary}>Update existing {isSalesforce ? 'CRM records' : 'contacts'} safely</button>
        : <><span className="rounded-full bg-[#cdfc54]/10 px-3 py-1 text-xs text-[#cdfc54]">Selected · {recordsLabel}</span><button type="button" disabled={disabled} className={secondary} onClick={() => void onOrdinary().catch((failure) => setError(failure instanceof Error ? failure.message : 'Workflow save failed.'))}>Use ordinary import</button></>}
    </div>
    {active && <div className="mt-4 rounded-2xl bg-[#07130f]/70 p-4"><p className="text-xs font-semibold text-[#b8d8ff]">Import rules</p><p className="mt-2 text-sm leading-6 text-[#c9d8d0]">{SAFE_IMPORT_RULES}</p><p className="mt-2 text-xs leading-5 text-[#8fa99d]">Upload your file, check the column mapping, and prepare a whole-file review. {isSalesforce ? 'Leads can fill first name, last name, company, phone, title, and website. Contacts can fill first name, last name, phone, and title; account relationships and company websites stay untouched. Lead and Contact matches are checked together; ambiguous identities stay on hold.' : 'Only the approved six contact fields can change.'} Primary email, ownership, lifecycle or Lead status, conversion, consent, subscriptions, and external identifiers stay untouched.</p></div>}
    <details className="mt-4">
      <summary className="cursor-pointer text-xs font-semibold text-[#b8d8ff]">Describe the import you want</summary>
      <label className="mt-3 block text-xs text-[#9db1a7]">Your request<textarea value={request} onChange={(event) => { setRequest(event.target.value); setProposal(null); }} rows={3} maxLength={2000} disabled={disabled} className="mt-2 block w-full resize-y rounded-xl border border-white/15 bg-[#07130f] p-3 text-sm text-[#edf8f2]" placeholder="Update existing contacts without wiping out good information, flag questionable matches, and show me exactly what will happen." /></label>
      <button type="button" disabled={disabled || !request.trim()} className={`${secondary} mt-3`} onClick={() => void assistant.proposeIntent({ request }).then(setProposal)}>Interpret request</button>
      {proposal && <div className="mt-3 rounded-xl border border-[#83bcff]/20 p-4"><p className="text-xs font-semibold text-[#b8d8ff]">Proposed import rules</p><p className="mt-2 text-sm leading-6">{proposal.interpretation}</p>{proposal.question && <p className="mt-2 text-sm text-[#e6bd68]">{proposal.question}</p>}<p className="mt-2 text-xs text-[#8fa99d]">Interpreting a request makes no CRM changes. Adopting these rules saves the workflow; approval happens after review.</p><button type="button" disabled={disabled} onClick={() => void adopt()} className={`${secondary} mt-3`}>Adopt Safe Import rules</button></div>}
    </details>
    {error && <p role="alert" className="mt-3 text-sm text-[#ffb19a]">{error}</p>}
  </section>;
}

type Props = {
  workspaceId: string | null; workspaceRevision: number | null; destinationType?: 'hubspot' | 'salesforce'; initialReviewId?: string; contacts: LiveContactState[]; accessKey: string; disabled: boolean;
  onBusyChange: (busy: boolean) => void; onDecision: (action: ImportMatchDecisionAction) => Promise<void>;
  onSkip: (contactId: string, reason: string) => Promise<void>;
};
type Response = { review: SafeImportReview | null; execution?: SafeImportExecution | null; error?: string; retryAt?: string };

export function SafeImportReview({ workspaceId, workspaceRevision, destinationType = 'hubspot', initialReviewId, contacts, accessKey, disabled, onBusyChange, onDecision, onSkip }: Props) {
  const [review, setReview] = useState<SafeImportReview | null>(null);
  const [execution, setExecution] = useState<SafeImportExecution | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [question, setQuestion] = useState('Why are these rows held?');
  const [rowQuery, setRowQuery] = useState('');
  const [rowFilter, setRowFilter] = useState('all');
  const [rowPage, setRowPage] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!execution?.nextAttemptAt) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [execution?.nextAttemptAt]);
  const requestLock = useRef(false);
  const connectorId = review?.connectorId ?? destinationType;
  const providerLabel = connectorId === 'salesforce' ? 'Salesforce' : 'HubSpot';
  const storageKey = workspaceId ? `gtm-control-tower-safe-import-${workspaceId}` : null;
  const recoveryKey = workspaceId ? `gtm-control-tower-safe-import-recovery-${workspaceId}` : null;
  useEffect(() => {
    if (!workspaceId) return;
    const reviewId = initialReviewId ?? window.localStorage.getItem(`gtm-control-tower-safe-import-recovery-${workspaceId}`)
      ?? window.localStorage.getItem(`gtm-control-tower-safe-import-${workspaceId}`);
    let cancelled = false;
    requestLock.current = true;
    // Loading is read-only. A reload never repeats approval or an interrupted write.
    void request('load', reviewId ?? undefined).then((result) => {
      if (!cancelled) {
        const current = !result.review || result.review.workspaceRevision === workspaceRevision || result.execution;
        setReview(current ? result.review : null); setExecution(result.execution ?? null);
        setUncertain(result.execution?.status === 'reconciliation-required' || result.execution?.status === 'running');
      }
    }).catch((failure) => { if (!cancelled) setError(message(failure)); }).finally(() => { requestLock.current = false; });
    return () => { cancelled = true; };
    // Workspace changes remount this component; an operator key change reruns the authorized read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, accessKey, initialReviewId]);

  async function request(action: 'prepare' | 'approve' | 'recover' | 'load' | 'continue', reviewId?: string): Promise<Response> {
    const response = await fetch('/api/control-tower/safe-import', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(accessKey ? { 'x-control-tower-key': accessKey } : {}) },
      body: JSON.stringify({ action, workspaceId, ...(reviewId ? { reviewId } : {}) }), cache: 'no-store',
    });
    const result = await response.json() as Response;
    if (!response.ok || (action !== 'load' && !result.review)) throw new Error(`${result.error ?? 'Safe Import could not return the saved review.'}${result.retryAt ? ` Retry after ${new Date(result.retryAt).toLocaleString()}; your saved progress is retained.` : ''}`);
    return result;
  }

  async function run(action: 'prepare' | 'approve' | 'recover' | 'load' | 'continue') {
    if (requestLock.current || !workspaceId || (action !== 'prepare' && !review)) return;
    requestLock.current = true;
    setPending(action); onBusyChange(true); setError(null); setExplanation(null);
    if (action === 'approve' && recoveryKey && review) window.localStorage.setItem(recoveryKey, review.id);
    try {
      const result = await request(action, action === 'prepare' ? undefined : review!.id);
      setReview(result.review); setExecution(result.execution ?? null);
      if (storageKey && result.review) window.localStorage.setItem(storageKey, result.review.id);
      const incomplete = result.execution?.status === 'reconciliation-required' || result.execution?.status === 'running';
      setUncertain(incomplete);
      if (recoveryKey && result.execution && result.review) {
        if (incomplete) window.localStorage.setItem(recoveryKey, result.review.id);
        else window.localStorage.removeItem(recoveryKey);
      }
      if (action === 'prepare' && recoveryKey) window.localStorage.removeItem(recoveryKey);
    } catch (failure) {
      setError(message(failure));
      if (action === 'approve') setUncertain(true);
    } finally { requestLock.current = false; setPending(null); onBusyChange(false); }
  }
  const expired = review ? Date.parse(review.expiresAt) <= Math.max(clock, Date.now()) : false;
  const waiting = !expired && Boolean(execution?.nextAttemptAt && Date.parse(execution.nextAttemptAt) > Math.max(clock, Date.now()));
  const outdated = review ? review.workspaceRevision !== workspaceRevision : false;
  const fullyChecked = review?.complete && review.counts.unresolved === 0 && review.rows.every((row) => row.status !== 'unresolved');
  const canApprove = fullyChecked && !outdated && !expired && !execution && !uncertain && review.counts['proposed-update'] > 0;
  const reconciled = execution && execution.status !== 'running' && execution.records.every((record) => !['pending', 'sending'].includes(record.status)
    && (record.status !== 'unknown' || Boolean(record.verification)));
  const canPrepare = !uncertain || reconciled;
  const filteredRows = review?.rows.filter((row) => (rowFilter === 'all' || row.status === rowFilter)
    && [row.contactId, row.email, contacts.find((contact) => contact.contactId === row.contactId)?.fullName ?? ''].join(' ').toLowerCase().includes(rowQuery.trim().toLowerCase())) ?? [];
  const rowPageSize = 25;
  const page = Math.min(rowPage, Math.max(0, Math.ceil(filteredRows.length / rowPageSize) - 1));
  const visibleRows = filteredRows.slice(page * rowPageSize, (page + 1) * rowPageSize);
  return <section aria-label="Safe Import review" className="mb-6 rounded-3xl border border-[#cdfc54]/20 bg-[#0c1d17] p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-wider text-[#cdfc54]">Whole-file review</p><h3 className="mt-1 text-xl font-semibold">Inspect every row before approving updates</h3><p className="mt-2 max-w-2xl text-xs leading-5 text-[#9db1a7]">Prepare review reads {providerLabel} and saves a proposal. It performs no CRM writes. Resolving a held row requires a fresh proposal and new approval.</p></div><button type="button" disabled={disabled || Boolean(pending) || !canPrepare || !workspaceId || !contacts.length} className={primary} onClick={() => void run('prepare')}>{pending === 'prepare' ? 'Reading whole file…' : review ? 'Prepare new review' : 'Prepare review'}</button></div>
    {!workspaceId && <p className="mt-3 text-xs text-[#e6bd68]">A saved workspace and direct {providerLabel} connection are required.</p>}
    {error && <p role="alert" className="mt-4 rounded-xl bg-[#ff9c82]/5 p-3 text-sm text-[#ffb19a]">{error}</p>}
    {uncertain && <p role="status" className="mt-3 text-sm leading-6 text-[#e6bd68]">Saved work remains queued or needs reconciliation. Only unsent records can continue under the original approval. Interrupted or unknown writes are never resent.</p>}
    {uncertain && reconciled && <p className="mt-2 text-xs leading-5 text-[#9db1a7]">Read-back evidence is saved. Acceptance remains unknown for interrupted writes. You can deliberately prepare a new review from current native values; it requires its own approval.</p>}
    {review && <>
      <p className="mt-4 break-words text-xs leading-5 text-[#8fa99d]">{review.sourceFile} · {review.rows.length} rows · {providerLabel} account {review.account.accountId} · Workspace r{review.workspaceRevision} · Expires {new Date(review.expiresAt).toLocaleString()}</p>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{Object.entries(review.counts).map(([status, count]) => <div key={status} className="rounded-xl bg-[#07130f]/70 p-3"><p className={`text-2xl font-semibold ${status === 'proposed-update' ? 'text-[#cdfc54]' : status === 'held' || status === 'unresolved' ? 'text-[#e6bd68]' : ''}`}>{count}</p><p className="mt-1 text-xs leading-5 text-[#9db1a7]">{rowLabels[status as keyof typeof rowLabels]}</p></div>)}</div>
      {!fullyChecked && <p className="mt-3 text-sm text-[#e6bd68]">This file is not fully checked. Unchecked rows cannot be approved.</p>}
      {outdated && <p className="mt-3 text-sm text-[#e6bd68]">The saved workspace changed after this review. Prepare a new review before approving any updates.</p>}
      {expired && !execution && <p className="mt-3 text-sm text-[#e6bd68]">This review expired. Prepare a new review before approving.</p>}
      <div className="mt-4 flex flex-wrap gap-2"><button type="button" className={secondary} onClick={() => download('json', review, execution)}>Download whole review (JSON)</button><button type="button" className={secondary} onClick={() => download('csv', review, execution)}>Download field decisions (CSV)</button><button type="button" className={secondary} disabled={Boolean(pending)} onClick={() => void run('load')}>Reload saved execution</button>{(uncertain || execution) && <button type="button" className={secondary} disabled={Boolean(pending)} onClick={() => void run('recover')}>{pending === 'recover' ? 'Reading native values…' : 'Reconcile and verify (read-only)'}</button>}</div>
      {execution?.nextAttemptAt && <p role="status" className="mt-3 text-sm leading-5 text-[#e6bd68]">{waiting ? 'Waiting until' : 'Retry eligible at'} {new Date(execution.nextAttemptAt).toLocaleString()}. {execution.retryReason} The saved approval still expires at {review && new Date(review.expiresAt).toLocaleString()}.</p>}
      {execution?.records.some((record) => record.status === 'pending') && <div className="mt-3"><p className="text-xs leading-5 text-[#9db1a7]">The background runner processes at most 10 records per chunk. The original review expiry still applies: remaining rows are held when it expires, and require a new review and approval.</p><button type="button" className={`${secondary} mt-2`} disabled={Boolean(pending) || waiting} onClick={() => void run('continue')}>{pending === 'continue' ? 'Processing next chunk…' : waiting ? 'Waiting for CRM capacity…' : 'Continue approved queue'}</button></div>}
      {execution && <ExecutionSummary execution={execution} />}
      <div className="mt-5 grid gap-3 sm:grid-cols-2"><label className="text-xs text-[#9db1a7]">Find reviewed row<input value={rowQuery} onChange={(event) => { setRowQuery(event.target.value); setRowPage(0); }} placeholder="Name, email, or row id" className="mt-2 block w-full rounded-xl border border-white/15 bg-[#07130f] p-3 text-sm text-[#edf8f2]" /></label><label className="text-xs text-[#9db1a7]">Show review decisions<select value={rowFilter} onChange={(event) => { setRowFilter(event.target.value); setRowPage(0); }} className="mt-2 block w-full rounded-xl border border-white/15 bg-[#07130f] p-3 text-sm text-[#edf8f2]"><option value="all">All checked rows</option>{Object.entries(rowLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-[#8fa99d]">{filteredRows.length ? `Showing ${page * rowPageSize + 1}–${Math.min((page + 1) * rowPageSize, filteredRows.length)} of ${filteredRows.length} matching rows.` : 'No rows match this filter.'} Filters do not change the whole-file approval.</p><div className="flex gap-2"><button type="button" className={secondary} disabled={page === 0} onClick={() => setRowPage(page - 1)}>Previous rows</button><button type="button" className={secondary} disabled={(page + 1) * rowPageSize >= filteredRows.length} onClick={() => setRowPage(page + 1)}>Next rows</button></div></div>
      <div className="mt-5 space-y-3">{visibleRows.map((row) => {
        const contact = contacts.find((candidate) => candidate.contactId === row.contactId);
        return <details key={row.contactId} className="rounded-2xl border border-white/10 bg-[#07130f]/60 p-4"><summary className="cursor-pointer break-words text-sm font-semibold">{contact?.fullName || row.email || row.contactId}<span className="ml-2 font-normal text-[#9db1a7]">{row.contactId} · {rowLabels[row.status]}</span></summary>
          {row.reason && <p className="mt-3 text-xs leading-5 text-[#e6bd68]">{row.reason}</p>}
          {row.record?.nativeId && <p className="mt-2 break-all text-xs text-[#9db1a7]">Existing {providerLabel} {row.record.matches[0]?.objectType === 'lead' ? 'Lead' : 'Contact'} {row.record.nativeId} · Primary email {row.record.matchDecision?.email || row.record.matches[0]?.email || 'empty'} is preserved.</p>}
          {row.record?.fieldDecisions?.length ? <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[650px] text-left text-xs leading-5"><thead><tr className="text-[#8fa99d]"><th className="py-2 pr-3">Field</th><th className="py-2 pr-3">Current CRM value</th><th className="py-2 pr-3">Imported value</th><th className="py-2 pr-3">Planned result</th><th className="py-2">Decision</th></tr></thead><tbody>{row.record.fieldDecisions.map((decision) => <FieldDecision key={decision.field} decision={decision} />)}</tbody></table></div> : <p className="mt-3 text-xs text-[#9db1a7]">No field writes are scheduled for this row.</p>}
          {contact && ['held', 'unmatched', 'unresolved'].includes(row.status) && <div className="mt-4"><p className="mb-3 text-xs leading-5 text-[#9db1a7]">Compare identity evidence and confirm the specific existing person with a reason, or skip this row. Matching suggestions alone do not schedule updates.</p><ImportMatchReview safeImport contacts={[contact]} connectorId={connectorId} workspaceId={workspaceId} accessKey={accessKey} disabled={disabled || Boolean(pending)} onDecision={onDecision} /><SkipRow contactId={row.contactId} disabled={disabled || Boolean(pending)} onSkip={onSkip} /></div>}
        </details>;
      })}</div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-5"><p className="max-w-xl text-xs leading-5 text-[#9db1a7]">Approval authorizes this saved plan for this {providerLabel} account. Changed CRM values are held on the final check. CRM reads and writes are separate operations; downstream automations and concurrent external changes are not fully simulated or prevented.</p><button type="button" disabled={disabled || Boolean(pending) || !canApprove} onClick={() => void run('approve')} className={primary}>{pending === 'approve' ? 'Saving approval and starting queue…' : `Approve ${review.counts['proposed-update']} ${connectorId === 'salesforce' ? 'record' : 'contact'} updates`}</button></div>
      <details className="mt-4"><summary className="cursor-pointer text-xs font-semibold text-[#b8d8ff]">Ask about this saved review</summary><label className="mt-3 block text-xs text-[#9db1a7]">Question<input value={question} onChange={(event) => setQuestion(event.target.value)} className="mt-2 block w-full rounded-xl border border-white/15 bg-[#07130f] p-3 text-sm text-[#edf8f2]" /></label><button type="button" disabled={!question.trim()} className={`${secondary} mt-3`} onClick={() => void assistant.explainReview({ review, question }).then((result) => setExplanation(result.text))}>Explain recorded evidence</button>{explanation && <p role="status" className="mt-3 text-sm leading-6 text-[#c9d8d0]">{explanation}</p>}<p className="mt-2 text-xs text-[#71877c]">Deterministic explanation · no model configured</p></details>
    </>}
  </section>;
}

function FieldDecision({ decision }: { decision: ImportFieldDecision }) {
  return <tr className="border-t border-white/10 align-top"><th scope="row" className="py-3 pr-3 font-semibold">{labels[decision.field]}</th><td className="max-w-[180px] break-words py-3 pr-3">{decision.currentValue ?? 'Empty'}</td><td className="max-w-[180px] break-words py-3 pr-3">{decision.importedValue ?? 'Empty'}</td><td className="max-w-[180px] break-words py-3 pr-3">{decision.proposedValue ?? 'Empty'}</td><td className="max-w-[240px] py-3"><p className={decision.action === 'fill' ? 'text-[#cdfc54]' : decision.action === 'review' ? 'text-[#e6bd68]' : 'text-[#b5c6bd]'}>{reasons[decision.reasonCode] ?? decision.reasonCode.replaceAll('-', ' ')}</p><span className="text-[#71877c]">{decision.action}</span></td></tr>;
}
function ExecutionSummary({ execution }: { execution: SafeImportExecution }) {
  const counts = { accepted: 0, verified: 0, different: 0, unavailable: 0, unknown: 0, pending: 0, held: 0, failed: 0 };
  const details = execution.records.filter((record) => record.status !== 'accepted' || record.verification?.status !== 'verified');
  const hasObservedUnknown = execution.records.some((record) => record.status !== 'accepted' && record.verification?.status === 'verified');
  for (const record of execution.records) {
    if (record.status === 'accepted') counts.accepted++;
    if (record.status === 'held') counts.held++;
    if (record.status === 'failed') counts.failed++;
    if (record.status === 'pending') counts.pending++;
    if (['sending', 'unknown'].includes(record.status)) counts.unknown++;
    if (record.verification) counts[record.verification.status]++;
  }
  return <div role="status" className="mt-4 rounded-2xl border border-[#83bcff]/20 bg-[#83bcff]/5 p-4"><p className="font-semibold">Execution: {counts.accepted} updates accepted · {counts.pending} queued · {counts.held} held · {counts.failed} failed · {counts.unknown} unknown</p><p className="mt-2 text-sm text-[#b8d8ff]">Verification: {counts.verified} {hasObservedUnknown ? 'values match' : 'verified'} · {counts.different} differ from the approved result · {counts.unavailable} could not be read</p><p className="mt-2 break-all text-xs text-[#8fa99d]">Saved execution {execution.id} · {execution.status}. A failed verification never reapplies an update.</p>{details.length > 25 && <p className="mt-2 text-xs text-[#9db1a7]">Showing 25 of {details.length} queued or follow-up records. Download the saved review for every result.</p>}{details.slice(0, 25).map((record) => <p key={record.contactId} className="mt-2 text-xs leading-5 text-[#e6bd68]">{record.contactId} · {record.status} · {record.status !== 'accepted' && record.verification?.status === 'verified' ? 'Observed approved values; acceptance unknown' : record.verification?.status ?? 'not verified'}{record.error ? ` · ${record.error}` : ''}{record.verification?.error ? ` · ${record.verification.error}` : ''}</p>)}</div>;
}
function SkipRow({ contactId, disabled, onSkip }: { contactId: string; disabled: boolean; onSkip: Props['onSkip'] }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div className="mt-3"><label className="block text-xs text-[#9db1a7]">Reason to skip this row<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} className="mt-2 block w-full rounded-xl border border-white/15 bg-[#07130f] p-3 text-sm" /></label><button type="button" disabled={disabled || saving || !reason.trim()} className={`${secondary} mt-3`} onClick={() => { setSaving(true); void onSkip(contactId, reason.trim()).catch((failure) => setError(message(failure))).finally(() => setSaving(false)); }}>{saving ? 'Saving selection…' : 'Skip this row'}</button>{error && <p role="alert" className="mt-2 text-xs text-[#ffb19a]">{error}</p>}</div>;
}
function download(format: 'json' | 'csv', review: SafeImportReview, execution: SafeImportExecution | null) {
  // Imported cells are untrusted. JSON retains exact evidence; spreadsheet CSV
  // prefixes formula-looking cells with an apostrophe so opening it cannot run them.
  const cell = (value: unknown) => {
    const raw = String(value ?? '');
    const safe = /^\s*[=+\-@]/u.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const header = ['review_id', 'provider', 'object_type', 'account_id', 'source_file_hash', 'workspace_revision', 'contact_id', 'imported_email', 'row_status', 'row_reason', 'native_id', 'field', 'current_value', 'imported_value', 'proposed_value', 'action', 'reason_code'];
  const lines = review.rows.flatMap((row) => (row.record?.fieldDecisions?.length ? row.record.fieldDecisions : [null]).map((decision) => [review.id, review.connectorId, row.record?.matches[0]?.objectType, review.account.accountId, review.sourceFileHash, review.workspaceRevision, row.contactId, row.email, row.status, row.reason, row.record?.nativeId, decision?.field, decision?.currentValue, decision?.importedValue, decision?.proposedValue, decision?.action, decision?.reasonCode].map(cell).join(',')));
  const body = format === 'json' ? JSON.stringify({ review, execution }, null, 2) : '\uFEFF' + [header.map(cell).join(','), ...lines].join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([body], { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${review.sourceFile.replace(/\.csv$/i, '')}-whole-import-review.${format}`; link.click(); URL.revokeObjectURL(url);
}
function message(failure: unknown) { return failure instanceof Error ? failure.message : 'The saved review could not be loaded.'; }
