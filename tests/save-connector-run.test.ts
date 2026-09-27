import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveConnectorRunReceipt, type PendingConnectorRun } from '../lib/save-connector-run';

const pending: PendingConnectorRun = {
  workspaceId: 'fixture-workspace',
  run: { receipt: {
    id: 'original-native-receipt', connectorId: 'hubspot', phase: 'receipt', status: 'executed',
    summary: 'One update completed.', recordsWritten: 1, createdAt: '2026-09-27T12:00:00.000Z', undoAvailable: true,
  } },
};
afterEach(() => vi.restoreAllMocks());

describe('saving a completed CRM receipt', () => {
  it('retries only run storage with the original payload and receipt ID', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ saved: true }), { status: 201 }));
    await expect(saveConnectorRunReceipt(pending)).rejects.toThrow('HTTP 503');
    await expect(saveConnectorRunReceipt(pending)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('/api/control-tower/runs');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual(pending);
    }
  });

  it.each([{ saved: false }, {}, { saved: 'true' }])('requires an explicit save acknowledgment: %j', async (result) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    await expect(saveConnectorRunReceipt(pending)).rejects.toThrow('did not confirm');
  });

  it('keeps a network failure distinct from the completed CRM operation', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(saveConnectorRunReceipt(pending)).rejects.toThrow('The CRM operation has already completed.');
  });

  it('rejects a malformed acknowledgment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unparseable', { status: 200 }));
    await expect(saveConnectorRunReceipt(pending)).rejects.toThrow('did not return a save confirmation');
  });

  it('does not send a receipt to a missing workspace', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(saveConnectorRunReceipt({ ...pending, workspaceId: null })).rejects.toThrow('Download this receipt');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
