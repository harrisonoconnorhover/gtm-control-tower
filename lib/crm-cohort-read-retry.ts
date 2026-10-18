export type CrmCohortReadWait = { attempt: number; retryAt: string; message: string };

/** Only for the read-only cohort endpoint. Workspace saves and CRM writes never use this loop. */
export async function retryCrmCohortRead<T>(options: {
  read: (signal: AbortSignal) => Promise<Response>;
  signal: AbortSignal;
  onWait: (state: CrmCohortReadWait) => void;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  budgetMs?: number;
}): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitForCrmRead;
  const random = options.random ?? Math.random;
  const budget = options.budgetMs ?? 5 * 60_000;
  const deadline = now() + budget;
  const lifetime = new AbortController();
  const cancel = () => lifetime.abort(options.signal.reason);
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
  const timer = setTimeout(() => lifetime.abort(new Error('Automatic CRM waiting has paused. The saved cohort and page position are unchanged; retry when ready.')), budget);
  const signal = lifetime.signal;
  let attempt = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      attempt += 1;
      let response: Response | undefined;
      let body: { error?: string; retryable?: boolean; retryAt?: string } = {};
      let failure = 'The CRM connection was interrupted.';
      try { response = await options.read(signal); }
      catch { signal.throwIfAborted(); }
      if (response) {
        try { body = await response.json() as typeof body; }
        catch {
          if (response.ok) throw new Error('The CRM returned an unreadable response. The saved cohort is unchanged.');
        }
        if (response.ok) return body as T;
        failure = body.error ?? `CRM read unavailable (HTTP ${response.status}).`;
        if (body.retryable === false || ![429, 502, 503, 504].includes(response.status)) throw new Error(failure);
      }
      const header = response?.headers.get('retry-after');
      const headerAt = header && /^\d+(\.\d+)?$/.test(header.trim())
        ? now() + Number(header) * 1_000 : header ? Date.parse(header) : NaN;
      const bodyAt = body.retryAt ? Date.parse(body.retryAt) : NaN;
      const backoff = Math.min(15_000, 1_000 * 2 ** Math.min(attempt - 1, 4)) + random() * 500;
      const retryAt = Math.max(now() + backoff, Number.isFinite(headerAt) ? headerAt : 0, Number.isFinite(bodyAt) ? bodyAt : 0);
      if (retryAt >= deadline) throw new Error(`${failure} Automatic waiting has paused. Retry after ${new Date(retryAt).toISOString()}; the saved cohort and page position are unchanged.`);
      options.onWait({ attempt, retryAt: new Date(retryAt).toISOString(), message: failure });
      await wait(Math.max(0, retryAt - now()), signal);
    }
  } finally { clearTimeout(timer); options.signal.removeEventListener('abort', cancel); }
}

export function waitForCrmRead(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Stopped', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
