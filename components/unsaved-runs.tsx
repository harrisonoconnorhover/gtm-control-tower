'use client';

import { useRef, useState } from 'react';
import { saveConnectorRunReceipt, type PendingConnectorRun } from '@/lib/save-connector-run';

type Props = {
  runs: PendingConnectorRun[];
  onSaved: (receiptId: string) => void;
};

export function UnsavedRuns({ runs, onSaved }: Props) {
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  if (!runs.length) return null;

  async function retry(pending: PendingConnectorRun) {
    if (saving.current || !pending.workspaceId) return;
    saving.current = true;
    setSavingId(pending.run.receipt.id);
    setError(null);
    try {
      await saveConnectorRunReceipt(pending);
      onSaved(pending.run.receipt.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The receipt could not be saved.');
    } finally {
      saving.current = false;
      setSavingId(null);
    }
  }

  function download(pending: PendingConnectorRun) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(pending, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `gtm-${pending.run.receipt.connectorId}-receipt-${pending.run.receipt.id.replace(/[^a-zA-Z0-9_-]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section role="alert" className="mb-6 rounded-2xl border border-[#e6bd68]/30 bg-[#e6bd68]/[0.07] p-5 text-[#e6cf95]">
      <h3 className="text-base font-semibold">CRM completed; receipt not saved</h3>
      <p className="mt-2 text-sm leading-6">The CRM returned the results below, but local run history has not confirmed their save. Keep this tab open or download each receipt, including any rollback backup, before leaving. Retrying saves the receipt only; it does not repeat the CRM operation.</p>
      <div className="mt-4 space-y-3">
        {runs.map((pending) => <div key={pending.run.receipt.id} className="rounded-xl border border-[#e6bd68]/20 p-3">
          <p className="text-sm"><span className="font-semibold capitalize">{pending.run.receipt.connectorId}</span> · {pending.run.receipt.summary}</p>
          {!pending.workspaceId && <p className="mt-2 text-xs leading-5">No saved workspace is available for this receipt. Download it to keep the result.</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={savingId !== null || !pending.workspaceId} onClick={() => void retry(pending)} className="rounded-full border border-[#e6bd68]/40 px-4 py-2 text-xs font-semibold disabled:opacity-40">{savingId === pending.run.receipt.id ? 'Saving receipt…' : 'Retry receipt save'}</button>
            <button type="button" onClick={() => download(pending)} className="rounded-full border border-[#e6bd68]/40 px-4 py-2 text-xs font-semibold">Download receipt</button>
          </div>
        </div>)}
      </div>
      {error && <p className="mt-3 text-sm">{error}</p>}
    </section>
  );
}
