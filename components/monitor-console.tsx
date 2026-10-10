'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MonitorConfig, MonitorFinding, MonitorOverview, MonitorRule, MonitorStatus } from '@/lib/monitor-types';

const KEY_STORAGE = 'gtm-control-tower-operator-key';
const inputStyle = 'w-full rounded-xl border border-white/15 bg-[#06100d] px-3 py-2.5 text-sm text-[#edf8f2] outline-none focus:border-[#d8ff67]/60 focus:ring-2 focus:ring-[#d8ff67]/15';
const secondaryButton = 'rounded-full border border-white/15 px-4 py-2.5 text-xs font-semibold text-[#c0d0c7] transition hover:border-white/30 hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#d8ff67] disabled:cursor-not-allowed disabled:opacity-40';
const primaryButton = 'rounded-full bg-[#d8ff67] px-5 py-2.5 text-xs font-bold text-[#06100d] transition hover:bg-[#e4ff95] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#d8ff67] disabled:cursor-not-allowed disabled:opacity-40';
const ruleNames: Record<MonitorRule, string> = {
  email_missing: 'Missing email',
  email_invalid: 'Invalid email',
  owner_missing: 'Missing owner',
  lifecycle_regression: 'Lifecycle moved backward',
  text_whitespace: 'Extra spaces in text',
};
const statusNames: Record<MonitorStatus, string> = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', fixed: 'Fixed', unknown: 'Verify outcome' };
type Provider = 'hubspot' | 'salesforce';
type QueueFilter = 'needs_attention' | 'all' | MonitorStatus;
type Triage = { id: string; status: 'open' | 'in_progress' | 'resolved'; assignee: string; note: string };

export function MonitorConsole() {
  const [provider, setProvider] = useState<Provider>('hubspot');
  const providerLabel = provider === 'salesforce' ? 'Salesforce' : 'HubSpot';
  const [overview, setOverview] = useState<MonitorOverview | null>(null);
  const [accessKey, setAccessKey] = useState('');
  const keyRef = useRef('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueFilter>('needs_attention');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(30);
  const accountId = overview?.accountId;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const params = new URLSearchParams(window.location.search);
    const initialProvider: Provider = params.get('provider') === 'salesforce' ? 'salesforce' : 'hubspot';
    const storedKey = window.sessionStorage.getItem(KEY_STORAGE) ?? '';
    keyRef.current = storedKey;
    async function initialize() {
      setAccessKey(storedKey);
      setProvider(initialProvider);
      setSelectedId(params.get('finding'));
      if (params.has('finding')) setFilter('all');
      try {
        const next = await requestMonitor(storedKey, initialProvider, undefined, controller.signal);
        if (!cancelled) {
          setOverview(next);
          setLoadedAt(new Date().toISOString());
        }
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialize();
    return () => { cancelled = true; controller.abort(); };
  }, []);

  useEffect(() => {
    if (!accountId || busy) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void requestMonitor(keyRef.current, provider, undefined, controller.signal).then((next) => {
        if (!controller.signal.aborted) {
          setOverview(next);
          setLoadedAt(new Date().toISOString());
        }
      }).catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(`Results could not refresh: ${errorMessage(caught)}`);
      });
    }, 30_000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [accountId, busy, provider]);

  async function changeProvider(next: Provider) {
    if (next === provider || loading || busy) return;
    setProvider(next); setOverview(null); setSelectedId(null); setError(null); setNotice(null); setLoading(true);
    const url = new URL(window.location.href);
    url.searchParams.set('provider', next); url.searchParams.delete('finding');
    window.history.replaceState(null, '', url);
    try {
      setOverview(await requestMonitor(keyRef.current, next));
      setLoadedAt(new Date().toISOString());
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }

  function rememberKey(value: string) {
    setAccessKey(value);
    keyRef.current = value;
    if (value) window.sessionStorage.setItem(KEY_STORAGE, value);
    else window.sessionStorage.removeItem(KEY_STORAGE);
  }

  async function refresh() {
    setBusy('refresh');
    setError(null);
    setNotice(null);
    try {
      setOverview(await requestMonitor(keyRef.current, provider));
      setLoadedAt(new Date().toISOString());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function mutate(action: 'configure' | 'tick' | 'triage', payload: Record<string, unknown>) {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const next = await requestMonitor(keyRef.current, provider, { action, ...payload });
      setOverview(next);
      setLoadedAt(new Date().toISOString());
      setNotice(action === 'configure' ? 'Monitoring settings saved.' : action === 'triage' ? 'Review decision saved.' : 'Check returned. Review its result in recent runs.');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  const findings = useMemo(() => (overview?.findings ?? []).filter((finding) => filter === 'all' || (filter === 'needs_attention' ? ['open', 'in_progress', 'unknown'].includes(finding.status) : finding.status === filter)), [overview, filter]);
  const selected = findings.find((finding) => finding.id === selectedId) ?? findings[0] ?? null;
  const disabled = loading || busy !== null;

  return (
    <main className="min-h-screen bg-[#06100d] text-[#edf8f2] selection:bg-[#d8ff67] selection:text-[#06100d]">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[600px] bg-[radial-gradient(circle_at_85%_0%,rgba(216,255,103,0.09),transparent_40%)]" />
      <div className="relative mx-auto max-w-[1500px] px-5 pb-12 sm:px-8 lg:px-12">
        <header className="flex flex-wrap items-center justify-between gap-5 border-b border-white/10 py-5">
          <Link href="/app" className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#d8ff67] font-mono text-xs font-black text-[#06100d]">GT</span><span><span className="block font-mono text-[9px] uppercase tracking-[0.22em] text-[#8ca397]">GTM Control Tower</span><span className="font-semibold">CRM Monitor</span></span></Link>
          <nav aria-label="Operator navigation" className="flex flex-wrap gap-2 text-xs"><Link href="/app/incidents" className={secondaryButton}>Incidents</Link><Link href="/app/work" className={secondaryButton}>Operations Inbox</Link><Link href="/app" className={secondaryButton}>Duplicate audit</Link><Link href="/app/lab" className={secondaryButton}>CSV cleanup lab</Link><Link href="/setup" className={secondaryButton}>Setup</Link></nav>
        </header>

        <section className="grid gap-6 py-9 lg:grid-cols-[1fr_auto] lg:items-end">
          <div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#d8ff67]">Connected CRM monitoring</p><h1 className="mt-3 max-w-3xl text-4xl font-semibold leading-[1.05] tracking-[-0.045em] sm:text-5xl">Catch the drift.<br /><span className="text-[#9bb3a5]">Keep a human in the loop.</span></h1><p className="mt-4 max-w-2xl text-sm leading-6 text-[#a0b4a8]">{provider === 'salesforce' ? 'Observe Salesforce Leads, Contacts, Accounts, and Opportunities.' : 'Observe HubSpot contacts, companies, and deals.'} Inspect grouped incidents and record findings. Repair supported contact fields when you opt in, and keep decisions that need judgment in your review queue.</p></div>
          <div className="flex flex-wrap gap-2"><button onClick={() => void refresh()} disabled={disabled} className={secondaryButton}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh results'}</button><button onClick={() => void mutate('tick', { force: true })} disabled={disabled || !overview?.config.enabled} title={!overview?.config.enabled ? 'Enable monitoring and save settings before running a check.' : undefined} className={primaryButton}>{busy === 'tick' ? `Checking ${providerLabel}…` : 'Run check now'}</button></div>
        </section>

        <label className="mb-5 grid max-w-sm gap-2 text-xs font-semibold text-[#a0b4a8]">CRM to monitor<select value={provider} disabled={disabled} onChange={(event) => void changeProvider(event.target.value as Provider)} className={inputStyle}><option value="hubspot">HubSpot Contacts</option><option value="salesforce">Salesforce Leads and Contacts</option></select></label>

        <details className="mb-5 rounded-2xl border border-white/10 bg-[#0b1b16] px-5 py-4" open={!overview && !loading}>
          <summary className="cursor-pointer text-xs font-semibold text-[#b3c7bb]">Operator access key</summary>
          <div className="mt-4 flex max-w-xl flex-wrap items-end gap-3"><label className="grid min-w-0 flex-1 gap-2 text-xs text-[#9bb3a5]" htmlFor="monitor-key">Key for this browser tab<input id="monitor-key" type="password" autoComplete="off" value={accessKey} onChange={(event) => rememberKey(event.target.value)} className={inputStyle} /></label><button onClick={() => void refresh()} disabled={disabled} className={secondaryButton}>Connect</button></div><p className="mt-2 text-xs leading-5 text-[#819c8c]">Use your self-hosted operator key if configured. It stays in this tab&apos;s session storage and is excluded from reports.</p>
        </details>

        {error && <div role="alert" className="mb-5 rounded-2xl border border-[#ff9c82]/25 bg-[#ff9c82]/[0.06] p-5 text-sm leading-6 text-[#ffb09a]">{error}{overview && <p className="mt-1 text-xs">The results below are the last loaded snapshot. Refresh after resolving the error.</p>}</div>}
        {notice && <p role="status" className="mb-5 rounded-2xl border border-[#d8ff67]/20 bg-[#d8ff67]/[0.04] px-5 py-4 text-sm text-[#d8ff67]">{notice}</p>}
        {loading && <div role="status" className="rounded-3xl border border-white/10 bg-[#0b1b16] p-10 text-center text-sm text-[#a0b4a8]">Loading connected {providerLabel} monitoring…</div>}
        {!loading && !overview && <section className="rounded-3xl border border-dashed border-white/15 p-8 sm:p-10"><p className="font-mono text-[10px] uppercase tracking-widest text-[#e6bd68]">Connection required</p><h2 className="mt-3 text-2xl font-semibold">Connect {providerLabel} to start monitoring.</h2><p className="mt-3 max-w-2xl text-sm leading-6 text-[#a0b4a8]">CRM Monitor needs a verified {providerLabel} account and persistent storage on your server. Complete connector setup, then refresh this page to read its actual findings.</p><Link href="/setup" className={`mt-5 inline-block ${secondaryButton}`}>Open connector setup</Link></section>}

        {overview && <>
          <section aria-label="Monitoring status" className="mb-6 rounded-3xl border border-white/10 bg-[#0b1b16] p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-3"><span className={`h-2.5 w-2.5 rounded-full ${overview.config.enabled ? 'bg-[#d8ff67]' : 'bg-[#7f9589]'}`} /><h2 className="font-semibold">Monitoring {overview.config.enabled ? 'enabled' : 'paused'}</h2><span className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] text-[#9bb3a5]">{providerLabel} {overview.accountId}</span></div><p className="text-xs text-[#8ca397]">Snapshot loaded {dateTime(loadedAt)}</p></div>
            <p className="mt-3 max-w-3xl text-xs leading-5 text-[#a0b4a8]">Scheduled checks require <code className="rounded bg-[#06100d] px-1.5 py-0.5 text-[#d8ff67]">npm run monitor</code> on your server. Enabled is a saved setting; this page does not verify that the runner is online. Closing this page does not stop a running server process. Results refresh every 30 seconds.</p>
            <dl className="mt-5 grid gap-4 border-t border-white/10 pt-5 sm:grid-cols-3"><StatusDetail label="Last check" value={dateTime(overview.lastCheckedAt)} /><StatusDetail label="Change watermark" value={dateTime(overview.watermark)} /><StatusDetail label="Next check due" value={overview.config.enabled ? dateTime(overview.nextCheckAt) : 'Monitoring paused'} /></dl>
            <p className="mt-4 rounded-xl border border-[#83bcff]/15 bg-[#83bcff]/[0.04] px-4 py-3 text-xs leading-5 text-[#a3c6e5]"><strong>{overview.phase === 'baseline' ? 'Building the baseline. ' : 'Watching record changes. '}</strong>{overview.coverageNote}</p>
            <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5"><Metric label="Open" value={overview.totals.open} /><Metric label="In progress" value={overview.totals.inProgress} /><Metric label="Auto-fixed" value={overview.totals.fixed} accent /><Metric label="Resolved" value={overview.totals.resolved} /><Metric label="Verify outcome" value={overview.totals.unknown} warning={overview.totals.unknown > 0} /></div>
          </section>

          <Configuration key={`${provider}:${overview.accountId}:${JSON.stringify(overview.config)}`} provider={provider} config={overview.config} disabled={disabled} saving={busy === 'configure'} onSave={(config) => void mutate('configure', { config })} />

          <section aria-labelledby="monitor-queue-title" className="mt-8">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-4"><div><p className="font-mono text-[10px] uppercase tracking-widest text-[#d8ff67]">Triage and repair evidence</p><h2 id="monitor-queue-title" className="mt-2 text-2xl font-semibold tracking-tight">Review queue</h2><p className="mt-2 text-xs leading-5 text-[#9bb3a5]">Recent findings returned by the server. Totals may include older findings outside this list.</p></div><div className="flex flex-wrap gap-2"><button onClick={() => exportFindings(overview)} className={secondaryButton}>Findings CSV</button><button onClick={() => download(`monitor-report-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), snapshotLoadedAt: loadedAt, scope: 'Recent findings and runs returned by the server; not a complete history.', ...overview }, null, 2), 'application/json')} className={secondaryButton}>Report JSON</button></div></div>
            <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
              <aside className="min-w-0 rounded-3xl border border-white/10 bg-[#0b1b16] p-4">
                <label className="grid gap-2 text-xs text-[#a0b4a8]" htmlFor="monitor-filter">Show findings<select id="monitor-filter" className={inputStyle} value={filter} onChange={(event) => { setFilter(event.target.value as QueueFilter); setVisibleLimit(30); }}><option value="needs_attention">Needs attention</option><option value="all">All recent findings</option><option value="open">Open</option><option value="in_progress">In progress</option><option value="fixed">Fixed</option><option value="resolved">Resolved</option><option value="unknown">Verify outcome</option></select></label>
                <p className="mb-3 mt-4 text-xs text-[#819c8c]">{findings.length.toLocaleString()} in this view</p>
                <div className="space-y-2 xl:max-h-[640px] xl:overflow-y-auto">{findings.slice(0, visibleLimit).map((finding) => <button key={finding.id} onClick={() => setSelectedId(finding.id)} aria-pressed={selected?.id === finding.id} className={`w-full rounded-2xl border p-4 text-left transition focus-visible:outline-2 focus-visible:outline-[#d8ff67] ${selected?.id === finding.id ? 'border-[#d8ff67]/40 bg-[#d8ff67]/[0.05]' : 'border-white/10 bg-[#06100d]/50 hover:border-white/25'}`}><div className="flex flex-wrap items-center justify-between gap-2"><StatusPill status={finding.status} /><span className={`text-[10px] ${finding.severity === 'critical' ? 'text-[#ffb09a]' : 'text-[#e6bd68]'}`}>{finding.severity}</span></div><p className="mt-3 break-words text-sm font-semibold">{finding.contactLabel || `${finding.objectType ?? 'Contact'} ${finding.contactId}`}</p><p className="mt-1 text-xs leading-5 text-[#a0b4a8]">{ruleNames[finding.rule]}</p><p className="mt-3 text-[11px] text-[#819c8c]">{finding.assignee || 'Unassigned'} · {dateTime(finding.lastSeenAt)}</p></button>)}</div>
                {findings.length > visibleLimit && <button onClick={() => setVisibleLimit((value) => value + 30)} className={`mt-3 w-full ${secondaryButton}`}>Show 30 more</button>}
                {!findings.length && <p className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-xs leading-6 text-[#9bb3a5]">{overview.lastCheckedAt ? 'No recent findings match this filter. See the coverage note before treating the account as clear.' : 'No check has completed yet. Run a check to start building the baseline.'}</p>}
              </aside>
              {selected ? <FindingDetail provider={provider} instanceUrl={overview.instanceUrl} key={`${selected.id}:${selected.status}:${selected.assignee}:${selected.note}`} finding={selected} disabled={disabled} saving={busy === 'triage'} onTriage={(triage) => void mutate('triage', triage)} /> : <div className="flex min-h-64 flex-col items-center justify-center rounded-3xl border border-dashed border-white/10 px-6 py-12 text-center"><span className="grid h-12 w-12 place-items-center rounded-full border border-[#d8ff67]/20 text-xl text-[#d8ff67]">✓</span><h3 className="mt-4 text-lg font-semibold">No findings in this view</h3><p className="mt-2 max-w-sm text-xs leading-6 text-[#9bb3a5]">Checks keep a record of what they scanned. Review recent runs below, or change the filter to inspect earlier decisions.</p></div>}
            </div>
          </section>

          <section aria-labelledby="monitor-runs-title" className="mt-8 overflow-hidden rounded-3xl border border-white/10 bg-[#0b1b16]">
            <div className="border-b border-white/10 px-5 py-5 sm:px-6"><h2 id="monitor-runs-title" className="text-xl font-semibold">Recent runs</h2><p className="mt-2 text-xs leading-5 text-[#9bb3a5]">Each row reports one scan batch. Reports and exports contain the recent results available here.</p></div>
            {overview.runs.length ? <div className="overflow-x-auto"><table className="w-full min-w-[780px] text-left text-xs"><caption className="sr-only">Recent CRM Monitor scan batches, with counts and provider errors</caption><thead className="border-b border-white/10 bg-[#06100d]/40 text-[#8ca397]"><tr>{['Started', 'Phase', 'Result', 'Scanned', 'New findings', 'Fixed', 'Review'].map((label) => <th key={label} scope="col" className="px-5 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{overview.runs.map((run) => <tr key={run.id} className="border-b border-white/[0.06] last:border-0"><td className="max-w-sm px-5 py-4"><p>{dateTime(run.startedAt)}</p><p className="mt-1 text-[10px] text-[#819c8c]">{run.finishedAt ? `Finished ${dateTime(run.finishedAt)}` : 'No completion recorded'}</p>{run.error && <p className="mt-2 break-words leading-5 text-[#ffb09a]">{run.error}</p>}</td><td className="px-5 py-4 text-[#a0b4a8]">{run.phase === 'baseline' ? 'Baseline' : 'Changes'}</td><td className={`px-5 py-4 ${run.status === 'failed' ? 'text-[#ffb09a]' : run.status === 'completed' ? 'text-[#d8ff67]' : 'text-[#83bcff]'}`}>{run.status === 'running' ? 'Started; awaiting result' : run.status}</td><td className="px-5 py-4">{run.scanned.toLocaleString()}</td><td className="px-5 py-4">{run.opened.toLocaleString()}</td><td className="px-5 py-4">{run.fixed.toLocaleString()}</td><td className="px-5 py-4">{run.needsReview.toLocaleString()}</td></tr>)}</tbody></table></div> : <p className="px-6 py-10 text-center text-sm text-[#9bb3a5]">No runs recorded. Enable monitoring and save settings, then run a check or start the server runner.</p>}
          </section>
        </>}
      </div>
    </main>
  );
}

function Configuration({ provider, config, disabled, saving, onSave }: { provider: Provider; config: MonitorConfig; disabled: boolean; saving: boolean; onSave: (config: MonitorConfig) => void }) {
  const [draft, setDraft] = useState(config);
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  return <section aria-labelledby="monitor-settings-title" className="rounded-3xl border border-white/10 bg-[#0b1b16] p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="monitor-settings-title" className="text-xl font-semibold">Monitoring settings</h2><p className="mt-2 text-xs leading-5 text-[#9bb3a5]">Scan record changes at a regular interval. The first checks build a baseline. Enable monitoring and save settings before running a manual check.</p></div><span className="rounded-full border border-white/10 px-3 py-1 text-[10px] text-[#9bb3a5]">{dirty ? 'Unsaved changes' : 'Saved settings'}</span></div>
    <form onSubmit={(event) => { event.preventDefault(); onSave(draft); }}><fieldset disabled={disabled} className="mt-5 grid gap-5 lg:grid-cols-[1.3fr_1fr]">
      <div className="space-y-3"><label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-white/10 bg-[#06100d]/45 p-4"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-[#d8ff67]" /><span><span className="block text-sm font-semibold">Enable scheduled monitoring</span><span className="mt-1 block text-xs leading-5 text-[#9bb3a5]">Allow the server runner to check this {provider === 'salesforce' ? 'Salesforce' : 'HubSpot'} account on schedule.</span></span></label>
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-[#e6bd68]/20 bg-[#e6bd68]/[0.03] p-4"><input type="checkbox" checked={draft.automaticRepairs} onChange={(event) => setDraft({ ...draft, automaticRepairs: event.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-[#d8ff67]" /><span><span className="block text-sm font-semibold">Automatically repair extra spaces</span><span className="mt-1 block text-xs leading-5 text-[#b8ad8a]">Explicit opt-in: {provider === 'salesforce' ? 'write whitespace fixes to Lead Company and Title, or Contact Title. Contact account relationships stay untouched. Lead status, conversion, and ownership are outside these rules.' : 'write whitespace fixes to HubSpot company and job title fields. Ownership and lifecycle decisions stay in review.'} This also applies to manual checks. Missing or invalid email stays in review.</span></span></label></div>
      <div className="grid content-start gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2"><label className="grid content-start gap-2 text-xs text-[#a0b4a8]">Check interval<select value={draft.intervalSeconds} onChange={(event) => setDraft({ ...draft, intervalSeconds: Number(event.target.value) })} className={inputStyle}>{![60, 300, 3600].includes(draft.intervalSeconds) && <option value={draft.intervalSeconds}>Every {draft.intervalSeconds} seconds</option>}<option value={60}>Every minute</option><option value={300}>Every 5 minutes</option><option value={3600}>Every hour</option></select></label><label className="grid content-start gap-2 text-xs text-[#a0b4a8]">Default review assignee<input value={draft.defaultAssignee} maxLength={100} onChange={(event) => setDraft({ ...draft, defaultAssignee: event.target.value })} placeholder="e.g. RevOps" className={inputStyle} /></label><p className="text-xs leading-5 text-[#819c8c] sm:col-span-2 lg:col-span-1 xl:col-span-2">Assignment is recorded in this queue. It does not send email, Slack messages, or change the CRM owner.</p></div>
    </fieldset><div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4"><p className="text-xs leading-5 text-[#9bb3a5]">{draft.automaticRepairs ? 'Saving allows the selected repairs on future checks.' : 'Automatic repairs are off. Findings are queued for review.'}</p><button type="submit" disabled={disabled || !dirty} className={primaryButton}>{saving ? 'Saving…' : 'Save settings'}</button></div></form>
  </section>;
}

function FindingDetail({ provider, instanceUrl, finding, disabled, saving, onTriage }: { provider: Provider; instanceUrl?: string; finding: MonitorFinding; disabled: boolean; saving: boolean; onTriage: (triage: Triage) => void }) {
  const [assignee, setAssignee] = useState(finding.assignee);
  const [note, setNote] = useState(finding.note);
  const [status, setStatus] = useState<Triage['status']>(finding.status === 'in_progress' || finding.status === 'resolved' ? finding.status : 'open');
  const nativeLink = nativeRecordLink(provider, instanceUrl, finding);
  const fields = [...new Set([...Object.keys(finding.before), ...Object.keys(finding.after)])];
  return <article className="min-w-0 rounded-3xl border border-white/10 bg-[#0b1b16] p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><StatusPill status={finding.status} /><h3 className="mt-4 break-words text-2xl font-semibold tracking-tight">{finding.contactLabel || `${finding.objectType ?? 'Contact'} ${finding.contactId}`}</h3><p className="mt-2 text-xs text-[#a0b4a8]">{ruleNames[finding.rule]} · {finding.severity} severity</p></div>{nativeLink && <a href={nativeLink} target="_blank" rel="noreferrer" className={secondaryButton}>Open in {provider === 'salesforce' ? 'Salesforce' : 'HubSpot'} ↗</a>}</div><p className="mt-5 text-sm font-medium leading-6">{finding.summary}</p><p className="mt-2 text-xs leading-6 text-[#a0b4a8]">{finding.detail}</p>
    {finding.status === 'unknown' && <p className="mt-4 rounded-xl border border-[#e6bd68]/25 bg-[#e6bd68]/[0.04] p-4 text-xs leading-6 text-[#e6bd68]">The repair outcome is uncertain. Inspect the native record before resolving this item; CRM Monitor will not blindly replay this repair.</p>}
    {finding.repairError && <p className="mt-3 rounded-xl border border-[#ff9c82]/20 p-4 text-xs leading-5 text-[#ffb09a]">Repair detail: {finding.repairError}</p>}
    <div className="mt-5 overflow-x-auto rounded-2xl border border-white/10"><table className="w-full min-w-[400px] table-fixed text-left text-xs"><caption className="sr-only">Observed record fields and proposed or applied changes</caption><thead className="bg-[#06100d]/60 text-[#8ca397]"><tr><th scope="col" className="w-1/4 px-4 py-3 font-medium">Field</th><th scope="col" className="px-4 py-3 font-medium">{finding.rule === 'lifecycle_regression' ? 'Previously observed' : 'Observed'}</th><th scope="col" className="px-4 py-3 font-medium">{finding.rule === 'lifecycle_regression' ? 'Current value' : finding.status === 'fixed' ? 'Verified after repair' : 'Proposed value'}</th></tr></thead><tbody>{fields.length ? fields.map((field) => <tr key={field} className="border-t border-white/[0.06]"><th scope="row" className="break-words px-4 py-3 font-medium text-[#a0b4a8]">{field === 'jobtitle' || field === 'Title' ? 'Job title' : field === 'hubspot_owner_id' ? 'Owner ID' : field === 'lifecyclestage' ? 'Lifecycle' : field}</th><td className="break-words px-4 py-3 font-mono text-[#c0d0c7]">{propertyValue(finding.before[field])}</td><td className="break-words px-4 py-3 font-mono text-[#d8ff67]">{Object.hasOwn(finding.after, field) ? propertyValue(finding.after[field]) : 'Human decision'}</td></tr>) : <tr><td colSpan={3} className="px-4 py-4 text-[#9bb3a5]">No field values recorded.</td></tr>}</tbody></table></div>
    <dl className="mt-5 grid grid-cols-2 gap-4 text-xs sm:grid-cols-3"><StatusDetail label="First seen" value={dateTime(finding.firstSeenAt)} /><StatusDetail label="Last seen" value={dateTime(finding.lastSeenAt)} /><StatusDetail label="Occurrences" value={finding.occurrences.toLocaleString()} />{finding.resolvedAt && <StatusDetail label="Closed at" value={dateTime(finding.resolvedAt)} />}</dl>
    {finding.status === 'fixed' ? <p className="mt-6 rounded-xl border border-[#d8ff67]/20 bg-[#d8ff67]/[0.04] px-4 py-4 text-xs leading-5 text-[#c6e890]">The server recorded this repair as fixed. Its before and after values remain available in the report.</p> : <form onSubmit={(event) => { event.preventDefault(); onTriage({ id: finding.id, status, assignee, note }); }} className="mt-6 border-t border-white/10 pt-5"><h4 className="text-sm font-semibold">Human review</h4><p className="mt-2 text-xs leading-5 text-[#9bb3a5]">Assign the next step or record a decision. Resolving here closes the finding; it does not edit {provider === 'salesforce' ? 'Salesforce' : 'HubSpot'}.</p><fieldset disabled={disabled} className="mt-4 grid gap-4 sm:grid-cols-2"><label className="grid gap-2 text-xs text-[#a0b4a8]">Assignee<input value={assignee} maxLength={100} onChange={(event) => setAssignee(event.target.value)} placeholder="Name or team" className={inputStyle} /></label><label className="grid gap-2 text-xs text-[#a0b4a8]">Review status<select value={status} onChange={(event) => setStatus(event.target.value as Triage['status'])} className={inputStyle}><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option></select></label><label className="grid gap-2 text-xs text-[#a0b4a8] sm:col-span-2">Decision or next step<textarea value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="What needs checking, or how this was resolved" className={`${inputStyle} resize-y`} /></label></fieldset><div className="mt-4 flex justify-end"><button type="submit" disabled={disabled} className={primaryButton}>{saving ? 'Saving review…' : 'Save review'}</button></div></form>}
  </article>;
}

function StatusPill({ status }: { status: MonitorStatus }) {
  const tone = status === 'fixed' ? 'bg-[#d8ff67]/10 text-[#d8ff67]' : status === 'unknown' ? 'bg-[#e6bd68]/10 text-[#e6bd68]' : status === 'in_progress' ? 'bg-[#83bcff]/10 text-[#a3cfff]' : 'bg-white/[0.06] text-[#b3c7bb]';
  return <span className={`inline-block rounded-full px-2.5 py-1 font-mono text-[9px] uppercase tracking-wider ${tone}`}>{statusNames[status]}</span>;
}

function Metric({ label, value, accent = false, warning = false }: { label: string; value: number; accent?: boolean; warning?: boolean }) {
  return <div className="rounded-2xl border border-white/[0.07] bg-[#06100d]/45 px-4 py-4"><p className="text-[11px] text-[#9bb3a5]">{label}</p><p className={`mt-2 text-3xl font-semibold tracking-tight ${warning ? 'text-[#e6bd68]' : accent ? 'text-[#d8ff67]' : ''}`}>{value.toLocaleString()}</p></div>;
}

function StatusDetail({ label, value }: { label: string; value: string }) { return <div><dt className="text-[10px] text-[#819c8c]">{label}</dt><dd className="mt-1 text-xs text-[#c0d0c7]">{value}</dd></div>; }
function dateTime(value: string | null) { if (!value) return 'Not recorded'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); }
function propertyValue(value: string | undefined) { return value === undefined || value === '' ? '(empty)' : JSON.stringify(value); }
function errorMessage(caught: unknown) { return caught instanceof Error ? caught.message : 'CRM Monitor could not complete the request.'; }

async function requestMonitor(accessKey: string, provider: Provider, body?: Record<string, unknown>, signal?: AbortSignal): Promise<MonitorOverview> {
  const response = await fetch(`/api/control-tower/monitor?provider=${provider}`, { method: body ? 'POST' : 'GET', cache: 'no-store', signal, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(accessKey ? { 'x-control-tower-key': accessKey } : {}) }, ...(body ? { body: JSON.stringify({ ...body, provider }) } : {}) });
  const result = await response.json() as { monitor?: MonitorOverview; error?: string };
  if (!response.ok || !result.monitor) throw new Error(result.error ?? `CRM Monitor request failed (${response.status}).`);
  return result.monitor;
}

function nativeRecordLink(provider: Provider, instanceUrl: string | undefined, finding: MonitorFinding): string | null {
  if (provider === 'hubspot') return `https://app.hubspot.com/contacts/${encodeURIComponent(finding.accountId)}/contact/${encodeURIComponent(finding.contactId)}`;
  if (!instanceUrl) return null;
  try {
    const instance = new URL(instanceUrl);
    if (instance.protocol !== 'https:') return null;
    return `${instance.origin}/lightning/r/${finding.objectType === 'Lead' ? 'Lead' : 'Contact'}/${encodeURIComponent(finding.contactId)}/view`;
  } catch { return null; }
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportFindings(overview: MonitorOverview) {
  const headers = ['provider', 'object_type', 'account_id', 'contact_id', 'contact', 'rule', 'severity', 'status', 'assignee', 'note', 'first_seen', 'last_seen', 'closed_at', 'occurrences', 'before', 'after', 'repair_error'];
  const rows = overview.findings.map((finding) => [finding.provider ?? overview.provider ?? 'hubspot', finding.objectType ?? 'Contact', finding.accountId, finding.contactId, finding.contactLabel, finding.rule, finding.severity, finding.status, finding.assignee, finding.note, finding.firstSeenAt, finding.lastSeenAt, finding.resolvedAt ?? '', String(finding.occurrences), JSON.stringify(finding.before), JSON.stringify(finding.after), finding.repairError ?? '']);
  const csv = [headers, ...rows].map((row) => row.map((value) => `"${(/^[\s]*[=+@-]/u.test(value) ? `'${value}` : value).replace(/"/gu, '""')}"`).join(',')).join('\r\n');
  download(`monitor-recent-findings-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
}
