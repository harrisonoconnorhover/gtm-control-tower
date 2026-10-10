import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function cdcRelayUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set CONTROL_TOWER_CDC_RELAY_URL.'); }
  const localDestination = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || (url.hostname === 'app' && url.port === '3000');
  if ((url.protocol !== 'https:' && !(localDestination && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/api/control-tower/events/salesforce') throw new Error('Use the HTTPS Salesforce intake URL (HTTP is allowed only on loopback or the app:3000 Compose service).');
  return url;
}
export async function sendCdcEnvelope(url, secret, value, fetcher = fetch, signal) {
  if (!secret || secret.length < 32) throw new Error('Set a CDC relay secret of at least 32 characters.');
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 1_048_576) throw new Error('CDC envelope exceeds 1 MiB.');
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', secret).update(`${timestamp}\nPOST\n${url.pathname}\n${body}`).digest('hex');
  const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: combinedSignal(signal, 15_000),
    headers: { 'content-type': 'application/json', 'x-control-tower-timestamp': timestamp, 'x-control-tower-signature': signature }, body });
  if (!response.ok) throw new CdcError(`CDC receiver returned HTTP ${response.status}; the pending envelope and checkpoint were preserved.`, [400, 401, 403, 409, 413].includes(response.status));
  const result = await response.json();
  if (typeof result.replayId !== 'string') throw new CdcError('CDC receiver returned an invalid acknowledgement; pending envelope preserved.', true);
  // A different checkpoint means another sender advanced the channel; never silently skip our pending input.
  if (result.replayId !== value.replayId) throw new CdcError('CDC receiver checkpoint differs; inspect the saved stream before restarting this subscriber.', true);
  return result;
}
class CdcError extends Error {
  constructor(message, permanent = false, replayInvalid = false) { super(message); this.permanent = permanent; this.replayInvalid = replayInvalid; }
}
function combinedSignal(signal, ms) { return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms); }

export async function readCdcState(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('CDC checkpoint file could not be read; refusing to start from a different position.'); }
}
export async function writeCdcState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** One ordered channel. Native credentials only go to its pinned Salesforce origin. */
export function createSalesforceCdcSubscriber(config, dependencies = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const readState = dependencies.readState ?? readCdcState;
  const writeState = dependencies.writeState ?? writeCdcState;
  const onStatus = dependencies.onStatus ?? ((value) => console.log(JSON.stringify(value)));
  const instance = new URL(config.instanceUrl);
  const version = config.apiVersion ?? '67.0';
  const channel = config.channel ?? '/data/ChangeEvents';
  if (instance.protocol !== 'https:' || instance.username || instance.password || instance.search || instance.hash || !['', '/'].includes(instance.pathname)
    || !/^\d+\.\d+$/.test(version) || Number(version) < 37) throw new Error('CDC requires an HTTPS Salesforce instance origin and Streaming API version >=37.0.');
  if (!config.accessToken?.trim() || !/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(config.organizationId)) throw new Error('Set SALESFORCE_ACCESS_TOKEN and SALESFORCE_MONITOR_ORG_ID.');
  if (!/^\/data\/(?:ChangeEvents|(?:Lead|Contact|Account|Opportunity)ChangeEvent)$/.test(channel)) throw new Error('Use a supported Salesforce CDC channel.');
  if (!config.checkpointPath) throw new Error('A persistent CDC checkpoint file is required.');
  const relayUrl = cdcRelayUrl(config.relayUrl);
  if (!config.relaySecret || config.relaySecret.length < 32) throw new Error('Set a CDC relay secret of at least 32 characters.');
  const streamUrl = `${instance.origin}/cometd/${version}`;
  const cookies = new Map();
  let state;
  let clientId;
  let messageId = 0;
  let backoff = 1000;
  const binding = { organizationId: config.organizationId, channel, instance: instance.origin, relayUrl: relayUrl.href };

  async function persist() {
    try { await writeState(config.checkpointPath, state); }
    catch { throw new CdcError('CDC checkpoint could not be persisted; subscriber stopped without advancing.', true); }
  }
  async function load() {
    state = await readState(config.checkpointPath);
    if (state) {
      if (state.version !== 1 || Object.entries(binding).some(([key, value]) => state[key] !== value)
        || !(state.nativeReplayId === null || /^\d+$/.test(state.nativeReplayId)) || !(state.relayReplayId === null || typeof state.relayReplayId === 'string')) throw new CdcError('CDC checkpoint belongs to another connection or is invalid; do not reset it implicitly.', true);
    } else {
      state = { version: 1, ...binding, nativeReplayId: null, relayReplayId: null, acknowledgedAt: null, pending: null };
      await persist();
    }
  }
  async function flush(signal) {
    if (!state.pending) return;
    const { envelope, nativeReplayId } = state.pending;
    const result = await sendCdcEnvelope(relayUrl, config.relaySecret, envelope, fetcher, signal);
    state = { ...state, nativeReplayId, relayReplayId: result.replayId, acknowledgedAt: new Date().toISOString(), pending: null };
    await persist();
    onStatus({ state: 'acknowledged', channel, replayId: result.replayId, accepted: result.accepted, needsReconciliation: result.needsReconciliation });
  }
  async function deliver(payload, replayId, signal) {
    state.pending = { nativeReplayId: replayId, envelope: { organizationId: config.organizationId, channel, replayId, previousReplayId: state.relayReplayId, events: [payload] } };
    await persist(); // Crash before acknowledgement must replay this exact envelope.
    await flush(signal);
  }
  async function gap(reason, signal) {
    state.pending = { nativeReplayId: null, envelope: { organizationId: config.organizationId, channel, replayId: `gap:${randomUUID()}`, previousReplayId: state.relayReplayId, events: [], gapReason: reason } };
    await persist();
    await flush(signal);
  }
  async function nativeRequest(url, body, signal, timeout = 120_000) {
    // Both native URL forms are constructed from one validated origin; neither response URLs nor redirects are followed.
    if (new URL(url).origin !== instance.origin) throw new CdcError('Native origin changed unexpectedly.', true);
    const response = await fetcher(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: combinedSignal(signal, timeout),
      headers: { authorization: `Bearer ${config.accessToken}`, accept: 'application/json', 'content-type': 'application/json',
        ...(cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}) }, ...(body ? { body } : {}) });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const first = cookie.split(';')[0]; const equals = first.indexOf('=');
      const name = first.slice(0, equals); const value = first.slice(equals + 1);
      if (equals > 0 && /^[A-Za-z0-9_-]+$/.test(name)) {
        if (/;\s*max-age=0(?:;|$)/i.test(cookie)) cookies.delete(name); else cookies.set(name, value);
      }
    }
    if (!response.ok) throw new CdcError(`Salesforce CDC returned HTTP ${response.status}.`, [400, 401, 403, 404].includes(response.status));
    const text = await boundedText(response, 8 * 1024 * 1024);
    // Node 22 JSON source context preserves integer replay IDs without rounding a 64-bit value.
    return JSON.parse(text, (key, value, context) => {
      if (key === 'replayId' && typeof value === 'number') {
        if (context?.source && /^\d+$/.test(context.source)) return context.source;
        if (Number.isSafeInteger(value) && value >= 0) return String(value);
        throw new CdcError('Native replay ID cannot be represented exactly; checkpoint preserved.', true);
      }
      return value;
    });
  }
  async function bayeux(message, signal, replayId) {
    let body = JSON.stringify([{ ...message, id: String(++messageId) }]);
    // Bayeux replay uses a JSON integer. Its exact decimal string is validated and inserted, never incremented.
    if (replayId !== undefined) {
      if (!/^(?:-2|\d+)$/.test(replayId)) throw new CdcError('Invalid native replay position.', true);
      body = body.replace('"__NATIVE_REPLAY__"', replayId);
    }
    const messages = await nativeRequest(streamUrl, body, signal);
    if (!Array.isArray(messages) || messages.length > 10_000) throw new CdcError('Salesforce returned an invalid Bayeux message batch.', true);
    return messages;
  }
  function validateMeta(messages, name) {
    const message = messages.find((item) => item?.channel === name);
    if (!message || message.successful !== true) {
      const error = typeof message?.error === 'string' ? message.error : '';
      const invalidReplay = /replay\s*id|replayId/i.test(error) && /invalid|expired/i.test(error);
      // Never echo native payloads, cookies, credentials or arbitrary response bodies.
      throw new CdcError(invalidReplay ? 'Salesforce rejected the saved replay ID.' : `Salesforce rejected ${name}; check CDC access and connection status.`, !invalidReplay && (message?.advice?.reconnect === 'none' || /^40[013]/.test(error) && !/unknown client/i.test(error)), invalidReplay);
    }
    return message;
  }
  async function connect(signal) {
    const identity = await nativeRequest(`${instance.origin}/services/data/v${version}/query?${new URLSearchParams({ q: 'SELECT Id FROM Organization LIMIT 1' })}`, null, signal, 30_000);
    if (identity?.done !== true || identity.nextRecordsUrl || identity.records?.length !== 1 || identity.records[0]?.Id !== config.organizationId) throw new CdcError('Native Salesforce organization does not match the configured CDC organization.', true);
    const handshakeMessages = await bayeux({ channel: '/meta/handshake', version: '1.0', minimumVersion: '1.0', supportedConnectionTypes: ['long-polling'], ext: { replay: true } }, signal);
    const handshake = validateMeta(handshakeMessages, '/meta/handshake');
    if (typeof handshake.clientId !== 'string' || !handshake.clientId || !handshake.supportedConnectionTypes?.includes('long-polling') || handshake.ext?.replay !== true) throw new CdcError('Salesforce did not negotiate replay-capable long polling.', true);
    clientId = handshake.clientId;
    const subscribed = await bayeux({ channel: '/meta/subscribe', clientId, subscription: channel, ext: { replay: { [channel]: '__NATIVE_REPLAY__' } } }, signal, state.nativeReplayId ?? '-2');
    validateMeta(subscribed, '/meta/subscribe');
    await processEvents(subscribed, signal);
    onStatus({ state: 'subscribed', channel, replay: state.nativeReplayId ?? 'retained-history' });
  }
  async function processEvents(messages, signal) {
    for (const message of messages) {
      if (message?.channel !== channel) continue;
      const replayId = message.data?.event?.replayId;
      const payload = message.data?.payload;
      if (typeof replayId !== 'string' || !/^\d+$/.test(replayId) || !payload?.ChangeEventHeader) throw new CdcError('Salesforce returned an invalid CDC event; checkpoint preserved.', true);
      await deliver(payload, replayId, signal);
    }
  }
  async function run({ signal, maxConnects = Infinity } = {}) {
    await load();
    let connects = 0;
    while (!signal?.aborted && connects < maxConnects) {
      try {
        await flush(signal);
        if (!clientId) await connect(signal);
        const messages = await bayeux({ channel: '/meta/connect', clientId, connectionType: 'long-polling' }, signal);
        // Save delivered data before interpreting reconnection advice; replay makes interrupted batches safe.
        await processEvents(messages, signal);
        const meta = validateMeta(messages, '/meta/connect');
        connects++; backoff = 1000;
        if (messages.some((item) => item?.channel === '/meta/disconnect') || meta.advice?.reconnect === 'handshake') clientId = undefined;
        if (meta.advice?.reconnect === 'none') throw new CdcError('Salesforce stopped the subscription; restore authentication or CDC access before restarting.', true);
        const interval = Number(meta.advice?.interval ?? 0);
        if (interval > 0 && connects < maxConnects) await sleep(Math.min(30_000, interval), signal);
      } catch (error) {
        if (signal?.aborted) break;
        if (error.replayInvalid) {
          try { await gap('Salesforce rejected the saved Streaming API replay ID. Retained-history replay and a full baseline are required; older intermediate changes cannot be reconstructed.', signal); }
          catch (deliveryError) { if (deliveryError.permanent) throw deliveryError; }
          clientId = undefined;
          onStatus({ state: 'replay-gap', channel });
          continue;
        }
        if (error.permanent) throw error;
        clientId = undefined;
        onStatus({ state: 'reconnecting', channel, retryInMs: backoff, detail: 'Connection or delivery interrupted; saved checkpoint and pending envelope retained.' });
        await sleep(backoff, signal).catch((failure) => { if (!signal?.aborted) throw failure; });
        backoff = Math.min(30_000, backoff * 2);
      }
    }
    if (clientId && !signal?.aborted) await bayeux({ channel: '/meta/disconnect', clientId }, signal).catch(() => undefined);
    return state;
  }
  return { run };
}
async function boundedText(response, maximum) {
  const reader = response.body?.getReader();
  if (!reader) throw new CdcError('Salesforce returned an empty response.', true);
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length;
    if (length > maximum) { await reader.cancel(); throw new CdcError('Salesforce CDC response exceeded the local batch limit; checkpoint preserved.', true); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
