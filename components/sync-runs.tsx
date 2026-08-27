'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { ConnectorId, ConnectorReceipt } from '@/lib/connector-contract';
import type { ConnectorRun } from '@/lib/connector-run';
import type { CrmWritebackReceipt } from '@/lib/crm-workflow';

export function SyncRuns() {
  const [runs, setRuns] = useState<ConnectorRun[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [filter, setFilter] = useState<'all' | ConnectorId>('all');
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [workspaceId] = useState<string | null>(() => typeof window === 'undefined' ? null : window.localStorage.getItem('gtm-control-tower-workspace-id'));

  async function refresh() {
    if (!workspaceId) { setStatus('empty'); return; }
    setStatus('loading');
    try {
      const response = await fetch(`/api/control-tower/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`, { cache: 'no-store' });
      const result = await response.json() as { runs?: ConnectorRun[] };
      if (!response.ok || !result.runs) throw new Error('Run history unavailable.');
      setRuns(result.runs);
      setStatus(result.runs.length ? 'ready' : 'empty');
    } catch { setStatus('error'); }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
    // The workspace id is fixed for the lifetime of this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const visible = useMemo(() => filter === 'all' ? runs : runs.filter((run) => run.connectorId === filter), [filter, runs]);
  const rolledBackPlanIds = useMemo(() => new Set(runs.flatMap((run) => run.phase === 'undo' && run.status === 'undone' && run.details?.writeback?.planId ? [run.details.writeback.planId] : [])), [runs]);
  const summary = useMemo(() => ({
    runs: runs.length,
    written: runs.reduce((sum, run) => sum + (run.receipt.recordsWritten ?? 0), 0),
    failed: runs.reduce((sum, run) => sum + (run.receipt.recordsFailed ?? 0), 0),
    undoable: runs.filter((run) => run.undo?.records.length && !rolledBackPlanIds.has(run.undo.sourcePlanId)).length,
  }), [runs, rolledBackPlanIds]);

  function exportHistory() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), workspaceId, runs: visible }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `gtm-control-tower-runs-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url);
  }

  async function rollback(run: ConnectorRun) {
    if (!workspaceId || !run.undo) return;
    setRollingBack(run.id);
    setRollbackError(null);
    try {
      const response = await fetch('/api/control-tower/crm-writeback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rollback', connectorId: run.connectorId, rollback: run.undo }),
      });
      const result = await response.json() as CrmWritebackReceipt | { error?: string };
      if (!response.ok || !('accepted' in result)) throw new Error('error' in result ? result.error : 'Rollback failed.');
      const receipt: ConnectorReceipt = {
        id: result.runId, connectorId: result.connectorId, phase: 'undo', status: result.status,
        summary: `Restored ${result.updated} CRM updates; ${result.held} held because provider state changed; ${result.failed} failed; ${run.undo.createdRecordsSkipped} created records intentionally left in place.`,
        recordsWritten: result.updated, recordsFailed: result.failed, createdAt: result.completedAt, undoAvailable: false,
        nativeReceiptId: result.runId,
      };
      await fetch('/api/control-tower/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, run: { receipt, details: { writeback: result } } }),
      });
      await refresh();
    } catch (error) {
      setRollbackError(error instanceof Error ? error.message : 'Rollback failed before a provider receipt returned.');
    } finally { setRollingBack(null); }
  }

  return (
    <main className="min-h-screen bg-[#06100d] text-[#edf8f2]">
      <div className="mx-auto max-w-[1400px] px-5 sm:px-8 lg:px-12">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 py-5">
          <Link href="/app" className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#d8ff67] font-mono text-xs font-black text-[#06100d]">GT</span><div><p className="font-mono text-[9px] uppercase tracking-wider text-[#71877c]">GTM Control Tower</p><p className="font-semibold">Sync Runs</p></div></Link>
          <nav className="flex gap-2 text-xs"><Link href="/app" className="rounded-full border border-white/10 px-4 py-2">Workspace</Link><Link href="/setup" className="rounded-full border border-white/10 px-4 py-2">Setup</Link></nav>
        </header>

        <section className="py-12">
          <div className="flex flex-wrap items-end justify-between gap-5">
            <div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#83bcff]">Durable evidence</p><h1 className="mt-2 text-5xl font-semibold tracking-[-0.055em]">Every batch should explain itself.</h1><p className="mt-4 max-w-2xl text-sm leading-6 text-[#8ca096]">Imports, repairs, holds, write plans, native receipts, and eligible rollback backups remain attached to the local workspace.</p></div>
            <div className="flex gap-2"><select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} className="rounded-full border border-white/10 bg-[#0b1b16] px-4 py-2.5 text-xs"><option value="all">All connectors</option>{['csv', 'google-sheets', 'hubspot', 'salesforce', 'bigquery'].map((id) => <option key={id} value={id}>{id}</option>)}</select><button onClick={exportHistory} disabled={!visible.length} className="rounded-full bg-[#d8ff67] px-4 py-2.5 text-xs font-bold text-[#06100d] disabled:opacity-40">Export evidence</button></div>
          </div>
          <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4"><RunStat label="Recorded runs" value={summary.runs} /><RunStat label="Records written" value={summary.written} /><RunStat label="Failures retained" value={summary.failed} warning={summary.failed > 0} /><RunStat label="Rollback ready" value={summary.undoable} /></div>
        </section>

        <section className="pb-16">
          {status === 'loading' && <p className="rounded-2xl border border-white/10 p-8 text-center text-sm text-[#71877c]">Loading durable run history…</p>}
          {status === 'empty' && <p className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-[#71877c]">No saved runs yet. Import and repair a batch in the workspace first.</p>}
          {status === 'error' && <p className="rounded-2xl border border-[#ff9c82]/20 p-8 text-center text-sm text-[#ff9c82]">Run history could not be loaded from this self-host.</p>}
          {rollbackError && <p className="mb-3 rounded-2xl border border-[#ff9c82]/20 bg-[#ff9c82]/[0.05] p-4 text-sm text-[#ff9c82]">{rollbackError}</p>}
          <div className="space-y-3">
            {visible.map((run) => <RunCard key={run.id} run={run} rolledBack={Boolean(run.undo && rolledBackPlanIds.has(run.undo.sourcePlanId))} rollingBack={rollingBack === run.id} onRollback={() => void rollback(run)} />)}
          </div>
        </section>
      </div>
    </main>
  );
}

function RunCard({ run, rolledBack, rollingBack, onRollback }: { run: ConnectorRun; rolledBack: boolean; rollingBack: boolean; onRollback: () => void }) {
  const plan = run.details?.plan;
  const writeback = run.details?.writeback;
  return (
    <article className="rounded-[24px] border border-white/10 bg-[#0b1b16] p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3"><span className={`mt-1 h-2.5 w-2.5 rounded-full ${run.status === 'failed' || run.status === 'partial' ? 'bg-[#ff9c82]' : run.status === 'undone' ? 'bg-[#83bcff]' : 'bg-[#d8ff67]'}`} /><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold capitalize">{run.connectorId} · {run.phase}</h2><span className="rounded-full bg-white/[0.05] px-2.5 py-1 font-mono text-[8px] uppercase text-[#8ca096]">{run.status}</span></div><p className="mt-2 text-xs text-[#8ca096]">{run.receipt.summary}</p><p className="mt-2 font-mono text-[8px] text-[#566b61]">{new Date(run.createdAt).toLocaleString()} · {run.receipt.nativeReceiptId ?? run.id}</p></div></div>
        {run.undo?.records.length ? <button onClick={onRollback} disabled={rollingBack || rolledBack} className="rounded-full border border-[#83bcff]/30 px-4 py-2 text-xs font-semibold text-[#83bcff] disabled:opacity-50">{rollingBack ? 'Rolling back…' : rolledBack ? 'Rollback completed' : `Roll back ${run.undo.records.length} updates`}</button> : null}
      </div>
      {(plan || writeback) && <div className="mt-4 grid gap-2 border-t border-white/[0.06] pt-4 sm:grid-cols-3 lg:grid-cols-6">
        <Mini label="Input" value={plan?.requested ?? writeback?.requested ?? 0} /><Mini label="Create" value={writeback?.created ?? plan?.creates ?? 0} /><Mini label="Update" value={writeback?.updated ?? plan?.updates ?? 0} /><Mini label="Unchanged" value={writeback?.unchanged ?? plan?.unchanged ?? 0} /><Mini label="Held" value={writeback?.held ?? plan?.held ?? 0} /><Mini label="Failed" value={writeback?.failed ?? 0} />
      </div>}
      {plan?.records.some((record) => record.changes.length) && <details className="mt-4 rounded-xl bg-[#06100d]/60 p-3"><summary className="cursor-pointer text-xs font-semibold text-[#a8bbb1]">Review field-level changes</summary><div className="mt-3 max-h-64 space-y-2 overflow-y-auto">{plan.records.filter((record) => record.changes.length).slice(0, 25).map((record) => <div key={record.contactId} className="font-mono text-[9px] leading-5 text-[#71877c]"><span className="text-[#a8bbb1]">{record.email}</span> · {record.changes.map((change) => `${change.field}: ${change.before ?? '∅'} → ${change.after ?? '∅'}`).join(' · ')}</div>)}</div></details>}
    </article>
  );
}

function RunStat({ label, value, warning = false }: { label: string; value: number; warning?: boolean }) { return <div className="rounded-2xl border border-white/10 bg-[#0b1b16] p-4"><p className="text-xs text-[#71877c]">{label}</p><p className={`mt-2 text-3xl font-semibold ${warning ? 'text-[#ff9c82]' : 'text-[#d8ff67]'}`}>{value}</p></div>; }
function Mini({ label, value }: { label: string; value: number }) { return <div className="rounded-xl bg-white/[0.035] p-3"><p className="font-mono text-[8px] uppercase text-[#566b61]">{label}</p><p className="mt-1 text-lg font-semibold">{value}</p></div>; }
