import { createHash } from 'node:crypto';

export type CrmRequestScope = { provider: 'hubspot' | 'salesforce'; accessToken: string; origin?: string };
export type CrmDeferredReason = 'rate_limit' | 'quota' | 'transient' | 'queue';
export type CrmRequestOptions = { signal?: AbortSignal; budgetMs?: number };
export class CrmReadDeferredError extends Error {
  readonly retryAt: string;
  constructor(readonly reason: CrmDeferredReason, retryAt: number, readonly status?: number) {
    super(reason === 'quota'
      ? 'The CRM quota is exhausted. Saved progress is unchanged; resume after the provider allows more requests.'
      : 'The CRM is temporarily busy. Saved progress is unchanged; resume this operation after the indicated time.');
    this.name = 'CrmReadDeferredError';
    this.retryAt = new Date(retryAt).toISOString();
  }
}
export function isCrmReadDeferredError(error: unknown): error is CrmReadDeferredError { return error instanceof CrmReadDeferredError; }

type Policy = { minimumIntervalMs: number; concurrency: number; defaultBudgetMs: number; attemptTimeoutMs: number; backoffBaseMs: number };
const DEFAULT_POLICY: Policy = { minimumIntervalMs: 250, concurrency: 2, defaultBudgetMs: 30_000, attemptTimeoutMs: 10_000, backoffBaseMs: 500 };
type Pending = { deadline: number; signal?: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; cleanup: () => void };
type Gate = { active: number; nextStart: number; cooldownUntil: number; reason: CrmDeferredReason; status?: number; pending: Pending[]; timer?: ReturnType<typeof setTimeout> };
let policy = { ...DEFAULT_POLICY };
const gates = new Map<string, Gate>();

/** In-memory fingerprints are scheduling keys only, never CRM account evidence or persisted credentials. */
function gateFor(scope: CrmRequestScope): Gate {
  const origin = scope.provider === 'hubspot' ? 'https://api.hubapi.com' : new URL(scope.origin ?? '').origin;
  const key = createHash('sha256').update(`${scope.provider}\n${origin}\n${scope.accessToken}`).digest('hex');
  let gate = gates.get(key);
  if (!gate) {
    gate = { active: 0, nextStart: 0, cooldownUntil: 0, reason: 'queue', pending: [] };
    gates.set(key, gate);
  }
  return gate;
}

function abortReason(signal: AbortSignal) { return signal.reason ?? new DOMException('Request cancelled.', 'AbortError'); }
function pump(gate: Gate) {
  if (gate.timer) clearTimeout(gate.timer);
  gate.timer = undefined;
  const now = Date.now();
  for (const item of [...gate.pending]) {
    if (item.signal?.aborted || item.deadline <= now || gate.cooldownUntil >= item.deadline) {
      gate.pending.splice(gate.pending.indexOf(item), 1); item.cleanup();
      item.reject(item.signal?.aborted ? abortReason(item.signal)
        : new CrmReadDeferredError(gate.cooldownUntil > now ? gate.reason : 'queue', Math.max(now + 1_000, gate.cooldownUntil, gate.nextStart), gate.status));
    }
  }
  if (!gate.pending.length || gate.active >= policy.concurrency) return;
  const startAt = Math.max(gate.nextStart, gate.cooldownUntil);
  if (startAt > now) { gate.timer = setTimeout(() => pump(gate), startAt - now); return; }
  const item = gate.pending.shift()!;
  item.cleanup(); gate.active += 1; gate.nextStart = now + policy.minimumIntervalMs;
  let released = false;
  item.resolve(() => { if (!released) { released = true; gate.active -= 1; pump(gate); } });
  pump(gate);
}

function acquire(gate: Gate, deadline: number, signal?: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => pump(gate);
    const timer = setTimeout(() => pump(gate), Math.max(0, deadline - Date.now()));
    const item: Pending = { deadline, signal, resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
    gate.pending.push(item); signal?.addEventListener('abort', onAbort, { once: true }); pump(gate);
  });
}

/** Pacing only: this never retries the callback, including when it performs a write. */
export async function withCrmRequestGate<T>(scope: CrmRequestScope, operation: (signal: AbortSignal) => Promise<T>, options: CrmRequestOptions = {}): Promise<T> {
  const deadline = Date.now() + (options.budgetMs ?? policy.defaultBudgetMs);
  const release = await acquire(gateFor(scope), deadline, options.signal);
  if (options.signal?.aborted) { release(); throw abortReason(options.signal); }
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal ? abortReason(options.signal) : undefined);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException('CRM request timed out.', 'TimeoutError')), Math.max(1, deadline - Date.now()));
  try { return await operation(controller.signal); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); release(); }
}

export function crmRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function quotaResponse(scope: CrmRequestScope, status: number, payload: unknown): boolean {
  if (scope.provider === 'hubspot') return status === 429 && isRecord(payload) && payload.policyName === 'DAILY';
  return status === 403 && Array.isArray(payload) && payload.some((entry) => isRecord(entry) && entry.errorCode === 'REQUEST_LIMIT_EXCEEDED');
}
type Cooldown = { retryAt: string; reason: 'rate_limit' | 'quota'; status: number };
/** Call immediately after a response, before releasing its slot, so siblings share the cooldown. */
export async function observeCrmCooldown(scope: CrmRequestScope, response: Response, payload?: unknown): Promise<Cooldown | null> {
  const quota = quotaResponse(scope, response.status, payload);
  if (response.status !== 429 && !quota) return null;
  const gate = gateFor(scope);
  const delay = crmRetryAfterMs(response.headers.get('retry-after')) ?? (quota ? 3_600_000 : 1_000);
  gate.cooldownUntil = Math.max(gate.cooldownUntil, Date.now() + delay);
  gate.reason = quota ? 'quota' : 'rate_limit'; gate.status = response.status; pump(gate);
  return { retryAt: new Date(gate.cooldownUntil).toISOString(), reason: quota ? 'quota' : 'rate_limit', status: response.status };
}

/** Only known CRM read endpoints are eligible for automatic retries. */
function assertRead(url: URL, init: RequestInit, scope: CrmRequestScope) {
  const method = (init.method ?? 'GET').toUpperCase();
  if (url.username || url.password || url.protocol !== 'https:') throw new Error('CRM reads require an HTTPS provider URL.');
  const path = url.pathname;
  if (scope.provider === 'hubspot') {
    if (url.origin !== 'https://api.hubapi.com') throw new Error('HubSpot reads require the native API origin.');
    const get = /^\/account-info\/v3\/details$/.test(path)
      || /^\/crm\/v3\/(?:properties\/(?:contacts|companies|deals)|pipelines\/deals)$/.test(path)
      || /^\/crm\/(?:v3\/objects|objects\/2026-03)\/(?:contacts|companies|deals|notes)(?:\/[^/]+)?$/.test(path)
      || /^\/crm\/v4\/objects\/(?:contacts|companies|deals|notes)\/[^/]+\/associations\/(?:contacts|companies|deals|notes)$/.test(path);
    const post = /^\/crm\/(?:v3\/objects|objects\/2026-03)\/(?:contacts|companies|deals|notes)\/(?:search|batch\/read)$/.test(path);
    if ((method === 'GET' && get) || (method === 'POST' && post)) return;
  } else if (url.origin === new URL(scope.origin ?? '').origin && method === 'GET'
    && /^\/services\/data\/v\d+\.\d+\/(?:query(?:\/[^/]+)?|sobjects\/(?:Lead|Contact)\/[^/]+)$/.test(path)) return;
  throw new Error('Automatic CRM retries are restricted to allowlisted read requests.');
}

/** Safe reads share the write pacing gate, but only this function performs retries. */
export async function readCrmJson(input: string | URL, init: RequestInit, scope: CrmRequestScope, options: CrmRequestOptions = {}): Promise<{ response: Response; payload: unknown }> {
  const url = new URL(input); assertRead(url, init, scope);
  const signal = options.signal ?? init.signal ?? undefined;
  const deadline = Date.now() + (options.budgetMs ?? policy.defaultBudgetMs);
  let attempt = 0;
  while (true) {
    signal?.throwIfAborted();
    let result: { response: Response; payload: unknown; cooldown: Cooldown | null };
    try {
      result = await withCrmRequestGate(scope, async (gateSignal) => {
        const controller = new AbortController();
        const cancel = () => controller.abort(abortReason(gateSignal));
        gateSignal.addEventListener('abort', cancel, { once: true });
        if (gateSignal.aborted) cancel();
        const timer = setTimeout(() => controller.abort(new DOMException('CRM read timed out.', 'TimeoutError')), policy.attemptTimeoutMs);
        try {
          const response = await fetch(input, { ...init, cache: 'no-store', redirect: 'manual', signal: controller.signal });
          const payload: unknown = await response.json().catch((error: unknown) => {
            // A damaged error body must not turn known permission failures into retryable reads.
            if (!response.ok && response.status !== 429 && ![502, 503, 504].includes(response.status)) return null;
            if (controller.signal.aborted || !(error instanceof SyntaxError)) throw error;
            return null;
          });
          return { response, payload, cooldown: await observeCrmCooldown(scope, response, payload) };
        } finally { clearTimeout(timer); gateSignal.removeEventListener('abort', cancel); }
      }, { signal, budgetMs: deadline - Date.now() });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof CrmReadDeferredError) throw error;
      if (!(error instanceof TypeError) && !(error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name))) throw error;
      await retryDelay(scope, deadline, attempt++, signal, 'transient');
      continue;
    }
    signal?.throwIfAborted();
    const { response, payload, cooldown } = result;
    if (cooldown?.reason === 'quota') throw new CrmReadDeferredError('quota', Date.parse(cooldown.retryAt), response.status);
    if (response.status !== 429 && ![502, 503, 504].includes(response.status)) return { response, payload };
    await retryDelay(scope, deadline, attempt++, signal, response.status === 429 ? 'rate_limit' : 'transient', response.status, response);
  }
}

async function retryDelay(scope: CrmRequestScope, deadline: number, attempt: number, signal: AbortSignal | undefined, reason: CrmDeferredReason, status?: number, response?: Response) {
  const now = Date.now();
  const jittered = Math.ceil(Math.min(8_000, policy.backoffBaseMs * 2 ** Math.min(attempt, 5)) * (0.5 + Math.random() * 0.5));
  const providerDelay = response ? crmRetryAfterMs(response.headers.get('retry-after'), now) ?? 0 : 0;
  const gate = gateFor(scope);
  const retryAt = Math.max(now + jittered, now + providerDelay, gate.cooldownUntil);
  if (retryAt >= deadline) throw new CrmReadDeferredError(reason, Math.max(now + 1_000, retryAt), status);
  await new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(signal ? abortReason(signal) : new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, Math.max(1, retryAt - now));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** Test isolation only: runtime callers use the fixed conservative policy above. */
export function resetCrmReadTransportForTests(overrides: Partial<Policy> = {}) {
  for (const gate of gates.values()) {
    if (gate.timer) clearTimeout(gate.timer);
    for (const pending of gate.pending) { pending.cleanup(); pending.reject(new DOMException('Test transport reset.', 'AbortError')); }
  }
  gates.clear(); policy = { ...DEFAULT_POLICY, ...overrides };
}
