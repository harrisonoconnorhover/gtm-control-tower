export type ScenarioKey = 'duplicate-surge' | 'routing-overload' | 'stage-regression';

export type Metric = {
  label: string;
  value: string;
  detail: string;
  direction: 'good' | 'warning';
};

export type Incident = {
  id: string;
  scenario: ScenarioKey;
  title: string;
  detail: string;
  recommendation: string;
  severity: 'critical' | 'warning';
};

export type FunnelStage = {
  label: string;
  count: number;
  conversion: number;
};

export type DemoStage = {
  id: 'ingest' | 'enrich' | 'route' | 'validate' | 'model' | 'diagnose';
  label: string;
  system: string;
  detail: string;
  result: string;
};

export const DEMO_BATCH = {
  raw: 8,
  malformed: 3,
  enriched: 7,
  routed: 6,
  quarantined: 2,
  modeled: 6,
};

export const demoStages: DemoStage[] = [
  {
    id: 'ingest',
    label: 'Ingest',
    system: 'HubSpot + n8n',
    detail: 'Accept a deliberately messy batch without trusting its shape.',
    result: '8 raw leads received',
  },
  {
    id: 'enrich',
    label: 'Enrich',
    system: 'n8n',
    detail: 'Normalize domains, company names, firmographics, and intent.',
    result: '7 profiles completed',
  },
  {
    id: 'route',
    label: 'Route',
    system: 'n8n + CRM',
    detail: 'Score fit and intent, then apply territory and capacity rules.',
    result: '6 owners assigned',
  },
  {
    id: 'validate',
    label: 'Test',
    system: 'BigQuery + dbt',
    detail: 'Catch duplicates, missing identity, and impossible lifecycle moves.',
    result: '2 records quarantined',
  },
  {
    id: 'model',
    label: 'Model',
    system: 'dbt',
    detail: 'Rebuild trusted funnel, routing SLA, and data-quality marts.',
    result: '15 checks passed',
  },
  {
    id: 'diagnose',
    label: 'Decide',
    system: 'Control Tower',
    detail: 'Translate the technical fault into revenue impact and a safe action.',
    result: '1 repair proposed',
  },
];

export function demoRunSummary(completedStage: number) {
  return {
    received: completedStage >= 0 ? DEMO_BATCH.raw : 0,
    enriched: completedStage >= 1 ? DEMO_BATCH.enriched : 0,
    routed: completedStage >= 2 ? DEMO_BATCH.routed : 0,
    quarantined: completedStage >= 3 ? DEMO_BATCH.quarantined : 0,
    testsPassed: completedStage >= 4 ? 15 : 0,
    diagnosisReady: completedStage >= 5,
  };
}

export const BASELINE = {
  leads: 5000,
  mql: 3682,
  sql: 2401,
  opportunities: 1184,
  won: 612,
  pipelineCoverage: 3.4,
  medianRouteSeconds: 102,
  dataQuality: 96.8,
  forecast: 1_240_000,
  forecastConfidence: 91,
};

export const scenarios: Record<ScenarioKey, Incident> = {
  'duplicate-surge': {
    id: 'duplicate-surge',
    scenario: 'duplicate-surge',
    title: 'Duplicate account surge',
    detail: '164 records now collide on normalized root domains.',
    recommendation: 'Quarantine writes, merge the six largest clusters, then replay downstream events.',
    severity: 'critical',
  },
  'routing-overload': {
    id: 'routing-overload',
    scenario: 'routing-overload',
    title: 'Northeast routing overload',
    detail: 'Median assignment time crossed the two-minute SLA.',
    recommendation: 'Shift enterprise overflow to the Central pod until capacity returns below 80%.',
    severity: 'warning',
  },
  'stage-regression': {
    id: 'stage-regression',
    scenario: 'stage-regression',
    title: 'Impossible lifecycle regression',
    detail: 'An integration moved 47 SQLs backward to MQL.',
    recommendation: 'Reject regressive events and rebuild lifecycle state from the immutable event log.',
    severity: 'critical',
  },
};

export const scenarioOrder: ScenarioKey[] = [
  'duplicate-surge',
  'routing-overload',
  'stage-regression',
];

export function scenarioMetrics(active: ScenarioKey | null): Metric[] {
  const metrics = {
    pipelineCoverage: BASELINE.pipelineCoverage,
    routeSeconds: BASELINE.medianRouteSeconds,
    dataQuality: BASELINE.dataQuality,
    forecast: BASELINE.forecast,
    confidence: BASELINE.forecastConfidence,
  };

  if (active === 'duplicate-surge') {
    metrics.dataQuality = 89.1;
    metrics.confidence = 84;
  }
  if (active === 'routing-overload') {
    metrics.routeSeconds = 487;
    metrics.pipelineCoverage = 3.1;
  }
  if (active === 'stage-regression') {
    metrics.dataQuality = 91.4;
    metrics.forecast = 1_110_000;
    metrics.confidence = 79;
  }

  const minutes = Math.floor(metrics.routeSeconds / 60);
  const seconds = String(metrics.routeSeconds % 60).padStart(2, '0');
  return [
    {
      label: 'Pipeline coverage',
      value: `${metrics.pipelineCoverage.toFixed(1)}×`,
      detail: active === 'routing-overload' ? 'capacity drag detected' : '+0.6 this week',
      direction: active === 'routing-overload' ? 'warning' : 'good',
    },
    {
      label: 'Median route time',
      value: `${String(minutes).padStart(2, '0')}:${seconds}`,
      detail: metrics.routeSeconds > 120 ? 'SLA breached' : 'under 2m SLA',
      direction: metrics.routeSeconds > 120 ? 'warning' : 'good',
    },
    {
      label: 'Data quality',
      value: `${metrics.dataQuality.toFixed(1)}%`,
      detail: metrics.dataQuality < 95 ? 'guardrails engaged' : '12 issues contained',
      direction: metrics.dataQuality < 95 ? 'warning' : 'good',
    },
    {
      label: 'Forecast',
      value: formatCurrency(metrics.forecast),
      detail: `${metrics.confidence}% confidence`,
      direction: metrics.confidence < 85 ? 'warning' : 'good',
    },
  ];
}

export function funnelForScenario(active: ScenarioKey | null): FunnelStage[] {
  const sql = active === 'stage-regression' ? BASELINE.sql - 47 : BASELINE.sql;
  const opportunities = active === 'routing-overload' ? BASELINE.opportunities - 62 : BASELINE.opportunities;
  const won = active === 'routing-overload' ? BASELINE.won - 18 : BASELINE.won;
  return [
    { label: 'Leads', count: BASELINE.leads, conversion: 100 },
    { label: 'MQL', count: BASELINE.mql, conversion: 73.6 },
    { label: 'SQL', count: sql, conversion: (sql / BASELINE.leads) * 100 },
    { label: 'Open opp', count: opportunities, conversion: (opportunities / BASELINE.leads) * 100 },
    { label: 'Won', count: won, conversion: (won / BASELINE.leads) * 100 },
  ];
}

export function nextScenario(current: ScenarioKey | null): ScenarioKey {
  if (!current) return scenarioOrder[0];
  const currentIndex = scenarioOrder.indexOf(current);
  return scenarioOrder[(currentIndex + 1) % scenarioOrder.length];
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
    notation: 'compact',
  }).format(value);
}

export function healthHeadline(active: ScenarioKey | null): string {
  if (!active) return 'The pipeline is healthy. Twelve risks are contained.';
  if (active === 'routing-overload') return 'Lead response is slipping. Revenue is now at risk.';
  if (active === 'stage-regression') return 'Lifecycle state is unreliable. Writes are quarantined.';
  return 'Duplicate pressure is rising. Identity controls are engaged.';
}
