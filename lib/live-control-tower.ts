import type { ScenarioKey } from './control-tower';

export type LiveMetricSnapshot = {
  totalEvents: number;
  routedLeads: number;
  duplicateEvents: number;
  missingOwnerEvents: number;
  medianRouteSeconds: number;
  qualityRate: number;
};

export type LiveFunnelStage = {
  label: 'Leads' | 'MQL' | 'SQL' | 'Open opp' | 'Won';
  count: number;
};

export type LiveControlTowerState = {
  source: 'bigquery';
  generatedAt: string;
  latestEventAt: string | null;
  metrics: LiveMetricSnapshot;
  funnel: LiveFunnelStage[];
  latestRepair: { scenario: ScenarioKey; approvedAt: string } | null;
};

export type RepairReceipt = {
  accepted: true;
  status: 'recorded';
  scenario: ScenarioKey;
  action: string;
  requestId: string;
  eventId: string;
  approvedAt: string;
};

const scenarios = new Set<ScenarioKey>([
  'duplicate-surge',
  'routing-overload',
  'stage-regression',
]);

const funnelLabels = new Set<LiveFunnelStage['label']>([
  'Leads',
  'MQL',
  'SQL',
  'Open opp',
  'Won',
]);

export function isScenarioKey(value: unknown): value is ScenarioKey {
  return typeof value === 'string' && scenarios.has(value as ScenarioKey);
}

export function isLiveControlTowerState(value: unknown): value is LiveControlTowerState {
  if (!isRecord(value) || value.source !== 'bigquery') return false;
  if (typeof value.generatedAt !== 'string') return false;
  if (value.latestEventAt !== null && typeof value.latestEventAt !== 'string') return false;
  if (!isMetricSnapshot(value.metrics)) return false;
  if (!Array.isArray(value.funnel) || value.funnel.length !== 5) return false;
  if (!value.funnel.every(isFunnelStage)) return false;
  if (value.latestRepair === null) return true;
  return isRecord(value.latestRepair)
    && isScenarioKey(value.latestRepair.scenario)
    && typeof value.latestRepair.approvedAt === 'string';
}

export function isRepairReceipt(value: unknown): value is RepairReceipt {
  return isRecord(value)
    && value.accepted === true
    && value.status === 'recorded'
    && isScenarioKey(value.scenario)
    && typeof value.action === 'string'
    && typeof value.requestId === 'string'
    && typeof value.eventId === 'string'
    && typeof value.approvedAt === 'string';
}

function isMetricSnapshot(value: unknown): value is LiveMetricSnapshot {
  if (!isRecord(value)) return false;
  return [
    value.totalEvents,
    value.routedLeads,
    value.duplicateEvents,
    value.missingOwnerEvents,
    value.medianRouteSeconds,
    value.qualityRate,
  ].every((metric) => typeof metric === 'number' && Number.isFinite(metric));
}

function isFunnelStage(value: unknown): value is LiveFunnelStage {
  return isRecord(value)
    && funnelLabels.has(value.label as LiveFunnelStage['label'])
    && typeof value.count === 'number'
    && Number.isFinite(value.count);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
