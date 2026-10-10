import { expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ getDatabase: async () => ({ kind: 'd1' }) }));

it('clearly rejects D1 instead of implying unqualified hosted support', async () => {
  const { getWatchdogOverview } = await import('../lib/watchdog');
  await expect(getWatchdogOverview('fixture-account')).rejects.toThrow('self-hosted SQLite');
});
