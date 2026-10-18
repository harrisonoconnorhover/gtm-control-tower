'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveContactState } from '@/lib/live-control-tower';
import { applySuppressionRules, exportSuppressionCsv, MAX_SUPPRESSION_RULES, normalizeSuppressionRule,
  parseSuppressionCsv, suppressionRuleKey, SUPPRESSION_TYPES, type SuppressionRule } from '@/lib/suppression';

export type SuppressionSnapshot = { rules: SuppressionRule[]; state: 'loading' | 'error' | 'ready' };
type Props = { contacts: LiveContactState[]; accessKey: string; busy?: boolean; onSnapshot: (snapshot: SuppressionSnapshot) => void };
type Draft = { id?: string; listName: string; type: SuppressionRule['type']; value: string; reason: string; enabled: boolean; includeSubdomains: boolean };
const emptyDraft = (): Draft => ({ listName: 'Suppression list', type: 'domain', value: '', reason: '', enabled: true, includeSubdomains: false });
const buttonClass = 'rounded-full border border-white/20 px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40';
const inputClass = 'mt-1 block w-full rounded-lg border border-white/20 bg-[#071710] px-3 py-2 text-sm';
const pageSize = 10;
const message = (error: unknown) => error instanceof Error ? error.message : 'Suppression lists could not be saved.';

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}

export function SuppressionReview({ contacts, accessKey, busy = false, onSnapshot }: Props) {
  const [rules, setRules] = useState<SuppressionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [csv, setCsv] = useState('');
  const [imported, setImported] = useState<ReturnType<typeof parseSuppressionCsv> | null>(null);
  const rulesRef = useRef(rules);
  const requestInFlight = useRef(false);
  const generation = useRef(0);
  const snapshotRef = useRef(onSnapshot);
  useEffect(() => { snapshotRef.current = onSnapshot; }, [onSnapshot]);

  const request = useCallback(async (body?: unknown, signal?: AbortSignal) => {
    const response = await fetch('/api/control-tower/suppressions', { method: body ? 'POST' : 'GET', cache: 'no-store', signal,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(accessKey ? { 'x-control-tower-key': accessKey } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const payload = await response.json() as { rules?: SuppressionRule[]; error?: string };
    if (!response.ok || !Array.isArray(payload.rules)) throw new Error(payload.error || 'Suppression lists are unavailable. Reload before importing.');
    return payload.rules;
  }, [accessKey]);

  const load = useCallback((signal?: AbortSignal) => {
    if (requestInFlight.current) return;
    const revision = ++generation.current;
    return request(undefined, signal).then((saved) => {
      if (signal?.aborted || revision !== generation.current) return;
      rulesRef.current = saved; setRules(saved); setError(''); setLoadFailed(false);
      snapshotRef.current({ rules: saved, state: 'ready' });
    }).catch((failure: unknown) => {
      if (signal?.aborted || revision !== generation.current) return;
      setError(message(failure)); setLoadFailed(true);
      snapshotRef.current({ rules: rulesRef.current, state: 'error' });
    }).finally(() => { if (!signal?.aborted && revision === generation.current) setLoading(false); });
  }, [request]);

  const reload = useCallback((signal?: AbortSignal) => {
    if (requestInFlight.current) return;
    setLoading(true);
    snapshotRef.current({ rules: rulesRef.current, state: 'loading' });
    void load(signal);
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const focus = () => reload(controller.signal);
    window.addEventListener('focus', focus);
    return () => { controller.abort(); window.removeEventListener('focus', focus); };
  }, [load, reload]);

  async function save(body: unknown, success: string) {
    if (requestInFlight.current || busy || loading || loadFailed) return false;
    requestInFlight.current = true; ++generation.current; setSaving(true); setError(''); setNotice('');
    snapshotRef.current({ rules: rulesRef.current, state: 'loading' });
    try {
      const saved = await request(body);
      rulesRef.current = saved; setRules(saved); setLoadFailed(false); setNotice(success);
      snapshotRef.current({ rules: saved, state: 'ready' });
      return true;
    } catch (failure) {
      setError(message(failure)); setLoadFailed(true);
      snapshotRef.current({ rules: rulesRef.current, state: 'error' });
      return false;
    } finally { requestInFlight.current = false; setSaving(false); }
  }

  const matchedContacts = useMemo(() => applySuppressionRules(contacts, rules).filter((contact) => contact.recordStatus === 'active' && contact.suppressionMatches?.length), [contacts, rules]);
  const matchCounts = new Map<string, number>();
  for (const contact of matchedContacts) for (const match of contact.suppressionMatches ?? []) matchCounts.set(match.ruleId, (matchCounts.get(match.ruleId) ?? 0) + 1);
  const filtered = rules.filter((rule) => [rule.listName, rule.type, rule.value, rule.reason].some((value) => value.toLowerCase().includes(query.trim().toLowerCase())));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const disabled = busy || loading || saving || loadFailed;
  const domainType = ['domain', 'email_domain', 'website_domain'].includes(draft.type);
  const previewByKey = new Map(rules.map((rule) => [suppressionRuleKey(rule), rule]));
  let newRuleCount = 0;
  for (const [index, rule] of (imported ?? []).entries()) {
    const key = suppressionRuleKey(rule);
    if (!previewByKey.has(key)) {
      previewByKey.set(key, { ...rule, id: `preview-${index}`, createdAt: '', updatedAt: '' });
      newRuleCount++;
    }
  }
  const preservedRuleCount = (imported?.length ?? 0) - newRuleCount;
  const previewRows = imported ? applySuppressionRules(contacts, [...previewByKey.values()]).filter((contact) => contact.recordStatus === 'active' && contact.suppressionMatches?.length) : [];
  const previewCount = previewRows.length;

  async function submitDraft(event: React.FormEvent) {
    event.preventDefault();
    try {
      const rule = normalizeSuppressionRule(draft);
      if (await save({ action: 'save', rule }, draft.id ? 'Suppression rule updated.' : 'Suppression rule saved. Matching rows are excluded.')) setDraft(emptyDraft());
    } catch (failure) { setError(message(failure)); }
  }

  function previewCsv() {
    setError(''); setNotice('');
    try { setImported(parseSuppressionCsv(csv)); } catch (failure) { setImported(null); setError(message(failure)); }
  }

  return <section aria-label="Suppression lists" className="mb-6 rounded-3xl border border-white/10 bg-[#0c1d17] p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-display text-xl">Suppression lists</h3>
        <p className="mt-2 text-sm text-[#bdcbc4]">Save contacts and companies that should stay out of imports, with a reason for each rule.</p></div>
      <span className="rounded-full bg-[#b8d8ff]/10 px-3 py-1 text-xs font-semibold text-[#b8d8ff]">No CRM changes</span>
    </div>
    <p className="mt-3 text-xs leading-5 text-[#9db1a7]">These lists apply to every saved workspace on this Control Tower installation, including future imports. Matches are excluded locally. Disabling or deleting a rule removes that suppression; manual skips remain.</p>
    <p role="status" className="mt-3 text-sm">{loading ? 'Loading suppression lists…' : `${rules.length} saved rules · ${matchedContacts.length} current rows suppressed`}</p>
    {loadFailed && <p className="mt-2 text-sm text-[#e6bd68]">Suppression lists must load before rows can be ready or sent to the CRM.</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className={buttonClass} disabled={loading || saving || busy} onClick={() => reload()}>Reload suppression lists</button>
      <button type="button" className={buttonClass} onClick={() => download('suppression-template.csv', 'list_name,type,value,reason,enabled,include_subdomains\nVendors,domain,vendor.example,Vendor rather than a prospect,true,true\nDo not contact,email,person@example.com,Requested no outreach,true,false\n')}>Download suppression template</button>
      <button type="button" className={buttonClass} disabled={loading || !rules.length} onClick={() => download('suppression-lists.csv', exportSuppressionCsv(rules))}>Export suppression lists</button>
    </div>
    {error && <p role="alert" className="mt-3 break-words text-sm text-[#ffb19a]">{error}</p>}
    {notice && <p role="status" className="mt-3 text-sm text-[#b8d8ff]">{notice}</p>}
    <details className="mt-4 rounded-xl border border-white/10 p-3" open={Boolean(draft.id) || undefined}>
      <summary className="cursor-pointer text-sm font-semibold">{draft.id ? 'Edit suppression rule' : 'Add a suppression rule'}</summary>
      <form onSubmit={(event) => void submitDraft(event)} className="mt-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs">Suppression list name<input required value={draft.listName} disabled={disabled} onChange={(event) => setDraft({ ...draft, listName: event.target.value })} className={inputClass} /></label>
          <label className="text-xs">Match rule<select value={draft.type} disabled={disabled} onChange={(event) => setDraft({ ...draft, type: event.target.value as Draft['type'], includeSubdomains: ['email', 'company_name'].includes(event.target.value) ? false : draft.includeSubdomains })} className={inputClass}>
            {SUPPRESSION_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select></label>
          <label className="text-xs">Value to suppress<input required value={draft.value} disabled={disabled} onChange={(event) => setDraft({ ...draft, value: event.target.value })} className={inputClass} /></label>
          <label className="text-xs">Suppression reason<input required value={draft.reason} disabled={disabled} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} placeholder="Vendor, competitor, requested no outreach…" className={inputClass} /></label>
        </div>
        <p className="mt-2 text-xs text-[#9db1a7]">{SUPPRESSION_TYPES.find((type) => type.value === draft.type)?.help}</p>
        <div className="mt-3 flex flex-wrap gap-4 text-xs">
          <label className="flex items-center gap-2"><input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />Rule enabled</label>
          {domainType && <label className="flex items-center gap-2"><input type="checkbox" checked={draft.includeSubdomains} disabled={disabled} onChange={(event) => setDraft({ ...draft, includeSubdomains: event.target.checked })} />Include subdomains</label>}
        </div>
        <div className="mt-3 flex flex-wrap gap-2"><button type="submit" disabled={disabled} className={buttonClass}>{draft.id ? 'Save rule changes' : 'Save suppression rule'}</button>
          {draft.id && <button type="button" className={buttonClass} disabled={saving} onClick={() => setDraft(emptyDraft())}>Cancel rule edit</button>}</div>
      </form>
    </details>
    <details className="mt-3 rounded-xl border border-white/10 p-3">
      <summary className="cursor-pointer text-sm font-semibold">Import a suppression CSV</summary>
      <p className="mt-3 text-xs text-[#9db1a7]">Use the template headers. Preview before saving; imports add new rules. Existing rules with the same list, type, value and subdomain setting are kept, including their reason and enabled state. Maximum {MAX_SUPPRESSION_RULES.toLocaleString()} saved rules.</p>
      <label className="mt-3 block text-xs">Suppression CSV file<input type="file" accept=".csv,text/csv" disabled={disabled} className="mt-2 block max-w-full text-xs" onChange={(event) => {
        const file = event.target.files?.[0]; if (!file) return; setImported(null);
        void file.text().then(setCsv).catch((failure) => setError(message(failure)));
      }} /></label>
      <label className="mt-3 block text-xs">Paste suppression CSV<textarea rows={5} value={csv} disabled={disabled} onChange={(event) => { setCsv(event.target.value); setImported(null); }} className={inputClass} /></label>
      <button type="button" disabled={disabled || !csv.trim()} className={`${buttonClass} mt-3`} onClick={previewCsv}>Preview suppression CSV</button>
      {imported && <section aria-label="Suppression import preview" className="mt-3 rounded-xl border border-[#b8d8ff]/20 p-3">
        <p className="text-sm font-semibold">{imported.length} rules to save · {newRuleCount} new · {preservedRuleCount} duplicate entries kept · {previewCount} current rows suppressed after saving</p>
        <ul className="mt-2 space-y-1 text-xs text-[#9db1a7]">{imported.slice(0, 10).map((rule, index) => <li key={index} className="break-words">{rule.listName} · {rule.type}: {rule.value} · {rule.reason}{rule.enabled ? '' : ' · Disabled'}{rules.some((saved) => suppressionRuleKey(saved) === suppressionRuleKey(rule)) ? ' · Already saved; existing settings kept' : ''}</li>)}</ul>
        {imported.length > 10 && <p className="mt-2 text-xs text-[#9db1a7]">Showing the first 10 rules.</p>}
        {!!previewRows.length && <p className="mt-2 break-words text-xs text-[#9db1a7]">Matching rows: {previewRows.slice(0, 10).map((row) => `${row.contactId} (${row.company || row.rawEmail})`).join(', ')}{previewRows.length > 10 ? '…' : ''}</p>}
        <button type="button" className={`${buttonClass} mt-3`} disabled={disabled || !imported.length} onClick={() => {
          void save({ action: 'import', rules: imported }, 'Suppression CSV saved. Matching rows are excluded.').then((saved) => { if (saved) { setImported(null); setCsv(''); } });
        }}>Save previewed suppression rules</button>
      </section>}
    </details>
    <label className="mt-4 block text-xs">Find suppression rules<input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="List, rule, value, or reason" className={inputClass} /></label>
    <div className="mt-3 space-y-3">{filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((rule) => <article key={rule.id} aria-label={`Suppression rule ${rule.value}`} className="rounded-xl border border-white/10 p-3">
      <p className="break-words text-sm font-semibold">{rule.value} <span className="text-xs font-normal text-[#9db1a7]">· {rule.enabled ? 'Enabled' : 'Disabled'}</span></p>
      <p className="mt-1 break-words text-xs text-[#9db1a7]">{rule.listName} · {SUPPRESSION_TYPES.find((type) => type.value === rule.type)?.label}{rule.includeSubdomains ? ' · includes subdomains' : ''} · {matchCounts.get(rule.id) ?? 0} current matches</p>
      <p className="mt-2 break-words text-sm text-[#e6bd68]">Reason: {rule.reason}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={disabled} onClick={() => { setDraft(rule); setError(''); }}>Edit rule</button>
        <button type="button" className={buttonClass} disabled={disabled} onClick={() => void save({ action: 'save', rule: { ...rule, enabled: !rule.enabled } }, `Rule ${rule.enabled ? 'disabled' : 'enabled'}.`)}>{rule.enabled ? 'Disable rule' : 'Enable rule'}</button>
        <button type="button" className={buttonClass} disabled={disabled} onClick={() => void save({ action: 'delete', id: rule.id }, 'Suppression rule deleted. Manual row skips remain.')}>Delete rule</button>
      </div>
    </article>)}</div>
    {!filtered.length && !loading && <p className="mt-3 text-xs text-[#9db1a7]">{rules.length ? 'No suppression rules match this search.' : 'No suppression rules saved yet.'}</p>}
    {filtered.length > pageSize && <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[#9db1a7]">
      <span>{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, filtered.length)} of {filtered.length} rules</span>
      <button type="button" className={buttonClass} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous suppression rules</button>
      <button type="button" className={buttonClass} disabled={(currentPage + 1) * pageSize >= filtered.length} onClick={() => setPage(currentPage + 1)}>Next suppression rules</button>
    </div>}
  </section>;
}
