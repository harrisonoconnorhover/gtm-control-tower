import { describe, expect, it } from 'vitest';
import { runSafeImportD1Qualification } from '../scripts/qualify-safe-import-d1.mjs';

type ExecutionMetrics = { bindingCalls: number; error: string | null; fakeCrmWrites: number };

describe('actual local D1 qualification', () => {
  it('uses production stores for immutable review, single claim, CAS, restart recovery, and query-budget measurement', async () => {
    const result = await runSafeImportD1Qualification();
    expect(result.mode).toBe('local actual D1 / workerd');
    expect(result.noRemoteResources).toBe(true);
    expect(result.review).toMatchObject({ count: 106, exactRoundtrip: true, immutable: true, unicode: 'Événement 🧪 Contacts.csv' });
    expect(result.concurrentClaims).toEqual({ winners: 1, sameExecution: true });
    expect(result.cas).toMatchObject({ winners: 1, staleRejected: true, otherRowsPending: true });
    expect(result.recovery).toMatchObject({ writes: 0, before: ['sending', 'unknown', 'accepted'],
      after: ['unknown', 'unknown', 'accepted'], held: 103, verified: 3, status: 'reconciliation-required' });
    expect(result.execution).toMatchObject({ fakeCrmWrites: 99, error: null, verified: 99, status: 'completed' });
    const execution = result.execution as ExecutionMetrics;
    expect(execution.bindingCalls).toBeGreaterThan(0);
    for (const [cap, limited] of [[50, result.simulatedFreeInvocationBudget as ExecutionMetrics], [1000, result.simulatedPaidInvocationBudget as ExecutionMetrics]] as const) {
      if (execution.bindingCalls > cap) {
        expect(limited.error).toContain(`SIMULATED_D1_INVOCATION_BUDGET_${cap}`);
        expect(limited.fakeCrmWrites).toBeLessThan(99);
      } else expect(limited).toMatchObject({ fakeCrmWrites: 99, error: null, verified: 99, status: 'completed' });
    }
  }, 60_000);
});
