import { describe, expect, it } from 'vitest';
import {
  isLiveControlTowerState,
  isRepairReceipt,
  isScenarioKey,
  isSeedReceipt,
} from '../lib/live-control-tower';

const validState = {
  source: 'bigquery',
  generatedAt: '2026-08-25T12:45:24.888-04:00',
  latestEventAt: '2026-08-25T11:27:44.425-04:00',
  metrics: {
    totalEvents: 708,
    routedLeads: 3,
    duplicateEvents: 5,
    missingOwnerEvents: 0,
    medianRouteSeconds: 72,
    qualityRate: 99.3,
  },
  funnel: [
    { label: 'Leads', count: 706 },
    { label: 'MQL', count: 528 },
    { label: 'SQL', count: 326 },
    { label: 'Open opp', count: 154 },
    { label: 'Won', count: 87 },
  ],
  contacts: [
    {
      contactId: 'F-002',
      fullName: ' Alex  Morgan ',
      rawEmail: ' ALEX@NORTHSTAR.AI ',
      normalizedEmail: 'alex@northstar.ai',
      company: 'NORTHSTAR ROBOTICS, INC.',
      region: 'Northeast',
      segment: 'Enterprise',
      lifecycleStage: 'mql',
      expectedLifecycleStage: 'customer',
      ownerId: 'NE-ENT',
      canonicalContactId: null,
      recordStatus: 'active',
      lastAction: 'seeded',
      qualityFlags: ['duplicate_identity', 'stage_regression'],
      updatedAt: '2026-08-25T12:45:24.888-04:00',
    },
  ],
  repairHistory: [],
  latestRepair: null,
};

describe('live control tower contracts', () => {
  it('accepts the BigQuery dashboard contract', () => {
    expect(isLiveControlTowerState(validState)).toBe(true);
    expect(isLiveControlTowerState({ ...validState, metrics: { totalEvents: '708' } })).toBe(false);
  });

  it('allows only known repair scenarios', () => {
    expect(isScenarioKey('duplicate-surge')).toBe(true);
    expect(isScenarioKey('delete-everything')).toBe(false);
  });

  it('requires a native n8n receipt before reporting a repair', () => {
    expect(isRepairReceipt({
      accepted: true,
      status: 'executed',
      scenario: 'stage-regression',
      action: 'replay_expected_lifecycle_state',
      requestId: 'request-1',
      eventId: 'REPAIR-stage-regression-request-1',
      affectedRecords: 2,
      approvedAt: '2026-08-25T12:45:24.888-04:00',
    })).toBe(true);
    expect(isRepairReceipt({ accepted: true, scenario: 'stage-regression' })).toBe(false);
  });

  it('requires an n8n receipt before reporting a CRM batch reset', () => {
    expect(isSeedReceipt({
      accepted: true,
      status: 'seeded',
      batch: 'funky-v1',
      contacts: 10,
      dirtyRecords: 7,
    })).toBe(true);
    expect(isSeedReceipt({ accepted: true, contacts: '10' })).toBe(false);
  });
});
