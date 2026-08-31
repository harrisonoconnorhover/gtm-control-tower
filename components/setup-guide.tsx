'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ConnectorCapability, ConnectorCatalog, ConnectorHealth } from '@/lib/connector-contract';

const command = 'docker compose up --build';

export function SetupGuide() {
  const [catalog, setCatalog] = useState<ConnectorCatalog | null>(null);
  const [status, setStatus] = useState<'checking' | 'ready' | 'offline'>('checking');
  const [copied, setCopied] = useState(false);
  const [accessKey, setAccessKey] = useState(() => typeof window === 'undefined' ? '' : window.sessionStorage.getItem('gtm-control-tower-operator-key') ?? '');

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const response = await fetch('/api/control-tower/connectors', { cache: 'no-store' });
        if (!response.ok) throw new Error('Connector check unavailable');
        const next = await response.json() as ConnectorCatalog;
        if (!cancelled) {
          setCatalog(next);
          setStatus('ready');
        }
      } catch {
        if (!cancelled) setStatus('offline');
      }
    }
    void check();
    return () => { cancelled = true; };
  }, []);

  const sheetsReady = catalog?.connectors.some((connector) => connector.id === 'google-sheets' && connector.configured) ?? false;
  const crmConnectors = useMemo(() => catalog?.connectors.filter((connector) => ['hubspot', 'salesforce'].includes(connector.id)) ?? [], [catalog]);

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <main className="min-h-screen bg-[#06100d] text-[#edf8f2] selection:bg-[#d8ff67] selection:text-[#06100d]">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[620px] bg-[radial-gradient(circle_at_70%_0%,rgba(131,188,255,0.12),transparent_35%),radial-gradient(circle_at_10%_8%,rgba(205,252,84,0.10),transparent_30%)]" />
      <div className="relative mx-auto max-w-[1280px] px-5 sm:px-8 lg:px-12">
        <header className="flex flex-wrap items-center justify-between gap-5 border-b border-white/10 py-5">
          <Link href="/" className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#d8ff67] font-mono text-xs font-black text-[#06100d]">GT</span>
            <div><p className="font-mono text-[9px] uppercase tracking-[0.22em] text-[#7e968b]">GTM Control Tower</p><p className="text-base font-semibold">Self-host setup</p></div>
          </Link>
          <nav className="flex flex-wrap gap-2 text-xs" aria-label="Primary navigation">
            <Link href="/" className="rounded-full border border-white/10 px-4 py-2 text-[#9fb2a8]">Demo</Link>
            <Link href="/app" className="rounded-full border border-white/10 px-4 py-2 text-[#9fb2a8]">Operator workspace</Link>
            <Link href="/runs" className="rounded-full border border-white/10 px-4 py-2 text-[#9fb2a8]">Sync runs</Link>
            <a href="https://github.com/harrisonoconnorhover/gtm-control-tower" target="_blank" rel="noreferrer" className="rounded-full border border-[#d8ff67]/25 px-4 py-2 font-semibold text-[#d8ff67]">GitHub ↗</a>
          </nav>
        </header>

        <section className="grid gap-10 py-14 lg:grid-cols-[0.95fr_1.05fr] lg:items-end lg:py-20">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#83bcff]">One command · local data by default</p>
            <h1 className="mt-4 text-5xl font-semibold leading-[0.96] tracking-[-0.055em] sm:text-6xl">Useful with a CSV. Better when you connect more.</h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-[#96aaa0]">The minimum install stores workspaces, mappings, repairs, receipts, and undo history in a local SQLite file. n8n and every external system are optional.</p>
          </div>
          <article className="rounded-[30px] border border-white/10 bg-[#0b1b16] p-5 shadow-[0_30px_100px_rgba(0,0,0,0.25)] sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <div><p className="text-xs text-[#71877c]">Start from the cloned repository</p><p className="mt-1 font-semibold">Launch the local stack</p></div>
              <span className="rounded-full bg-[#d8ff67]/10 px-3 py-1 font-mono text-[9px] text-[#d8ff67]">MAC / LINUX / WSL</span>
            </div>
            <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#06100d] px-4 py-4">
              <code className="overflow-x-auto text-xs text-[#d8ff67]">{command}</code>
              <button onClick={() => void copyCommand()} className="shrink-0 rounded-full border border-white/10 px-3 py-2 text-[10px] text-[#a9bbb2]">{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <p className="mt-4 text-xs leading-5 text-[#71877c]">Then open <strong className="text-[#a9bbb2]">localhost:3000/app</strong>. n8n is available at <strong className="text-[#a9bbb2]">localhost:5678</strong> only when you need a connected workflow.</p>
          </article>
        </section>

        <section className="grid gap-4 pb-8 md:grid-cols-2 xl:grid-cols-4" aria-label="Setup steps">
          <SetupStep number="01" title="Start free" detail="Import a CSV, map any headers, run repairs, export the governed result." status="required" />
          <SetupStep number="02" title="Keep history" detail="SQLite saves workspaces, mapping presets, receipts, and twenty undo revisions." status="automatic" />
          <SetupStep number="03" title="Add Sheets" detail="Attach Google OAuth inside local n8n; email-keyed upserts are serialized so reruns and overlapping syncs stay duplicate-free." status="optional" />
          <SetupStep number="04" title="Add destinations" detail="Turn on HubSpot, Salesforce, or BigQuery only after their server-side variables exist." status="optional" />
        </section>

        <section className="grid gap-5 py-8 lg:grid-cols-[1.1fr_0.9fr]">
          <article className="overflow-hidden rounded-[30px] border border-white/10 bg-[#0b1b16]">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-5 py-5 sm:px-6">
              <div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#83bcff]">Current environment</p><h2 className="mt-1 text-xl font-semibold">Connector health</h2></div>
              <span className={`rounded-full px-3 py-1.5 font-mono text-[9px] uppercase ${status === 'ready' ? 'bg-[#d8ff67]/10 text-[#d8ff67]' : status === 'checking' ? 'bg-[#e6bd68]/10 text-[#e6bd68]' : 'bg-[#ff7755]/10 text-[#ff9c82]'}`}>{status}</span>
            </div>
            <div className="divide-y divide-white/[0.06]">
              <HealthRow name="CSV import + export" detail="No account or connector required" ready />
              <HealthRow name="Saved workspace" detail={catalog?.persistenceEnabled ? 'SQLite/D1 persistence is enabled here' : 'Session-only on this public demonstration'} ready={Boolean(catalog?.persistenceEnabled)} />
              <HealthRow name="Google Sheets through n8n" detail={sheetsReady ? 'Both server-side webhook URLs are configured' : 'Attach local n8n workflows and Google credentials to enable'} ready={sheetsReady} />
              {crmConnectors.map((connector) => <HealthRow key={connector.id} name={connector.label} detail={connector.configured ? 'Server-side connector configured' : connector.setupHint ?? 'Optional connector not configured'} ready={connector.configured} />)}
            </div>
          </article>

          <article className="rounded-[30px] border border-[#d8ff67]/20 bg-[#d8ff67]/[0.06] p-5 sm:p-6">
            <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#d8ff67]">Safe default</p>
            <h2 className="mt-2 text-2xl font-semibold">Local-first until you explicitly write.</h2>
            <ul className="mt-5 space-y-3 text-sm leading-6 text-[#9fb2a8]">
              <li>• Preview and validation happen before destination actions.</li>
              <li>• Unconfigured systems are hidden instead of pretending to work.</li>
              <li>• Google credentials stay in n8n; CRM secrets stay server-side.</li>
              <li>• Sheets writes queue one at a time; reruns update matching emails in place.</li>
              <li>• Every external run must return a receipt before it appears complete.</li>
            </ul>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/app" className="rounded-full bg-[#d8ff67] px-5 py-3 text-sm font-bold text-[#06100d]">Open the workspace</Link>
              <a href="https://github.com/harrisonoconnorhover/gtm-control-tower/blob/main/docs/google-sheets-setup.md" target="_blank" rel="noreferrer" className="rounded-full border border-white/15 px-5 py-3 text-sm font-semibold text-[#dce9e2]">Sheets guide ↗</a>
            </div>
          </article>
        </section>

        <section className="py-8" aria-label="Guided CRM connection checks">
          <div className="mb-5">
            <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#83bcff]">Guided connection lab</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">Prove read and write access before a real batch.</h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[#81978c]">Secrets remain server-side. The read test changes nothing; the write test upserts one clearly labeled synthetic contact at an example.com address, so repeating it is safe.</p>
          </div>
          {catalog?.accessKeyRequired && <div className="mb-5 rounded-2xl border border-[#83bcff]/20 bg-[#83bcff]/[0.05] p-4"><label htmlFor="setup-operator-key" className="text-xs font-semibold text-[#b8d9ff]">Operator access key</label><input id="setup-operator-key" type="password" value={accessKey} onChange={(event) => { const value = event.target.value; setAccessKey(value); if (value) window.sessionStorage.setItem('gtm-control-tower-operator-key', value); else window.sessionStorage.removeItem('gtm-control-tower-operator-key'); }} className="mt-3 block w-full max-w-lg rounded-xl border border-white/10 bg-[#06100d] px-4 py-3 text-sm outline-none focus:border-[#83bcff]/50" /><p className="mt-2 text-[10px] text-[#71877c]">Stored only for this browser tab.</p></div>}
          <div className="grid gap-5 lg:grid-cols-2">
            {crmConnectors.map((connector) => <ConnectionTestCard key={connector.id} connector={connector} accessKey={accessKey} />)}
          </div>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-white/10 py-8 text-xs text-[#667c71]"><p>Need only the demonstration? The public route stores no uploaded lead data.</p><Link href="/" className="text-[#d8ff67]">Back to the two-minute demo →</Link></footer>
      </div>
    </main>
  );
}

function SetupStep({ number, title, detail, status }: { number: string; title: string; detail: string; status: string }) {
  return <article className="rounded-2xl border border-white/10 bg-[#0b1b16] p-5"><div className="flex items-center justify-between"><span className="font-mono text-[10px] text-[#83bcff]">{number}</span><span className="rounded-full bg-white/[0.05] px-2.5 py-1 font-mono text-[8px] uppercase text-[#71877c]">{status}</span></div><h2 className="mt-5 font-semibold">{title}</h2><p className="mt-2 text-xs leading-5 text-[#71877c]">{detail}</p></article>;
}

function HealthRow({ name, detail, ready }: { name: string; detail: string; ready: boolean }) {
  return <div className="flex items-center justify-between gap-5 px-5 py-4 sm:px-6"><div><p className="text-sm font-semibold">{name}</p><p className="mt-1 text-xs text-[#71877c]">{detail}</p></div><span className={`shrink-0 rounded-full px-3 py-1 font-mono text-[8px] uppercase ${ready ? 'bg-[#d8ff67]/10 text-[#d8ff67]' : 'bg-white/[0.05] text-[#71877c]'}`}>{ready ? 'ready' : 'optional'}</span></div>;
}

function ConnectionTestCard({ connector, accessKey }: { connector: ConnectorCapability; accessKey: string }) {
  const [checking, setChecking] = useState<'read' | 'write' | null>(null);
  const [results, setResults] = useState<Partial<Record<'read' | 'write', ConnectorHealth>>>({});

  async function run(action: 'read' | 'write') {
    setChecking(action);
    try {
      const response = await fetch('/api/control-tower/connector-health', {
        method: 'POST', headers: { 'content-type': 'application/json', ...(accessKey ? { 'x-control-tower-key': accessKey } : {}) }, body: JSON.stringify({ connectorId: connector.id, action }),
      });
      const result = await response.json() as ConnectorHealth;
      setResults((current) => ({ ...current, [action]: result }));
    } catch {
      setResults((current) => ({ ...current, [action]: { connectorId: connector.id as 'hubspot' | 'salesforce', action, status: 'failed', message: 'The local server did not complete this test.', checkedAt: new Date().toISOString() } }));
    } finally {
      setChecking(null);
    }
  }

  const direct = connector.features?.includes('safe-writeback');
  return (
    <article className="rounded-[28px] border border-white/10 bg-[#0b1b16] p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div><p className="font-mono text-[9px] uppercase tracking-wider text-[#71877c]">{connector.mode ?? 'optional'} connector</p><h3 className="mt-1 text-xl font-semibold">{connector.label}</h3></div>
        <span className={`rounded-full px-3 py-1 font-mono text-[8px] uppercase ${connector.configured ? 'bg-[#d8ff67]/10 text-[#d8ff67]' : 'bg-white/[0.05] text-[#71877c]'}`}>{connector.configured ? 'configured' : 'needs setup'}</span>
      </div>
      <ol className="mt-5 space-y-2 text-xs leading-5 text-[#8ca096]">
        <li>1. {connector.id === 'hubspot' ? 'Add a private-app token with contacts read/write, or attach the two n8n OAuth workflows.' : 'Authorize Salesforce CLI and run npm run configure:salesforce.'}</li>
        <li>2. Restart the local dashboard so server-side values reload.</li>
        <li>3. Verify read access, then deliberately send the synthetic test record.</li>
        <li>4. {direct ? 'Safe preview, field diff, backup, and update rollback are available.' : 'This mode supports delegated writes; use a private-app token for field diffs and rollback.'}</li>
      </ol>
      <div className="mt-5 flex flex-wrap gap-2">
        <button onClick={() => void run('read')} disabled={checking !== null} className="rounded-full border border-[#83bcff]/30 px-4 py-2.5 text-xs font-semibold text-[#83bcff] disabled:opacity-50">{checking === 'read' ? 'Testing read…' : 'Test read access'}</button>
        <button onClick={() => void run('write')} disabled={checking !== null} className="rounded-full bg-[#d8ff67] px-4 py-2.5 text-xs font-bold text-[#06100d] disabled:opacity-50">{checking === 'write' ? 'Sending test…' : 'Send one test record'}</button>
      </div>
      <div className="mt-4 space-y-2" aria-live="polite">
        {(['read', 'write'] as const).map((action) => results[action] && <p key={action} className={`rounded-xl border px-3 py-2 text-[11px] ${results[action]?.status === 'ready' ? 'border-[#d8ff67]/20 bg-[#d8ff67]/[0.05] text-[#bddd78]' : 'border-[#ff9c82]/20 bg-[#ff9c82]/[0.05] text-[#ffb09a]'}`}><strong className="capitalize">{action}:</strong> {results[action]?.message}</p>)}
      </div>
    </article>
  );
}
