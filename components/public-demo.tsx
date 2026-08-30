'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  previewMessyLeadDemo,
  runMessyLeadDemo,
  type DemoPipelineResult,
} from '@/lib/messy-lead-demo';
import type { LiveContactState } from '@/lib/live-control-tower';
import { InstantCrmAudit } from '@/components/instant-crm-audit';

const steps = [
  { label: 'Ingest', system: 'CSV / Sheets', detail: 'Accept the source exactly as it arrives.' },
  { label: 'Normalize', system: 'Control Tower', detail: 'Standardize identity, stages, and routing inputs.' },
  { label: 'Merge', system: 'Identity rules', detail: 'Keep one canonical contact without deleting evidence.' },
  { label: 'Reroute', system: 'Capacity rules', detail: 'Move overloaded Northeast enterprise leads safely.' },
  { label: 'Replay', system: 'Lifecycle guardrail', detail: 'Restore impossible stage regressions.' },
  { label: 'Receipt', system: 'Destination gate', detail: 'Write clean rows and hold everything unresolved.' },
];

const preview = previewMessyLeadDemo();

export function PublicDemo() {
  const [stage, setStage] = useState(-1);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DemoPipelineResult | null>(null);
  const complete = stage === steps.length - 1 && !running;

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
    if (!result || stage < 2) return preview.sample;
    return result.repairedSample;
  }, [result, stage]);

  function runDemo() {
    setResult(runMessyLeadDemo());
    setStage(0);
    setRunning(true);
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
            <a href="#walkthrough" className="rounded-full border border-white/10 px-4 py-2 text-[#9fb2a8]">Watch proof</a>
            <a href="https://github.com/harrisonoconnorhover/gtm-control-tower#quick-start-one-command-no-accounts-required" className="rounded-full border border-white/10 px-4 py-2 text-[#9fb2a8] transition hover:border-white/25 hover:text-white">Self-host setup</a>
            <a href="https://github.com/harrisonoconnorhover/gtm-control-tower" target="_blank" rel="noreferrer" className="rounded-full border border-[#d8ff67]/25 px-4 py-2 font-semibold text-[#d8ff67] transition hover:bg-[#d8ff67]/10">GitHub ↗</a>
          </nav>
        </header>

        <section className="grid min-h-[650px] items-center gap-12 py-14 lg:grid-cols-[1.02fr_0.98fr] lg:py-20">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#d8ff67]/20 bg-[#d8ff67]/[0.06] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[#d8ff67]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#d8ff67]" />
              Deterministic · inspectable · self-hosted
            </div>
            <h1 className="max-w-[850px] text-5xl font-semibold leading-[0.93] tracking-[-0.065em] sm:text-7xl lg:text-[86px]">
              Bad CRM data in. Defensible action out.
            </h1>
            <p className="mt-7 max-w-2xl text-base leading-7 text-[#96aaa0] sm:text-lg">
              GTM Control Tower maps messy lead files, contains unsafe records, executes merge and routing repairs, and leaves a receipt a revenue team can actually audit.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a href="#audit" className="rounded-full bg-[#83bcff] px-6 py-3.5 text-sm font-black text-[#06100d] shadow-[0_14px_50px_rgba(131,188,255,0.16)] transition hover:-translate-y-0.5 hover:bg-[#acd5ff]">
                Audit my CSV privately
              </a>
              <button
                onClick={runDemo}
                disabled={running}
                className="rounded-full border border-[#d8ff67]/25 bg-[#d8ff67]/[0.08] px-6 py-3.5 text-sm font-bold text-[#d8ff67] transition hover:-translate-y-0.5 hover:bg-[#d8ff67]/[0.14] disabled:cursor-wait disabled:opacity-70"
                data-testid="run-public-demo"
              >
                {running ? `Running ${steps[Math.max(stage, 0)].label.toLowerCase()}…` : result ? 'Replay the 64-row cleanup' : 'Run the 64-row cleanup'}
              </button>
              <a href="https://github.com/harrisonoconnorhover/gtm-control-tower#quick-start-one-command-no-accounts-required" className="rounded-full border border-white/15 bg-white/[0.035] px-6 py-3.5 text-sm font-semibold text-[#c8d7d0] transition hover:border-white/30 hover:bg-white/[0.07]">Self-host the workspace</a>
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
                <h2 className="mt-1 text-lg font-semibold">Messy source preview</h2>
              </div>
              <span className={`rounded-full px-3 py-1.5 font-mono text-[9px] uppercase ${complete ? 'bg-[#d8ff67] text-[#06100d]' : running ? 'bg-[#e6bd68]/15 text-[#e6bd68]' : 'bg-[#ff7755]/10 text-[#ff9c82]'}`}>
                {complete ? 'governed' : running ? 'processing' : 'untrusted'}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left text-[11px]">
                <thead className="bg-white/[0.025] font-mono text-[8px] uppercase tracking-wider text-[#667c71]">
                  <tr>
                    <th className="px-5 py-3 font-medium">Contact</th>
                    <th className="px-4 py-3 font-medium">Raw identity</th>
                    <th className="px-4 py-3 font-medium">Broken state</th>
                    <th className="px-5 py-3 font-medium">Decision</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {shownContacts.map((contact) => <ContactRow key={contact.contactId} contact={contact} repaired={Boolean(result && stage >= 2)} />)}
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

        <section id="demo" className="scroll-mt-6 pb-8" aria-label="Interactive cleanup demonstration">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#d8ff67]">The two-minute proof</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Six controls. One auditable batch.</h2>
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
                <article key={step.label} className={`min-h-[188px] rounded-2xl border p-4 transition-all duration-500 ${isActive ? '-translate-y-1 border-[#d8ff67]/55 bg-[#d8ff67]/10' : isDone ? 'border-[#4fa782]/30 bg-[#10241c]' : 'border-white/[0.08] bg-white/[0.025]'}`}>
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
        </section>

        <section className="grid gap-5 py-8 lg:grid-cols-[0.9fr_1.1fr]">
          <article className="rounded-[30px] border border-white/10 bg-[#0b1b16] p-5 sm:p-7">
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#ff9c82]">Before</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">The CRM looks populated. It is not trustworthy.</h2>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <OutcomeMetric label="Destination-ready" value={`${preview.beforeQuality.toFixed(0)}%`} tone="warning" />
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
              <OutcomeMetric label="Quality" value={complete && result ? `${result.afterQuality.toFixed(0)}%` : '—'} />
              <OutcomeMetric label="Merged" value={complete && result ? String(result.mergedRows) : '—'} />
              <OutcomeMetric label="Rerouted" value={complete && result ? String(result.reroutedRows) : '—'} />
              <OutcomeMetric label="Held safely" value={complete && result ? String(result.heldRows) : '—'} />
            </div>
            <div className="mt-5 rounded-2xl border border-white/10 bg-[#06100d]/55 p-4 font-mono text-[10px] leading-6 text-[#89a095]">
              {complete && result ? (
                <>
                  <p className="text-[#d8ff67]">RECEIPT · DEMO-LAB-64 · EXECUTED</p>
                  <p>{result.activeRows} canonical rows · {result.readyRows} ready for CRM · {result.heldRows} held for review</p>
                  <p>{result.mergedRows} merges · {result.reroutedRows} reroutes · {result.replayedRows} lifecycle replays</p>
                </>
              ) : <p>Run the batch to produce the deterministic execution receipt.</p>}
            </div>
          </article>
        </section>

        <section id="walkthrough" className="scroll-mt-6 py-8" aria-label="Live sandbox acceptance and walkthrough">
          <div className="overflow-hidden rounded-[34px] border border-[#83bcff]/20 bg-[#0a1b17]">
            <div className="grid gap-0 xl:grid-cols-[0.82fr_1.18fr]">
              <div className="p-6 sm:p-8 lg:p-10">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#83bcff]">Live development-system acceptance</p>
                <h2 className="mt-3 text-4xl font-semibold leading-tight tracking-[-0.05em]">The receipt caught what the local validator missed.</h2>
                <p className="mt-5 text-sm leading-6 text-[#8ca096]">A separate 72-row privacy-safe batch ran through the real operator flow and both CRM sandboxes. Eight duplicates were merged, six malformed emails stayed out, and an internationalized-domain mismatch surfaced as six honest HubSpot failures. IDNA normalization fixed the provider boundary; the retry completed without duplicating prior successes.</p>
                <div className="mt-6 grid grid-cols-2 gap-3">
                  <ProofStat value="72" label="messy input rows" />
                  <ProofStat value="58" label="governed CRM identities" />
                  <ProofStat value="0" label="duplicate Salesforce emails" />
                  <ProofStat value="58/58" label="final HubSpot receipt" />
                </div>
                <p className="mt-5 font-mono text-[9px] leading-5 text-[#657d72]">REPEAT PROOF · SALESFORCE 0 CREATED / 58 UPDATED · HUBSPOT 52 UPDATED / 6 CORRECTED CREATED</p>
              </div>
              <div className="border-t border-white/10 bg-[#06100d] p-4 xl:border-l xl:border-t-0 sm:p-5">
                <div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-sm font-semibold">Two-minute product walkthrough</p><p className="mt-1 text-[10px] text-[#71877c]">Synthetic data only · captions and full script included</p></div><a href="/gtm-control-tower-walkthrough.mp4" download className="rounded-full border border-white/10 px-3 py-2 text-[10px] text-[#a8bbb1]">Download MP4</a></div>
                <video controls preload="metadata" poster="/og.png" className="aspect-video w-full rounded-2xl border border-white/10 bg-black" aria-label="Two-minute GTM Control Tower walkthrough">
                  <source src="/gtm-control-tower-walkthrough.mp4" type="video/mp4" />
                  <track kind="captions" src="/gtm-control-tower-walkthrough.vtt" srcLang="en" label="English" default />
                  Your browser does not support the walkthrough video.
                </video>
              </div>
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
          <p className="font-mono">BUILT FOR GTM ENGINEERING, REVOPS, AND REVENUE SYSTEMS</p>
        </footer>
      </div>
    </main>
  );
}

function ContactRow({ contact, repaired }: { contact: LiveContactState; repaired: boolean }) {
  const issue = contact.qualityFlags[0]?.replaceAll('_', ' ') ?? 'clean';
  const decision = !repaired
    ? 'unreviewed'
    : contact.recordStatus === 'merged'
      ? `merged → ${contact.canonicalContactId}`
      : contact.lastAction.replaceAll('_', ' ');
  return (
    <tr className={contact.recordStatus === 'merged' ? 'bg-[#83bcff]/[0.04] text-[#8ca096]' : ''}>
      <td className="px-5 py-3.5"><p className="font-semibold">{contact.fullName}</p><p className="mt-1 font-mono text-[8px] text-[#64796e]">{contact.contactId}</p></td>
      <td className="max-w-[210px] px-4 py-3.5"><p className="break-all">{contact.rawEmail}</p><p className="mt-1 break-all font-mono text-[8px] text-[#72cca4]">→ {contact.normalizedEmail ?? 'invalid'}</p></td>
      <td className="px-4 py-3.5"><span className={`rounded px-2 py-1 font-mono text-[8px] ${issue === 'clean' ? 'bg-[#d8ff67]/10 text-[#d8ff67]' : 'bg-[#ff7755]/10 text-[#ff9c82]'}`}>{issue}</span></td>
      <td className="px-5 py-3.5 font-mono text-[8px] text-[#a8b9b0]">{decision}</td>
    </tr>
  );
}

function HeroStat({ value, label, warning = false }: { value: string; label: string; warning?: boolean }) {
  return <div className="bg-[#0b1b16] p-4"><p className={`text-2xl font-semibold ${warning ? 'text-[#ff9c82]' : 'text-[#edf8f2]'}`}>{value}</p><p className="mt-1 text-[10px] leading-4 text-[#71877c]">{label}</p></div>;
}

function OutcomeMetric({ label, value, tone = 'good' }: { label: string; value: string; tone?: 'good' | 'warning' }) {
  return <div className="rounded-2xl border border-white/10 bg-[#06100d]/45 p-4"><p className="text-xs text-[#7f958a]">{label}</p><p className={`mt-2 text-2xl font-semibold ${tone === 'warning' ? 'text-[#ff9c82]' : 'text-[#d8ff67]'}`}>{value}</p></div>;
}

function ProofStat({ value, label }: { value: string; label: string }) {
  return <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4"><p className="text-3xl font-semibold text-[#83bcff]">{value}</p><p className="mt-1 text-[10px] text-[#71877c]">{label}</p></div>;
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
    `${result.rawRows - 4} emails normalized`,
    `${result.mergedRows} duplicates merged`,
    `${result.reroutedRows} owners corrected`,
    `${result.replayedRows} stages restored`,
    `${result.readyRows} ready · ${result.heldRows} held`,
  ][index];
}
