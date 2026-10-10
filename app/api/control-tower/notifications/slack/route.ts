import { operatorAccessError } from '@/lib/operator-auth';
import { persistenceEnabled } from '@/lib/workspace-store';
import { deliverSlackNotifications, enqueueSlackNotification, getSlackNotificationEventState, getSlackNotificationStatus } from '@/lib/slack-notifications';

const headers = { 'cache-control': 'no-store' };
function accessError(request: Request) {
  return operatorAccessError(request) ?? (!persistenceEnabled() ? Response.json({ error: 'Slack notifications require persistent storage.' }, { status: 503, headers }) : null);
}
export async function GET(request: Request) {
  const denied = accessError(request);
  if (denied) return denied;
  try { return Response.json({ slack: await getSlackNotificationStatus() }, { headers }); }
  catch { return Response.json({ error: 'Slack notification status is unavailable. Check the self-hosted SQLite runtime.' }, { status: 503, headers }); }
}
export async function POST(request: Request) {
  const denied = accessError(request);
  if (denied) return denied;
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: 'Send a notification action.' }, { status: 400, headers }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('action' in body) || !['test', 'deliver'].includes(String(body.action)) || Object.keys(body).length !== 1) {
    return Response.json({ error: 'Choose test or deliver. Recipients and message contents are configured on the server.' }, { status: 400, headers });
  }
  try {
    const previous = await getSlackNotificationStatus();
    if (!previous.configured) return Response.json({ slack: previous, outcome: 'idle', error: previous.error ?? 'Slack is not configured on this server.' }, { status: body.action === 'test' ? 503 : 200, headers });
    const key = body.action === 'test' ? `test:${crypto.randomUUID()}` : null;
    if (key) await enqueueSlackNotification({ key, provider: 'system', title: 'Slack connection test',
      summary: 'Control Tower can send operations notifications here. Open the Operations Inbox to inspect saved work.', path: '/app/work' });
    const slack = await deliverSlackNotifications();
    const rateLimited = slack.lastDelivery?.state === 'rate_limited' && slack.nextAttemptAt && Date.parse(slack.nextAttemptAt) > Date.now();
    let outcome = 'idle';
    if (key) {
      const state = await getSlackNotificationEventState(key);
      outcome = state === 'pending' || state === 'sending' ? (rateLimited ? 'rate_limited' : 'queued') : state ?? 'idle';
    } else {
      outcome = slack.unknown > previous.unknown ? 'unknown' : slack.failed > previous.failed ? 'failed' : slack.delivered > previous.delivered ? 'delivered'
        : rateLimited && slack.pending ? 'rate_limited' : slack.pending || slack.sending ? 'queued' : 'idle';
    }
    return Response.json({ slack, outcome }, { headers });
  } catch { return Response.json({ error: 'The notification action could not finish. Reload status before sending another test; delivery may be uncertain.' }, { status: 503, headers }); }
}
