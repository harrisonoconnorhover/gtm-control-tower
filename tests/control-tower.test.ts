import { describe, expect, it } from 'vitest';
import {
  BASELINE,
  demoRunSummary,
  demoStages,
  funnelForScenario,
  nextScenario,
  scenarioMetrics,
} from '../lib/control-tower';

describe('control tower scenarios', () => {
  it('cycles through the three deterministic incidents', () => {
    expect(nextScenario(null)).toBe('duplicate-surge');
    expect(nextScenario('duplicate-surge')).toBe('routing-overload');
    expect(nextScenario('routing-overload')).toBe('stage-regression');
    expect(nextScenario('stage-regression')).toBe('duplicate-surge');
  });

  it('breaches the route-time SLA during overload', () => {
    const routeTime = scenarioMetrics('routing-overload').find(
      (metric) => metric.label === 'Median route time',
    );
    expect(routeTime).toMatchObject({ direction: 'warning', detail: 'SLA breached' });
  });

  it('removes regressed SQLs from the funnel', () => {
    const sql = funnelForScenario('stage-regression').find((stage) => stage.label === 'SQL');
    expect(sql?.count).toBe(BASELINE.sql - 47);
  });

  it('reveals each control outcome only after its stage completes', () => {
    expect(demoRunSummary(-1)).toMatchObject({ received: 0, diagnosisReady: false });
    expect(demoRunSummary(2)).toMatchObject({ received: 8, enriched: 7, routed: 6, quarantined: 0 });
    expect(demoRunSummary(demoStages.length - 1)).toEqual({
      received: 8,
      enriched: 7,
      routed: 6,
      quarantined: 2,
      testsPassed: 15,
      diagnosisReady: true,
    });
  });
});
