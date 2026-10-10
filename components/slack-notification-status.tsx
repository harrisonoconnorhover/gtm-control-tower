'use client';

import { useEffect, useRef, useState } from 'react';

type DeliveryState = 'sending' | 'delivered' | 'failed' | 'unknown' | 'rate_limited';
interface SlackStatus {
  configured: boolean;
  enabled: boolean;
  error: string | null;
  pending: number;
  sending: number;
  delivered: number;
  failed: number;
  unknown: number;
  nextAttemptAt: string | null;
  lastDelivery: { state: DeliveryState; eventCount: number; startedAt: string; finishedAt: string | null; error: string | null } | null;
}
interface SlackResponse {
  slack: SlackStatus;
  outcome?: 'delivered' | 'queued' | 'rate_limited' | 'unknown' | 'failed' | 'idle';
  error?: string;
}

const button = 'rounded-full border border-white/20 px-3 py-2 text-xs font-semibold text-[#d8ff67] disabled:opacity-40';

// The parent keys this component by the submitted operator key. Replacing it
// aborts its reads and prevents an older response from updating a new session.
export function SlackNotificationStatus({ accessKey }: { accessKey: string | null }) {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    if (accessKey === null) return () => active.abort();
    const refresh = async () => {
      try {
        const response = await requestSlack(accessKey, undefined, active.signal);
        if (!active.signal.aborted) { setStatus(response.slack); setError(null); }
      } catch (caught) { if (!active.signal.aborted) setError(message(caught)); }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => { active.abort(); window.clearInterval(timer); };
  }, [accessKey]);

  async function act(action: 'test' | 'deliver') {
    const active = controller.current;
    if (accessKey === null || !active || active.signal.aborted) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await requestSlack(accessKey, { action }, active.signal);
      if (active.signal.aborted) return;
      setStatus(response.slack);
      setNotice(actionNotice(action, response.outcome));
    } catch (caught) { if (!active.signal.aborted) setError(message(caught)); }
    finally { if (!active.signal.aborted) setBusy(false); }
  }

  const state = !status ? error ? 'Status unavailable' : 'Checking connection…' : !status.configured ? 'Not connected' : status.enabled ? 'Notifications enabled' : 'Notifications paused';
  return <section aria-label="Slack notifications" className="rounded-2xl border border-white/10 p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">Slack notifications</h2><span className={`text-[11px] ${status?.enabled ? 'text-[#d8ff67]' : 'text-[#9fb2a8]'}`}>{state}</span></div>
    <p className="mt-3 text-xs leading-5 text-[#9fb2a8]">New findings, repair results, and import updates go to your operations channel with a link back to review.</p>
    {error && <p role="alert" className="mt-3 break-words text-xs leading-5 text-[#ffbb86]">{error}</p>}
    {status?.error && <p className="mt-3 break-words text-xs leading-5 text-[#ffbb86]">{status.error}</p>}
    {notice && <p role="status" className="mt-3 text-xs leading-5 text-[#d8ff67]">{notice}</p>}
    {status && <>
      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">{[['Queued', status.pending], ['Sent', status.delivered], ['Failed', status.failed], ['Unconfirmed', status.unknown]].map(([label, count]) => <div key={label} className="flex justify-between gap-2"><dt className="text-[#9fb2a8]">{label}</dt><dd className="tabular-nums">{count}</dd></div>)}</dl>
      {status.sending > 0 && <p className="mt-3 text-xs text-[#9fb2a8]">{status.sending} delivery in progress.</p>}
      {status.pending > 0 && status.nextAttemptAt && <p className="mt-3 text-xs leading-5 text-[#9fb2a8]">Next delivery can run after {formatTime(status.nextAttemptAt)}.</p>}
      {status.unknown > 0 && <p className="mt-3 text-xs leading-5 text-[#ffbb86]">Some messages may have reached Slack. Check the channel; unconfirmed deliveries are not automatically resent.</p>}
      {status.lastDelivery && <p className="mt-3 break-words text-xs leading-5 text-[#718c7e]">Last delivery: {deliveryLabel(status.lastDelivery.state)} · {formatTime(status.lastDelivery.finishedAt ?? status.lastDelivery.startedAt)}{status.lastDelivery.error ? `. ${status.lastDelivery.error}` : ''}</p>}
      <div className="mt-4 flex flex-wrap gap-2"><button type="button" className={button} disabled={busy || !status.configured} onClick={() => void act('test')}>{busy ? 'Sending…' : 'Send test message'}</button><button type="button" className={button} disabled={busy || !status.configured || !status.enabled || status.pending === 0 || status.sending > 0} onClick={() => void act('deliver')}>Send queued</button></div>
      {!status.configured && <details className="mt-4 border-t border-white/10 pt-3"><summary className="cursor-pointer text-xs text-[#9fb2a8]">Connect your operations channel</summary><p className="mt-3 text-xs leading-5 text-[#9fb2a8]">Ask your server administrator to set <code className="break-all">CONTROL_TOWER_SLACK_WEBHOOK_URL</code> to this channel’s incoming webhook and <code className="break-all">CONTROL_TOWER_APP_URL</code> to the reachable address of your private Control Tower app. Keep the webhook secret on the server.</p></details>}
    </>}
  </section>;
}

async function requestSlack(key: string, body?: { action: 'test' | 'deliver' }, signal?: AbortSignal): Promise<SlackResponse> {
  const response = await fetch('/api/control-tower/notifications/slack', { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-control-tower-key': key }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal });
  const data = await response.json() as SlackResponse;
  if (!response.ok) throw new Error(data.error || 'Slack delivery status is unavailable. The inbox is still available.');
  return data;
}
function actionNotice(action: 'test' | 'deliver', outcome?: SlackResponse['outcome']) {
  if (outcome === 'delivered') return action === 'test' ? 'Slack confirmed the test message was sent.' : 'Slack confirmed the queued messages were sent.';
  if (outcome === 'unknown') return 'Delivery is unconfirmed. Check the Slack channel before sending another message.';
  if (outcome === 'failed') return 'Slack did not accept this delivery. See the delivery details below.';
  if (outcome === 'rate_limited') return 'Slack asked us to wait. The message remains queued for a later attempt.';
  if (outcome === 'idle') return 'There are no messages eligible to send right now.';
  return action === 'test' ? 'Test message queued. Delivery has not been confirmed.' : 'Delivery requested. Check the saved delivery status below.';
}
function deliveryLabel(state: DeliveryState) { return ({ sending: 'in progress', delivered: 'confirmed by Slack', failed: 'failed', unknown: 'unconfirmed', rate_limited: 'waiting for Slack' })[state]; }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
function message(caught: unknown) { return caught instanceof Error ? caught.message : 'Slack delivery status is unavailable. The inbox is still available.'; }
