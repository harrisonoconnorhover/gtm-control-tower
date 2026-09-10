'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createInboundLab, defaultLabSettings, labMetrics, labScenarios, retryInbound, runSyntheticBatch, submitInbound, traceStages, type FormInput, type InboundLabState, type LabRun, type LeadContext, type Region } from '@/lib/inbound-lab';

const storageKey = 'gtm-inbound-practice-v1';
const fieldLabels: [keyof FormInput, string, string][] = [['firstName', 'First name', 'text'], ['lastName', 'Last name', 'text'], ['email', 'Business email', 'email'], ['phone', 'Phone number', 'tel'], ['company', 'Company name', 'text']];
const inputStyle = 'w-full min-w-0 rounded-xl border border-white/20 bg-[#07130f] px-3 py-3 text-base text-[#edf8f2] outline-none focus:border-[#d8ff67] focus:ring-2 focus:ring-[#d8ff67]/20';
const buttonStyle = 'rounded-xl border border-white/20 px-4 py-2.5 text-sm font-semibold text-[#d6e5dc] hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40';
const statusStyle = { routed: 'bg-[#d8ff67]/15 text-[#d8ff67]', held: 'bg-[#f5bc67]/15 text-[#f5bc67]', failed: 'bg-[#ff8c7b]/15 text-[#ffad9f]' };

export function InboundLeadLab({ homeHref = '#top' }: { homeHref?: string }) {
  const [state, setState] = useState<InboundLabState>(() => runSyntheticBatch(createInboundLab()));
  const [selectedId, setSelectedId] = useState('req-032');
  const [scenarioId, setScenarioId] = useState('new');
  const [input, setInput] = useState<FormInput>({ ...labScenarios[1].input });
  const [context, setContext] = useState<LeadContext>({ ...labScenarios[1].context });
  const [filter, setFilter] = useState('all');
  const [notice, setNotice] = useState('32 fictional requests are ready to inspect.');
  const [saveError, setSaveError] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [resetConfirm, setResetConfirm] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const traceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Delay browser storage until hydration so server and browser start identically.
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) {
          const parsed = JSON.parse(saved) as InboundLabState;
          if (parsed.version === 1 && Array.isArray(parsed.runs) && Array.isArray(parsed.leads) && Array.isArray(parsed.reps) && Array.isArray(parsed.accounts) && parsed.settings) {
            setState(parsed);
            setSelectedId(parsed.runs.at(-1)?.id ?? '');
            setNotice('Restored your practice session from this browser.');
          }
        }
      } catch { setSaveError('Browser storage is unavailable or unreadable. You can still practice and export this session.'); }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      try { window.localStorage.setItem(storageKey, JSON.stringify(state)); setSaveError(''); }
      catch { setSaveError('This session could not be saved in browser storage. Export it before closing the tab.'); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [state, hydrated]);

  const metrics = labMetrics(state);
  const selected = state.runs.find(run => run.id === selectedId) ?? state.runs.at(-1);
  const attempt = selected?.attempts.at(-1);
  const selectedLead = state.leads.find(lead => lead.id === selected?.leadId);
  const visibleRuns = state.runs.filter(run => filter === 'all' || run.status === filter).toReversed();
  const currentScenario = labScenarios.find(item => item.id === scenarioId);
  const faultCount = Number(state.settings.emailMapping === 'broken') + Number(state.settings.crmFault !== 'none') + Number(state.settings.notificationFault);

  function selectScenario(id: string) {
    const scenario = labScenarios.find(item => item.id === id)!;
    setScenarioId(id); setInput({ ...scenario.input }); setContext({ ...scenario.context }); setEditingId(null);
  }

  function finish(next: InboundLabState, id: string) {
    setState(next); setSelectedId(id); setFilter('all');
    const run = next.runs.find(item => item.id === id);
    setNotice(run ? `${run.id}: ${run.reason}` : 'Session updated.');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = editingId ? retryInbound(state, editingId, { input, context }) : submitInbound(state, input, context, currentScenario?.label ?? 'Manual request');
    finish(next, editingId ?? next.runs.at(-1)!.id); setEditingId(null);
  }

  function editRequest(run: LabRun) {
    setEditingId(run.id); setInput({ ...run.input }); setContext({ ...run.context }); setScenarioId('');
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    formRef.current?.querySelector('input')?.focus({ preventScroll: true });
  }

  function download() {
    const blob = new Blob([JSON.stringify({ purpose: 'Synthetic inbound routing practice; all destinations are simulated.', ...state }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'inbound-routing-practice.json'; link.click(); URL.revokeObjectURL(url);
    setNotice('Practice session exported, including original payloads and every attempt.');
  }

  return (
    <main className="min-h-screen bg-[#06100d] text-base text-[#edf8f2] selection:bg-[#d8ff67] selection:text-[#06100d]">
      <div className="mx-auto max-w-[1540px] px-4 pb-12 sm:px-7 lg:px-10">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/15 py-5">
          <a href={homeHref} className="flex items-center gap-3 text-sm font-semibold"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#d8ff67] font-mono font-bold text-[#06100d]">GT</span>GTM Control Tower <span className="text-[#819c8e]">/ Inbound lab</span></a>
          <div className="flex flex-wrap items-center gap-2"><span className="rounded-full border border-[#d8ff67]/30 px-3 py-2 text-sm text-[#d8ff67]">Synthetic data · local sandbox</span><button type="button" className={buttonStyle} onClick={download}>Export session</button></div>
        </header>

        <div className="flex flex-wrap items-end justify-between gap-4 py-7">
          <div><p className="font-mono text-sm text-[#a1b7aa]">FORM → RECORD → RIGHT REP</p><h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Inbound Routing Lab</h1><p className="mt-2 max-w-2xl text-[#a1b7aa]">Follow a demo request. Find the broken handoff. Fix it and replay.</p></div>
          <button className={buttonStyle} onClick={() => { const next = runSyntheticBatch(state); finish(next, next.runs.at(-1)!.id); }}>Add 32 sample requests</button>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-6">
          {([['Requests', metrics.requests], ['Routed', metrics.routed], ['Held for review', metrics.held], ['Failed handoffs', metrics.failed], ['CRM contacts', metrics.leads], ['Notifications', metrics.notifications]] as const).map(([label, value]) => <div key={label} className="rounded-xl border border-white/15 bg-[#0c1d15] p-4"><p className="text-sm text-[#adc3b5]">{label}</p><p className={`mt-1 text-3xl font-semibold tabular-nums ${label === 'Held for review' ? 'text-[#f5bc67]' : label === 'Failed handoffs' ? 'text-[#ffad9f]' : 'text-[#edf8f2]'}`}>{value}</p></div>)}
        </div>

        <p role="status" aria-live="polite" className="mb-5 rounded-xl border border-white/15 bg-white/[0.03] px-4 py-3 text-sm leading-6 text-[#c3d6c9]">{notice}</p>
        {saveError && <p role="alert" className="mb-4 text-sm text-[#f5bc67]">{saveError}</p>}

        <div className="grid items-start gap-5 xl:grid-cols-[0.85fr_1.15fr]">
          <section className="rounded-2xl border border-white/15 bg-[#0c1d15] p-5 sm:p-6" aria-labelledby="intake-title">
            <div className="mb-5 flex items-center justify-between gap-3"><h2 id="intake-title" className="text-xl font-semibold">{editingId ? `Correct ${editingId}` : 'Request a demo'}</h2><span className="text-sm text-[#a1b7aa]">Practice form</span></div>
            <label className="block text-sm text-[#c3d6c9]">Try a scenario<select className={`${inputStyle} mt-2`} value={scenarioId} onChange={event => selectScenario(event.target.value)}><option value="" disabled>Custom correction</option>{labScenarios.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <p className="mb-5 mt-2 min-h-12 text-sm leading-6 text-[#a1b7aa]">{editingId ? 'Fix the source fields or enrichment. Previous attempts remain in the history.' : currentScenario?.description}</p>
            <form ref={formRef} onSubmit={submit} noValidate={scenarioId === 'invalid'} className="grid grid-cols-2 gap-4">
              {fieldLabels.map(([key, label, type]) => <label key={key} className={`min-w-0 text-sm text-[#c3d6c9] ${key === 'email' ? 'col-span-2' : ''}`}>{label}{key === 'phone' && <span className="text-[#94ae9f]"> (optional)</span>}<input className={`${inputStyle} mt-2`} name={key} type={type} autoComplete="off" required={key !== 'phone'} value={input[key]} onChange={event => setInput({ ...input, [key]: event.target.value })} /></label>)}
              <details className="col-span-2 rounded-xl border border-white/15 p-3" open={Boolean(editingId)}>
                <summary className="cursor-pointer text-sm font-semibold text-[#c3d6c9]">Synthetic enrichment & attribution</summary>
                <p className="my-3 text-sm leading-6 text-[#a1b7aa]">Practice values added after the form is submitted. Use these to explore how enrichment affects routing.</p>
                <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Region<select className={`${inputStyle} mt-1`} value={context.region} onChange={event => setContext({ ...context, region: event.target.value as Region | '' })}><option value="">Unknown</option><option>East</option><option>Central</option><option>West</option></select></label><label className="text-sm">Monthly media budget ($)<input className={`${inputStyle} mt-1`} type="number" min="0" value={context.monthlySpend} onChange={event => setContext({ ...context, monthlySpend: Number(event.target.value) })} /></label><label className="text-sm">Source<input className={`${inputStyle} mt-1`} value={context.source} onChange={event => setContext({ ...context, source: event.target.value })} /></label><label className="text-sm">Campaign<input className={`${inputStyle} mt-1`} value={context.campaign} onChange={event => setContext({ ...context, campaign: event.target.value })} /></label></div>
              </details>
              <p className="col-span-2 text-sm leading-6 text-[#a1b7aa]">Use fictional details. Your practice session is saved in this browser. CRM updates and notifications are simulated.</p>
              <button disabled={!hydrated} type="submit" className="col-span-2 rounded-xl bg-[#d8ff67] px-5 py-3.5 font-semibold text-[#06100d] hover:bg-[#e4ff9b] disabled:opacity-50">{editingId ? 'Save correction & retry' : 'Submit test request'}</button>
              {editingId && <button className={`${buttonStyle} col-span-2`} type="button" onClick={() => { setEditingId(null); selectScenario('new'); }}>Cancel correction</button>}
            </form>
          </section>

          <section ref={traceRef} className="min-w-0 rounded-2xl border border-white/15 bg-[#0c1d15] p-5 sm:p-6" aria-labelledby="trace-title">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-sm text-[#a1b7aa]">{selected?.id ?? 'NO REQUEST SELECTED'}</p><h2 id="trace-title" className="mt-1 text-xl font-semibold">{selected ? `${selected.input.firstName} ${selected.input.lastName}` : 'Request trace'}</h2><p className="mt-1 text-sm text-[#a1b7aa]">{selected?.input.company}</p></div>{selected && <Status status={selected.status} />}</div>
            {selected ? <>
              <ol className="my-5 space-y-2">
                {traceStages.map((stage, index) => {
                  const step = attempt?.steps.find(item => item.stage === stage);
                  return <li key={stage} className={`flex gap-3 rounded-xl border p-3 ${step?.status === 'failed' ? 'border-[#ff8c7b]/40 bg-[#ff8c7b]/5' : step?.status === 'held' ? 'border-[#f5bc67]/40 bg-[#f5bc67]/5' : 'border-white/10'}`}><span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full font-mono text-sm ${step?.status === 'passed' ? 'bg-[#d8ff67]/15 text-[#d8ff67]' : step ? 'bg-[#f5bc67]/15 text-[#f5bc67]' : 'bg-white/5 text-[#819c8e]'}`}>{step?.status === 'passed' ? '✓' : step ? '!' : index + 1}</span><div className="min-w-0"><p className="font-semibold">{stage}<span className="ml-2 text-sm font-normal text-[#a1b7aa]">{step?.status ?? 'not reached'}</span></p><p className="mt-1 text-sm leading-6 text-[#b0c7b8]">{step?.detail ?? 'Waiting for the earlier steps to complete.'}</p></div></li>;
                })}
              </ol>
              <div className="flex flex-wrap gap-2"><button className={buttonStyle} disabled={selected.status === 'routed'} onClick={() => finish(retryInbound(state, selected.id), selected.id)}>Retry selected request</button><button className={buttonStyle} disabled={selected.status === 'routed'} onClick={() => editRequest(selected)}>Correct source fields</button><span className="self-center text-sm text-[#a1b7aa]">{selected.attempts.length} {selected.attempts.length === 1 ? 'attempt' : 'attempts'}</span></div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2"><details className="min-w-0 rounded-xl border border-white/15 p-3"><summary className="cursor-pointer text-sm font-semibold">Captured payload</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-sm leading-6 text-[#b0c7b8]">{JSON.stringify(selected.payload, null, 2)}</pre></details><details className="min-w-0 rounded-xl border border-white/15 p-3"><summary className="cursor-pointer text-sm font-semibold">Simulated CRM record</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-sm leading-6 text-[#b0c7b8]">{selectedLead ? JSON.stringify({ ...selectedLead, owner: state.reps.find(rep => rep.id === selectedLead.ownerId)?.name ?? 'Unassigned' }, null, 2) : 'No CRM record has been created for this request.'}</pre></details></div>
              {selected.attempts.length > 1 && <details className="mt-3 rounded-xl border border-white/15 p-3"><summary className="cursor-pointer text-sm font-semibold">Previous attempts</summary>{selected.attempts.slice(0, -1).map((item, index) => <div key={index} className="mt-3 border-t border-white/10 pt-3 text-sm"><p>Attempt {index + 1} · {new Date(item.at).toLocaleString()}</p><p className="mt-1 text-[#f5bc67]">{item.steps.at(-1)?.detail}</p><pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-[#a1b7aa]">{JSON.stringify(item.payload, null, 2)}</pre></div>)}</details>}
            </> : <p className="mt-6 text-[#a1b7aa]">Submit a test request or load the sample batch to start.</p>}
          </section>
        </div>

        <section className="my-5 rounded-2xl border border-[#f5bc67]/25 bg-[#f5bc67]/[0.035] p-5 sm:p-6" aria-labelledby="fault-title">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="fault-title" className="text-xl font-semibold">Break a handoff</h2><p className="mt-1 text-sm leading-6 text-[#b0c7b8]">Turn on a fault, submit with a new fictional email, inspect the trace, then fix the setting and retry. Reusing an email reuses its CRM contact.</p></div><button className={buttonStyle} onClick={() => { setState({ ...state, settings: { ...defaultLabSettings } }); setNotice('Mapping, CRM responses, and notifications are healthy. Retry the affected request to finish it.'); }}>Restore healthy settings</button></div>
          <div className="mt-5 grid gap-4 md:grid-cols-3"><label className="text-sm">Email field mapping<select className={`${inputStyle} mt-2`} value={state.settings.emailMapping} onChange={event => setState({ ...state, settings: { ...state.settings, emailMapping: event.target.value as 'correct' | 'broken' } })}><option value="correct">Correct · source field 3</option><option value="broken">Broken · source field 8</option></select></label><label className="text-sm">CRM response<select className={`${inputStyle} mt-2`} value={state.settings.crmFault} onChange={event => setState({ ...state, settings: { ...state.settings, crmFault: event.target.value as InboundLabState['settings']['crmFault'] } })}><option value="none">Healthy</option><option value="before-write">Fail before record creation</option><option value="after-write">Lose response after creation</option></select></label><label className="flex items-center gap-3 self-end rounded-xl border border-white/20 p-3 text-sm"><input className="h-5 w-5 accent-[#d8ff67]" type="checkbox" checked={state.settings.notificationFault} onChange={event => setState({ ...state, settings: { ...state.settings, notificationFault: event.target.checked } })} />Fail rep notification</label></div>
          <p className="mt-3 text-sm text-[#f5bc67]">{faultCount ? `${faultCount} fault${faultCount === 1 ? '' : 's'} active for new attempts.` : 'All handoffs healthy.'}</p>
        </section>

        <section className="overflow-hidden rounded-2xl border border-white/15 bg-[#0c1d15]" aria-labelledby="queue-title">
          <div className="flex flex-wrap items-center justify-between gap-3 p-5"><h2 id="queue-title" className="text-xl font-semibold">Request queue</h2><label className="flex items-center gap-2 text-sm">Show<select className={`${inputStyle} !w-auto !py-2`} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All requests ({metrics.requests})</option><option value="held">Held ({metrics.held})</option><option value="failed">Failed ({metrics.failed})</option><option value="routed">Routed ({metrics.routed})</option></select></label></div>
          <div className="max-h-[460px] overflow-auto"><table className="w-full min-w-[730px] text-left text-sm"><thead className="sticky top-0 bg-[#13271b] text-[#b0c7b8]"><tr>{['Request', 'Contact / company', 'Source', 'Result', 'Owner', 'Attempts'].map(label => <th key={label} className="px-4 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{visibleRuns.map(run => <tr key={run.id} className={`border-t border-white/10 ${selected?.id === run.id ? 'bg-[#d8ff67]/[0.07]' : 'hover:bg-white/[0.035]'}`}><td className="px-4 py-3"><button className="font-mono text-[#d8ff67] underline decoration-[#d8ff67]/30 underline-offset-4" onClick={() => { setSelectedId(run.id); traceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} aria-label={`Inspect ${run.id} ${run.input.company}`}>{run.id}</button></td><td className="px-4 py-3"><p>{run.input.firstName} {run.input.lastName}</p><p className="mt-1 text-[#a1b7aa]">{run.input.company}</p></td><td className="px-4 py-3 text-[#a1b7aa]">{run.context.source}</td><td className="px-4 py-3"><Status status={run.status} /></td><td className="px-4 py-3">{state.reps.find(rep => rep.id === run.ownerId)?.name ?? '—'}</td><td className="px-4 py-3">{run.attempts.length}</td></tr>)}</tbody></table>{!visibleRuns.length && <p className="p-6 text-[#a1b7aa]">No requests in this view.</p>}</div>
        </section>

        <section className="mt-5 grid gap-5 lg:grid-cols-2">
          <details className="rounded-2xl border border-white/15 bg-[#0c1d15] p-5"><summary className="cursor-pointer text-xl font-semibold">Rep pool & routing policy</summary><p className="my-4 text-sm leading-6 text-[#a1b7aa]">Fictional rules: preserve active contact/account owners; otherwise match region and budget segment ($35k+ is Enterprise), then choose the lowest utilization. Missing context or no eligible rep is held. Assigned totals include a fictional starting workload; you can change availability and capacity below.</p><div className="space-y-3">{state.reps.map(rep => <div key={rep.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3"><div><p className="font-semibold">{rep.name}</p><p className="text-sm text-[#a1b7aa]">{rep.region} · {rep.segment} · {rep.assigned}/{rep.capacity} assigned</p></div><div className="flex items-center gap-3"><label className="flex items-center gap-2 text-sm">Capacity<input aria-label={`${rep.name} capacity`} className={`${inputStyle} !w-20 !p-2`} type="number" min="0" step="1" value={rep.capacity} onChange={event => setState({ ...state, reps: state.reps.map(item => item.id === rep.id ? { ...item, capacity: Math.max(0, Math.floor(Number(event.target.value))) } : item) })} /></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[#d8ff67]" checked={rep.active} onChange={event => setState({ ...state, reps: state.reps.map(item => item.id === rep.id ? { ...item, active: event.target.checked } : item) })} />Available</label></div></div>)}</div></details>
          <details className="rounded-2xl border border-white/15 bg-[#0c1d15] p-5">
            <summary className="cursor-pointer text-xl font-semibold">How this lab works</summary>
            <div className="mt-4 space-y-3 text-sm leading-6 text-[#b0c7b8]">
              <p>The practice form captures first name, last name, business email, phone, and company. Phone is optional.</p>
              <p>Synthetic enrichment adds region and budget. The lab matches existing accounts, preserves ownership, and routes new prospects to an available rep.</p>
              <p>CRM records and notifications are simulated. Inspect each step, introduce a fault, then retry to see how the handoff recovers.</p>
            </div>
          </details>
        </section>
        <footer className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/15 pt-5 text-sm text-[#a1b7aa]"><p>Fictional advertisers, people, and budgets. Reserved .example addresses. Session stays in this browser.</p>{resetConfirm ? <div className="flex gap-2"><button className={buttonStyle} onClick={() => { setState(createInboundLab()); setSelectedId(''); setEditingId(null); setResetConfirm(false); setNotice('Practice requests cleared. Start with the form or add the sample batch.'); }}>Clear this practice session</button><button className={buttonStyle} onClick={() => setResetConfirm(false)}>Keep session</button></div> : <button className={buttonStyle} onClick={() => setResetConfirm(true)}>Reset practice</button>}</footer>
      </div>
    </main>
  );
}

function Status({ status }: { status: LabRun['status'] }) {
  return <span className={`inline-block rounded-full px-3 py-1.5 text-sm font-medium ${statusStyle[status]}`}>{status === 'routed' ? 'Routed' : status === 'held' ? 'Held' : 'Failed'}</span>;
}
