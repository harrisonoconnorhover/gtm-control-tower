'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  messyLeadDemoCsv,
  previewMessyLeadDemo,
  runMessyLeadDemo,
  type DemoPipelineResult,
} from '@/lib/messy-lead-demo';
import type { LiveContactState } from '@/lib/live-control-tower';
import { buildDemoDecisionReport, demoDecisionStatus, type DemoDecision, type DemoDecisionReport, type DemoDecisionStatus } from '@/lib/demo-decisions';
import { InstantCrmAudit } from '@/components/instant-crm-audit';

const steps = [
  { label: 'Ingest', system: 'Sample CSV', detail: 'Read 64 fictional leads in your browser.' },
  { label: 'Normalize', system: 'Control Tower', detail: 'Standardize identity, stages, and routing inputs.' },
  { label: 'Merge', system: 'Identity rules', detail: 'Keep one canonical contact without deleting evidence.' },
  { label: 'Reroute', system: 'Example policy', detail: 'Assign Northeast enterprise leads to the overflow owner.' },
  { label: 'Replay', system: 'Expected stage', detail: 'Restore the later stage supplied in the sample file.' },
  { label: 'Receipt', system: 'Readiness check', detail: 'Count ready and held rows; CRM writes require the operator workspace.' },
];

const preview = previewMessyLeadDemo();

export function PublicDemo() {
  const [stage, setStage] = useState(-1);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DemoPipelineResult | null>(null);
  const complete = stage === steps.length - 1 && !running;
  const resultsRef = useRef<HTMLElement>(null);
  const requestedRun = useRef(false);
  const report = useMemo(() => result ? buildDemoDecisionReport(result, messyLeadDemoCsv()) : null, [result]);

  useEffect(() => {
    if (!complete || !requestedRun.current) return;
    requestedRun.current = false;
    const results = resultsRef.current;
    results?.focus({ preventScroll: true });
    results?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [complete, result]);

  useEffect(() => {
    const sectionId = window.location.hash.slice(1);
    if (sectionId) document.getElementById(sectionId)?.scrollIntoView();
  }, []);

  useEffect(() => {
    const captureParameter = new URLSearchParams(window.location.search).get('capture');
    const requestedStage = captureParameter === null ? null : Number(captureParameter);
    if (requestedStage !== null && Number.isInteger(requestedStage) && requestedStage >= 0 && requestedStage < steps.length) {
      const timer = window.setTimeout(() => {
        setResult(runMessyLeadDemo());
        setStage(requestedStage);
        setRunning(false);
        document.querySelector(requestedStage === steps.length - 1 ? '#walkthrough' : '#demo')?.scrollIntoView({ block: 'start' });
      }, 80);
      return () => window.clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    if (!running) return;
    if (stage >= steps.length - 1) {
      const stop = window.setTimeout(() => setRunning(false), 520);
      return () => window.clearTimeout(stop);
    }
    const advance = window.setTimeout(() => setStage((current) => current + 1), 620);
    return () => window.clearTimeout(advance);
  }, [running, stage]);

  const shownContacts = useMemo(() => {
    if (!result || !complete) return preview.sample;
    return result.repairedSample;
  }, [result, complete]);

  function runDemo() {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestedRun.current = true;
    setResult(runMessyLeadDemo());
    setStage(reduceMotion ? steps.length - 1 : 0);
    setRunning(!reduceMotion);
    if (!reduceMotion) {
      const demo = document.getElementById('demo');
      demo?.focus({ preventScroll: true });
      demo?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  return (
    <main id="top" data-capture-stage={stage} className="min-h-screen overflow-hidden bg-[#06100d] text-[#edf8f2] selection:bg-[#d8ff67] selection:text-[#06100d]">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[760px] bg-[radial-gradient(circle_at_72%_4%,rgba(205,252,84,0.15),transparent_32%),radial-gradient(circle_at_12%_12%,rgba(49,156,118,0.18),transparent_30%)]" />
      <div className="relative mx-auto max-w-[1500px] px-5 sm:px-8 lg:px-12">
        <header className="flex flex-wrap items-center justify-between gap-5 border-b border-white/10 py-5">
          <a href="#top" className="flex items-center gap-3" aria-label="GTM Control Tower home">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#d8ff67] font-mono text-xs font-black text-[#06100d] shadow-[0_0_40px_rgba(216,255,103,0.16)]">GT</span>
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-[#7e968b]">Revenue systems lab</p>
              <p className="text-base font-semibold tracking-tight">GTM Control Tower</p>
            </div>
          </a>
          <nav className="flex flex-wrap items-center gap-2 text-xs" aria-label="Primary navigation">
            <a href="#audit" className="rounded-full bg-[#83bcff]/10 px-4 py-2 font-semibold text-[#83bcff]">Audit your CSV</a>
            <a href="#demo" className="rounded-full bg-white/[0.06] px-4 py-2 text-[#dce9e2]">Two-minute demo</a>
            <a href="#salesforce-proof" className="rounded-full border border-[#83bcff]/20 px-4 py-2 font-semibold text-[#83bcff]">Apex proof</a>
            <a href="https://github.com/harrisonoconnorhover/gtm-control-tower#quick-start-one-command-no-accounts-required" className="rounded-full border border-white/10 px-4 py-2 text-[#9fb2a8] transition hover:border-white/25 hover:text-white">Self-host setup</a>
            <a href="https://github.com/harrisonoconnorhover/gtm-control-tower" target="_blank" rel="noreferrer" className="rounded-full border border-[#d8ff67]/25 px-4 py-2 font-semibold text-[#d8ff67] transition hover:bg-[#d8ff67]/10">GitHub ↗</a>
          </nav>
        </header>

        <section className="grid min-h-[650px] items-center gap-12 py-14 lg:grid-cols-[1.02fr_0.98fr] lg:py-20">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#d8ff67]/20 bg-[#d8ff67]/[0.06] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[#d8ff67]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#d8ff67]" />
              Browser demo · synthetic data · open source
            </div>
            <h1 className="max-w-[850px] text-5xl font-semibold leading-[0.93] tracking-[-0.065em] sm:text-7xl lg:text-[86px]">
              Bad CRM data in. Defensible action out.
            </h1>
            <p className="mt-7 max-w-2xl text-base leading-7 text-[#96aaa0] sm:text-lg">
              Inspect duplicate leads, incorrect owner assignments, and lifecycle mismatches. Run the sample cleanup to see which records pass the readiness checks and which still need review.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a href="#audit" className="rounded-full bg-[#83bcff] px-6 py-3.5 text-sm font-black text-[#06100d] shadow-[0_14px_50px_rgba(131,188,255,0.16)] transition hover:-translate-y-0.5 hover:bg-[#acd5ff]">
                Audit my CSV privately
              </a>
              <button
                onClick={runDemo}
                aria-controls="demo-results"
                aria-describedby="demo-boundary"
                disabled={running}
                className="rounded-full border border-[#d8ff67]/25 bg-[#d8ff67]/[0.08] px-6 py-3.5 text-sm font-bold text-[#d8ff67] transition hover:-translate-y-0.5 hover:bg-[#d8ff67]/[0.14] disabled:cursor-wait disabled:opacity-70"
                data-testid="run-public-demo"
              >
                {running ? `Running ${steps[Math.max(stage, 0)].label.toLowerCase()}…` : result ? 'Replay the 64-row cleanup' : 'Run the 64-row cleanup'}
              </button>
              <a href="/enterprise-import-walkthrough.html" className="rounded-full border border-white/15 bg-white/[0.035] px-6 py-3.5 text-sm font-semibold text-[#c8d7d0] transition hover:border-white/30 hover:bg-white/[0.07]">Follow a real CRM import</a>
            </div>
            <div className="mt-9 grid max-w-2xl grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-4">
              <HeroStat value="64" label="deliberately messy rows" />
              <HeroStat value={String(preview.duplicateRows)} label="duplicate identities" warning />
              <HeroStat value={String(preview.routingExceptions)} label="routing exceptions" warning />
              <HeroStat value={String(preview.lifecycleRegressions)} label="stage regressions" warning />
            </div>
          </div>

          <article className="overflow-hidden rounded-[32px] border border-white/10 bg-[#0b1b16]/95 shadow-[0_40px_120px_rgba(0,0,0,0.34)]">
            <div className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4 sm:px-6">
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#7f9a8d]">Batch lab-2026-08</p>
                <h2 className="mt-1 text-lg font-semibold">{complete ? 'Six result examples' : 'Messy source preview'}</h2>
              </div>
              <span className={`rounded-full px-3 py-1.5 font-mono text-[9px] uppercase ${complete ? 'bg-[#d8ff67] text-[#06100d]' : running ? 'bg-[#e6bd68]/15 text-[#e6bd68]' : 'bg-[#ff7755]/10 text-[#ff9c82]'}`}>
                {complete ? 'complete' : running ? 'processing' : 'untrusted'}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left text-[11px]">
                <thead className="bg-white/[0.025] font-mono text-[8px] uppercase tracking-wider text-[#667c71]">
                  <tr>
                    <th className="px-5 py-3 font-medium">Contact</th>
                    <th className="px-4 py-3 font-medium">Raw identity</th>
                    <th className="px-4 py-3 font-medium">Flags</th>
                    <th className="px-5 py-3 font-medium">Decision</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {shownContacts.map((contact) => <ContactRow key={contact.contactId} contact={contact} repaired={complete} />)}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-5 py-4 text-[10px] text-[#71877c] sm:px-6">
              <span>Showing six representative rows from the bundled 64-row fixture.</span>
              <span className="font-mono text-[#9bb0a5]">No customer data · no hidden API</span>
            </div>
          </article>
        </section>

        <InstantCrmAudit />

        <section id="demo" tabIndex={-1} className="scroll-mt-6 pb-8 focus-visible:outline-2 focus-visible:outline-[#d8ff67]" aria-label="Interactive cleanup demonstration">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#d8ff67]">The two-minute proof</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Six controls. One auditable batch.</h2>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-[#9fb2a8]">Choose <strong>Run the 64-row cleanup</strong> to inspect the results below. Expand any record to compare values and rules, then download the same decisions. To try an audit first, use <a href="#audit" className="underline underline-offset-4">Try safe sample</a> and download its aggregate report.</p>
            </div>
            <p aria-live="polite" className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#71877c]">
              {stage < 0 ? 'Ready to run' : running ? `Step ${stage + 1} of ${steps.length}` : 'Run complete'}
            </p>
          </div>
          <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
            {steps.map((step, index) => {
              const isActive = running && stage === index;
              const isDone = stage > index || (!running && stage === index);
              return (
                <article key={step.label} className={`min-h-[188px] rounded-2xl border p-4 transition-all duration-500 motion-reduce:transition-none ${isActive ? '-translate-y-1 border-[#d8ff67]/55 bg-[#d8ff67]/10' : isDone ? 'border-[#4fa782]/30 bg-[#10241c]' : 'border-white/[0.08] bg-white/[0.025]'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <span className={`grid h-7 w-7 place-items-center rounded-full font-mono text-[9px] ${isActive ? 'bg-[#d8ff67] text-[#06100d]' : isDone ? 'bg-[#4fa782]/20 text-[#7fddb6]' : 'bg-white/[0.06] text-[#6a8075]'}`}>{isDone ? '✓' : String(index + 1).padStart(2, '0')}</span>
                    <span className="font-mono text-[8px] uppercase tracking-wider text-[#63776d]">{step.system}</span>
                  </div>
                  <h3 className="mt-5 font-semibold">{step.label}</h3>
                  <p className="mt-2 text-xs leading-5 text-[#81978c]">{step.detail}</p>
                  <p className={`mt-4 font-mono text-[9px] ${isActive || isDone ? 'text-[#d8ff67]' : 'text-[#50635a]'}`}>{stageResult(index, result, isActive, isDone)}</p>
                </article>
              );
            })}
          </div>
          <p id="demo-boundary" className="mt-4 max-w-4xl text-xs leading-6 text-[#9fb2a8]">This run uses fictional records and computes the result locally in your browser. The example policy sends Northeast enterprise leads to <code>CE-ENT-OVERFLOW</code>; it does not measure rep capacity. Stage replay uses the file&apos;s <code>expected_lifecycle_stage</code>, so it depends on a supplied source of truth. This page makes no CRM changes.</p>
        </section>

        <section id="demo-results" ref={resultsRef} tabIndex={-1} aria-label="Cleanup results" className="grid scroll-mt-6 gap-5 py-8 focus-visible:outline-2 focus-visible:outline-[#d8ff67] lg:grid-cols-[0.9fr_1.1fr]">
          <article className="rounded-[30px] border border-white/10 bg-[#0b1b16] p-5 sm:p-7">
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#ff9c82]">Before</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">The CRM looks populated. It is not trustworthy.</h2>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <OutcomeMetric label="Destination-ready" value={`${preview.beforeQuality.toFixed(0)}%`} detail={`${Math.round(preview.rawRows * preview.beforeQuality / 100)} / ${preview.rawRows} input rows`} tone="warning" />
              <OutcomeMetric label="Flagged rows" value={String(preview.initiallyFlagged)} tone="warning" />
              <OutcomeMetric label="Duplicate rows" value={String(preview.duplicateRows)} tone="warning" />
              <OutcomeMetric label="Stage reversals" value={String(preview.lifecycleRegressions)} tone="warning" />
            </div>
          </article>

          <article className={`rounded-[30px] border p-5 transition-colors sm:p-7 ${complete ? 'border-[#d8ff67]/30 bg-[#d8ff67]/[0.07]' : 'border-white/10 bg-[#0b1b16]'}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#d8ff67]">After</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">Only explainable rows cross the destination gate.</h2>
              </div>
              <span className="rounded-full border border-[#d8ff67]/20 px-3 py-1.5 font-mono text-[9px] text-[#d8ff67]">PREVIEW → EXECUTE → RECEIPT</span>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <OutcomeMetric label="Destination-ready" value={complete && result ? `${result.afterQuality.toFixed(0)}%` : '—'} detail={complete && result ? `${result.readyRows} / ${result.activeRows} canonical rows` : 'After cleanup'} />
              <OutcomeMetric label="Merged" value={complete && result ? String(result.mergedRows) : '—'} />
              <OutcomeMetric label="Rerouted" value={complete && result ? String(result.reroutedRows) : '—'} />
              <OutcomeMetric label="Held safely" value={complete && result ? String(result.heldRows) : '—'} />
            </div>
            <div className="mt-5 rounded-2xl border border-white/10 bg-[#06100d]/55 p-4 font-mono text-[10px] leading-6 text-[#89a095]">
              {complete && result ? (
                <>
                  <p className="text-[#d8ff67]">BROWSER RECEIPT · DEMO-LAB-64 · LOCAL CLEANUP COMPLETE</p>
                  <p>{result.activeRows} canonical rows · {result.readyRows} pass readiness checks · {result.heldRows} held for review</p>
                  <p>{result.mergedRows} merges · {result.reroutedRows} reroutes · {result.replayedRows} lifecycle replays</p>
                  <a href="#decisions" className="mt-2 inline-block rounded text-[#d8ff67] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4">Inspect all {result.rawRows} record decisions ↓</a>
                </>
              ) : <p>Run the batch to produce the deterministic execution receipt.</p>}
            </div>
          </article>
        </section>

        {complete && report ? <DecisionInspector report={report} /> : (
          <section id="decisions" aria-labelledby="decisions-heading" className="scroll-mt-6 rounded-[30px] border border-white/10 bg-[#0b1b16] p-5 sm:p-7">
            <h2 id="decisions-heading" className="text-2xl font-semibold tracking-tight">Inspect the record decisions</h2>
            <p className="mt-3 text-sm leading-6 text-[#9fb2a8]">Run the fictional batch to compare every record, inspect all remaining holds and download the same decisions. Nothing is sent to a CRM.</p>
            <button type="button" onClick={runDemo} disabled={running} aria-controls="demo-results" className="mt-4 rounded-full border border-[#d8ff67]/35 bg-[#d8ff67]/10 px-5 py-3 text-sm font-semibold text-[#d8ff67] disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#d8ff67]">{running ? 'Cleanup running…' : 'Run cleanup and inspect records'}</button>
          </section>
        )}

        <section id="salesforce-proof" className="scroll-mt-6 py-8" aria-label="Salesforce Apex and Flow architecture proof">
          <div className="overflow-hidden rounded-[34px] border border-[#83bcff]/25 bg-[#081814]">
            <div className="grid gap-0 xl:grid-cols-[0.78fr_1.22fr]">
              <div className="border-b border-white/10 p-6 sm:p-8 lg:p-10 xl:border-b-0 xl:border-r">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#83bcff]">Separate Salesforce development-org exercise</p>
                <h2 className="mt-3 text-4xl font-semibold leading-tight tracking-[-0.05em]">Route approved leads and preserve newer changes.</h2>
                <p className="mt-5 text-sm leading-6 text-[#8ca096]">Agentforce and the triage Flow stay read-only. Ownership changes cross a separate Screen Flow approval boundary, then one Queueable Apex job locks the selected Leads, rejects stale data, applies deployable Custom Metadata policies, and writes a durable receipt for every record.</p>
                <p className="mt-4 rounded-2xl border border-[#d8ff67]/20 bg-[#d8ff67]/[0.06] px-4 py-3 font-mono text-[10px] leading-5 text-[#b9d978]">SEPTEMBER 2, 2026 · 6/6 ROUTING TESTS PASSED · SEPARATE LIVE 3-LEAD RUN: 2 ROUTED, 1 HELD, 0 FAILED · REPEATED APPROVAL RETURNED THE SAME RUN</p>
                <div className="mt-6 grid grid-cols-2 gap-3">
                  <ProofStat value="200" label="Leads in the bulk test" />
                  <ProofStat value="1" label="Queueable job per run" />
                  <ProofStat value="0" label="duplicate jobs per token" />
                  <ProofStat value="5" label="durable receipt states" />
                </div>
                <div className="mt-6 flex flex-wrap gap-3">
                  <a href="https://github.com/harrisonoconnorhover/gtm-control-tower/blob/main/salesforce/force-app/main/default/classes/GTMLeadRoutingService.cls" target="_blank" rel="noreferrer" className="rounded-full bg-[#83bcff] px-5 py-3 text-sm font-black text-[#06100d]">Read the Apex ↗</a>
                  <a href="https://github.com/harrisonoconnorhover/gtm-control-tower/blob/main/docs/salesforce-apex-routing.md" target="_blank" rel="noreferrer" className="rounded-full border border-white/15 px-5 py-3 text-sm font-semibold text-[#c8d7d0]">See the test contract ↗</a>
                </div>
              </div>
              <div className="p-6 sm:p-8 lg:p-10">
                <div className="grid gap-3 md:grid-cols-2">
                  <ApexProofStep number="01" eyebrow="Recommend" title="Agentforce → read-only Flow" detail="Deterministic Apex explains readiness and recommends a queue without changing Salesforce." />
                  <ApexProofStep number="02" eyebrow="Authorize" title="Human approval Screen Flow" detail="A required confirmation and Flow interview token create an explicit, idempotent write boundary." />
                  <ApexProofStep number="03" eyebrow="Plan" title="Custom Metadata policies" detail="Admins change score, segment, priority, and queue rules without editing or redeploying Apex." />
                  <ApexProofStep number="04" eyebrow="Protect" title="FOR UPDATE + stale guard" detail="The async worker locks Leads and refuses to overwrite a record changed after the operator approved it." />
                  <ApexProofStep number="05" eyebrow="Execute" title="Partial-success Queueable" detail="Database.update(..., false) preserves valid ownership changes when an individual Lead fails." />
                  <ApexProofStep number="06" eyebrow="Recover" title="Receipts + Transaction Finalizer" detail="Per-Lead outcomes stay queryable, and a separate finalizer transaction records terminal async failures." />
                </div>
                <p className="mt-5 font-mono text-[9px] leading-5 text-[#657d72]">WITH SHARING · USER-MODE CRUD/FLS · BULK 200 · ROW LOCKS · IDEMPOTENCY · CUSTOM METADATA · PARTIAL DML · TRANSACTION FINALIZER</p>
              </div>
            </div>
          </div>
        </section>

        <section id="sister-projects" className="scroll-mt-6 py-8" aria-labelledby="sister-projects-heading">
          <div className="mb-6 max-w-2xl">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#9fb2a8]">Sister projects</p>
            <h2 id="sister-projects-heading" className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">More tools for the work around your CRM.</h2>
            <p className="mt-4 text-sm leading-6 text-[#9fb2a8]">Independent software projects by Harrison O&apos;Connor-Hoover. Each has its own codebase, setup, and development status.</p>
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <article className="flex flex-col rounded-2xl border border-white/15 bg-[#0b1b16] p-6 sm:p-8">
              <p className="font-mono text-xs text-[#ffb49d]">LEAD ASSIGNMENT</p>
              <h3 className="mt-3 text-2xl font-semibold">Hot Potato</h3>
              <p className="mt-4 text-sm leading-6 text-[#b1c2b9]">Route an inbound lead to an eligible rep, preserve a valid existing owner, and record why that rep was chosen. The routing engine uses readable rules and weighted round robin.</p>
              <p className="mb-6 mt-4 text-xs leading-5 text-[#9fb2a8]">Open-source application in active development. Real calendar and CRM actions require your own provider connections.</p>
              <a href="https://github.com/harrisonoconnorhover/hot-potato" target="_blank" rel="noopener noreferrer" className="mt-auto w-fit rounded-lg border border-[#ffb49d]/35 px-4 py-3 text-sm font-semibold text-[#ffb49d] transition hover:bg-[#ffb49d]/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#ffb49d]">Explore Hot Potato source ↗</a>
            </article>
            <article className="flex flex-col rounded-2xl border border-white/15 bg-[#0b1b16] p-6 sm:p-8">
              <p className="font-mono text-xs text-[#bfb5ff]">RESEARCH WORKBOOKS</p>
              <h3 className="mt-3 text-2xl font-semibold">Pomade</h3>
              <p className="mt-4 text-sm leading-6 text-[#b1c2b9]">Import account data, apply reusable formulas and research recipes, and inspect the sources and run history behind the results. Keep review and CRM updates as deliberate steps.</p>
              <p className="mb-6 mt-4 text-xs leading-5 text-[#9fb2a8]">In active development. Hosted access is private; the public repository documents the available workflows and limits.</p>
              <a href="https://github.com/harrisonoconnorhover/pomade" target="_blank" rel="noopener noreferrer" className="mt-auto w-fit rounded-lg border border-[#bfb5ff]/35 px-4 py-3 text-sm font-semibold text-[#bfb5ff] transition hover:bg-[#bfb5ff]/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#bfb5ff]">Explore Pomade source ↗</a>
            </article>
          </div>
        </section>

        <section id="walkthrough" className="scroll-mt-6 py-8" aria-label="CRM sandbox results">
          <div className="grid gap-8 rounded-[34px] border border-[#83bcff]/20 bg-[#0a1b17] p-6 sm:p-8 lg:grid-cols-[1.2fr_1fr] lg:items-center lg:p-10">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#83bcff]">Historical CRM sandbox run · documented August 26, 2026</p>
              <h2 className="mt-3 text-4xl font-semibold leading-tight tracking-[-0.05em]">The receipt caught what the local validator missed.</h2>
              <p className="mt-5 text-sm leading-6 text-[#8ca096]">A separate 72-row batch with synthetic people ran through the operator flow and both CRM sandboxes. Eight duplicate rows were consolidated locally, six malformed emails stayed out, and an internationalized-domain mismatch surfaced as six HubSpot failures. IDNA normalization fixed the provider boundary; the retry completed without duplicating prior successes.</p>
              <p className="mt-4 text-xs leading-6 text-[#9fb2a8]">These recorded results come from a different batch than the 64-row browser demo. They describe development systems, not customer outcomes or a live connection from this page. <a href="https://github.com/harrisonoconnorhover/gtm-control-tower/blob/d81b57e/README.md#verified-integration-behavior" target="_blank" rel="noreferrer" className="underline underline-offset-4">Read the historical run notes ↗</a></p>
            </div>
            <div>
              <div className="grid grid-cols-2 gap-3">
                <ProofStat value="72" label="messy input rows" />
                <ProofStat value="58" label="governed CRM identities" />
                <ProofStat value="0" label="duplicate Salesforce emails" />
                <ProofStat value="58/58" label="final HubSpot receipt" />
              </div>
              <p className="mt-5 font-mono text-[9px] leading-5 text-[#657d72]">REPEAT PROOF · SALESFORCE 0 CREATED / 58 UPDATED · HUBSPOT 52 UPDATED / 6 CORRECTED CREATED</p>
            </div>
          </div>
        </section>

        <section className="my-8 overflow-hidden rounded-[34px] border border-white/10 bg-[#edf4e9] text-[#102019]">
          <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[0.86fr_1.14fr] lg:items-center lg:p-10">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#486257]">Useful before enterprise software</p>
              <h2 className="mt-3 text-3xl font-semibold leading-tight tracking-[-0.045em] sm:text-4xl">Start with a file. Add systems only when they earn their keep.</h2>
              <p className="mt-4 max-w-xl text-sm leading-6 text-[#5d6f66]">This public demonstration runs entirely in your browser. The real operator workspace self-hosts with Docker, CSV, and SQLite; Google Sheets, HubSpot, Salesforce, and BigQuery remain optional connectors.</p>
              <div className="mt-6 flex flex-wrap gap-3">
                <a href="https://github.com/harrisonoconnorhover/gtm-control-tower#quick-start-one-command-no-accounts-required" className="rounded-full bg-[#102019] px-5 py-3 text-sm font-bold text-white">See the self-host setup</a>
                <a href="https://github.com/harrisonoconnorhover/gtm-control-tower" className="rounded-full border border-[#102019]/15 px-5 py-3 text-sm font-semibold">View source</a>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center">
              <PathNode eyebrow="Source" title="CSV or Sheets" detail="Free and portable" />
              <PathArrow />
              <PathNode eyebrow="Decision" title="Control Tower" detail="Map · repair · receipt" accent />
              <PathArrow />
              <PathNode eyebrow="Optional" title="CRM / warehouse" detail="HubSpot · SFDC · BQ" />
            </div>
          </div>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-white/10 py-8 text-xs text-[#667c71]">
          <p>Browser-only audit · no uploads · open-source self-hosted workspace</p>
          <nav aria-label="Sister projects" className="flex flex-wrap items-center gap-x-5 gap-y-3 text-[#9fb2a8]">
            <span>Sister projects</span>
            <a href="https://github.com/harrisonoconnorhover/hot-potato" target="_blank" rel="noopener noreferrer" className="rounded underline underline-offset-4 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4">Hot Potato ↗</a>
            <a href="https://github.com/harrisonoconnorhover/pomade" target="_blank" rel="noopener noreferrer" className="rounded underline underline-offset-4 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-4">Pomade ↗</a>
          </nav>
          <p className="font-mono">BUILT FOR GTM ENGINEERING, REVOPS, AND REVENUE SYSTEMS</p>
        </footer>
      </div>
    </main>
  );
}

function ContactRow({ contact, repaired }: { contact: LiveContactState; repaired: boolean }) {
  const status = demoDecisionStatus(contact);
  return (
    <tr className={contact.recordStatus === 'merged' ? 'bg-[#83bcff]/[0.04] text-[#8ca096]' : ''}>
      <td className="px-5 py-3.5"><p className="font-semibold">{contact.fullName}</p><p className="mt-1 font-mono text-[8px] text-[#64796e]">{contact.contactId}</p></td>
      <td className="max-w-[210px] px-4 py-3.5"><p className="break-all">{contact.rawEmail}</p><p className="mt-1 break-all font-mono text-[8px] text-[#72cca4]">→ {contact.normalizedEmail ?? 'invalid'}</p></td>
      <td className="px-4 py-3.5"><div className="flex flex-wrap gap-1">{contact.qualityFlags.length ? contact.qualityFlags.map((flag) => <span key={flag} className="rounded bg-[#ff7755]/10 px-2 py-1 font-mono text-[8px] text-[#ff9c82]">{flag.replaceAll('_', ' ')}</span>) : <span className="text-[#9fb2a8]">None</span>}</div></td>
      <td className="px-5 py-3.5 font-mono text-[9px] text-[#a8b9b0]">
        <p>{repaired ? status : 'Not yet repaired'}</p>
        {repaired ? <p className="mt-1 text-[8px] text-[#7f958a]">Last action: {contact.lastAction.replaceAll('_', ' ')}</p> : null}
      </td>
    </tr>
  );
}

function DecisionInspector({ report }: { report: DemoDecisionReport }) {
  const [filter, setFilter] = useState<'All' | DemoDecisionStatus>('All');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const shown = report.decisions.filter((decision) => filter === 'All' || decision.status === filter);
  const merged = report.decisions.find((decision) => decision.status === 'Merged');
  const routed = report.decisions.find((decision) => decision.before.ownerId !== decision.after.ownerId && decision.status === 'Ready');
  const held = report.decisions.find((decision) => decision.status === 'Held' && decision.fields.some((field) => field.changed))
    ?? report.decisions.find((decision) => decision.status === 'Held');

  function inspect(contactId: string) {
    setFilter('All');
    setExpandedId(contactId);
    window.requestAnimationFrame(() => {
      const summary = document.getElementById(`decision-${contactId}`);
      summary?.focus({ preventScroll: true });
      summary?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
  }

  function downloadReport() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'gtm-control-tower-64-row-decisions.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section id="decisions" aria-labelledby="decisions-heading" className="scroll-mt-6 rounded-[30px] border border-[#d8ff67]/25 bg-[#0b1b16] p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-3xl">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#d8ff67]">Record decisions</p>
          <h2 id="decisions-heading" className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">See what changed and what still blocks a record.</h2>
          <p className="mt-3 text-sm leading-6 text-[#9fb2a8]">Ready, Held and Merged are final destination states. Last action describes only the most recent repair. Expand a record for both snapshots, every remaining hold and the rules that explain its result.</p>
        </div>
        <button type="button" onClick={downloadReport} className="rounded-full border border-[#d8ff67]/35 bg-[#d8ff67]/10 px-5 py-3 text-sm font-semibold text-[#d8ff67] hover:bg-[#d8ff67]/20 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#d8ff67]">Download decisions JSON</button>
      </div>
      <p className="mt-4 text-xs leading-6 text-[#9fb2a8]">{report.summary.inputRows} original rows = {report.summary.readyRows} Ready + {report.summary.heldRows} Held + {report.summary.mergedRows} Merged. Synthetic data · browser computation · zero CRM writes. The download includes this same report and the unchanged source CSV.</p>
      <div className="mt-5 flex flex-wrap gap-2" aria-label="Example record decisions">
        {merged ? <InspectorButton onClick={() => inspect(merged.contactId)}>Inspect a merged pair</InspectorButton> : null}
        {routed ? <InspectorButton onClick={() => inspect(routed.contactId)}>Inspect an owner change</InspectorButton> : null}
        {held ? <InspectorButton onClick={() => inspect(held.contactId)}>Inspect a held record</InspectorButton> : null}
      </div>
      <div className="my-5 flex flex-wrap items-center justify-between gap-3">
        <label htmlFor="decision-status-filter" className="flex items-center gap-3 text-sm text-[#b1c2b9]">Final status
          <select id="decision-status-filter" value={filter} onChange={(event) => { setFilter(event.target.value as 'All' | DemoDecisionStatus); setExpandedId(null); }} className="rounded-lg border border-white/20 bg-[#06100d] px-3 py-2 text-[#edf8f2] focus-visible:outline-2 focus-visible:outline-[#d8ff67]">
            {(['All', 'Ready', 'Held', 'Merged'] as const).map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <p aria-live="polite" className="text-xs text-[#9fb2a8]">Showing {shown.length} of {report.decisions.length} records</p>
      </div>
      <div className="max-h-[660px] space-y-2 overflow-y-auto rounded-xl pr-1" aria-label="Record decision list">
        {shown.map((decision) => {
          const canonical = report.decisions.find((candidate) => candidate.contactId === decision.canonicalContactId);
          return (
            <details key={decision.contactId} open={expandedId === decision.contactId} onToggle={(event) => {
              if (event.currentTarget.open) setExpandedId(decision.contactId);
              else setExpandedId((current) => current === decision.contactId ? null : current);
            }} className="rounded-xl border border-white/10 bg-[#06100d]/60">
              <summary id={`decision-${decision.contactId}`} className="cursor-pointer rounded-xl px-4 py-4 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#d8ff67]">
                <span className="ml-2 inline-flex max-w-[85%] flex-wrap items-center gap-x-3 gap-y-2 align-middle">
                  <span className="font-mono text-xs text-[#9fb2a8]">{decision.contactId}</span>
                  <span className="text-sm font-semibold">{decision.fullName}</span>
                  <DecisionStatus status={decision.status} />
                  <span className="text-xs text-[#9fb2a8]">{decision.status === 'Held' ? `${decision.holdReasons.length} remaining ${decision.holdReasons.length === 1 ? 'hold' : 'holds'}` : decision.status === 'Merged' ? `→ ${decision.canonicalContactId}` : 'No remaining holds'}</span>
                </span>
              </summary>
              <div className="space-y-5 border-t border-white/10 p-4 sm:p-5">
                <p className="text-xs leading-6 text-[#9fb2a8]">Last action: <code className="break-all text-[#edf8f2]">{decision.lastAction}</code>. Final destination status: <strong>{decision.status}</strong>.</p>
                <div className="rounded-xl border border-white/10 p-4">
                  <h3 className="text-sm font-semibold">Email normalization at import</h3>
                  <p className="mt-2 break-all font-mono text-xs leading-6 text-[#b1c2b9]">{decision.inputNormalization.rawEmail || '(blank)'} → {decision.inputNormalization.normalizedEmail || '(no valid identity)'}</p>
                  <p className="mt-2 text-xs text-[#9fb2a8]">{decision.inputNormalization.changed ? 'Changed during import; the original value is retained.' : decision.inputNormalization.normalizedEmail ? 'Already normalized; no import change.' : 'Unresolved input; no email was guessed.'} The comparison below starts after import.</p>
                </div>
                <div>
                  <h3 className="text-sm font-semibold">Before repair → after repair</h3>
                  <dl className="mt-3 divide-y divide-white/10">
                    {decision.fields.map((field) => <div key={field.field} className={`grid gap-2 py-3 sm:grid-cols-[0.8fr_1fr_1fr] ${field.changed ? 'text-[#d8ff67]' : 'text-[#9fb2a8]'}`}>
                      <dt className="text-xs font-semibold">{field.label}{field.changed ? <span className="ml-2 rounded bg-[#d8ff67]/10 px-1.5 py-1 font-normal">Changed</span> : null}</dt>
                      <dd className="break-all font-mono text-xs"><span className="mr-2 font-sans text-[#7f958a]">Before</span>{field.before || '(blank)'}</dd>
                      <dd className="break-all font-mono text-xs"><span className="mr-2 font-sans text-[#7f958a]">After</span>{field.after || '(blank)'}</dd>
                    </div>)}
                  </dl>
                </div>
                <div>
                  <h3 className="text-sm font-semibold">Why these decisions happened</h3>
                  <ul className="mt-3 list-disc space-y-2 pl-5 text-xs leading-6 text-[#b1c2b9]">{decision.explanations.map((explanation) => <li key={explanation}>{explanation}</li>)}</ul>
                </div>
                <RemainingHolds decision={decision} />
                {canonical ? <div className="rounded-xl border border-[#83bcff]/25 p-4 text-xs leading-6">
                  <h3 className="font-semibold text-[#83bcff]">Canonical side of this pair: {canonical.contactId}</h3>
                  <p className="mt-2 break-all text-[#b1c2b9]">{canonical.fullName} · original email {canonical.before.rawEmail} · normalized identity {canonical.after.normalizedEmail}</p>
                  <p className="mt-1 text-[#9fb2a8]">Final status: {canonical.status}. {canonical.holdReasons.length ? `${canonical.holdReasons.length} holds remain on the canonical record.` : 'No remaining holds on the canonical record.'}</p>
                  <div className="mt-3"><InspectorButton onClick={() => inspect(canonical.contactId)}>Inspect {canonical.contactId}</InspectorButton></div>
                </div> : null}
                {decision.mergedContactIds.length ? <div className="flex flex-wrap items-center gap-2 text-xs text-[#9fb2a8]"><span>Retained merge evidence:</span>{decision.mergedContactIds.map((id) => <InspectorButton key={id} onClick={() => inspect(id)}>Inspect {id}</InspectorButton>)}</div> : null}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function DecisionStatus({ status }: { status: DemoDecisionStatus }) {
  const tone = status === 'Ready' ? 'bg-[#d8ff67]/10 text-[#d8ff67]' : status === 'Held' ? 'bg-[#ff7755]/10 text-[#ff9c82]' : 'bg-[#83bcff]/10 text-[#83bcff]';
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}>{status}</span>;
}

function InspectorButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className="rounded-lg border border-white/20 px-3 py-2 text-xs font-semibold text-[#c8d7d0] hover:border-[#d8ff67]/40 hover:text-[#d8ff67] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d8ff67]">{children}</button>;
}

function RemainingHolds({ decision }: { decision: DemoDecision }) {
  return <div className="rounded-xl border border-white/10 p-4">
    <h3 className="text-sm font-semibold">Remaining destination holds</h3>
    {decision.status === 'Merged' ? <p className="mt-2 text-xs leading-6 text-[#9fb2a8]">This row is excluded from destination use because it was merged. Inspect its canonical record for readiness; the original flags remain in the download.</p> : decision.holdReasons.length ? <ul className="mt-3 list-disc space-y-2 pl-5 text-xs leading-6 text-[#ffb49d]">{decision.holdReasons.map((reason) => <li key={reason.flag}><strong>{reason.flag.replaceAll('_', ' ')}</strong>: {reason.explanation}</li>)}</ul> : <p className="mt-2 text-xs leading-6 text-[#9fb2a8]">None under the local rules. This does not establish factual accuracy or acceptance by a CRM.</p>}
    {decision.informationalFlags.length ? <p className="mt-3 text-xs leading-6 text-[#9fb2a8]">Informational flags (not holds): {decision.informationalFlags.map((flag) => flag.replaceAll('_', ' ')).join(', ')}.</p> : null}
  </div>;
}

function HeroStat({ value, label, warning = false }: { value: string; label: string; warning?: boolean }) {
  return <div className="bg-[#0b1b16] p-4"><p className={`text-2xl font-semibold ${warning ? 'text-[#ff9c82]' : 'text-[#edf8f2]'}`}>{value}</p><p className="mt-1 text-[10px] leading-4 text-[#71877c]">{label}</p></div>;
}

function OutcomeMetric({ label, value, detail, tone = 'good' }: { label: string; value: string; detail?: string; tone?: 'good' | 'warning' }) {
  return <div className="rounded-2xl border border-white/10 bg-[#06100d]/45 p-4"><p className="text-xs text-[#7f958a]">{label}</p><p className={`mt-2 text-2xl font-semibold ${tone === 'warning' ? 'text-[#ff9c82]' : 'text-[#d8ff67]'}`}>{value}</p>{detail && <p className="mt-1 text-[10px] leading-4 text-[#9fb2a8]">{detail}</p>}</div>;
}

function ProofStat({ value, label }: { value: string; label: string }) {
  return <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4"><p className="text-3xl font-semibold text-[#83bcff]">{value}</p><p className="mt-1 text-[10px] text-[#71877c]">{label}</p></div>;
}

function ApexProofStep({ number, eyebrow, title, detail }: { number: string; eyebrow: string; title: string; detail: string }) {
  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-[#83bcff]/10 font-mono text-[9px] text-[#83bcff]">{number}</span>
        <span className="font-mono text-[8px] uppercase tracking-[0.16em] text-[#688075]">{eyebrow}</span>
      </div>
      <h3 className="mt-4 font-semibold text-[#edf8f2]">{title}</h3>
      <p className="mt-2 text-xs leading-5 text-[#81978c]">{detail}</p>
    </article>
  );
}

function PathNode({ eyebrow, title, detail, accent = false }: { eyebrow: string; title: string; detail: string; accent?: boolean }) {
  return <div className={`rounded-2xl border p-4 ${accent ? 'border-[#477b60]/30 bg-[#d8ff67]/40' : 'border-[#102019]/10 bg-white/55'}`}><p className="font-mono text-[8px] uppercase tracking-wider text-[#60746a]">{eyebrow}</p><p className="mt-2 font-semibold">{title}</p><p className="mt-1 text-[10px] text-[#66776f]">{detail}</p></div>;
}

function PathArrow() {
  return <span className="hidden text-center font-mono text-[#698075] sm:block">→</span>;
}

function stageResult(index: number, result: DemoPipelineResult | null, active: boolean, done: boolean): string {
  if (active) return 'working…';
  if (!done || !result) return 'queued';
  return [
    `${result.rawRows} rows accepted`,
    `${result.initialContacts.filter((contact) => contact.normalizedEmail).length} valid email identities`,
    `${result.mergedRows} duplicates merged`,
    `${result.reroutedRows} owners corrected`,
    `${result.replayedRows} stages restored`,
    `${result.readyRows} ready · ${result.heldRows} held`,
  ][index];
}
