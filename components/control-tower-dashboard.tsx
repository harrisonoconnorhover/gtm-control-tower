'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  demoRunSummary,
  demoStages,
  funnelForScenario,
  healthHeadline,
  nextScenario,
  scenarioMetrics,
  scenarios,
  type ScenarioKey,
} from '@/lib/control-tower';
import {
  isLiveControlTowerState,
  isRepairReceipt,
  type LiveControlTowerState,
  type RepairReceipt,
} from '@/lib/live-control-tower';

const integrations = [
  { name: 'HubSpot', role: 'live CRM', status: 'validated', tone: 'live' },
  { name: 'n8n', role: 'orchestration', status: 'live locally', tone: 'live' },
  { name: 'BigQuery', role: 'event warehouse', status: 'validated', tone: 'live' },
  { name: 'dbt', role: 'semantic layer', status: '15 / 15 pass', tone: 'live' },
  { name: 'Salesforce', role: 'parallel CRM', status: 'access pending', tone: 'staged' },
  { name: 'Control Tower', role: 'decision layer', status: 'demo model', tone: 'demo' },
];

const dbtTests = [
  ['unique_account_domain', '2 duplicates contained'],
  ['valid_lifecycle_progression', '1 regression rejected'],
  ['opportunity_has_owner', 'complete'],
  ['route_time_under_sla', '96.4% within SLA'],
  ['closed_won_has_amount', 'complete'],
];

const activity = [
  ['00:05.8', 'Control Tower', 'Duplicate cluster isolated; repair plan ready'],
  ['00:04.7', 'dbt', 'Trusted funnel rebuilt from accepted events'],
  ['00:03.5', 'BigQuery', 'Immutable raw and quality events appended'],
  ['00:02.2', 'n8n', 'Six qualified records scored and routed'],
  ['00:00.7', 'HubSpot', 'Eight deliberately messy leads received'],
];

const baselineIncidents = [
  { id: 'missing-company', title: 'Missing company identity', detail: 'One personal-email lead is held for review instead of contaminating account metrics.', severity: 'warning' },
  { id: 'lifecycle', title: 'Lifecycle regression blocked', detail: 'A Customer → MQL write was quarantined before it changed source-of-truth state.', severity: 'resolved' },
];

function metricsFromLiveState(state: LiveControlTowerState): ReturnType<typeof scenarioMetrics> {
  const leads = state.funnel.find((stage) => stage.label === 'Leads')?.count ?? 0;
  const won = state.funnel.find((stage) => stage.label === 'Won')?.count ?? 0;
  const wonRate = leads > 0 ? (won / leads) * 100 : 0;
  const routeWarning = state.metrics.medianRouteSeconds > 120;
  const qualityWarning = state.metrics.qualityRate < 95;
  return [
    {
      label: 'Warehouse events',
      value: state.metrics.totalEvents.toLocaleString(),
      detail: 'accepted in the last 30 days',
      direction: 'good',
    },
    {
      label: 'Median route time',
      value: formatRouteTime(state.metrics.medianRouteSeconds),
      detail: routeWarning ? '2m SLA breached' : 'under 2m SLA',
      direction: routeWarning ? 'warning' : 'good',
    },
    {
      label: 'Data quality',
      value: `${state.metrics.qualityRate.toFixed(1)}%`,
      detail: `${state.metrics.duplicateEvents} duplicates detected`,
      direction: qualityWarning ? 'warning' : 'good',
    },
    {
      label: 'Lead → won',
      value: `${wonRate.toFixed(1)}%`,
      detail: `${won.toLocaleString()} won of ${leads.toLocaleString()} leads`,
      direction: 'good',
    },
  ];
}

function funnelFromLiveState(state: LiveControlTowerState): ReturnType<typeof funnelForScenario> {
  const leads = state.funnel.find((stage) => stage.label === 'Leads')?.count ?? 0;
  return state.funnel.map((stage) => ({
    label: stage.label,
    count: stage.count,
    conversion: leads > 0 ? (stage.count / leads) * 100 : 0,
  }));
}

function formatRouteTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = String(Math.round(seconds % 60)).padStart(2, '0');
  return `${String(minutes).padStart(2, '0')}:${remainder}`;
}

export function ControlTowerDashboard() {
  const [activeScenario, setActiveScenario] = useState<ScenarioKey | null>(null);
  const [repaired, setRepaired] = useState(false);
  const [demoStage, setDemoStage] = useState(-1);
  const [demoRunning, setDemoRunning] = useState(false);
  const [liveState, setLiveState] = useState<LiveControlTowerState | null>(null);
  const [liveStatus, setLiveStatus] = useState<'loading' | 'live' | 'offline'>('loading');
  const [repairStatus, setRepairStatus] = useState<'idle' | 'sending' | 'recorded' | 'error'>('idle');
  const [repairReceipt, setRepairReceipt] = useState<RepairReceipt | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const visibleScenario = repaired ? null : activeScenario;
  const metrics = useMemo(
    () => !visibleScenario && liveState ? metricsFromLiveState(liveState) : scenarioMetrics(visibleScenario),
    [liveState, visibleScenario],
  );
  const funnel = useMemo(
    () => !visibleScenario && liveState ? funnelFromLiveState(liveState) : funnelForScenario(visibleScenario),
    [liveState, visibleScenario],
  );
  const runSummary = useMemo(() => demoRunSummary(demoStage), [demoStage]);

  const refreshLiveState = useCallback(async () => {
    setLiveStatus((status) => status === 'live' ? 'live' : 'loading');
    try {
      const response = await fetch('/api/control-tower/state', { cache: 'no-store' });
      const state: unknown = await response.json();
      if (!response.ok || !isLiveControlTowerState(state)) throw new Error('Live state unavailable');
      setLiveState(state);
      setLiveStatus('live');
    } catch {
      setLiveStatus('offline');
    }
  }, []);

  useEffect(() => {
    const initialRefreshTimer = window.setTimeout(() => void refreshLiveState(), 0);
    const refreshTimer = window.setInterval(() => void refreshLiveState(), 30_000);
    return () => {
      window.clearTimeout(initialRefreshTimer);
      window.clearInterval(refreshTimer);
    };
  }, [refreshLiveState]);

  useEffect(() => {
    if (!demoRunning) return;
    if (demoStage >= demoStages.length - 1) {
      const completionTimer = window.setTimeout(() => setDemoRunning(false), 550);
      return () => window.clearTimeout(completionTimer);
    }
    const stageTimer = window.setTimeout(() => setDemoStage((stage) => stage + 1), 780);
    return () => window.clearTimeout(stageTimer);
  }, [demoRunning, demoStage]);

  function runMessyBatch() {
    setDemoStage(0);
    setDemoRunning(true);
    setActiveScenario('duplicate-surge');
    setRepaired(false);
    setRepairStatus('idle');
    setRepairReceipt(null);
    setRepairError(null);
  }

  function triggerChaos() {
    setActiveScenario(nextScenario(activeScenario));
    setRepaired(false);
    setDemoRunning(false);
    setDemoStage(demoStages.length - 1);
    setRepairStatus('idle');
    setRepairReceipt(null);
    setRepairError(null);
  }

  async function approveRepair() {
    if (!activeScenario || repairStatus === 'sending') return;
    setRepairStatus('sending');
    setRepairError(null);
    try {
      const response = await fetch('/api/control-tower/repair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario: activeScenario }),
      });
      const receipt: unknown = await response.json();
      if (!response.ok || !isRepairReceipt(receipt)) throw new Error('The workflow did not return a receipt.');
      setRepairReceipt(receipt);
      setRepairStatus('recorded');
      setRepaired(true);
      await refreshLiveState();
    } catch (error) {
      setRepairStatus('error');
      setRepairError(error instanceof Error ? error.message : 'The repair workflow is unavailable.');
    }
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#07130f] text-[#edf8f2] selection:bg-[#cdfc54] selection:text-[#07130f]">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[520px] bg-[radial-gradient(circle_at_76%_8%,rgba(205,252,84,0.11),transparent_33%),radial-gradient(circle_at_12%_0%,rgba(64,170,127,0.16),transparent_31%)]" />
      <div className="relative mx-auto max-w-[1540px] px-5 py-5 sm:px-8 lg:px-12">
        <header className="flex flex-wrap items-center justify-between gap-5 border-b border-white/10 pb-5">
          <div className="flex items-center gap-4">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#cdfc54] font-mono text-sm font-black text-[#07130f] shadow-[0_0_45px_rgba(205,252,84,0.18)]">GT</span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#8fa99d]">Revenue systems portfolio lab</p>
              <h1 className="text-xl font-semibold tracking-tight">GTM Control Tower</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="rounded-full border border-[#cdfc54]/20 bg-[#cdfc54]/[0.07] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#cdfc54]">HubSpot → BigQuery validated</span>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#9db1a7]">Synthetic demo data</span>
          </div>
        </header>

        <section className="grid items-end gap-8 py-10 lg:grid-cols-[1.2fr_0.8fr] lg:py-14">
          <div>
            <div className="mb-4 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-[#cdfc54]">
              <span className={`h-2 w-2 rounded-full ${demoRunning ? 'animate-pulse bg-[#cdfc54]' : 'bg-[#4fa782]'}`} />
              {demoRunning ? `Processing · ${demoStages[Math.max(demoStage, 0)].label}` : 'Guided system walkthrough'}
            </div>
            <h2 className="max-w-[980px] text-4xl font-semibold leading-[0.98] tracking-[-0.05em] sm:text-6xl lg:text-[72px]">
              Watch messy CRM data become a trusted revenue decision.
            </h2>
            <p className="mt-6 max-w-2xl text-base leading-7 text-[#9cb0a7] sm:text-lg">
              Eight flawed leads enter. The system enriches and routes the usable records, contains bad writes, rebuilds the funnel, and explains what is costing the team revenue.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <button
                data-testid="run-demo"
                onClick={runMessyBatch}
                disabled={demoRunning}
                className="rounded-full bg-[#cdfc54] px-6 py-3 text-sm font-bold text-[#07130f] shadow-[0_12px_40px_rgba(205,252,84,0.16)] transition hover:-translate-y-0.5 hover:bg-[#dcff83] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#cdfc54] disabled:cursor-wait disabled:opacity-65"
              >
                {demoRunning ? 'Batch running…' : demoStage >= 0 ? 'Replay messy lead batch' : 'Run messy lead batch'}
              </button>
              <button
                data-testid="chaos-trigger"
                onClick={triggerChaos}
                className="rounded-full border border-white/15 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-[#c9d8d0] transition hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9d8d0]"
              >
                Test another failure
              </button>
            </div>
          </div>
          <article className="rounded-[30px] border border-white/10 bg-[#0c1d17]/90 p-5 shadow-[0_30px_90px_rgba(0,0,0,0.28)] backdrop-blur sm:p-6">
            <div className="flex items-start justify-between gap-5">
              <div>
                <p className="text-sm text-[#8fa99d]">What is real?</p>
                <h3 className="mt-1 text-xl font-semibold">Honest integration boundary</h3>
              </div>
              <span className="rounded-full bg-[#cdfc54]/10 px-3 py-1 font-mono text-[10px] text-[#cdfc54]">PORTFOLIO-SAFE</span>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <ProofPoint label="Live path" value="HubSpot · n8n · BigQuery" />
              <ProofPoint label="Analytics" value="dbt · 15 checks passed" />
              <ProofPoint label="Demo layer" value="Deterministic synthetic batch" />
              <ProofPoint label="Salesforce" value="Built · access recovery pending" muted />
            </div>
          </article>
        </section>

        <LiveWarehouseCard state={liveState} status={liveStatus} onRefresh={refreshLiveState} />

        <section className="rounded-[34px] border border-white/10 bg-[#091a14]/92 p-4 shadow-[0_30px_100px_rgba(0,0,0,0.22)] sm:p-6" aria-label="Messy lead processing walkthrough">
          <div className="flex flex-wrap items-end justify-between gap-4 px-1 pb-5">
            <div>
              <p className="text-sm text-[#8fa99d]">One batch, six controls</p>
              <h3 className="mt-1 text-2xl font-semibold tracking-tight">From raw signal to governed action</h3>
            </div>
            <p aria-live="polite" className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#8fa99d]">
              {demoStage < 0 ? 'Ready for input' : demoRunning ? `Step ${demoStage + 1} of ${demoStages.length}` : 'Run complete · diagnosis ready'}
            </p>
          </div>
          <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
            {demoStages.map((stage, index) => {
              const complete = demoStage > index || (!demoRunning && demoStage === index);
              const active = demoRunning && demoStage === index;
              return (
                <article
                  key={stage.id}
                  className={`relative min-h-[176px] rounded-2xl border p-4 transition-all duration-500 ${active ? 'translate-y-[-3px] border-[#cdfc54]/60 bg-[#cdfc54]/10 shadow-[0_18px_50px_rgba(205,252,84,0.08)]' : complete ? 'border-[#4fa782]/30 bg-[#11251d]' : 'border-white/[0.08] bg-white/[0.025]'}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className={`grid h-7 w-7 place-items-center rounded-full font-mono text-[10px] ${active ? 'bg-[#cdfc54] text-[#07130f]' : complete ? 'bg-[#4fa782]/20 text-[#7fddb6]' : 'bg-white/[0.06] text-[#70857b]'}`}>
                      {complete ? '✓' : String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="font-mono text-[9px] uppercase tracking-wider text-[#70857b]">{stage.system}</span>
                  </div>
                  <h4 className="mt-5 font-semibold">{stage.label}</h4>
                  <p className="mt-2 text-xs leading-5 text-[#81978d]">{stage.detail}</p>
                  <p className={`mt-4 font-mono text-[10px] ${active || complete ? 'text-[#cdfc54]' : 'text-[#566b61]'}`}>{complete ? stage.result : active ? 'working…' : 'queued'}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="mt-6 grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
          <TransformationCard demoStage={demoStage} />
          <RunOutcomeCard summary={runSummary} demoStage={demoStage} />
        </section>

        <div className="mt-7 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-[#8fa99d]">{visibleScenario ? 'Scenario impact model' : liveState ? 'Live warehouse metrics' : 'Demo baseline'}</p>
            <h3 className="mt-1 text-xl font-semibold">{visibleScenario ? 'How this failure changes the business' : 'What BigQuery says now'}</h3>
          </div>
          <span className={`rounded-full px-3 py-1 font-mono text-[9px] uppercase tracking-wider ${visibleScenario ? 'bg-[#ff7b55]/10 text-[#ff9d7f]' : liveState ? 'bg-[#cdfc54]/10 text-[#cdfc54]' : 'bg-white/[0.05] text-[#8fa99d]'}`}>
            {visibleScenario ? 'Simulated overlay' : liveState ? 'Live' : 'Fallback'}
          </span>
        </div>
        <section className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Pipeline health metrics">
          {metrics.map((metric) => (
            <article key={metric.label} className={`rounded-3xl border p-5 transition-colors ${metric.direction === 'warning' ? 'border-[#ff7b55]/45 bg-[#2b1712]' : 'border-white/10 bg-[#0c1d17]'}`}>
              <p className="text-sm text-[#8fa99d]">{metric.label}</p>
              <p className="mt-3 text-3xl font-semibold tracking-tight">{metric.value}</p>
              <p className={`mt-2 font-mono text-[11px] ${metric.direction === 'warning' ? 'text-[#ff9d7f]' : 'text-[#cdfc54]'}`}>{metric.detail}</p>
            </article>
          ))}
        </section>

        <section className="mt-6 grid gap-5 xl:grid-cols-[1.18fr_0.82fr]">
          <FunnelCard funnel={funnel} live={!visibleScenario && Boolean(liveState)} />
          <IncidentCard
            activeScenario={visibleScenario}
            repaired={repaired}
            repairStatus={repairStatus}
            repairReceipt={repairReceipt}
            repairError={repairError}
            onApproveRepair={approveRepair}
          />
        </section>

        <section className="mt-6 overflow-hidden rounded-[28px] border border-white/10 bg-[#0c1d17]">
          <div className="border-b border-white/10 px-5 py-4 sm:px-6">
            <p className="text-sm text-[#8fa99d]">System lineage</p>
            <h3 className="mt-1 text-lg font-semibold">One auditable path, with every boundary labeled</h3>
          </div>
          <div className="grid divide-y divide-white/10 sm:grid-cols-3 sm:divide-x sm:divide-y-0 xl:grid-cols-6">
            {integrations.map((integration) => (
              <div key={integration.name} className="p-5">
                <p className="font-semibold">{integration.name}</p>
                <p className="mt-1 text-xs text-[#81978d]">{integration.role}</p>
                <p className={`mt-4 font-mono text-[10px] uppercase tracking-wider ${integration.tone === 'live' ? 'text-[#cdfc54]' : integration.tone === 'staged' ? 'text-[#e6bd68]' : 'text-[#83bcff]'}`}>{integration.status}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-6 grid gap-5 lg:grid-cols-2">
          <article className="rounded-[28px] border border-white/10 bg-[#0c1d17] p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-[#8fa99d]">dbt quality suite</p>
                <h3 className="mt-1 text-lg font-semibold">Business rules that fail loudly</h3>
              </div>
              <span className="rounded-full bg-[#cdfc54]/10 px-3 py-1 font-mono text-[10px] text-[#cdfc54]">15 / 15 PASS</span>
            </div>
            <div className="mt-5 space-y-2">
              {dbtTests.map(([name, result]) => (
                <div key={name} className="flex items-center justify-between gap-4 rounded-xl bg-white/[0.035] px-4 py-3">
                  <code className="min-w-0 truncate text-xs text-[#b5c6bd]">{name}</code>
                  <span className="shrink-0 font-mono text-[9px] uppercase text-[#cdfc54]">{result}</span>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-[28px] border border-white/10 bg-[#f0f5e8] p-5 text-[#10221a] sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-[#65736b]">Automation trace</p>
                <h3 className="mt-1 text-lg font-semibold">Every decision is explainable</h3>
              </div>
              <span className="font-mono text-[10px] text-[#65736b]">DEMO REPLAY</span>
            </div>
            <div className="mt-5 divide-y divide-[#10221a]/10">
              {activity.map(([time, source, message]) => (
                <div key={`${time}-${source}`} className="grid grid-cols-[54px_86px_1fr] gap-2 py-3 text-xs">
                  <code className="text-[#77847d]">{time}</code>
                  <span className="font-semibold">{source}</span>
                  <span className="leading-5 text-[#55645c]">{message}</span>
                </div>
              ))}
            </div>
          </article>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-3 py-8 text-xs text-[#71877c]">
          <p>Portfolio simulation · no employer or customer data</p>
          <p className="font-mono">HUBSPOT / SALESFORCE → N8N → BIGQUERY → DBT → DECISION</p>
        </footer>
      </div>
    </main>
  );
}

function LiveWarehouseCard({
  state,
  status,
  onRefresh,
}: {
  state: LiveControlTowerState | null;
  status: 'loading' | 'live' | 'offline';
  onRefresh: () => Promise<void>;
}) {
  const latestEvent = state?.latestEventAt
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(state.latestEventAt))
    : 'No event yet';
  return (
    <section className="mb-6 overflow-hidden rounded-[28px] border border-white/10 bg-[#0c1d17]" aria-label="Live warehouse status">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span className={`h-2.5 w-2.5 rounded-full ${status === 'live' ? 'bg-[#cdfc54] shadow-[0_0_18px_rgba(205,252,84,0.55)]' : status === 'loading' ? 'animate-pulse bg-[#e6bd68]' : 'bg-[#ff7b55]'}`} />
          <div>
            <p className="text-sm font-semibold">Live warehouse truth</p>
            <p className="mt-0.5 text-xs text-[#71877c]">n8n queries BigQuery through a server-side connector</p>
          </div>
        </div>
        <button
          onClick={() => void onRefresh()}
          disabled={status === 'loading'}
          className="rounded-full border border-white/10 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-[#a9bbb2] transition hover:bg-white/[0.05] disabled:cursor-wait disabled:opacity-60"
        >
          {status === 'loading' ? 'Refreshing…' : 'Refresh warehouse'}
        </button>
      </div>
      {state ? (
        <div className="grid divide-y divide-white/10 sm:grid-cols-3 sm:divide-x sm:divide-y-0 xl:grid-cols-6">
          <LiveStat label="30-day events" value={state.metrics.totalEvents.toLocaleString()} />
          <LiveStat label="Routed leads" value={state.metrics.routedLeads.toLocaleString()} />
          <LiveStat label="Median routing" value={formatRouteTime(state.metrics.medianRouteSeconds)} />
          <LiveStat label="Quality rate" value={`${state.metrics.qualityRate.toFixed(1)}%`} />
          <LiveStat label="Duplicates seen" value={state.metrics.duplicateEvents.toLocaleString()} warning={state.metrics.duplicateEvents > 0} />
          <LiveStat label="Latest event" value={latestEvent} compact />
        </div>
      ) : (
        <div className="px-5 py-5 text-sm text-[#8fa99d] sm:px-6">
          {status === 'offline' ? 'The live connector is offline; the deterministic walkthrough remains available.' : 'Loading the current BigQuery snapshot…'}
        </div>
      )}
    </section>
  );
}

function LiveStat({ label, value, warning = false, compact = false }: { label: string; value: string; warning?: boolean; compact?: boolean }) {
  return (
    <div className="p-4 sm:p-5">
      <p className="font-mono text-[9px] uppercase tracking-wider text-[#71877c]">{label}</p>
      <p className={`mt-2 font-semibold ${compact ? 'text-sm' : 'text-xl'} ${warning ? 'text-[#ff9d7f]' : 'text-[#e5f1eb]'}`}>{value}</p>
    </div>
  );
}

function ProofPoint({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
      <p className="font-mono text-[9px] uppercase tracking-wider text-[#70857b]">{label}</p>
      <p className={`mt-2 text-sm font-medium ${muted ? 'text-[#d8bd78]' : 'text-[#dceae3]'}`}>{value}</p>
    </div>
  );
}

function TransformationCard({ demoStage }: { demoStage: number }) {
  const enriched = demoStage >= 1;
  const routed = demoStage >= 2;
  return (
    <article className="rounded-[30px] border border-white/10 bg-[#f0f5e8] p-5 text-[#10221a] sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-[#637169]">Record transformation</p>
          <h3 className="mt-1 text-xl font-semibold">Messy in. Account-ready out.</h3>
        </div>
        <span className="rounded-full bg-[#10221a]/[0.06] px-3 py-1 font-mono text-[10px] text-[#637169]">LEAD 04 / 08</span>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_32px_1fr] sm:items-stretch">
        <RecordPanel title="Raw CRM record" tone="bad" rows={[
          ['company', ' North Star Robotics, INC. '],
          ['domain', 'HTTPS://WWW.NORTHSTAR.AI/'],
          ['annual_revenue', '$42M'],
          ['owner', '(blank)'],
        ]} />
        <div className="grid place-items-center text-xl text-[#758179]" aria-hidden="true">→</div>
        <RecordPanel title="Governed record" tone="good" rows={[
          ['account', enriched ? 'Northstar Robotics' : '—'],
          ['domain', enriched ? 'northstar.ai' : '—'],
          ['segment / score', enriched ? 'Enterprise · 92' : '—'],
          ['route', routed ? 'Enterprise East' : '—'],
        ]} />
      </div>
    </article>
  );
}

function RecordPanel({ title, rows, tone }: { title: string; rows: string[][]; tone: 'bad' | 'good' }) {
  return (
    <div className={`rounded-2xl border p-4 ${tone === 'bad' ? 'border-[#d97757]/20 bg-[#fff6ef]' : 'border-[#2f956c]/20 bg-[#e9f5ed]'}`}>
      <p className={`font-mono text-[9px] uppercase tracking-wider ${tone === 'bad' ? 'text-[#b05a40]' : 'text-[#2f7659]'}`}>{title}</p>
      <dl className="mt-3 space-y-2.5">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[112px_1fr] gap-2 text-[11px] sm:grid-cols-[96px_1fr]">
            <dt className="font-mono text-[#7b8780]">{label}</dt>
            <dd className="min-w-0 break-words font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RunOutcomeCard({ summary, demoStage }: { summary: ReturnType<typeof demoRunSummary>; demoStage: number }) {
  const checks = [
    ['Duplicate root domain', demoStage >= 3 ? 'contained' : 'waiting', 'northstar.ai appears twice'],
    ['Lifecycle regression', demoStage >= 3 ? 'blocked' : 'waiting', 'Customer → MQL rejected'],
    ['Missing identity', demoStage >= 3 ? 'review' : 'waiting', 'personal email, no company'],
  ];
  return (
    <article className="rounded-[30px] border border-white/10 bg-[#0c1d17] p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-[#8fa99d]">Control outcomes</p>
          <h3 className="mt-1 text-xl font-semibold">Bad data becomes visible—not viral</h3>
        </div>
        <span className={`rounded-full px-3 py-1 font-mono text-[10px] ${summary.diagnosisReady ? 'bg-[#cdfc54]/10 text-[#cdfc54]' : 'bg-white/[0.05] text-[#8fa99d]'}`}>{summary.diagnosisReady ? 'DIAGNOSIS READY' : 'AWAITING RUN'}</span>
      </div>
      <div className="mt-5 grid grid-cols-4 gap-2">
        <OutcomeStat value={summary.received} label="received" />
        <OutcomeStat value={summary.enriched} label="enriched" />
        <OutcomeStat value={summary.routed} label="routed" />
        <OutcomeStat value={summary.quarantined} label="held" warning />
      </div>
      <div className="mt-5 space-y-2">
        {checks.map(([label, status, detail]) => (
          <div key={label} className="grid gap-1 rounded-xl border border-white/[0.06] bg-white/[0.025] px-4 py-3 sm:grid-cols-[1fr_auto] sm:gap-4">
            <div>
              <p className="text-xs font-semibold text-[#cbdad2]">{label}</p>
              <p className="mt-1 text-[11px] text-[#71877c]">{detail}</p>
            </div>
            <span className={`self-center font-mono text-[9px] uppercase ${status === 'waiting' ? 'text-[#566b61]' : status === 'review' ? 'text-[#e6bd68]' : 'text-[#cdfc54]'}`}>{status}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function OutcomeStat({ value, label, warning = false }: { value: number; label: string; warning?: boolean }) {
  return (
    <div className="rounded-xl bg-white/[0.035] p-3 text-center">
      <p className={`text-xl font-semibold ${warning && value > 0 ? 'text-[#ff9d7f]' : 'text-white'}`}>{value}</p>
      <p className="mt-1 font-mono text-[8px] uppercase tracking-wider text-[#71877c]">{label}</p>
    </div>
  );
}

function FunnelCard({ funnel, live }: { funnel: ReturnType<typeof funnelForScenario>; live: boolean }) {
  return (
    <article className="rounded-[30px] border border-white/10 bg-[#0c1d17] p-5 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-[#8fa99d]">{live ? 'Live trusted funnel' : 'Scenario funnel model'}</p>
          <h3 className="mt-1 text-xl font-semibold">Accepted events only</h3>
        </div>
        <span className={`font-mono text-[10px] ${live ? 'text-[#cdfc54]' : 'text-[#8fa99d]'}`}>{live ? 'BIGQUERY · 30 DAYS' : 'SIMULATED OVERLAY'}</span>
      </div>
      <div className="mt-8 grid grid-cols-5 items-end gap-2 sm:gap-4">
        {funnel.map((stage) => (
          <div key={stage.label} className="flex min-w-0 flex-col justify-end gap-3">
            <div className="rounded-xl bg-gradient-to-t from-[#1f4939] to-[#cdfc54] transition-all" style={{ height: `${Math.max(38, stage.conversion * 1.75)}px` }} />
            <div>
              <p className="truncate font-mono text-[9px] uppercase tracking-wide text-[#8fa99d] sm:text-[11px]">{stage.label}</p>
              <p className="mt-1 text-sm font-semibold sm:text-lg">{stage.count.toLocaleString()}</p>
              <p className="mt-1 hidden font-mono text-[9px] text-[#71877c] sm:block">{stage.conversion.toFixed(1)}%</p>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function IncidentCard({
  activeScenario,
  repaired,
  repairStatus,
  repairReceipt,
  repairError,
  onApproveRepair,
}: {
  activeScenario: ScenarioKey | null;
  repaired: boolean;
  repairStatus: 'idle' | 'sending' | 'recorded' | 'error';
  repairReceipt: RepairReceipt | null;
  repairError: string | null;
  onApproveRepair: () => Promise<void>;
}) {
  const active = activeScenario ? scenarios[activeScenario] : null;
  const incidentRows = active ? [active, ...baselineIncidents] : baselineIncidents;
  return (
    <article className="rounded-[30px] border border-white/10 bg-[#f0f5e8] p-5 text-[#10221a] sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-[#637169]">What is broken?</p>
          <h3 className="mt-1 text-xl font-semibold">Revenue impact, then repair</h3>
        </div>
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full font-semibold text-white ${active ? 'bg-[#ff7b55]' : 'bg-[#2f956c]'}`}>{active ? incidentRows.length : repaired ? '✓' : incidentRows.length}</span>
      </div>
      {active && (
        <div className="mt-5 rounded-2xl border border-[#d97757]/20 bg-[#fff1e9] p-4">
          <p className="font-mono text-[9px] uppercase tracking-wider text-[#b05a40]">Revenue consequence</p>
          <p data-testid="health-headline" className="mt-2 text-sm font-semibold leading-5">{healthHeadline(active)}</p>
        </div>
      )}
      {repaired && repairReceipt && (
        <div data-testid="repair-success" className="mt-5 rounded-2xl border border-[#2f956c]/25 bg-[#dff2e8] p-4 text-sm text-[#236b50]">
          <p className="font-semibold">n8n recorded the repair approval in BigQuery.</p>
          <p className="mt-1 text-xs leading-5">Action: {repairReceipt.action.replaceAll('_', ' ')} · Receipt {repairReceipt.eventId}</p>
        </div>
      )}
      {repairStatus === 'error' && repairError && (
        <div className="mt-5 rounded-2xl border border-[#d97757]/25 bg-[#fff1e9] p-4 text-sm text-[#9a452f]">
          {repairError} No repair was reported as complete.
        </div>
      )}
      <div className="mt-4 space-y-3">
        {incidentRows.map((incident) => (
          <div key={incident.id} className="rounded-2xl border border-[#10221a]/10 bg-white/70 p-4">
            <div className="flex items-start gap-3">
              <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${incident.severity === 'critical' ? 'bg-[#ff5f45]' : incident.severity === 'warning' ? 'bg-[#e6a62c]' : 'bg-[#2f956c]'}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{incident.title}</p>
                <p className="mt-1 text-xs leading-5 text-[#637169]">{incident.detail}</p>
                {'recommendation' in incident && active && incident.id === active.id && (
                  <div className="mt-3 border-t border-[#10221a]/10 pt-3">
                    <p className="text-xs leading-5 text-[#43534a]">{incident.recommendation}</p>
                    <button
                      data-testid="approve-repair"
                      onClick={() => void onApproveRepair()}
                      disabled={repairStatus === 'sending'}
                      className="mt-3 rounded-full bg-[#10221a] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#234234] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#10221a] disabled:cursor-wait disabled:opacity-65"
                    >
                      {repairStatus === 'sending' ? 'Sending to n8n…' : 'Approve repair workflow'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
