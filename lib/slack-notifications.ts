import { getDatabase, type DatabaseAdapter } from '@/db';
import { migrateMonitorStorage } from './monitor-migration';

export type SlackNotificationEvent = {
  key: string;
  provider: 'hubspot' | 'salesforce' | 'system';
  title: string;
  summary: string;
  path: string;
};
type DeliveryState = 'sending' | 'delivered' | 'failed' | 'unknown' | 'rate_limited';
export type SlackNotificationStatus = {
  configured: boolean;
  enabled: boolean;
  error: string | null;
  pending: number;
  sending: number;
  delivered: number;
  failed: number;
  unknown: number;
  nextAttemptAt: string | null;
  lastDelivery: {
    state: DeliveryState;
    eventCount: number;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
  } | null;
};

type Configuration = { webhook: string; app: string; error: null } | { webhook: null; app: null; error: string | null };
type EventRow = { event_key: string; provider: SlackNotificationEvent['provider']; title: string; summary: string; path: string };
const LEASE_MS = 60_000;
const MAX_DIGEST_EVENTS = 20;
let schemaPromise: Promise<void> | null = null;

function configuration(): Configuration {
  const webhook = process.env.CONTROL_TOWER_SLACK_WEBHOOK_URL?.trim();
  const app = process.env.CONTROL_TOWER_APP_URL?.trim();
  if (!webhook) return { webhook: null, app: null, error: null };
  if (!app) return { webhook: null, app: null, error: 'Set CONTROL_TOWER_APP_URL to enable Slack links.' };
  try {
    const target = new URL(webhook);
    if (target.protocol !== 'https:' || !['hooks.slack.com', 'hooks.slack-gov.com'].includes(target.hostname)
      || target.port || target.username || target.password || target.search || target.hash
      || !/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(target.pathname)) {
      return { webhook: null, app: null, error: 'Slack requires an HTTPS incoming webhook on hooks.slack.com or hooks.slack-gov.com.' };
    }
    const base = new URL(app);
    const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && localhost)) || base.username || base.password
      || base.search || base.hash || base.pathname !== '/' || app.length > 500) {
      return { webhook: null, app: null, error: 'CONTROL_TOWER_APP_URL must be an HTTPS app origin (HTTP is allowed for localhost).' };
    }
    return { webhook: target.href, app: base.origin, error: null };
  } catch {
    return { webhook: null, app: null, error: 'Slack webhook or app URL configuration is invalid.' };
  }
}

async function database(): Promise<DatabaseAdapter> {
  const db = await getDatabase();
  if (db.kind !== 'sqlite') throw new Error('Slack notifications currently require the self-hosted SQLite runtime.');
  schemaPromise ??= migrateMonitorStorage(db).then(() => db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS slack_notification_events (
      event_key TEXT PRIMARY KEY, provider TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
      path TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', delivery_id TEXT,
      created_at TEXT NOT NULL, finished_at TEXT
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_slack_events_pending ON slack_notification_events(state, created_at)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS slack_notification_deliveries (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, event_count INTEGER NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, error TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS slack_notification_control (
      id INTEGER PRIMARY KEY CHECK (id = 1), lease_id TEXT, lease_expires_at TEXT, next_attempt_at TEXT
    )`),
    db.prepare('INSERT INTO slack_notification_control (id) VALUES (1) ON CONFLICT(id) DO NOTHING'),
  ])).then(() => undefined).catch((error) => { schemaPromise = null; throw error; });
  await schemaPromise;
  return db;
}

/** Callers supply operational counts and labels only, never CRM values or source text. */
export async function enqueueSlackNotification(event: SlackNotificationEvent): Promise<void> {
  // Do not build a retrospective backlog before the operator connects Slack.
  if (!configuration().webhook) return;
  if (!event.key || event.key.length > 500 || !['hubspot', 'salesforce', 'system'].includes(event.provider)
    || !event.title || event.title.length > 120 || !event.summary || event.summary.length > 400
    || !/^\/app(?:\/|\?|$)/.test(event.path) || event.path.length > 500 || /[\\\u0000-\u001f\u007f]/.test(event.path)) {
    throw new Error('Invalid Slack notification event.');
  }
  const db = await database();
  await db.prepare(`INSERT INTO slack_notification_events (event_key, provider, title, summary, path, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING`)
    .bind(event.key, event.provider, event.title, event.summary, event.path, new Date().toISOString()).run();
}

function payload(events: EventRow[], app: string) {
  const labels = { hubspot: 'HubSpot', salesforce: 'Salesforce', system: 'Control Tower' };
  const counts = (['hubspot', 'salesforce', 'system'] as const).map((provider) => {
    const count = events.filter((event) => event.provider === provider).length;
    return count ? `${count} ${labels[provider]}` : '';
  }).filter(Boolean).join(' · ');
  return {
    text: `Control Tower: ${events.length} operations updates (${counts}).`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Control Tower operations', emoji: false } },
      { type: 'section', text: { type: 'plain_text', text: `${events.length} updates · ${counts}`, emoji: false } },
      ...events.flatMap((event) => {
        const url = new URL(event.path, app).href.replaceAll('|', '%7C').replaceAll('<', '%3C').replaceAll('>', '%3E').replaceAll('&', '&amp;');
        return [
          // plain_text prevents source-like strings from becoming mentions or Slack formatting.
          { type: 'section', text: { type: 'plain_text', text: `${labels[event.provider]} · ${event.title}\n${event.summary}`, emoji: false } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `<${url}|Open in Control Tower>` }] },
        ];
      }),
    ],
  };
}

/** At most one digest is attempted per call. A lost response is held, never replayed. */
export async function deliverSlackNotifications(): Promise<SlackNotificationStatus> {
  const { flushIncidentNotifications } = await import('./crm-incidents');
  await flushIncidentNotifications();
  const config = configuration();
  if (!config.webhook) return getSlackNotificationStatus();
  const db = await database();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const claim = await db.prepare(`UPDATE slack_notification_control SET lease_id = ?, lease_expires_at = ?
    WHERE id = 1 AND (lease_id IS NULL OR lease_expires_at <= ?) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    RETURNING id`).bind(id, new Date(Date.now() + LEASE_MS).toISOString(), now, now).first();
  if (!claim) return getSlackNotificationStatus();

  // Any prior sending rows belonged to an expired lease. Slack provides no idempotency key.
  const fence = 'EXISTS (SELECT 1 FROM slack_notification_control WHERE id = 1 AND lease_id = ? AND lease_expires_at > ?)';
  const recoveryTime = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE slack_notification_events SET state = 'unknown', finished_at = ? WHERE state = 'sending' AND ${fence}`).bind(now, id, recoveryTime),
    db.prepare(`UPDATE slack_notification_deliveries SET state = 'unknown', finished_at = ?,
      error = 'Delivery was interrupted; check Slack. This digest will not be resent.' WHERE state = 'sending' AND ${fence}`).bind(now, id, recoveryTime),
  ]);
  const events = (await db.prepare(`SELECT event_key, provider, title, summary, path FROM slack_notification_events
    WHERE state = 'pending' ORDER BY created_at, rowid LIMIT ?`).bind(MAX_DIGEST_EVENTS).all<EventRow>()).results;
  if (!events.length) {
    await db.prepare('UPDATE slack_notification_control SET lease_id = NULL, lease_expires_at = NULL WHERE id = 1 AND lease_id = ?').bind(id).run();
    return getSlackNotificationStatus();
  }
  await db.batch([
    db.prepare(`INSERT INTO slack_notification_deliveries (id, state, event_count, started_at)
      SELECT ?, 'sending', ?, ? WHERE ${fence}`).bind(id, events.length, now, id, now),
    ...events.map((event) => db.prepare(`UPDATE slack_notification_events SET state = 'sending', delivery_id = ?
      WHERE event_key = ? AND state = 'pending' AND ${fence}`).bind(id, event.event_key, id, now)),
    db.prepare(`UPDATE slack_notification_control SET next_attempt_at = ? WHERE id = 1 AND lease_id = ?`)
      .bind(new Date(Date.now() + 1000).toISOString(), id),
  ]);
  const validClaim = await db.prepare(`SELECT id FROM slack_notification_deliveries WHERE id = ? AND state = 'sending' AND ${fence}`)
    .bind(id, id, new Date().toISOString()).first();
  if (!validClaim) return getSlackNotificationStatus();

  let state: Exclude<DeliveryState, 'sending'> = 'unknown';
  let error: string | null = null;
  let nextAttemptAt = new Date(Date.now() + 1000).toISOString();
  try {
    const response = await fetch(config.webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload(events, config.app)), redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 200 && (await response.text()).trim() === 'ok') state = 'delivered';
    else if (response.status === 429) {
      state = 'rate_limited';
      const seconds = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(seconds) && seconds > 0 && seconds < 100_000_000 ? Math.ceil(seconds) : 60;
      nextAttemptAt = new Date(Date.now() + delay * 1000).toISOString();
      error = 'Slack rate limited this digest. It will retry after the requested delay.';
    } else if ([400, 403, 404].includes(response.status)) {
      state = 'failed';
      error = `Slack rejected this digest (HTTP ${response.status}). Check the webhook and channel configuration.`;
    } else {
      error = `Slack returned an uncertain result (HTTP ${response.status}). Check Slack; this digest will not be resent.`;
    }
  } catch {
    // Error strings and Slack response bodies may include webhook secrets; never persist them.
    error = 'Slack delivery outcome is unknown. Check Slack; this digest will not be resent.';
  }
  const finished = new Date().toISOString();
  await db.batch([
    db.prepare(`UPDATE slack_notification_events SET state = ?, finished_at = ?, delivery_id = ?
      WHERE delivery_id = ? AND state = 'sending' AND ${fence}`)
      .bind(state === 'rate_limited' ? 'pending' : state, state === 'rate_limited' ? null : finished, state === 'rate_limited' ? null : id, id, id, finished),
    db.prepare(`UPDATE slack_notification_deliveries SET state = ?, finished_at = ?, error = ?
      WHERE id = ? AND state = 'sending' AND ${fence}`).bind(state, finished, error, id, id, finished),
    db.prepare(`UPDATE slack_notification_control SET lease_id = NULL, lease_expires_at = NULL, next_attempt_at = ?
      WHERE id = 1 AND lease_id = ? AND lease_expires_at > ?`).bind(nextAttemptAt, id, finished),
  ]);
  return getSlackNotificationStatus();
}

export async function getSlackNotificationEventState(key: string): Promise<'pending' | 'sending' | 'delivered' | 'failed' | 'unknown' | null> {
  const db = await database();
  const row = await db.prepare('SELECT state FROM slack_notification_events WHERE event_key = ?').bind(key)
    .first<{ state: 'pending' | 'sending' | 'delivered' | 'failed' | 'unknown' }>();
  return row?.state ?? null;
}

export async function getSlackNotificationStatus(): Promise<SlackNotificationStatus> {
  const config = configuration();
  const db = await database();
  const [counts, last, control] = await Promise.all([
    db.prepare('SELECT state, COUNT(*) AS count FROM slack_notification_events GROUP BY state').all<{ state: string; count: number }>(),
    db.prepare(`SELECT state, event_count, started_at, finished_at, error FROM slack_notification_deliveries ORDER BY started_at DESC, rowid DESC LIMIT 1`)
      .first<{ state: DeliveryState; event_count: number; started_at: string; finished_at: string | null; error: string | null }>(),
    db.prepare('SELECT next_attempt_at FROM slack_notification_control WHERE id = 1').first<{ next_attempt_at: string | null }>(),
  ]);
  const total = Object.fromEntries(counts.results.map((row) => [row.state, row.count]));
  return {
    configured: Boolean(config.webhook), enabled: Boolean(config.webhook), error: config.error,
    pending: total.pending ?? 0, sending: total.sending ?? 0, delivered: total.delivered ?? 0, failed: total.failed ?? 0, unknown: total.unknown ?? 0,
    nextAttemptAt: control?.next_attempt_at ?? null,
    lastDelivery: last ? { state: last.state, eventCount: last.event_count, startedAt: last.started_at, finishedAt: last.finished_at, error: last.error } : null,
  };
}
