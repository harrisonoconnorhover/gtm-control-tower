import { expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ getDatabase: async () => ({ kind: 'd1' }) }));

it('clearly rejects D1 instead of implying unqualified hosted support', async () => {
  const { getMonitorOverview } = await import('../lib/monitor');
  await expect(getMonitorOverview('fixture-account')).rejects.toThrow('self-hosted SQLite');
});
