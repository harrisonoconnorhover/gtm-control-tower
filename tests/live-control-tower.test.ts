import { describe, expect, it } from 'vitest';
import {
  isLiveControlTowerState,
  isRepairReceipt,
  isScenarioKey,
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
      status: 'recorded',
      scenario: 'stage-regression',
      action: 'reject_regression_and_replay_event_log',
      requestId: 'request-1',
      eventId: 'REPAIR-stage-regression-request-1',
      approvedAt: '2026-08-25T12:45:24.888-04:00',
    })).toBe(true);
    expect(isRepairReceipt({ accepted: true, scenario: 'stage-regression' })).toBe(false);
  });
});
