'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { isSuppressed } from '@/lib/suppression';
import type { LiveContactState } from '@/lib/live-control-tower';
import { normalizeWebsiteUrl, WEBSITE_CHECK_BATCH_SIZE, type WebsiteCheckResult } from '@/lib/website-check-types';

type Props = {
  contacts: LiveContactState[];
  workspaceId: string | null;
  accessKey: string;
  disabled?: boolean;
  onObservations?: (snapshot: WebsiteReviewSnapshot) => void;
};

export type WebsiteReviewSnapshot = { checks: WebsiteCheckResult[]; state: 'loading' | 'error' | 'ready' };

type WebsiteGroup = { url: string; companies: string[]; count: number };
type CheckResponse = { checks: WebsiteCheckResult[] };

const pageSize = 10;
const buttonClass = 'rounded-full border border-white/20 px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40';
const statusLabels: Record<WebsiteCheckResult['status'], string> = {
  reachable: 'Content retrieved', blocked: 'Blocked by website', timed_out: 'Timed out',
  failed: 'Could not load', needs_review: 'Needs review', invalid: 'Invalid or restricted address',
};

export function WebsiteCheckReview({ contacts, ...props }: Props) {
  const included = useMemo(() => contacts.filter((contact) => contact.recordStatus === 'active' && !contact.importExclusion && !isSuppressed(contact)), [contacts]);
  const input = useMemo(() => {
    const groups = new Map<string, WebsiteGroup>();
    let missing = 0;
    let invalid = 0;
    for (const contact of included) {
      if (!contact.website?.trim()) { missing++; continue; }
      const url = normalizeWebsiteUrl(contact.website);
      if (!url) { invalid++; continue; }
      const group = groups.get(url) ?? { url, companies: [], count: 0 };
      group.count++;
      if (contact.company && !group.companies.includes(contact.company)) group.companies.push(contact.company);
      groups.set(url, group);
    }
    return { groups: [...groups.values()], missing, invalid };
  }, [included]);

  // Changing the input or authorization aborts the old client's requests and
  // reloads the saved observations for this workspace and these exact URLs.
  const reviewKey = JSON.stringify([props.workspaceId, props.accessKey, input.groups.map((group) => group.url)]);
  return <WebsiteReview key={reviewKey} {...props} {...input} />;
}

function WebsiteReview({ workspaceId, accessKey, disabled = false, groups, missing, invalid, onObservations }: Omit<Props, 'contacts'> & {
  groups: WebsiteGroup[]; missing: number; invalid: number;
}) {
  const [checks, setChecks] = useState<Map<string, WebsiteCheckResult>>(() => new Map());
  const [loading, setLoading] = useState(Boolean(workspaceId && groups.length));
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState(0);
  const request = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const pauseRequested = useRef(false);
  const unchecked = groups.filter((group) => !checks.has(group.url));
  const savedCount = groups.length - unchecked.length;
  const reachableCount = groups.filter((group) => checks.get(group.url)?.status === 'reachable').length;
  const lastPage = Math.max(0, Math.ceil(groups.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const rows = groups.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const unavailable = disabled || !workspaceId || loading || running || loadFailed;

  useEffect(() => {
    if (!workspaceId || !groups.length) { onObservations?.({ checks: [], state: 'ready' }); return; }
    onObservations?.({ checks: [], state: 'loading' });
    const controller = new AbortController();
    request.current = controller;
    async function load() {
      try {
        const result = await requestChecks(`/api/control-tower/website-checks?workspaceId=${encodeURIComponent(workspaceId!)}`, accessKey, controller.signal);
        if (!controller.signal.aborted) {
          setChecks(new Map(result.checks.map((check) => [check.url, check])));
          setLoadFailed(false);
          setError('');
          setProgress('');
          onObservations?.({ checks: result.checks, state: 'ready' });
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setLoadFailed(true);
          setError(message(failure));
          onObservations?.({ checks: [], state: 'error' });
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [workspaceId, accessKey, reload, groups.length, onObservations]);

  useEffect(() => () => {
    pauseRequested.current = true;
    request.current?.abort();
  }, []);

  useEffect(() => {
    if (disabled) pauseRequested.current = true;
  }, [disabled]);

  async function checkWebsites(recheck: boolean) {
    if (unavailable || runningRef.current || !workspaceId) return;
    const queue = (recheck ? groups : unchecked).map((group) => group.url);
    if (!queue.length) return;
    const controller = new AbortController();
    request.current = controller;
    runningRef.current = true;
    pauseRequested.current = false;
    setRunning(true);
    onObservations?.({ checks: [...checks.values()], state: 'loading' });
    setStopping(false);
    setError('');
    setProgress(`Checking 0 of ${queue.length} websites…`);
    let completed = 0;
    let failed = false;
    const observed = new Map(checks);
    try {
      for (let index = 0; index < queue.length; index += WEBSITE_CHECK_BATCH_SIZE) {
        if (pauseRequested.current || controller.signal.aborted) break;
        const urls = queue.slice(index, index + WEBSITE_CHECK_BATCH_SIZE);
        const result = await requestChecks('/api/control-tower/website-checks', accessKey, controller.signal, { workspaceId, urls, recheck });
        if (controller.signal.aborted) return;
        setChecks((previous) => new Map([...previous, ...result.checks.map((check) => [check.url, check] as const)]));
        for (const check of result.checks) observed.set(check.url, check);
        completed += urls.length;
        setProgress(`Checked and saved ${completed} of ${queue.length} websites.`);
      }
      if (!controller.signal.aborted && completed < queue.length) setProgress(`Stopped after ${completed} of ${queue.length} websites. Completed results are saved.`);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setLoadFailed(true);
        failed = true;
        setError(message(failure));
        setProgress(`Stopped after ${completed} of ${queue.length} websites. Reload saved results before continuing; the last batch may have saved.`);
      }
    } finally {
      if (!controller.signal.aborted) {
        runningRef.current = false;
        setRunning(false);
        setStopping(false);
        onObservations?.({ checks: [...observed.values()], state: failed ? 'error' : 'ready' });
      }
    }
  }

  return (
    <section aria-label="Company website checks" className="mb-6 rounded-3xl border border-white/10 bg-[#0c1d17] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-xl">Company website checks</h3>
          <p className="mt-2 text-sm text-[#bdcbc4]">See whether each website returns content. We try a page request first, then a browser when needed.</p>
        </div>
        <span className="rounded-full bg-[#b8d8ff]/10 px-3 py-1 text-xs font-semibold text-[#b8d8ff]">Saved with this workspace</span>
      </div>
      <p className="mt-3 text-xs leading-5 text-[#9db1a7]">{groups.length} distinct websites · {savedCount} checked · {reachableCount} with content · {missing} included rows without a website{invalid ? ` · ${invalid} with an invalid website` : ''}. Skipped and merged rows are excluded.</p>
      <p className="mt-2 text-xs leading-5 text-[#9db1a7]">Results describe reachability at the time checked and do not change import decisions. Company identity, ICP fit, and email deliverability belong in Pomade.</p>
      {!workspaceId && <p className="mt-3 text-sm text-[#e6bd68]">Save this workspace before checking websites.</p>}
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className={`${buttonClass} bg-[#cdfc54]/10 text-[#cdfc54]`} disabled={unavailable || !unchecked.length}
          onClick={() => void checkWebsites(false)}>{savedCount ? 'Check unchecked websites' : 'Check company websites'}</button>
        {savedCount > 0 && <button type="button" className={buttonClass} disabled={unavailable || !groups.length}
          onClick={() => void checkWebsites(true)}>Recheck all websites</button>}
        {running && <button type="button" className={buttonClass} disabled={stopping} onClick={() => {
          pauseRequested.current = true; setStopping(true);
        }}>{stopping ? 'Stopping after current batch…' : 'Stop after current batch'}</button>}
        {loadFailed && <button type="button" className={buttonClass} disabled={loading} onClick={() => {
          onObservations?.({ checks: [...checks.values()], state: 'loading' });
          setLoading(true); setReload((value) => value + 1);
        }}>Reload saved website results</button>}
      </div>
      <p role="status" className="mt-3 text-xs text-[#9db1a7]">{loading ? 'Loading saved website results…' : progress}</p>
      {error && <p role="alert" className="mt-3 rounded-xl border border-[#ff9c82]/20 bg-[#ff9c82]/5 p-3 text-sm text-[#ffb19a]">{error}</p>}
      <div className="mt-4 space-y-3">
        {rows.map((group) => {
          const check = checks.get(group.url);
          return <article key={group.url} aria-label={`Website ${group.url}`} className="min-w-0 rounded-xl border border-white/10 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-semibold">{group.companies.length ? group.companies.slice(0, 3).join(', ') : 'Company not supplied'}{group.companies.length > 3 ? ` + ${group.companies.length - 3} more` : ''}</p>
                <p className="mt-1 break-all text-xs text-[#9db1a7]">{group.url}</p>
                <p className="mt-1 text-xs text-[#9db1a7]">{group.count} included {group.count === 1 ? 'row' : 'rows'}</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${check?.status === 'reachable' ? 'bg-[#cdfc54]/10 text-[#cdfc54]' : 'bg-white/5 text-[#e6bd68]'}`}>
                {check ? statusLabels[check.status] : 'Not checked'}
              </span>
            </div>
            {check && <>
              {check.title && <p className="mt-3 break-words text-sm">Page title: {check.title}</p>}
              {check.finalUrl && <p className="mt-2 break-all text-xs text-[#bdcbc4]">Final URL: {check.finalUrl}</p>}
              <p className="mt-2 break-words text-xs leading-5 text-[#bdcbc4]">{check.detail}</p>
              <p className="mt-2 text-xs leading-5 text-[#9db1a7]">{check.method === 'browser' ? 'Browser fallback' : 'HTTP GET'}{check.httpStatus !== null ? ` · HTTP ${check.httpStatus}` : ''} · Checked {new Date(check.checkedAt).toLocaleString()}</p>
            </>}
          </article>;
        })}
        {!groups.length && <p className="text-sm text-[#9db1a7]">No website URLs are available in the included rows. Add or correct website values in your source, then reload the import.</p>}
      </div>
      {groups.length > pageSize && <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[#9db1a7]">
        <span>{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, groups.length)} of {groups.length} websites</span>
        <button type="button" className={buttonClass} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous websites</button>
        <button type="button" className={buttonClass} disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next websites</button>
      </div>}
    </section>
  );
}

async function requestChecks(url: string, accessKey: string, signal: AbortSignal, body?: object): Promise<CheckResponse> {
  const headers = new Headers();
  if (accessKey) headers.set('x-control-tower-key', accessKey);
  if (body) headers.set('content-type', 'application/json');
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers, signal, cache: 'no-store', body: body ? JSON.stringify(body) : undefined });
  const result = await response.json() as CheckResponse & { error?: unknown };
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Website results could not be loaded or saved. Try again.');
  return result;
}

function message(failure: unknown) {
  return failure instanceof Error ? failure.message : 'Website checks could not complete. Try again.';
}
