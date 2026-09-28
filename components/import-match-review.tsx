'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DuplicateScanView } from '@/lib/duplicate-scan-store';
import { isHubSpotEligible, toHubSpotSyncContact } from '@/lib/hubspot-sync';
import {
  suggestMatchFields,
  type ImportMatchInput,
  type ImportMatchReport,
  type MatchField,
} from '@/lib/import-match';
import type { LiveContactState } from '@/lib/live-control-tower';
import { isSalesforceEligible, toSalesforceSyncLead } from '@/lib/salesforce-sync';
import { importMatchSourceKey, type ConfirmedImportMatch } from '@/lib/import-match-decision';

export type ImportMatchDecisionAction = {
  action: 'confirm';
  connectorId: 'hubspot' | 'salesforce';
  contactId: string;
  sourceKey: string;
  scanId: string;
  nativeId: string;
  objectType: 'contact' | 'lead';
  fields: MatchField[];
  reason: string;
} | {
  action: 'clear';
  connectorId: 'hubspot' | 'salesforce';
  contactId: string;
};

type Props = {
  contacts: LiveContactState[];
  connectorId: 'hubspot' | 'salesforce';
  workspaceId: string | null;
  accessKey: string;
  disabled?: boolean;
  onDecision: (action: ImportMatchDecisionAction) => Promise<void>;
};

type MatchResponse = {
  report: ImportMatchReport;
  scan: Pick<DuplicateScanView, 'id' | 'connectorId' | 'recordsScanned' | 'sourceComplete' | 'startedAt' | 'completedAt' | 'analysisWarnings'>;
};

const pageSize = 100;
const secondaryButton = 'rounded-full border border-white/20 px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40';
const fieldLabels: Record<MatchField, string> = { name: 'Name', email: 'Email', phone: 'Phone', state: 'State', company: 'Company' };

export function ImportMatchReview({ contacts, ...props }: Props) {
  const inputs = useMemo<ImportMatchInput[]>(() => contacts.filter((contact) => contact.recordStatus === 'active' && !contact.importExclusion).map((contact) => {
    const placeholderName = contact.fullName.trim() === contact.contactId.trim();
    let fullName = placeholderName ? '' : contact.fullName;
    const eligible = props.connectorId === 'hubspot' ? isHubSpotEligible(contact) : isSalesforceEligible(contact);
    if (eligible) {
      const portable = props.connectorId === 'hubspot' ? toHubSpotSyncContact(contact) : toSalesforceSyncLead(contact);
      const writtenName = [portable.firstName.trim(), portable.lastName.trim()].filter(Boolean).join(' ');
      fullName = placeholderName && writtenName === contact.contactId.trim() ? '' : writtenName;
    }
    return {
      contactId: contact.contactId,
      fullName,
      email: contact.normalizedEmail || contact.rawEmail,
      phone: contact.phone || '',
      state: contact.state || '',
      company: contact.company || '',
    };
  }), [contacts, props.connectorId]);

  // A different import, provider, workspace, or authorization discards the old
  // review and aborts its pending requests instead of showing stale suggestions.
  const reviewKey = JSON.stringify([props.connectorId, props.workspaceId, props.accessKey, inputs]);
  return <MatchReview key={reviewKey} {...props} contacts={contacts} inputs={inputs} />;
}

function MatchReview({ contacts, inputs, connectorId, workspaceId, accessKey, disabled = false, onDecision }: Props & { inputs: ImportMatchInput[] }) {
  const suggestions = useMemo(() => suggestMatchFields(inputs), [inputs]);
  const [fields, setFields] = useState<MatchField[]>(() => suggestions.filter((field) => field.recommended).map((field) => field.field));
  const [page, setPage] = useState(0);
  const [scan, setScan] = useState<DuplicateScanView | null>(null);
  const [loadingScan, setLoadingScan] = useState(Boolean(workspaceId));
  const [scanning, setScanning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [matching, setMatching] = useState(false);
  const [result, setResult] = useState<MatchResponse | null>(null);
  const [error, setError] = useState('');
  const scanRequest = useRef<AbortController | null>(null);
  const matchRequest = useRef<AbortController | null>(null);
  const pauseRequested = useRef(false);
  const connectorName = connectorId === 'hubspot' ? 'HubSpot' : 'Salesforce';
  const start = page * pageSize;
  const batch = inputs.slice(start, start + pageSize);
  const end = start + batch.length;
  const contactById = new Map(contacts.map((contact) => [contact.contactId, contact]));
  const confirmedContacts = contacts.filter((contact) => contact.crmMatchDecisions?.[connectorId]);

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    scanRequest.current = controller;
    async function loadSnapshot() {
      try {
        const response = await requestJson<{ scan: DuplicateScanView | null }>(
          `/api/control-tower/duplicate-scan?workspaceId=${encodeURIComponent(workspaceId!)}&connectorId=${connectorId}`,
          accessKey, controller.signal,
        );
        if (!controller.signal.aborted) setScan(response.scan);
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      } finally {
        if (!controller.signal.aborted) setLoadingScan(false);
      }
    }
    void loadSnapshot();
    return () => controller.abort();
  }, [accessKey, connectorId, workspaceId]);

  useEffect(() => () => {
    pauseRequested.current = true;
    scanRequest.current?.abort();
    matchRequest.current?.abort();
  }, []);

  useEffect(() => {
    if (disabled) pauseRequested.current = true;
  }, [disabled]);

  function clearResult() {
    matchRequest.current?.abort();
    setMatching(false);
    setResult(null);
    setError('');
  }

  async function readSnapshot(restart: boolean) {
    if (!workspaceId || disabled || scanning) return;
    clearResult();
    scanRequest.current?.abort();
    const controller = new AbortController();
    scanRequest.current = controller;
    pauseRequested.current = false;
    setLoadingScan(false);
    setScanning(true);
    setStopping(false);
    try {
      let current = (await requestJson<{ scan: DuplicateScanView }>('/api/control-tower/duplicate-scan', accessKey, controller.signal, {
        workspaceId, connectorId, action: restart ? 'restart' : 'start',
      })).scan;
      if (controller.signal.aborted) return;
      setScan(current);
      const seenCursors = new Set<string>();
      while (current.status === 'scanning' && !pauseRequested.current) {
        const cursor = JSON.stringify(current.cursor);
        if (seenCursors.has(cursor)) throw new Error('The CRM scan repeated a page cursor. Scanning stopped; start a fresh snapshot instead of treating this as complete.');
        seenCursors.add(cursor);
        current = (await requestJson<{ scan: DuplicateScanView }>('/api/control-tower/duplicate-scan', accessKey, controller.signal, {
          workspaceId, connectorId, action: 'step', scanId: current.id,
        })).scan;
        if (controller.signal.aborted) return;
        setScan(current);
      }
      if (current.status === 'failed') throw new Error('The CRM snapshot failed. Start a fresh snapshot to try again.');
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) {
        setScanning(false);
        setStopping(false);
      }
    }
  }

  async function findSuggestions() {
    if (!workspaceId || !scan?.complete || !batch.length || !fields.length || disabled || scanning || matching) return;
    clearResult();
    const controller = new AbortController();
    matchRequest.current = controller;
    setMatching(true);
    try {
      const response = await requestJson<MatchResponse>('/api/control-tower/import-matches', accessKey, controller.signal, {
        workspaceId, connectorId, scanId: scan.id, contacts: batch, fields,
      });
      if (!controller.signal.aborted) setResult(response);
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setMatching(false);
    }
  }

  function exportReport() {
    if (!result) return;
    const report = {
      exportedAt: new Date().toISOString(),
      purpose: 'Read-only import-to-CRM suggestions; no records are linked, merged, or written.',
      scoreMeaning: 'Uncalibrated ranking score out of 100, not a probability of identity.',
      coverageMeaning: 'Results describe the dated scan only. No suggestion is not evidence that a record is safe to create.',
      importedRows: { first: start + 1, last: end, total: inputs.length },
      ...result,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gtm-${connectorId}-import-match-review-${start + 1}-${end}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section aria-label="Approximate CRM matches" className="mb-6 rounded-[28px] border border-white/10 bg-[#0c1d17] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#83bcff]">Match review · {connectorName}</p>
          <h3 className="mt-2 text-xl font-semibold">Find possible CRM matches</h3>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[#9db1a7]">Choose fields to explore possible matches in a dated CRM snapshot. The write preview separately checks all five fields and holds new records with possible duplicates, even if the CRM would accept them. Suggestions never link or update an existing person automatically.</p>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[#9db1a7]">For eligible rows, name checks use the destination&apos;s first and last names. Mapped first/last columns take precedence over the full-name column. Rows not yet eligible use their imported full name.</p>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[#9db1a7]">If you verify that a suggestion is the same person, save your choice and reason below. Confirmation preserves the CRM email and makes no CRM write. Build a fresh write preview to review permitted field changes before approving an update.</p>
        </div>
        <span className="text-xs text-[#cdfc54]">{inputs.length} active imported records</span>
      </div>

      {confirmedContacts.length > 0 && <section aria-label="Confirmed CRM matches" className="mt-5 rounded-2xl border border-[#83bcff]/20 bg-[#83bcff]/5 p-4">
        <h4 className="text-sm font-semibold">Saved matches · {confirmedContacts.length}</h4>
        <p className="mt-2 text-xs leading-5 text-[#9db1a7]">These choices are saved with the imported rows. They do not prove an update occurred. Each write preview checks the selected CRM record again.</p>
        <div className="mt-3 space-y-3">{confirmedContacts.map((contact) => <SavedMatchDecision key={contact.contactId} contact={contact} decision={contact.crmMatchDecisions![connectorId]!} disabled={disabled || scanning || matching} onDecision={onDecision} />)}</div>
      </section>}

      {!inputs.length ? <p className="mt-4 text-sm text-[#9db1a7]">Import a CSV with active records to review possible matches.</p> : (
        <>
          <fieldset disabled={disabled || scanning} className="mt-5 disabled:opacity-60">
            <legend className="text-sm font-semibold">Matching fields</legend>
            <p className="mt-1 text-xs text-[#9db1a7]">Suggested fields reflect coverage in your imported file. Change this selection to explore the evidence; it does not weaken the duplicate check in the write preview.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {suggestions.map((suggestion) => (
                <label key={suggestion.field} className="flex min-w-0 cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-[#07130f]/60 p-3">
                  <input type="checkbox" checked={fields.includes(suggestion.field)} onChange={(event) => {
                    clearResult();
                    setFields((current) => event.target.checked ? [...current, suggestion.field] : current.filter((field) => field !== suggestion.field));
                  }} className="mt-1 accent-[#cdfc54]" />
                  <span className="min-w-0 text-xs leading-5"><span className="font-semibold text-[#edf8f2]">{suggestion.label}</span><span className="ml-2 text-[#9db1a7]">{suggestion.populated}/{suggestion.total} populated{suggestion.recommended ? ' · suggested' : ''}</span><span className="block text-[#9db1a7]">{suggestion.reason}</span></span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-5 rounded-2xl border border-white/10 bg-[#07130f]/60 p-4">
            <h4 className="text-sm font-semibold">CRM snapshot</h4>
            <div aria-live="polite" className="mt-2 text-xs leading-5 text-[#9db1a7]">
              {loadingScan ? <p>Loading saved snapshot details…</p> : scan ? (
                <>
                  <p>{scan.recordsScanned.toLocaleString()} records · {scan.pagesScanned} pages · {scanning ? 'Reading CRM pages…' : scan.status === 'scanning' ? 'Paused before completion' : scan.status === 'failed' ? 'Failed snapshot' : scan.sourceComplete ? 'Provider pagination complete' : 'Partial snapshot'}</p>
                  <p>Read started {dateLabel(scan.startedAt)}{scan.completedAt ? ` · Finished ${dateLabel(scan.completedAt)}` : ''}.</p>
                  <p className={scan.sourceComplete ? '' : 'text-[#e6bd68]'}>{scan.sourceComplete ? 'Coverage describes the records visible during this scan, not the current CRM state.' : 'Coverage is incomplete. Missing candidates cannot establish that a person is absent.'}</p>
                  {scan.analysisWarnings.map((warning, index) => <p key={index} className="mt-1 text-[#e6bd68]">{warning}</p>)}
                </>
              ) : <p>No saved snapshot. Read CRM records to build one.</p>}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {scanning ? <button type="button" disabled={stopping} onClick={() => { pauseRequested.current = true; setStopping(true); }} className={secondaryButton}>{stopping ? 'Stopping after this page…' : 'Stop after current page'}</button> : (
                <>
                  {(!scan || scan.status === 'scanning') && <button type="button" disabled={disabled || !workspaceId || loadingScan} onClick={() => void readSnapshot(false)} className={secondaryButton}>{scan ? 'Resume scan' : 'Read CRM snapshot'}</button>}
                  {scan && <button type="button" disabled={disabled || !workspaceId || loadingScan} onClick={() => void readSnapshot(true)} className={secondaryButton}>Read fresh snapshot</button>}
                </>
              )}
            </div>
            <p className="mt-2 text-xs leading-5 text-[#9db1a7]">Reading a snapshot makes CRM read requests and saves pages in this workspace. It does not write CRM records. Stop takes effect after the current page. New-record creation requires a complete snapshot started within the last 15 minutes; missing or partial coverage holds creation.</p>
            {!workspaceId && <p className="mt-2 text-xs text-[#e6bd68]">Save this workspace before reading a CRM snapshot.</p>}
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">Imported rows {start + 1}–{end} of {inputs.length}</span>
              {inputs.length > pageSize && <>
                <button type="button" disabled={disabled || scanning || page === 0} onClick={() => { clearResult(); setPage(page - 1); }} className={secondaryButton}>Previous 100</button>
                <button type="button" disabled={disabled || scanning || end === inputs.length} onClick={() => { clearResult(); setPage(page + 1); }} className={secondaryButton}>Next 100</button>
              </>}
            </div>
            <button type="button" onClick={() => void findSuggestions()} disabled={disabled || scanning || loadingScan || matching || !workspaceId || !scan?.complete || !fields.length} className="rounded-full bg-[#cdfc54] px-5 py-3 text-sm font-semibold text-[#10221a] disabled:cursor-not-allowed disabled:opacity-40">{matching ? 'Comparing snapshot…' : 'Find suggestions for these rows'}</button>
          </div>
          {!fields.length && <p className="mt-2 text-xs text-[#e6bd68]">Select at least one matching field.</p>}
          <p className="mt-2 text-xs leading-5 text-[#9db1a7]">A score out of 100 ranks evidence; it is uncalibrated and is not a probability that two records are the same person. No suggestion means no candidate within this scan and these rules, not permission to create a CRM record.</p>
        </>
      )}

      {error && <p role="alert" className="mt-4 rounded-xl border border-[#ff9c82]/20 bg-[#ff9c82]/5 p-3 text-sm text-[#ffb19a]">{error}</p>}
      <p role="status" className="mt-3 text-xs text-[#9db1a7]">{matching ? 'Finding suggestions for the selected imported rows.' : result ? `Review ready for ${result.report.rows.length} imported records.` : ''}</p>
      {result && (
        <div className="mt-4 border-t border-white/10 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h4 className="font-semibold">Ranked suggestions · rows {start + 1}–{end}</h4>
            <button type="button" onClick={exportReport} className={secondaryButton}>Download this review (JSON)</button>
          </div>
          <p className="mt-2 break-words text-xs leading-5 text-[#9db1a7]">Rules {result.report.ruleVersion} · Snapshot {result.scan.id} · {result.scan.recordsScanned.toLocaleString()} records · {result.scan.sourceComplete ? 'Provider pagination complete' : 'Partial coverage'} · Finished {dateLabel(result.scan.completedAt)}. Up to three suggestions per imported record.</p>
          {[...result.scan.analysisWarnings, ...result.report.warnings].map((warning, index) => <p key={index} className="mt-2 text-xs leading-5 text-[#e6bd68]">{warning}</p>)}
          <div className="mt-4 space-y-3">
            {result.report.rows.map((row, rowIndex) => (
              <details key={row.contactId} open={rowIndex === 0} className="min-w-0 rounded-2xl border border-white/10 bg-[#07130f]/60 p-4">
                <summary className="cursor-pointer break-words text-sm font-semibold">{row.input.fullName || row.input.email || row.contactId} <span className="font-normal text-[#9db1a7]">· {row.contactId} · {row.candidates.length ? `${row.candidates.length} of ${row.candidateCount} suggestions shown` : 'No suggestion'}</span></summary>
                {row.warnings.map((warning, index) => <p key={index} className="mt-3 text-xs leading-5 text-[#e6bd68]">{warning}</p>)}
                {!row.candidates.length && <p className="mt-3 text-xs leading-5 text-[#9db1a7]">No candidate met the selected rules within this snapshot. This does not prove the person is new or safe to create.</p>}
                <div className="mt-3 space-y-3">
                  {row.candidates.slice(0, 3).map((candidate, index) => (
                    <article key={candidate.record.recordKey} className="min-w-0 rounded-xl border border-white/10 p-3 sm:p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0"><h5 className="break-words text-sm font-semibold">{index + 1}. {candidate.record.fullName || candidate.record.email || 'Unnamed CRM record'}</h5><p className="mt-1 break-all font-mono text-xs text-[#9db1a7]">{connectorName} {candidate.record.objectType} · {candidate.record.nativeId}</p></div>
                        <span className="rounded-full bg-[#83bcff]/10 px-3 py-1 text-xs font-semibold text-[#b6d7ff]">Score {candidate.score}/100</span>
                      </div>
                      <ul className="mt-3 space-y-1 text-xs leading-5">{candidate.evidence.map((evidence, evidenceIndex) => <li key={evidenceIndex} className={evidence.tone === 'conflict' ? 'text-[#ffb19a]' : evidence.tone === 'warning' ? 'text-[#e6bd68]' : 'text-[#b5c6bd]'}>{evidence.label} ({evidence.weight > 0 ? '+' : ''}{evidence.weight})</li>)}</ul>
                      <div className="mt-3 divide-y divide-white/10">
                        {candidate.comparisons.map((comparison) => (
                          <div key={comparison.field} className="py-3">
                            <p className="text-xs font-semibold">{fieldLabels[comparison.field]} <span className={comparison.status === 'conflict' ? 'text-[#ffb19a]' : 'text-[#9db1a7]'}>· {comparison.status}</span></p>
                            <dl className="mt-2 grid min-w-0 grid-cols-2 gap-3 text-xs leading-5">
                              <div className="min-w-0"><dt className="text-[#71877c]">Imported</dt><dd className="[overflow-wrap:anywhere]">{comparison.imported || 'Empty'}</dd></div>
                              <div className="min-w-0"><dt className="text-[#71877c]">CRM snapshot</dt><dd className="[overflow-wrap:anywhere]">{comparison.existing || 'Empty'}</dd></div>
                            </dl>
                          </div>
                        ))}
                      </div>
                      {candidate.record.objectType !== (connectorId === 'hubspot' ? 'contact' : 'lead')
                        ? <p className="mt-3 text-xs leading-5 text-[#e6bd68]">This record can inform the review, but this workflow updates only HubSpot Contacts and unconverted Salesforce Leads. It cannot be selected as an update target.</p>
                        : contactById.has(row.contactId) && <CandidateConfirmation
                          contact={contactById.get(row.contactId)!}
                          connectorId={connectorId}
                          scanId={result.scan.id}
                          nativeId={candidate.record.nativeId}
                          objectType={candidate.record.objectType}
                          fields={result.report.fields}
                          email={candidate.record.email}
                          disabled={disabled || scanning || matching}
                          onDecision={onDecision}
                        />}
                    </article>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function CandidateConfirmation({ contact, connectorId, scanId, nativeId, objectType, fields, email, disabled, onDecision }: {
  contact: LiveContactState;
  connectorId: 'hubspot' | 'salesforce';
  scanId: string;
  nativeId: string;
  objectType: 'contact' | 'lead';
  fields: MatchField[];
  email: string;
  disabled: boolean;
  onDecision: Props['onDecision'];
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const selected = contact.crmMatchDecisions?.[connectorId];
  const isCurrentChoice = selected?.target.nativeId === nativeId && selected.target.objectType === objectType
    && selected.sourceKey === importMatchSourceKey(contact);
  async function confirm() {
    if (disabled || saving || !reason.trim()) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await onDecision({ action: 'confirm', connectorId, contactId: contact.contactId, sourceKey: importMatchSourceKey(contact), scanId, nativeId, objectType, fields, reason: reason.trim() });
      setSaved(true);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setSaving(false); }
  }
  return <div className="mt-3 border-t border-white/10 pt-4">
    <p className="break-words text-xs leading-5 text-[#b5c6bd]">CRM email will stay <strong className="[overflow-wrap:anywhere]">{email || 'empty'}</strong>. Confirm only after checking the identity evidence; the score is a ranking, not certainty.</p>
    <label className="mt-3 block text-xs font-semibold">
      Reason for matching {contact.contactId} to {nativeId}
      <textarea value={reason} onChange={(event) => { setReason(event.target.value); setSaved(false); }} maxLength={500} required rows={2} disabled={disabled || saving} className="mt-2 block w-full resize-y rounded-xl border border-white/20 bg-[#07130f] p-3 text-sm font-normal text-[#edf8f2] disabled:opacity-50" placeholder="What identifies this as the same person?" />
    </label>
    <p className="mt-1 text-xs text-[#71877c]">Required · up to 500 characters</p>
    <button type="button" disabled={disabled || saving || !reason.trim()} onClick={() => void confirm()} className={`${secondaryButton} mt-3`}>{saving ? 'Saving confirmed match…' : 'Use this existing record'}</button>
    {error && <p role="alert" className="mt-2 text-xs leading-5 text-[#ffb19a]">{error}</p>}
    {saved && isCurrentChoice && <p role="status" className="mt-2 text-xs leading-5 text-[#cdfc54]">Match saved. No CRM write occurred. Build a fresh write preview to review the update.</p>}
  </div>;
}

function SavedMatchDecision({ contact, decision, disabled, onDecision }: {
  contact: LiveContactState;
  decision: ConfirmedImportMatch;
  disabled: boolean;
  onDecision: Props['onDecision'];
}) {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  const stale = decision.sourceKey !== importMatchSourceKey(contact);
  const targetName = [decision.target.fields.firstName, decision.target.fields.lastName].filter(Boolean).join(' ');
  async function clear() {
    if (disabled || clearing) return;
    setClearing(true);
    setError('');
    try { await onDecision({ action: 'clear', connectorId: decision.connectorId, contactId: contact.contactId }); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setClearing(false); }
  }
  return <article className="min-w-0 rounded-xl border border-white/10 p-3">
    <h5 className="break-words text-sm font-semibold">{contact.fullName || contact.contactId} <span className="font-normal text-[#9db1a7]">· {contact.contactId}</span></h5>
    <p className="mt-2 break-words text-xs leading-5">Selected: {targetName || 'Unnamed CRM record'} · {decision.target.objectType} <span className="font-mono [overflow-wrap:anywhere]">{decision.target.nativeId}</span></p>
    <p className="mt-1 text-xs leading-5">Preserved CRM email: <span className="[overflow-wrap:anywhere]">{decision.target.email || 'Empty'}</span></p>
    <p className="mt-1 break-words text-xs leading-5 text-[#9db1a7]">Reason: {decision.reason}</p>
    <p className="mt-1 text-xs leading-5 text-[#9db1a7]">Confirmed {dateLabel(decision.confirmedAt)}.</p>
    {stale && <p className="mt-2 text-xs leading-5 text-[#e6bd68]">This imported row changed after confirmation. Its saved match is stale; review fresh suggestions and confirm again before updating.</p>}
    {contact.importExclusion && <p className="mt-2 text-xs leading-5 text-[#e6bd68]">This row is skipped. The saved match does not include it in an import.</p>}
    <button type="button" aria-label={`Clear confirmed match for ${contact.contactId}`} disabled={disabled || clearing} onClick={() => void clear()} className={`${secondaryButton} mt-3`}>{clearing ? 'Clearing match…' : 'Clear confirmed match'}</button>
    {error && <p role="alert" className="mt-2 text-xs leading-5 text-[#ffb19a]">{error}</p>}
  </article>;
}

async function requestJson<T>(url: string, accessKey: string, signal: AbortSignal, body?: object): Promise<T> {
  const headers = new Headers();
  if (accessKey) headers.set('x-control-tower-key', accessKey);
  if (body) headers.set('content-type', 'application/json');
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers, signal, cache: 'no-store', body: body ? JSON.stringify(body) : undefined });
  const result = await response.json() as T & { error?: unknown };
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'The match review request failed.');
  return result;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The match review could not complete.';
}

function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'not finished';
}
