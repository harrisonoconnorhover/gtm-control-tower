'use client';

import { useMemo, useState } from 'react';
import {
  funnelForScenario,
  healthHeadline,
  nextScenario,
  scenarioMetrics,
  scenarios,
  type ScenarioKey,
} from '@/lib/control-tower';

const integrations = [
  { name: 'Salesforce', role: 'system of record', status: 'connected' },
  { name: 'n8n', role: 'orchestration', status: '14 workflows' },
  { name: 'BigQuery', role: 'event warehouse', status: '2.8m rows' },
  { name: 'dbt', role: 'semantic layer', status: '28 tests' },
  { name: 'Control Tower', role: 'decision layer', status: 'live' },
];

const dbtTests = [
  ['unique_account_domain', 'pass'],
  ['valid_lifecycle_progression', 'pass'],
  ['opportunity_has_owner', 'pass'],
  ['route_time_under_sla', 'pass'],
  ['closed_won_has_amount', 'pass'],
];

const baselineIncidents = [
  { id: 'capacity', title: 'Capacity warning', detail: 'Northeast pod is at 78% of weekly capacity.', severity: 'warning' },
  { id: 'repair', title: 'Stage history repaired', detail: 'Three out-of-order events were replayed safely.', severity: 'resolved' },
];

const activity = [
  ['13:42:18', 'n8n', 'Lead scored 87 and routed to Enterprise East'],
  ['13:42:16', 'dbt', 'fct_routing_sla passed 28 checks'],
  ['13:41:59', 'BigQuery', '243 CRM events loaded idempotently'],
  ['13:41:44', 'Salesforce', 'Opportunity ACME-184 advanced to Proposal'],
];

export function ControlTowerDashboard() {
  const [activeScenario, setActiveScenario] = useState<ScenarioKey | null>(null);
  const [repaired, setRepaired] = useState(false);
  const metrics = useMemo(() => scenarioMetrics(repaired ? null : activeScenario), [activeScenario, repaired]);
  const funnel = useMemo(() => funnelForScenario(repaired ? null : activeScenario), [activeScenario, repaired]);
  const visibleScenario = repaired ? null : activeScenario;

  function triggerChaos() {
    setActiveScenario(nextScenario(activeScenario));
    setRepaired(false);
  }

  function approveRepair() {
    setRepaired(true);
  }

  return (
    <main className="min-h-screen bg-[#07130f] text-[#edf8f2]">
      <div className="mx-auto max-w-[1540px] px-5 py-5 sm:px-8 lg:px-12">
        <header className="flex flex-wrap items-center justify-between gap-5 border-b border-white/10 pb-5">
          <div className="flex items-center gap-4">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#cdfc54] font-mono text-sm font-black text-[#07130f] shadow-[0_0_45px_rgba(205,252,84,0.18)]">GT</span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#8fa99d]">Revenue operations lab</p>
              <h1 className="text-xl font-semibold tracking-tight">GTM Control Tower</h1>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 font-mono text-[11px] text-[#9db1a7] sm:inline">SYNTHETIC DATA · 5,000 LEADS</span>
            <button
              data-testid="chaos-trigger"
              onClick={triggerChaos}
              className="rounded-full border border-[#ff7b55]/55 bg-[#ff7b55]/10 px-5 py-2.5 text-sm font-semibold text-[#ffb7a1] transition hover:-translate-y-0.5 hover:bg-[#ff7b55]/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ffb7a1]"
            >
              {activeScenario ? 'Trigger next incident' : 'Trigger chaos mode'}
            </button>
          </div>
        </header>

        <section className="grid gap-6 py-8 lg:grid-cols-[1.45fr_0.75fr]">
          <div>
            <div className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-[#cdfc54]">
              <span className={`h-2 w-2 rounded-full ${visibleScenario ? 'animate-pulse bg-[#ff7b55]' : 'bg-[#cdfc54]'}`} />
              {visibleScenario ? 'Incident simulation active' : 'All systems live'}
            </div>
            <h2 data-testid="health-headline" className="max-w-4xl text-4xl font-semibold leading-[1.03] tracking-[-0.045em] sm:text-5xl lg:text-[58px]">
              {healthHeadline(visibleScenario)}
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-[#99afa5]">
              Synthetic Salesforce events flow through n8n, BigQuery, and dbt into a decision-ready command center with tested metrics and human-approved repairs.
            </p>
          </div>
          <SystemPulse active={Boolean(visibleScenario)} />
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Pipeline health metrics">
          {metrics.map((metric) => (
            <article key={metric.label} className={`rounded-3xl border p-5 transition-colors ${metric.direction === 'warning' ? 'border-[#ff7b55]/45 bg-[#2b1712]' : 'border-white/10 bg-[#0c1d17]'}`}>
              <p className="text-sm text-[#8fa99d]">{metric.label}</p>
              <p className="mt-3 text-3xl font-semibold tracking-tight">{metric.value}</p>
              <p className={`mt-2 font-mono text-[11px] ${metric.direction === 'warning' ? 'text-[#ff9d7f]' : 'text-[#cdfc54]'}`}>{metric.detail}</p>
            </article>
          ))}
        </section>

        <section className="mt-6 grid gap-5 xl:grid-cols-[1.18fr_0.82fr]">
          <FunnelCard funnel={funnel} />
          <IncidentCard
            activeScenario={visibleScenario}
            repaired={repaired}
            onApproveRepair={approveRepair}
          />
        </section>

        <section className="mt-6 overflow-hidden rounded-[28px] border border-white/10 bg-[#0c1d17]">
          <div className="border-b border-white/10 px-5 py-4 sm:px-6">
            <p className="text-sm text-[#8fa99d]">System lineage</p>
            <h3 className="mt-1 text-lg font-semibold">One auditable path from signal to decision</h3>
          </div>
          <div className="grid divide-y divide-white/10 sm:grid-cols-5 sm:divide-x sm:divide-y-0">
            {integrations.map((integration, index) => (
              <div key={integration.name} className="relative p-5">
                {index < integrations.length - 1 && <span aria-hidden="true" className="absolute -right-1 top-1/2 z-10 hidden h-2 w-2 -translate-y-1/2 rotate-45 border-r border-t border-[#cdfc54] sm:block" />}
                <p className="font-semibold">{integration.name}</p>
                <p className="mt-1 text-xs text-[#81978d]">{integration.role}</p>
                <p className="mt-4 font-mono text-[10px] uppercase tracking-wider text-[#cdfc54]">{integration.status}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-6 grid gap-5 lg:grid-cols-2">
          <article className="rounded-[28px] border border-white/10 bg-[#0c1d17] p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-[#8fa99d]">dbt quality suite</p>
                <h3 className="mt-1 text-lg font-semibold">Trusted models, explicit contracts</h3>
              </div>
              <span className="rounded-full bg-[#cdfc54]/10 px-3 py-1 font-mono text-[10px] text-[#cdfc54]">28 / 28 PASS</span>
            </div>
            <div className="mt-5 space-y-2">
              {dbtTests.map(([name]) => (
                <div key={name} className="flex items-center justify-between rounded-xl bg-white/[0.035] px-4 py-3">
                  <code className="text-xs text-[#b5c6bd]">{name}</code>
                  <span className="font-mono text-[10px] text-[#cdfc54]">PASS</span>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-[28px] border border-white/10 bg-[#f0f5e8] p-5 text-[#10221a] sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-[#65736b]">Automation log</p>
                <h3 className="mt-1 text-lg font-semibold">Recent decisions</h3>
              </div>
              <span className="font-mono text-[10px] text-[#65736b]">LIVE REPLAY</span>
            </div>
            <div className="mt-5 divide-y divide-[#10221a]/10">
              {activity.map(([time, source, message]) => (
                <div key={`${time}-${source}`} className="grid grid-cols-[58px_74px_1fr] gap-2 py-3 text-xs">
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
          <p className="font-mono">SALESFORCE → N8N → BIGQUERY → DBT</p>
        </footer>
      </div>
    </main>
  );
}

function SystemPulse({ active }: { active: boolean }) {
  const bars = active
    ? [88, 32, 95, 41, 91, 38, 97, 47, 89, 45, 94, 39]
    : [42, 58, 51, 74, 66, 82, 62, 91, 76, 88, 70, 96];
  return (
    <div className={`rounded-[28px] border p-5 transition-colors ${active ? 'border-[#ff7b55]/40 bg-[#241611]' : 'border-white/10 bg-white/[0.035]'}`}>
      <div className="mb-6 flex items-center justify-between">
        <span className="text-sm font-medium">System pulse</span>
        <span className={`rounded-full px-3 py-1 font-mono text-[10px] ${active ? 'bg-[#ff7b55]/15 text-[#ff9d7f]' : 'bg-[#cdfc54]/15 text-[#cdfc54]'}`}>
          {active ? 'GUARDRAILS ENGAGED' : 'HEALTHY'}
        </span>
      </div>
      <div className="flex h-28 items-end gap-2" aria-label="Recent pipeline event volume">
        {bars.map((height, index) => (
          <span key={index} className={`flex-1 rounded-t-md transition-all ${active ? 'bg-[#ff7b55]' : 'bg-[#cdfc54]'}`} style={{ height: `${height}%`, opacity: 0.42 + index / 22 }} />
        ))}
      </div>
    </div>
  );
}

function FunnelCard({ funnel }: { funnel: ReturnType<typeof funnelForScenario> }) {
  return (
    <article className="rounded-[30px] border border-white/10 bg-[#0c1d17] p-5 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-[#8fa99d]">Funnel movement</p>
          <h3 className="mt-1 text-xl font-semibold">From signal to revenue</h3>
        </div>
        <span className="font-mono text-[10px] text-[#8fa99d]">LAST 30 DAYS</span>
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
  onApproveRepair,
}: {
  activeScenario: ScenarioKey | null;
  repaired: boolean;
  onApproveRepair: () => void;
}) {
  const active = activeScenario ? scenarios[activeScenario] : null;
  const incidentRows = active
    ? [active, ...baselineIncidents]
    : baselineIncidents;
  return (
    <article className="rounded-[30px] border border-white/10 bg-[#f0f5e8] p-5 text-[#10221a] sm:p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-[#637169]">Incident queue</p>
          <h3 className="mt-1 text-xl font-semibold">Human judgment required</h3>
        </div>
        <span className={`grid h-9 w-9 place-items-center rounded-full font-semibold text-white ${active ? 'bg-[#ff7b55]' : 'bg-[#2f956c]'}`}>
          {active ? incidentRows.length : repaired ? '✓' : incidentRows.length}
        </span>
      </div>
      {repaired && (
        <div data-testid="repair-success" className="mt-5 rounded-2xl border border-[#2f956c]/25 bg-[#dff2e8] p-4 text-sm text-[#236b50]">
          Repair approved. The event log was replayed and all dependent models are healthy.
        </div>
      )}
      <div className="mt-5 space-y-3">
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
                      onClick={onApproveRepair}
                      className="mt-3 rounded-full bg-[#10221a] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#234234] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#10221a]"
                    >
                      Approve repair & replay
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
