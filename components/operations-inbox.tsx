'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OperationsInbox, WorkStatus } from '@/lib/operations-inbox';
import { SlackNotificationStatus } from '@/components/slack-notification-status';

const keyStorage = 'gtm-control-tower-operator-key';
const input = 'w-full rounded-xl border border-white/15 bg-[#06100d] px-3 py-2.5 text-sm text-[#edf8f2] outline-none focus:border-[#d8ff67]';
const button = 'rounded-full border border-white/20 px-4 py-2.5 text-xs font-semibold text-[#d8ff67] disabled:opacity-40';
const names: Record<WorkStatus, string> = { received: 'Received', needs_review: 'Needs attention', ready: 'Ready for review', executing: 'Executing', completed: 'Completed', reconcile: 'Verify outcome' };

export function OperationsInboxConsole() {
  const [data, setData] = useState<OperationsInbox | null>(null);
  const [accessKey, setAccessKey] = useState('');
  const [submittedKey, setSubmittedKey] = useState<string | null>(null);
  const keyRef = useRef('');
  const [provider, setProvider] = useState('all');
  const [showCompleted, setShowCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [receivedHref, setReceivedHref] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await requestInbox(keyRef.current, undefined, signal) as OperationsInbox;
    if (!signal?.aborted) { setData(result); setError(null); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    keyRef.current = window.sessionStorage.getItem(keyStorage) ?? '';
    queueMicrotask(() => { setAccessKey(keyRef.current); setSubmittedKey(keyRef.current); });
    const reload = () => { void refresh(controller.signal).catch((caught: unknown) => { if (!controller.signal.aborted) setError(message(caught)); }); };
    reload();
    const timer = window.setInterval(reload, 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [refresh]);

  async function action(body: unknown) {
    setBusy(true); setError(null); setNotice(null); setReceivedHref(null);
    try {
      const result = await requestInbox(keyRef.current, body) as { workspaceId?: string };
      await refresh();
      setNotice(result.workspaceId ? 'File received. Prepare the review in its workspace before approving any updates.' : 'Assignment saved.');
      if (result.workspaceId) setReceivedHref(`/app/lab?workspaceId=${encodeURIComponent(result.workspaceId)}`);
    } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }

  const visible = (data?.items ?? []).filter((item) => (provider === 'all' || item.provider === provider) && (showCompleted || item.status !== 'completed'));
  const attention = data?.items.filter((item) => item.status !== 'completed').length ?? 0;
  const ready = data?.items.filter((item) => item.status === 'ready').length ?? 0;
  const uncertain = data?.items.filter((item) => item.status === 'reconcile').length ?? 0;

  return <main className="min-h-screen bg-[#06100d] px-4 py-8 text-[#edf8f2] sm:px-8 lg:py-12">
    <div className="mx-auto max-w-6xl">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-5">
        <div><p className="text-xs uppercase tracking-[0.2em] text-[#d8ff67]">Control Tower / Private operations</p><h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Operations Inbox</h1><p className="mt-3 max-w-xl text-sm leading-6 text-[#9fb2a8]">One place for incoming lists and CRM findings. Review exact changes, follow up on uncertain records, and see verified results.</p></div>
        <nav className="flex flex-wrap gap-2"><Link className={button} href="/app/watchdog">Watchdog</Link><Link className={button} href="/app/lab">CSV lab</Link><Link className={button} href="/app">Control Tower</Link></nav>
      </header>
      <form className="mb-6 flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); keyRef.current = accessKey; setSubmittedKey(accessKey); window.sessionStorage.setItem(keyStorage, accessKey); void refresh().catch((caught) => setError(message(caught))); }}>
        <label className="w-full text-xs text-[#9fb2a8] sm:w-72">Operator access key<input type="password" autoComplete="off" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} className={`${input} mt-2`} /></label><button className={button} type="submit">Load inbox</button>
      </form>
      {error && <p role="alert" className="mb-5 rounded-xl border border-[#ffbb86]/25 bg-[#ffbb86]/5 p-4 text-sm text-[#ffcca5]">{error}</p>}
      {notice && <p role="status" className="mb-5 rounded-xl border border-[#d8ff67]/25 p-4 text-sm text-[#d8ff67]">{notice} {receivedHref && <Link className="underline" href={receivedHref}>Open saved workspace</Link>}</p>}
      <div className="mb-8 grid gap-3 sm:grid-cols-3">{[['To follow up', attention], ['Ready for review', ready], ['Verify outcome', uncertain]].map(([label, count]) => <div key={label} className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><p className="text-xs text-[#9fb2a8]">{label}</p><p className="mt-2 text-3xl font-medium">{data ? count : '—'}</p></div>)}</div>
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_300px]">
        <section aria-label="Work queue" className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><label className="text-xs text-[#9fb2a8]">Show CRM<select className={`${input} mt-1`} value={provider} onChange={(event) => setProvider(event.target.value)}><option value="all">All CRMs</option><option value="hubspot">HubSpot</option><option value="salesforce">Salesforce</option></select></label><label className="flex items-center gap-2 text-xs text-[#9fb2a8]"><input type="checkbox" checked={showCompleted} onChange={(event) => setShowCompleted(event.target.checked)} />Include completed</label><button type="button" className={button} onClick={() => void refresh().catch((caught) => setError(message(caught)))}>Refresh</button></div>
          {!data && !error && <p className="py-10 text-sm text-[#9fb2a8]">Loading saved work…</p>}
          {data && visible.length === 0 && <div className="rounded-2xl border border-dashed border-white/15 p-8"><h2 className="font-medium">No work in this view</h2><p className="mt-2 text-sm text-[#9fb2a8]">Upload a list or enable Watchdog for a connected CRM. Completed items are available using the filter above.</p></div>}
          <div className="space-y-3">{visible.map((item) => <article key={item.id} className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <div className="flex flex-wrap justify-between gap-2"><p className="text-[11px] uppercase tracking-wider text-[#9fb2a8]">{item.provider === 'salesforce' ? 'Salesforce' : 'HubSpot'} · {item.kind === 'import' ? 'Safe Import' : 'Watchdog'}</p><span className={`text-xs ${item.status === 'reconcile' ? 'text-[#ffbb86]' : 'text-[#d8ff67]'}`}>{names[item.status]}</span></div>
            <h2 className="mt-3 break-words text-lg font-medium">{item.title}</h2><p className="mt-1 break-words text-xs text-[#9fb2a8]">{item.source}{item.accountId ? ` · Account ${item.accountId}` : ' · Account verified when review is prepared'}</p><p className="mt-4 break-words text-sm leading-6 text-[#c6d5cd]">{item.summary}</p>
            {item.counts && <p className="mt-2 text-xs text-[#9fb2a8]">{item.counts.unchanged} unchanged · {item.counts.skipped} deliberately skipped. Held and unmatched rows remain unresolved work.</p>}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-[#9fb2a8]">{item.assignee || 'Unassigned'}</span><Link className={button} href={item.href}>{item.kind === 'import' ? 'Open review workspace' : 'Investigate finding'} →</Link></div>
            {item.note && <p className="mt-3 whitespace-pre-wrap break-words text-xs leading-5 text-[#9fb2a8]">{item.note}</p>}
            {item.kind === 'import' && <details className="mt-4 border-t border-white/10 pt-3"><summary className="cursor-pointer text-xs text-[#9fb2a8]">Assignment and notes</summary><form className="mt-3 space-y-3" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); void action({ action: 'assign', id: item.id, assignee: values.get('assignee'), note: values.get('note') }); }}><label className="block text-xs text-[#9fb2a8]">Assignee<input name="assignee" maxLength={120} defaultValue={item.assignee} className={`${input} mt-1`} /></label><label className="block text-xs text-[#9fb2a8]">Note<textarea name="note" maxLength={2000} defaultValue={item.note} className={`${input} mt-1`} /></label><button className={button} disabled={busy}>Save assignment</button></form></details>}
          </article>)}</div>
          {data && <p className="mt-5 text-xs leading-5 text-[#718c7e]">{data.coverage}</p>}
        </section>
        <aside className="space-y-4">
          <SlackNotificationStatus key={submittedKey ?? 'loading'} accessKey={submittedKey} />
          <section className="rounded-2xl border border-[#d8ff67]/20 bg-[#d8ff67]/[0.035] p-5"><h2 className="text-lg font-medium">Submit a lead list</h2><p className="mt-2 text-xs leading-5 text-[#9fb2a8]">CSV with an Email column. Existing records only; populated fields are preserved. Receiving a file does not approve updates.</p>
            <form className="mt-4 space-y-4" onSubmit={async (event) => { event.preventDefault(); const values = new FormData(event.currentTarget); const file = values.get('file'); if (!(file instanceof File) || !file.size) { setError('Choose a CSV file.'); return; } if (file.size > 4 * 1024 * 1024) { setError('Upload a CSV smaller than 4 MB.'); return; } try { await action({ action: 'receive', provider: values.get('provider'), fileName: file.name, csv: await file.text() }); } catch (caught) { setError(message(caught)); } }}>
              <label className="block text-xs text-[#9fb2a8]">Destination<select name="provider" className={`${input} mt-1`}><option value="hubspot">HubSpot Contacts</option><option value="salesforce">Salesforce Leads + Contacts</option></select></label><label className="block text-xs text-[#9fb2a8]">CSV file<input name="file" type="file" accept=".csv,text/csv" required className="mt-2 block w-full text-xs file:mr-2 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-[#d8ff67]" /></label><button disabled={busy} className="w-full rounded-full bg-[#d8ff67] px-5 py-3 text-xs font-bold text-[#06100d] disabled:opacity-40">{busy ? 'Saving…' : 'Add to inbox'}</button>
            </form>
          </section>
          <section className="rounded-2xl border border-white/10 p-5"><h2 className="text-sm font-medium">Connected monitoring</h2>{data?.connections.map((connection) => <div key={connection.provider} className="mt-4"><p className="text-xs font-medium">{connection.provider === 'salesforce' ? 'Salesforce' : 'HubSpot'}</p><p className="mt-1 break-words text-xs leading-5 text-[#9fb2a8]">{connection.error ?? `Account ${connection.accountId}`}</p></div>)}<p className="mt-4 text-xs leading-5 text-[#718c7e]">Automatic fixes follow each account’s Watchdog setting. Imports always use their saved approval review.</p></section>
        </aside>
      </div>
    </div>
  </main>;
}

async function requestInbox(key: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch('/api/control-tower/work', { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-control-tower-key': key }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal });
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(data.error || 'Inbox request failed.');
  return data;
}
function message(error: unknown) { return error instanceof Error ? error.message : 'Inbox request failed.'; }
