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

export type LiveContactState = {
  contactId: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  rawEmail: string;
  normalizedEmail: string | null;
  company: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  website?: string | null;
  region: string;
  segment: string;
  lifecycleStage: string;
  expectedLifecycleStage: string;
  ownerId: string | null;
  canonicalContactId: string | null;
  recordStatus: 'active' | 'merged';
  lastAction: string;
  qualityFlags: string[];
  updatedAt: string;
};

export type RepairRun = {
  runId: string;
  scenario: ScenarioKey;
  action: string;
  status: 'executed';
  affectedRecords: number;
  finishedAt: string;
};

export type LiveControlTowerState = {
  source: 'bigquery';
  generatedAt: string;
  latestEventAt: string | null;
  metrics: LiveMetricSnapshot;
  funnel: LiveFunnelStage[];
  contacts: LiveContactState[];
  repairHistory: RepairRun[];
  latestRepair: { scenario: ScenarioKey; approvedAt: string } | null;
};

export type RepairReceipt = {
  accepted: true;
  status: 'executed';
  scenario: ScenarioKey;
  action: string;
  requestId: string;
  eventId: string;
  affectedRecords: number;
  approvedAt: string;
};

export type SeedReceipt = {
  accepted: true;
  status: 'seeded';
  batch: 'funky-v1';
  contacts: number;
  dirtyRecords: number;
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
  if (!Array.isArray(value.contacts) || !value.contacts.every(isContactState)) return false;
  if (!Array.isArray(value.repairHistory) || !value.repairHistory.every(isRepairRun)) return false;
  if (value.latestRepair === null) return true;
  return isRecord(value.latestRepair)
    && isScenarioKey(value.latestRepair.scenario)
    && typeof value.latestRepair.approvedAt === 'string';
}

export function isRepairReceipt(value: unknown): value is RepairReceipt {
  return isRecord(value)
    && value.accepted === true
    && value.status === 'executed'
    && isScenarioKey(value.scenario)
    && typeof value.action === 'string'
    && typeof value.requestId === 'string'
    && typeof value.eventId === 'string'
    && typeof value.affectedRecords === 'number'
    && Number.isFinite(value.affectedRecords)
    && typeof value.approvedAt === 'string';
}

export function isSeedReceipt(value: unknown): value is SeedReceipt {
  return isRecord(value)
    && value.accepted === true
    && value.status === 'seeded'
    && value.batch === 'funky-v1'
    && typeof value.contacts === 'number'
    && Number.isFinite(value.contacts)
    && typeof value.dirtyRecords === 'number'
    && Number.isFinite(value.dirtyRecords);
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

function isContactState(value: unknown): value is LiveContactState {
  if (!isRecord(value)) return false;
  if (!isNullableString(value.normalizedEmail) || !isNullableString(value.company)) return false;
  if (!isNullableString(value.ownerId) || !isNullableString(value.canonicalContactId)) return false;
  if (value.recordStatus !== 'active' && value.recordStatus !== 'merged') return false;
  if (!Array.isArray(value.qualityFlags) || !value.qualityFlags.every((flag) => typeof flag === 'string')) return false;
  return [
    value.contactId,
    value.fullName,
    value.rawEmail,
    value.region,
    value.segment,
    value.lifecycleStage,
    value.expectedLifecycleStage,
    value.lastAction,
    value.updatedAt,
  ].every((field) => typeof field === 'string');
}

function isRepairRun(value: unknown): value is RepairRun {
  return isRecord(value)
    && typeof value.runId === 'string'
    && isScenarioKey(value.scenario)
    && typeof value.action === 'string'
    && value.status === 'executed'
    && typeof value.affectedRecords === 'number'
    && Number.isFinite(value.affectedRecords)
    && typeof value.finishedAt === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
