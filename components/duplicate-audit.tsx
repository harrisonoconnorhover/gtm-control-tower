'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectorCatalog } from '@/lib/connector-contract';
import type { DuplicateScanView, ReviewedDuplicateCluster } from '@/lib/duplicate-scan-store';
import type { IdentityConnector } from '@/lib/identity-resolution';
import type { SavedWorkspace } from '@/lib/workspace';

type QueueFilter = 'unreviewed' | 'high_confidence' | 'review' | 'possible' | 'all';
type LoadState = 'booting' | 'ready' | 'scanning' | 'error';

const connectorNames: Record<IdentityConnector, string> = { hubspot: 'HubSpot', salesforce: 'Salesforce' };

export function DuplicateAudit() {
  const [catalog, setCatalog] = useState<ConnectorCatalog | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [connectorId, setConnectorId] = useState<IdentityConnector>('hubspot');
  const [scan, setScan] = useState<DuplicateScanView | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('booting');
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueFilter>('unreviewed');
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [primaryRecordKey, setPrimaryRecordKey] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(50);
  const [accessKey, setAccessKey] = useState(() => typeof window === 'undefined' ? '' : window.sessionStorage.getItem('gtm-control-tower-operator-key') ?? '');
  const pauseRequested = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
        const catalogResponse = await fetch('/api/control-tower/connectors', { cache: 'no-store' });
        const nextCatalog = await catalogResponse.json() as ConnectorCatalog;
        if (!catalogResponse.ok) throw new Error('Connector catalog unavailable.');
        if (cancelled) return;
        setCatalog(nextCatalog);
        const configured = crmScanners(nextCatalog);
        if (configured.length && !configured.includes(connectorId)) setConnectorId(configured[0]);
        if (!nextCatalog.persistenceEnabled) throw new Error('Full-account scans require local SQLite or hosted D1 persistence.');
        const storedId = window.localStorage.getItem('gtm-control-tower-workspace-id');
        if (storedId) {
          const savedResponse = await fetch(`/api/control-tower/workspace?id=${encodeURIComponent(storedId)}`, { cache: 'no-store' });
          if (savedResponse.ok) {
            setWorkspaceId(storedId);
            setLoadState('ready');
            return;
          }
        }
        const createdResponse = await fetch('/api/control-tower/workspace', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', name: 'CRM duplicate audit' }),
        });
        const created = await createdResponse.json() as { workspace?: SavedWorkspace; error?: string };
        if (!createdResponse.ok || !created.workspace) throw new Error(created.error ?? 'Could not create a local workspace.');
        window.localStorage.setItem('gtm-control-tower-workspace-id', created.workspace.id);
        setWorkspaceId(created.workspace.id);
        setLoadState('ready');
      } catch (caught) {
        if (!cancelled) {
          setError(message(caught));
          setLoadState('error');
        }
      }
    }
    void initialize();
    return () => { cancelled = true; };
    // Initialization deliberately runs once; provider changes load their own latest scan below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!workspaceId || !catalog || (catalog.accessKeyRequired && !accessKey)) return;
    let cancelled = false;
    async function loadLatest() {
      setError(null);
      try {
        const response = await operatorFetch(`/api/control-tower/duplicate-scan?workspaceId=${encodeURIComponent(workspaceId!)}&connectorId=${connectorId}`, {}, accessKey);
        const result = await response.json() as { scan?: DuplicateScanView | null; error?: string };
        if (!response.ok) throw new Error(result.error ?? 'Could not load the latest account scan.');
        if (!cancelled) {
          setScan(result.scan ?? null);
          setSelectedClusterId(result.scan?.clusters[0]?.clusterId ?? null);
          setPrimaryRecordKey(result.scan?.clusters[0]?.review?.primaryRecordKey ?? result.scan?.clusters[0]?.recommendedPrimaryKey ?? null);
          setLoadState('ready');
        }
      } catch (caught) {
        if (!cancelled) {
          setError(message(caught));
          setLoadState('error');
        }
      }
    }
    void loadLatest();
    return () => { cancelled = true; };
  }, [accessKey, catalog, connectorId, workspaceId]);

  const availableConnectors = useMemo(() => catalog ? crmScanners(catalog) : [], [catalog]);
  const filteredClusters = useMemo(() => (scan?.clusters ?? []).filter((cluster) => {
    if (filter === 'all') return true;
    if (filter === 'unreviewed') return !cluster.review;
    return cluster.band === filter;
  }), [filter, scan]);
  const selectedCluster = useMemo(() => scan?.clusters.find((cluster) => cluster.clusterId === selectedClusterId)
    ?? filteredClusters[0] ?? null, [filteredClusters, scan, selectedClusterId]);
  const reviewedCount = scan?.clusters.filter((cluster) => cluster.review).length ?? 0;

  const effectivePrimaryRecordKey = selectedCluster && selectedCluster.members.some((member) => member.record.recordKey === primaryRecordKey)
    ? primaryRecordKey as string
    : selectedCluster?.review?.primaryRecordKey ?? selectedCluster?.recommendedPrimaryKey ?? '';

  function rememberAccessKey(value: string) {
    setAccessKey(value);
    if (value) window.sessionStorage.setItem('gtm-control-tower-operator-key', value);
    else window.sessionStorage.removeItem('gtm-control-tower-operator-key');
  }

  async function beginOrResumeScan(restart = false) {
    if (!workspaceId) return;
    pauseRequested.current = false;
    setLoadState('scanning');
    setError(null);
    try {
      let current = restart
        ? await startScan(workspaceId, connectorId, accessKey, 'restart')
        : scan?.status === 'scanning' ? scan : await startScan(workspaceId, connectorId, accessKey);
      setScan(current);
      while (current.status === 'scanning' && !pauseRequested.current) {
        const response = await operatorFetch('/api/control-tower/duplicate-scan', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'step', workspaceId, connectorId, scanId: current.id }),
        }, accessKey);
        const result = await response.json() as { scan?: DuplicateScanView; error?: string };
        if (!response.ok || !result.scan) throw new Error(result.error ?? 'The provider page could not be scanned.');
        current = result.scan;
        setScan(current);
      }
      setSelectedClusterId(current.clusters[0]?.clusterId ?? null);
      setPrimaryRecordKey(current.clusters[0]?.review?.primaryRecordKey ?? current.clusters[0]?.recommendedPrimaryKey ?? null);
      setLoadState('ready');
    } catch (caught) {
      setError(message(caught));
      setLoadState('error');
    }
  }

  async function decide(cluster: ReviewedDuplicateCluster, decision: 'not_duplicate' | 'confirmed_duplicate') {
    if (!workspaceId) return;
    setError(null);
    try {
      const response = await operatorFetch('/api/control-tower/duplicate-scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'decide', workspaceId, connectorId, scanId: scan?.id, clusterId: cluster.clusterId,
          decision, primaryRecordKey: decision === 'confirmed_duplicate' ? primaryRecordKey : null,
        }),
      }, accessKey);
      const result = await response.json() as { scan?: DuplicateScanView; error?: string };
      if (!response.ok || !result.scan) throw new Error(result.error ?? 'The review decision was not saved.');
      setScan(result.scan);
    } catch (caught) {
      setError(message(caught));
    }
  }

  function exportReview() {
    if (!scan) return;
    const report = {
      exportedAt: new Date().toISOString(),
      connector: scan.connectorId,
      sourceComplete: scan.sourceComplete,
      recordsScanned: scan.recordsScanned,
      ruleVersion: scan.ruleVersion,
      clusters: scan.clusters,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gtm-control-tower-${scan.connectorId}-duplicate-review-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const needsKey = Boolean(catalog?.accessKeyRequired && !accessKey);
  const scannerReady = availableConnectors.includes(connectorId);

  return (
    <main className="min-h-screen bg-[#06100d] text-[#edf8f2] selection:bg-[#d8ff67] selection:text-[#06100d]">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[620px] bg-[radial-gradient(circle_at_70%_0%,rgba(131,188,255,0.12),transparent_35%),radial-gradient(circle_at_10%_8%,rgba(205,252,84,0.10),transparent_30%)]" />
      <div className="relative mx-auto max-w-[1500px] px-5 sm:px-8 lg:px-12">
        <header className="flex flex-wrap items-center justify-between gap-5 border-b border-white/10 py-5">
          <Link href="/" className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#d8ff67] font-mono text-xs font-black text-[#06100d]">GT</span><div><p className="font-mono text-[9px] uppercase tracking-[0.22em] text-[#7e968b]">GTM Control Tower</p><p className="font-semibold">Identity operations</p></div></Link>
          <nav className="flex flex-wrap gap-2 text-xs"><Link href="/app/lab" className="rounded-full border border-white/10 px-4 py-2 text-[#9fb2a8]">CSV cleanup lab</Link><Link href="/setup" className="rounded-full border border-white/10 px-4 py-2 text-[#9fb2a8]">Setup</Link><Link href="/runs" className="rounded-full border border-white/10 px-4 py-2 text-[#9fb2a8]">Run evidence</Link></nav>
        </header>

        <section className="grid gap-7 py-10 lg:grid-cols-[1fr_auto] lg:items-end">
          <div><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#83bcff]">Whole-account duplicate audit</p><h1 className="mt-3 max-w-4xl text-5xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-6xl">Find the same person hiding in different CRM records.</h1><p className="mt-5 max-w-3xl text-base leading-7 text-[#91a69b]">Read HubSpot Contacts or active Salesforce Leads and Contacts page by page, up to your configured safety ceiling. Exact identifiers, safe aliases, phone reuse, name compatibility, company context, conflicts, and record quality all remain visible—no black-box merge score.</p></div>
          <div className="flex flex-wrap gap-2 lg:justify-end">{availableConnectors.map((id) => <button key={id} onClick={() => { setConnectorId(id); setScan(null); setPrimaryRecordKey(null); setVisibleLimit(50); }} className={`rounded-full px-5 py-3 text-sm font-semibold ${connectorId === id ? 'bg-[#d8ff67] text-[#06100d]' : 'border border-white/10 bg-[#0b1b16] text-[#a9bbb2]'}`}>{connectorNames[id]}</button>)}</div>
        </section>

        {catalog && !availableConnectors.length && <Notice tone="warning">No direct CRM scanner is configured. Add a HubSpot service key or refresh a Salesforce session under <Link href="/setup" className="underline">Setup</Link>.</Notice>}
        {needsKey && <section className="mb-5 rounded-[24px] border border-[#83bcff]/20 bg-[#83bcff]/[0.05] p-5"><label className="text-sm font-semibold" htmlFor="operator-key">Operator access key</label><p className="mt-1 text-xs text-[#81978c]">Kept only in this browser tab and sent as a request header. It is never saved with CRM records or exports.</p><input id="operator-key" type="password" value={accessKey} onChange={(event) => rememberAccessKey(event.target.value)} className="mt-4 w-full max-w-lg rounded-xl border border-white/10 bg-[#06100d] px-4 py-3 text-sm outline-none focus:border-[#83bcff]/50" /></section>}
        {error && <Notice tone="error">{error}</Notice>}

        <section className="mb-6 rounded-[30px] border border-white/10 bg-[#0b1b16] p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-5">
            <div><div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${loadState === 'scanning' ? 'animate-pulse bg-[#83bcff]' : scan?.complete ? 'bg-[#d8ff67]' : 'bg-[#566b61]'}`} /><p className="font-semibold">{loadState === 'scanning' ? `Scanning ${connectorNames[connectorId]}…` : scan?.complete ? `${connectorNames[connectorId]} account scan complete` : `Ready to scan ${connectorNames[connectorId]}`}</p></div><p className="mt-2 text-xs text-[#71877c]">{scan ? `${scan.recordsScanned.toLocaleString()} records · ${scan.pagesScanned.toLocaleString()} provider page${scan.pagesScanned === 1 ? '' : 's'} · rules ${scan.ruleVersion}` : 'Read-only until you explicitly approve a review decision.'}</p></div>
            <div className="flex flex-wrap gap-2">{loadState === 'scanning' ? <button onClick={() => { pauseRequested.current = true; }} className="rounded-full border border-white/15 px-5 py-2.5 text-xs font-semibold">Pause after this page</button> : <><button onClick={() => void beginOrResumeScan()} disabled={!workspaceId || !scannerReady || needsKey} className="rounded-full bg-[#d8ff67] px-5 py-2.5 text-xs font-bold text-[#06100d] disabled:cursor-not-allowed disabled:opacity-40">{scan?.status === 'scanning' ? 'Resume scan' : scan?.complete ? 'Run a fresh scan' : 'Scan the account'}</button>{scan?.status === 'scanning' && <button onClick={() => void beginOrResumeScan(true)} disabled={!workspaceId || !scannerReady || needsKey} className="rounded-full border border-[#e6bd68]/30 px-5 py-2.5 text-xs font-semibold text-[#e6bd68] disabled:opacity-40">Start over</button>}</>}{scan?.complete && <button onClick={exportReview} className="rounded-full border border-white/15 px-5 py-2.5 text-xs font-semibold">Export review JSON</button>}</div>
          </div>
          {scan && <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"><Metric label="Scanned" value={scan.recordsScanned} /><Metric label="Candidate groups" value={scan.clusterCount} /><Metric label="High confidence" value={scan.highConfidenceClusters} /><Metric label="Needs review" value={scan.reviewClusters} /><Metric label="Possible" value={scan.possibleClusters} /><Metric label="Reviewed" value={reviewedCount} /></div>}
          {scan?.complete && <div className={`mt-4 rounded-xl border px-4 py-3 text-xs ${scan.sourceComplete ? 'border-[#d8ff67]/20 bg-[#d8ff67]/[0.04] text-[#bddd78]' : 'border-[#e6bd68]/20 bg-[#e6bd68]/[0.04] text-[#e6bd68]'}`}>{scan.sourceComplete ? 'Provider pagination reached the end: these metrics cover the full account.' : 'The configured scan ceiling was reached: review this result as a partial account audit.'}</div>}
          {scan?.analysisWarnings.map((warning) => <p key={warning} className="mt-2 rounded-xl border border-[#e6bd68]/20 bg-[#e6bd68]/[0.04] px-4 py-3 text-xs text-[#e6bd68]">{warning}</p>)}
        </section>

        {scan?.complete && scan.sourceComplete && scan.clusterCount === 0 && <section className="mb-16 rounded-[30px] border border-[#d8ff67]/20 bg-[#d8ff67]/[0.05] p-10 text-center"><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#d8ff67]">Clean account</p><h2 className="mt-3 text-3xl font-semibold">No evidence-backed duplicate candidates found.</h2><p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[#91a69b]">The scan reached every provider page and retained the rule version, record count, and run receipt.</p></section>}
        {scan?.complete && !scan.sourceComplete && scan.clusterCount === 0 && <section className="mb-16 rounded-[30px] border border-[#e6bd68]/20 bg-[#e6bd68]/[0.04] p-10 text-center"><p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#e6bd68]">Partial audit</p><h2 className="mt-3 text-3xl font-semibold">No candidates found in the scanned portion.</h2><p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[#91a69b]">Increase the self-host safety ceiling and run again before treating the account as clean.</p></section>}

        {scan?.clusters.length ? <section className="grid gap-5 pb-16 xl:grid-cols-[420px_minmax(0,1fr)]">
          <aside className="rounded-[28px] border border-white/10 bg-[#0b1b16] p-4 xl:sticky xl:top-5 xl:max-h-[calc(100vh-40px)] xl:overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-1"><div><p className="font-mono text-[9px] uppercase tracking-wider text-[#83bcff]">Review queue</p><h2 className="mt-1 text-xl font-semibold">{filteredClusters.length.toLocaleString()} groups</h2></div><select value={filter} onChange={(event) => { setFilter(event.target.value as QueueFilter); setVisibleLimit(50); }} className="rounded-full border border-white/10 bg-[#06100d] px-3 py-2 text-[10px]"><option value="unreviewed">Unreviewed</option><option value="high_confidence">High confidence</option><option value="review">Needs review</option><option value="possible">Possible</option><option value="all">All</option></select></div>
            <div className="mt-4 space-y-2 xl:max-h-[calc(100vh-145px)] xl:overflow-y-auto xl:pr-1">{filteredClusters.slice(0, visibleLimit).map((cluster) => <QueueCard key={cluster.clusterId} cluster={cluster} active={selectedCluster?.clusterId === cluster.clusterId} onClick={() => { setSelectedClusterId(cluster.clusterId); setPrimaryRecordKey(cluster.review?.primaryRecordKey ?? cluster.recommendedPrimaryKey); }} />)}{filteredClusters.length > visibleLimit && <button onClick={() => setVisibleLimit((value) => value + 50)} className="w-full rounded-xl border border-white/10 px-4 py-3 text-xs text-[#9fb2a8]">Load 50 more</button>}</div>
          </aside>
          {selectedCluster ? <ClusterReview cluster={selectedCluster} primaryRecordKey={effectivePrimaryRecordKey} confirmationBlocked={hasUnresolvedOverlap(scan.clusters, selectedCluster)} onPrimaryChange={setPrimaryRecordKey} onDecide={(decision) => void decide(selectedCluster, decision)} /> : <div className="rounded-[28px] border border-dashed border-white/10 p-10 text-center text-sm text-[#71877c]">Choose a candidate group to inspect its evidence.</div>}
        </section> : null}
      </div>
    </main>
  );
}

function ClusterReview({ cluster, primaryRecordKey, confirmationBlocked, onPrimaryChange, onDecide }: { cluster: ReviewedDuplicateCluster; primaryRecordKey: string; confirmationBlocked: boolean; onPrimaryChange: (value: string) => void; onDecide: (decision: 'not_duplicate' | 'confirmed_duplicate') => void }) {
  return <article className="rounded-[28px] border border-white/10 bg-[#0b1b16] p-5 sm:p-7">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><Band band={cluster.band} /><span className="rounded-full bg-white/[0.05] px-3 py-1 font-mono text-[9px] uppercase text-[#8ca096]">{cluster.confidence}% minimum pair score</span>{cluster.review && <span className="rounded-full bg-[#83bcff]/10 px-3 py-1 font-mono text-[9px] uppercase text-[#83bcff]">{cluster.review.decision.replace('_', ' ')}</span>}</div><h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">Compare {cluster.members.length} records</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-[#8ca096]">{cluster.primaryReason}</p></div><span className="font-mono text-[9px] text-[#566b61]">{cluster.clusterId}</span></div>
    {cluster.blockers.map((blocker) => <p key={blocker} className="mt-4 rounded-xl border border-[#e6bd68]/20 bg-[#e6bd68]/[0.04] px-4 py-3 text-xs leading-5 text-[#e6bd68]">{blocker}</p>)}
    <div className="mt-6 grid gap-3 lg:grid-cols-2">{cluster.members.map((member) => { const selected = member.record.recordKey === primaryRecordKey; return <label key={member.record.recordKey} className={`cursor-pointer rounded-2xl border p-4 transition ${selected ? 'border-[#d8ff67]/40 bg-[#d8ff67]/[0.05]' : 'border-white/10 bg-[#06100d]/50 hover:border-white/20'}`}><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{member.record.fullName || '(No name)'}</p><p className="mt-1 font-mono text-[9px] uppercase text-[#71877c]">{member.record.connectorId} {member.record.objectType} · {member.record.nativeId}</p></div><input type="radio" name={`primary-${cluster.clusterId}`} checked={selected} onChange={() => onPrimaryChange(member.record.recordKey)} className="mt-1 accent-[#d8ff67]" /></div><dl className="mt-4 grid gap-2 text-xs"><RecordValue label="Email" value={member.record.email} /><RecordValue label="Company" value={member.record.company} /><RecordValue label="Phone" value={member.record.phone || member.record.secondaryPhone} /><RecordValue label="Title" value={member.record.jobTitle} /></dl>{member.evidence.length ? <div className="mt-4 flex flex-wrap gap-1.5">{member.evidence.map((evidence) => <span key={evidence.key} className={`rounded-full px-2.5 py-1 text-[9px] ${evidence.tone === 'conflict' ? 'bg-[#ff9c82]/10 text-[#ff9c82]' : evidence.tone === 'warning' ? 'bg-[#e6bd68]/10 text-[#e6bd68]' : 'bg-[#83bcff]/10 text-[#9dcdff]'}`}>{evidence.label} · {evidence.weight > 0 ? '+' : ''}{evidence.weight}</span>)}</div> : <p className="mt-4 text-[10px] text-[#d8ff67]">Recommended primary</p>}</label>; })}</div>
    <section className="mt-6 rounded-2xl border border-white/10 bg-[#06100d]/55 p-4"><div className="flex items-center justify-between"><div><p className="font-mono text-[9px] uppercase tracking-wider text-[#83bcff]">Field recovery plan</p><h3 className="mt-1 font-semibold">What the surviving record should retain</h3></div><span className="text-[10px] text-[#71877c]">{cluster.fields.filter((field) => field.conflicting).length} conflicts</span></div><div className="mt-4 divide-y divide-white/[0.06]">{cluster.fields.map((field) => <div key={field.field} className="grid grid-cols-[100px_1fr_auto] gap-3 py-3 text-xs"><span className="text-[#71877c]">{fieldLabel(field.field)}</span><span className={field.value ? 'text-[#dce9e2]' : 'text-[#566b61]'}>{field.value || 'empty'}</span><span className={field.conflicting ? 'text-[#e6bd68]' : 'text-[#71877c]'}>{field.conflicting ? 'review conflict' : 'agrees'}</span></div>)}</div></section>
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-5"><p className="max-w-xl text-xs leading-5 text-[#71877c]">{confirmationBlocked ? 'Dismiss the overlapping candidate group before this plan can be approved.' : 'A decision saves the human judgment and chosen survivor. It does not silently perform an irreversible native CRM merge.'}</p><div className="flex flex-wrap gap-2"><button onClick={() => onDecide('not_duplicate')} className="rounded-full border border-white/15 px-5 py-2.5 text-xs font-semibold">Not a duplicate</button><button onClick={() => onDecide('confirmed_duplicate')} disabled={confirmationBlocked} className="rounded-full bg-[#d8ff67] px-5 py-2.5 text-xs font-bold text-[#06100d] disabled:cursor-not-allowed disabled:opacity-40">Approve cleanup plan</button></div></div>
  </article>;
}

function QueueCard({ cluster, active, onClick }: { cluster: ReviewedDuplicateCluster; active: boolean; onClick: () => void }) { const names = cluster.members.map((member) => member.record.fullName || member.record.email || member.record.nativeId); return <button onClick={onClick} className={`w-full rounded-2xl border p-4 text-left transition ${active ? 'border-[#d8ff67]/35 bg-[#d8ff67]/[0.05]' : 'border-white/[0.07] bg-[#06100d]/40 hover:border-white/15'}`}><div className="flex items-center justify-between gap-3"><Band band={cluster.band} /><span className="font-mono text-[9px] text-[#71877c]">{cluster.members.length} records</span></div><p className="mt-3 truncate text-sm font-semibold">{names[0]}</p><p className="mt-1 truncate text-xs text-[#71877c]">{names.slice(1).join(' · ')}</p>{cluster.review && <p className="mt-3 text-[10px] font-semibold uppercase text-[#83bcff]">{cluster.review.decision.replace('_', ' ')}</p>}</button>; }
function Band({ band }: { band: ReviewedDuplicateCluster['band'] }) { const style = band === 'high_confidence' ? 'bg-[#d8ff67]/10 text-[#d8ff67]' : band === 'review' ? 'bg-[#83bcff]/10 text-[#83bcff]' : 'bg-[#e6bd68]/10 text-[#e6bd68]'; return <span className={`rounded-full px-3 py-1 font-mono text-[9px] uppercase ${style}`}>{band.replace('_', ' ')}</span>; }
function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-2xl border border-white/[0.07] bg-[#06100d]/45 p-4"><p className="text-[10px] text-[#71877c]">{label}</p><p className="mt-2 text-2xl font-semibold">{value.toLocaleString()}</p></div>; }
function RecordValue({ label, value }: { label: string; value: string | undefined }) { return <div className="grid grid-cols-[70px_1fr] gap-2"><dt className="text-[#566b61]">{label}</dt><dd className="truncate text-[#a9bbb2]">{value || '—'}</dd></div>; }
function Notice({ tone, children }: { tone: 'warning' | 'error'; children: React.ReactNode }) { return <div className={`mb-5 rounded-2xl border px-5 py-4 text-sm ${tone === 'error' ? 'border-[#ff9c82]/20 bg-[#ff9c82]/[0.05] text-[#ffb09a]' : 'border-[#e6bd68]/20 bg-[#e6bd68]/[0.04] text-[#e6bd68]'}`}>{children}</div>; }
function crmScanners(catalog: ConnectorCatalog): IdentityConnector[] { return catalog.connectors.filter((connector) => connector.configured && connector.features?.includes('account-scan')).flatMap((connector): IdentityConnector[] => connector.id === 'hubspot' || connector.id === 'salesforce' ? [connector.id] : []); }
function hasUnresolvedOverlap(clusters: ReviewedDuplicateCluster[], cluster: ReviewedDuplicateCluster) { if (!cluster.ambiguousOverlap) return false; const memberKeys = new Set(cluster.members.map((member) => member.record.recordKey)); return clusters.some((candidate) => candidate.clusterId !== cluster.clusterId && candidate.members.some((member) => memberKeys.has(member.record.recordKey)) && candidate.review?.decision !== 'not_duplicate'); }
function fieldLabel(field: ReviewedDuplicateCluster['fields'][number]['field']) { return field === 'secondaryPhone' ? 'Mobile phone' : field.replace(/([A-Z])/gu, ' $1').replace(/^./u, (letter) => letter.toUpperCase()); }
function operatorFetch(url: string, init: RequestInit, accessKey: string) { const headers = new Headers(init.headers); if (accessKey) headers.set('x-control-tower-key', accessKey); return fetch(url, { ...init, headers, cache: 'no-store' }); }
async function startScan(workspaceId: string, connectorId: IdentityConnector, accessKey: string, action: 'start' | 'restart' = 'start'): Promise<DuplicateScanView> { const response = await operatorFetch('/api/control-tower/duplicate-scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, workspaceId, connectorId }) }, accessKey); const result = await response.json() as { scan?: DuplicateScanView; error?: string }; if (!response.ok || !result.scan) throw new Error(result.error ?? 'The account scan could not start.'); return result.scan; }
function message(error: unknown) { return error instanceof Error ? error.message : 'The duplicate audit could not continue.'; }
