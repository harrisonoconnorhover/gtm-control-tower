import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getDatabase, type DatabaseAdapter } from '@/db';
import { monitorAccountScope, type MonitorObjectType, type MonitorObservationSource, type MonitorProvider } from './monitor-types';

export type MonitorNativeEvent = {
  id: string; scope: string; provider: MonitorProvider; objectType: MonitorObjectType;
  recordId: string | null; kind: 'refresh' | 'delete' | 'gap'; occurredAt: string;
  source: MonitorObservationSource & { eventId: string }; reason?: string;
  relatedRecords?: { objectType: MonitorObjectType; id: string }[];
  nativeDetails?: Record<string, string | number | boolean | string[]>;
};
export type MonitorEventStatus = {
  pending: number; held: number; needsReconciliation: boolean; oldestPendingAt: string | null;
  streams: { channel: string; replayId: string | null; receivedAt: string; needsReconciliation: boolean; detail: string | null }[];
};
export class MonitorIntakeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
let schema: Promise<DatabaseAdapter> | undefined;
async function eventDatabase(): Promise<DatabaseAdapter> {
  schema ??= getDatabase().then(async (db) => {
    if (db.kind !== 'sqlite') throw new MonitorIntakeError('Native monitor intake requires self-hosted SQLite.', 503);
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS monitor_native_events (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL, processed_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, held INTEGER NOT NULL DEFAULT 0, error TEXT
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_monitor_native_events_pending ON monitor_native_events(account_id, processed_at, received_at)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS monitor_native_streams (
        account_id TEXT NOT NULL, channel TEXT NOT NULL, replay_id TEXT, received_at TEXT NOT NULL, delivery_id TEXT,
        needs_reconciliation INTEGER NOT NULL DEFAULT 0, detail TEXT, PRIMARY KEY(account_id, channel)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS monitor_native_deliveries (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, channel TEXT NOT NULL, received_at TEXT NOT NULL
      )`),
    ]);
    return db;
  }).catch((error) => { schema = undefined; throw error; });
  return schema;
}

/** Native receivers only save hints. Polling workers re-read current records under the existing lease. */
export async function receiveHubSpotMonitorEvents(request: Request): Promise<{ accepted: number }> {
  const secret = required('HUBSPOT_MONITOR_CLIENT_SECRET');
  const portal = required('HUBSPOT_MONITOR_PORTAL_ID');
  const publicUrl = required('HUBSPOT_MONITOR_WEBHOOK_URL');
  const body = await boundedBody(request);
  verifyHubSpotMonitorSignature(request, body, secret, publicUrl);
  const values = parseJson(body);
  if (!Array.isArray(values) || !values.length || values.length > 100) throw new MonitorIntakeError('Expected 1–100 HubSpot webhook events.');
  const events = values.flatMap((value) => hubspotHints(value, portal));
  if (events.length > 500) throw new MonitorIntakeError('HubSpot batch exceeds 500 affected record hints.');
  const db = await eventDatabase();
  const now = new Date().toISOString();
  await db.batch([
    ...events.map((event) => eventInsert(db, event, now)),
    db.prepare(`INSERT INTO monitor_native_streams(account_id,channel,received_at,needs_reconciliation,detail) VALUES (?,?,?,?,?)
      ON CONFLICT(account_id,channel) DO UPDATE SET received_at=excluded.received_at,
      needs_reconciliation=MAX(monitor_native_streams.needs_reconciliation,excluded.needs_reconciliation),detail=COALESCE(excluded.detail,monitor_native_streams.detail)`)
      .bind(events[0].scope, 'hubspot-webhooks', now, Number(events.some(event => event.kind === 'gap')), events.find(event => event.kind === 'gap')?.reason ?? null),
  ]);
  return { accepted: events.length };
}

function hubspotHints(value: unknown, portal: string): MonitorNativeEvent[] {
  if (!isRecord(value) || String(value.portalId) !== portal) throw new MonitorIntakeError('Webhook account does not match the configured HubSpot account.', 403);
  const types: Record<string, MonitorObjectType> = { contact: 'Contact', company: 'Company', deal: 'Deal' };
  const subscription = boundedString(value.subscriptionType, 80, 'subscription type');
  const [nativeType, family, extra] = subscription.split('.');
  const objectType = types[nativeType];
  if (!objectType || extra || !['creation', 'propertyChange', 'deletion', 'restore', 'associationChange', 'merge'].includes(family)) throw new MonitorIntakeError('Unsupported HubSpot monitor subscription.');
  const occurredAt = timestamp(value.occurredAt);
  const eventId = nativeHubSpotId(value.eventId);
  if (!eventId) throw new MonitorIntakeError('Invalid HubSpot event ID.');
  const scope = monitorAccountScope('hubspot', portal);
  const source: MonitorNativeEvent['source'] = { kind: 'hubspot_webhook', eventId, occurredAt, attribution: 'refresh_trigger_only',
    ...(typeof value.sourceId === 'string' && value.sourceId.startsWith('userId:') ? { actorId: value.sourceId.slice(0, 200) } : {}),
    ...(typeof value.changeSource === 'string' ? { origin: value.changeSource.slice(0, 200) } : {}) };
  const details: NonNullable<MonitorNativeEvent['nativeDetails']> = { subscriptionType: subscription };
  const relatedRecords: NonNullable<MonitorNativeEvent['relatedRecords']> = [];
  const hints: { objectType: MonitorObjectType; recordId: string | null; kind: MonitorNativeEvent['kind']; reason?: string }[] = [];
  if (family === 'associationChange') {
    const associationType = typeof value.associationType === 'string' ? value.associationType.slice(0, 160) : '';
    const match = /^([A-Z_]+)_TO_([A-Z_]+)$/.exec(associationType);
    const fromType = match ? types[match[1].toLowerCase()] : undefined;
    const toType = match ? types[match[2].toLowerCase()] : undefined;
    const from = nativeHubSpotId(value.fromObjectId); const to = nativeHubSpotId(value.toObjectId);
    details.associationType = associationType;
    if (from) details.fromObjectId = from;
    if (to) details.toObjectId = to;
    if (typeof value.associationRemoved === 'boolean') details.associationRemoved = value.associationRemoved;
    if (typeof value.isPrimaryAssociation === 'boolean') details.isPrimaryAssociation = value.isPrimaryAssociation;
    if (fromType && from) relatedRecords.push({ objectType: fromType, id: from });
    if (toType && to && !relatedRecords.some(record => record.objectType === toType && record.id === to)) relatedRecords.push({ objectType: toType, id: to });
    for (const record of relatedRecords) hints.push({ objectType: record.objectType, recordId: record.id, kind: 'refresh' });
    if (!fromType || !toType || !from || !to || typeof value.associationRemoved !== 'boolean') hints.push({ objectType, recordId: null, kind: 'gap', reason: 'HubSpot association change has incomplete or out-of-scope endpoint evidence. A full baseline is required; no relationship is inferred.' });
    source.reportedValues = Object.fromEntries(Object.entries(details).filter(([, field]) => !Array.isArray(field))) as Record<string,string|number|boolean>;
  } else if (family === 'merge') {
    const primary = nativeHubSpotId(value.primaryObjectId);
    const replacement = nativeHubSpotId(value.newObjectId);
    const hasReplacement = value.newObjectId !== undefined && value.newObjectId !== null;
    const mergedInput = Array.isArray(value.mergedObjectIds) ? value.mergedObjectIds : [];
    const merged = [...new Set(mergedInput.slice(0, 100).map(nativeHubSpotId).filter((id): id is string => id !== null))].sort();
    if (primary) details.primaryObjectId = primary;
    if (replacement) details.newObjectId = replacement;
    details.mergedObjectIds = merged;
    details.mergedObjectCount = mergedInput.length;
    if (mergedInput.length > 100 || mergedInput.some(id => nativeHubSpotId(id) === null)) details.truncated = true;
    if (typeof value.numberOfPropertiesMoved === 'number' && Number.isSafeInteger(value.numberOfPropertiesMoved) && value.numberOfPropertiesMoved >= 0) details.numberOfPropertiesMoved = value.numberOfPropertiesMoved;
    const survivor = hasReplacement ? replacement : primary;
    for (const id of [...new Set([survivor, primary, ...merged].filter((id): id is string => id !== null))].slice(0, 100)) relatedRecords.push({ objectType, id });
    if (survivor) hints.push({ objectType, recordId: survivor, kind: 'refresh' });
    // Old IDs may redirect to the survivor. Never rebind existing findings or repair authority automatically.
    hints.push({ objectType, recordId: null, kind: 'gap', reason: survivor
      ? 'HubSpot reported a merge. Refreshing the reported survivor and reconciling affected relationships; old record identities and saved repairs are not remapped automatically.'
      : 'HubSpot merge survivor is ambiguous. A full baseline and human identity review are required; no old record is treated as the survivor.' });
    Object.assign(source, reportedValues({ ...details, mergedObjectIds: JSON.stringify(merged) }));
  } else {
    const recordId = nativeHubSpotId(value.objectId);
    if (!recordId) throw new MonitorIntakeError('Invalid HubSpot record ID.');
    hints.push({ objectType, recordId, kind: family === 'deletion' ? 'delete' : 'refresh' });
    Object.assign(source, reportedValues(typeof value.propertyName === 'string' ? { [value.propertyName]: value.propertyValue } : {}));
    if (typeof value.propertyName === 'string') source.changedFields = [value.propertyName.slice(0, 200)];
  }
  return hints.map((hint) => ({ ...hint, id: hash(['hubspot', portal, eventId, String(value.subscriptionId), subscription, occurredAt,
    hint.objectType, hint.recordId, hint.kind, details, source.reportedValues,
    hash([value.propertyName, value.propertyValue, value.fromObjectId, value.toObjectId, value.primaryObjectId, value.newObjectId, value.mergedObjectIds])]), scope, provider: 'hubspot', occurredAt, source,
    ...(relatedRecords.length ? { relatedRecords } : {}), ...(family === 'merge' || family === 'associationChange' ? { nativeDetails: details } : {}) }));
}
function nativeHubSpotId(value: unknown): string | null {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  return (typeof value === 'number' || typeof value === 'string') && /^\d{1,30}$/.test(String(value)) ? String(value) : null;
}

export function verifyHubSpotMonitorSignature(request: Request, body: string, secret: string, publicUrl: string): void {
  const configured = new URL(publicUrl);
  if (configured.protocol !== 'https:' || configured.username || configured.password || configured.hash || configured.pathname !== new URL(request.url).pathname) throw new MonitorIntakeError('Set the exact public HTTPS webhook URL.', 503);
  const stamp = request.headers.get('x-hubspot-request-timestamp') ?? '';
  verifyTimestamp(stamp);
  // Use the pinned external URL, not proxy-controlled Host/X-Forwarded-* headers.
  const uri = publicUrl.replace(/%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi, (value) => decodeURIComponent(value));
  const expected = createHmac('sha256', secret).update(`${request.method}${uri}${body}${stamp}`).digest('base64');
  if (!constantEquals(expected, request.headers.get('x-hubspot-signature-v3') ?? '')) throw new MonitorIntakeError('Invalid HubSpot webhook signature.', 401);
}

/** Trusted relay protocol: one ordered decoded Pub/Sub envelope, opaque replay IDs, explicit gaps. */
export async function receiveSalesforceMonitorEvents(request: Request): Promise<{ accepted: number; replayId: string; needsReconciliation: boolean }> {
  const secret = required('CONTROL_TOWER_CDC_RELAY_SECRET');
  if (secret.length < 32) throw new MonitorIntakeError('Use a CDC relay secret of at least 32 characters.', 503);
  const organizationId = required('SALESFORCE_MONITOR_ORG_ID');
  const body = await boundedBody(request);
  const stamp = request.headers.get('x-control-tower-timestamp') ?? '';
  verifyTimestamp(stamp);
  const path = new URL(request.url).pathname;
  const expected = createHmac('sha256', secret).update(`${stamp}\nPOST\n${path}\n${body}`).digest('hex');
  if (!constantEquals(expected, request.headers.get('x-control-tower-signature') ?? '')) throw new MonitorIntakeError('Invalid Salesforce relay signature.', 401);
  const value = parseJson(body);
  if (!isRecord(value) || value.organizationId !== organizationId || !/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(organizationId)) throw new MonitorIntakeError('Relay organization does not match the configured Salesforce organization.', 403);
  const channel = boundedString(value.channel, 100, 'channel');
  if (!/^\/data\/(?:ChangeEvents|(?:Lead|Contact|Account|Opportunity)ChangeEvent)$/.test(channel)) throw new MonitorIntakeError('Unsupported Salesforce CDC channel.');
  const replayId = boundedString(value.replayId, 512, 'opaque replay ID');
  const previousReplayId = value.previousReplayId === null ? null : boundedString(value.previousReplayId, 512, 'previous replay ID');
  if (!Array.isArray(value.events) || value.events.length > 100) throw new MonitorIntakeError('Expected at most 100 decoded CDC payloads.');
  const explicitGap = value.gapReason === undefined ? null : boundedString(value.gapReason, 500, 'gap reason');
  if (!value.events.length && !explicitGap) throw new MonitorIntakeError('An empty CDC envelope must report a replay gap.');
  const scope = monitorAccountScope('salesforce', organizationId);
  const events: MonitorNativeEvent[] = [];
  for (const payload of value.events) {
    if (!isRecord(payload) || !isRecord(payload.ChangeEventHeader)) throw new MonitorIntakeError('Expected decoded ChangeEventHeader.');
    const header = payload.ChangeEventHeader;
    const type = boundedString(header.entityName, 30, 'entity');
    if (!['Lead', 'Contact', 'Account', 'Opportunity'].includes(type)) throw new MonitorIntakeError('Unsupported Salesforce CDC entity.');
    const objectType = type as MonitorObjectType;
    const changeType = boundedString(header.changeType, 30, 'change type');
    if (!['CREATE', 'UPDATE', 'DELETE', 'UNDELETE', 'GAP_CREATE', 'GAP_UPDATE', 'GAP_DELETE', 'GAP_UNDELETE', 'GAP_OVERFLOW'].includes(changeType)) throw new MonitorIntakeError('Unsupported Salesforce CDC change type.');
    const occurredAt = timestamp(header.commitTimestamp);
    const ids = header.recordIds;
    if (!Array.isArray(ids) || ids.length > 200 || (!ids.length && !changeType.startsWith('GAP_'))) throw new MonitorIntakeError('Invalid CDC record list.');
    const gap = changeType.startsWith('GAP_') || ids.some((id) => typeof id === 'string' && id.endsWith('*'));
    const transactionId = boundedString(header.transactionKey, 200, 'transaction key');
    const sequence = Number(header.sequenceNumber);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new MonitorIntakeError('Invalid CDC transaction sequence.');
    const eventId = `${transactionId}:${sequence}:${type}`;
    const source: MonitorNativeEvent['source'] = { kind: 'salesforce_cdc', eventId, occurredAt, transactionId, attribution: 'refresh_trigger_only', ...reportedValues(payload),
      ...(typeof header.commitUser === 'string' ? { actorId: header.commitUser.slice(0, 200) } : {}),
      ...(typeof header.changeOrigin === 'string' ? { origin: header.changeOrigin.slice(0, 200) } : {}),
      ...(Array.isArray(header.changedFields) && header.changedFields.every((field) => typeof field === 'string' && !field.startsWith('0x')) ? { changedFields: header.changedFields.slice(0, 200) as string[] } : {}) };
    if (gap) events.push({ id: hash([scope, channel, eventId, changeType]), scope, provider: 'salesforce', objectType, recordId: null, kind: 'gap', occurredAt, source, reason: `Salesforce ${changeType}; current-state reconciliation is required. Intermediate changes are unavailable.` });
    else for (const record of ids) {
      const prefix = { Lead: '00Q', Contact: '003', Account: '001', Opportunity: '006' }[type as 'Lead' | 'Contact' | 'Account' | 'Opportunity'];
      if (typeof record !== 'string' || !new RegExp(`^${prefix}[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$`).test(record)) throw new MonitorIntakeError('CDC record ID does not match its entity.');
      events.push({ id: hash([scope, channel, eventId, changeType, record]), scope, provider: 'salesforce', objectType, recordId: record, kind: changeType === 'DELETE' ? 'delete' : 'refresh', occurredAt, source });
    }
  }
  if (events.length > 500) throw new MonitorIntakeError('CDC envelope exceeds 500 affected records; split the relay batch.');
  const db = await eventDatabase();
  const deliveryId = hash([scope, channel, replayId, body]);
  const oldDelivery = await db.prepare('SELECT id FROM monitor_native_deliveries WHERE id=?').bind(deliveryId).first();
  const checkpoint = await db.prepare('SELECT replay_id, received_at, needs_reconciliation, delivery_id FROM monitor_native_streams WHERE account_id=? AND channel=?').bind(scope, channel)
    .first<{ replay_id: string | null; received_at: string; needs_reconciliation: number; delivery_id: string | null }>();
  if (oldDelivery) return { accepted: 0, replayId: checkpoint?.replay_id ?? replayId, needsReconciliation: Boolean(checkpoint?.needs_reconciliation) };
  if ((checkpoint?.replay_id ?? null) !== previousReplayId && !explicitGap) throw new MonitorIntakeError('CDC checkpoint differs. Resume from the saved replay ID or submit an explicit replay-gap envelope.', 409);
  const stale = checkpoint && Date.now() - Date.parse(checkpoint.received_at) > 72 * 60 * 60 * 1000;
  const gapReason = explicitGap ?? (stale ? 'Subscriber resumed beyond the 72-hour retention window; intermediate changes may be unavailable.' : null);
  if (gapReason) events.push({ id: hash([deliveryId, 'gap']), scope, provider: 'salesforce', objectType: 'Account', recordId: null, kind: 'gap', occurredAt: new Date().toISOString(), source: { kind: 'salesforce_cdc', eventId: deliveryId }, reason: gapReason });
  const needsReconciliation = Boolean(checkpoint?.needs_reconciliation || gapReason || events.some((event) => event.kind === 'gap'));
  const now = new Date().toISOString();
  // Compare-and-swap the opaque checkpoint and all hints in one SQLite transaction.
  // Every insert is fenced by this delivery; concurrent handlers cannot regress the cursor.
  const results = await db.batch([
    db.prepare(`INSERT INTO monitor_native_streams(account_id,channel,replay_id,received_at,needs_reconciliation,detail,delivery_id) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(account_id,channel) DO UPDATE SET replay_id=excluded.replay_id,received_at=excluded.received_at,
        needs_reconciliation=excluded.needs_reconciliation,detail=COALESCE(excluded.detail,monitor_native_streams.detail),delivery_id=excluded.delivery_id
      WHERE monitor_native_streams.replay_id IS ? AND monitor_native_streams.delivery_id IS ?`)
      .bind(scope, channel, replayId, now, Number(needsReconciliation), gapReason ?? (events.some((event) => event.kind === 'gap') ? 'Native CDC gap requires reconciliation.' : null), deliveryId,
        checkpoint?.replay_id ?? null, checkpoint?.delivery_id ?? null),
    ...events.map((event) => db.prepare(`INSERT INTO monitor_native_events(id,account_id,payload_json,received_at)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM monitor_native_streams WHERE account_id=? AND channel=? AND delivery_id=?) ON CONFLICT(id) DO NOTHING`)
      .bind(event.id, scope, JSON.stringify(event), now, scope, channel, deliveryId)),
    db.prepare(`INSERT INTO monitor_native_deliveries(id,account_id,channel,received_at)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM monitor_native_streams WHERE account_id=? AND channel=? AND delivery_id=?) ON CONFLICT(id) DO NOTHING`)
      .bind(deliveryId, scope, channel, now, scope, channel, deliveryId),
  ]);
  if (!(results[0] as { changes: number }).changes) throw new MonitorIntakeError('CDC checkpoint advanced concurrently; reconcile the response before retrying.', 409);
  return { accepted: events.length, replayId, needsReconciliation };
}

export async function takePendingMonitorEvents(scope: string, limit = 10): Promise<MonitorNativeEvent[]> {
  const db = await eventDatabase();
  const rows = await db.prepare('SELECT payload_json FROM monitor_native_events WHERE account_id=? AND processed_at IS NULL AND held=0 AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY received_at,id LIMIT ?').bind(scope, new Date().toISOString(), Math.max(1, Math.min(50, limit))).all<{ payload_json: string }>();
  return rows.results.map((row) => JSON.parse(row.payload_json) as MonitorNativeEvent);
}
export async function markMonitorEventProcessed(scope: string, id: string): Promise<void> {
  const db = await eventDatabase();
  await db.prepare('UPDATE monitor_native_events SET processed_at=? WHERE account_id=? AND id=? AND processed_at IS NULL').bind(new Date().toISOString(), scope, id).run();
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await db.batch([
    db.prepare('DELETE FROM monitor_native_events WHERE account_id=? AND processed_at IS NOT NULL AND received_at<?').bind(scope, cutoff),
    db.prepare(`DELETE FROM monitor_native_events WHERE id IN (SELECT id FROM monitor_native_events
      WHERE account_id=? AND processed_at IS NOT NULL ORDER BY received_at DESC,id DESC LIMIT -1 OFFSET 10000)`).bind(scope),
    db.prepare('DELETE FROM monitor_native_deliveries WHERE account_id=? AND received_at<?').bind(scope, cutoff),
  ]);
}
export async function markMonitorEventFailed(scope: string, id: string, error: string): Promise<void> {
  const db = await eventDatabase();
  await db.prepare(`UPDATE monitor_native_events SET attempts=attempts+1, held=CASE WHEN attempts>=2 THEN 1 ELSE 0 END,
    next_attempt_at=?,error=? WHERE account_id=? AND id=? AND processed_at IS NULL`)
    .bind(new Date(Date.now() + 60_000).toISOString(), error.slice(0, 500), scope, id).run();
}
/** Explicit operator retry after resolving the underlying read/permission failure. */
export async function retryHeldMonitorEvents(scope: string): Promise<void> {
  const db = await eventDatabase();
  await db.prepare('UPDATE monitor_native_events SET attempts=0,held=0,next_attempt_at=NULL,error=NULL WHERE account_id=? AND processed_at IS NULL AND held=1').bind(scope).run();
}
export async function markMonitorEventsReconciled(scope: string, baselineStartedAt = new Date().toISOString()): Promise<void> {
  const db = await eventDatabase();
  await db.prepare('UPDATE monitor_native_streams SET needs_reconciliation=0 WHERE account_id=? AND received_at<=?').bind(scope, baselineStartedAt).run();
}
export async function getMonitorEventStatus(scope: string): Promise<MonitorEventStatus> {
  const db = await eventDatabase();
  const count = await db.prepare('SELECT COUNT(*) AS count, SUM(held) AS held, MIN(received_at) AS oldest FROM monitor_native_events WHERE account_id=? AND processed_at IS NULL').bind(scope).first<{ count: number; held: number | null; oldest: string | null }>();
  const rows = await db.prepare('SELECT channel,replay_id,received_at,needs_reconciliation,detail FROM monitor_native_streams WHERE account_id=?').bind(scope)
    .all<{ channel: string; replay_id: string | null; received_at: string; needs_reconciliation: number; detail: string | null }>();
  return { pending: count?.count ?? 0, held: count?.held ?? 0, needsReconciliation: rows.results.some((row) => Boolean(row.needs_reconciliation)), oldestPendingAt: count?.oldest ?? null, streams: rows.results.map((row) => ({ channel: row.channel, replayId: row.replay_id, receivedAt: row.received_at, needsReconciliation: Boolean(row.needs_reconciliation), detail: row.detail })) };
}
/** Bounded raw event evidence, separate from independently observed before/after state. */
export async function getRecentMonitorEvents(scope: string, recordKeys: string[], limit = 50): Promise<(MonitorNativeEvent & { receivedAt: string; processedAt: string | null })[]> {
  if (!recordKeys.length) return [];
  const keys = [...new Set(recordKeys)].slice(0, 100);
  const db = await eventDatabase();
  const rows = await db.prepare(`SELECT payload_json,received_at,processed_at FROM monitor_native_events WHERE account_id=?
    AND (CASE WHEN json_extract(payload_json,'$.provider')='hubspot' AND json_extract(payload_json,'$.objectType')='Contact'
      THEN json_extract(payload_json,'$.recordId') ELSE json_extract(payload_json,'$.objectType')||':'||json_extract(payload_json,'$.recordId') END)
      IN (${keys.map(() => '?').join(',')}) OR account_id=? AND EXISTS (SELECT 1 FROM json_each(payload_json,'$.relatedRecords') related
        WHERE (CASE WHEN json_extract(payload_json,'$.provider')='hubspot' AND json_extract(related.value,'$.objectType')='Contact'
          THEN json_extract(related.value,'$.id') ELSE json_extract(related.value,'$.objectType')||':'||json_extract(related.value,'$.id') END)
          IN (${keys.map(() => '?').join(',')})) ORDER BY received_at DESC,id DESC LIMIT ?`).bind(scope, ...keys, scope, ...keys, Math.max(1,Math.min(100,limit)))
    .all<{payload_json:string;received_at:string;processed_at:string|null}>();
  return rows.results.map(row=>({...JSON.parse(row.payload_json) as MonitorNativeEvent,receivedAt:row.received_at,processedAt:row.processed_at}));
}
function reportedValues(value: Record<string, unknown>): Pick<MonitorObservationSource,'reportedValues'|'reportedValuesTruncated'> {
  const result: Record<string, string | number | boolean | null> = {};
  let remaining = 8000; let truncated = false;
  for (const [key, field] of Object.entries(value)) {
    if (key === 'ChangeEventHeader') continue;
    if (Object.keys(result).length >= 60 || remaining <= 0 || key.length > 200) { truncated = true; continue; }
    if (field === null || typeof field === 'boolean' || typeof field === 'number' && Number.isFinite(field)) result[key] = field;
    else if (typeof field === 'string') { result[key] = field.slice(0, Math.min(1000,remaining)); remaining -= String(result[key]).length; if (result[key] !== field) truncated = true; }
    else if (field !== undefined) truncated = true;
  }
  return { reportedValues: result, ...(truncated ? { reportedValuesTruncated: true } : {}) };
}
function eventInsert(db: DatabaseAdapter, event: MonitorNativeEvent, now: string) {
  return db.prepare('INSERT INTO monitor_native_events(id,account_id,payload_json,received_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(event.id, event.scope, JSON.stringify(event), now);
}
async function boundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) throw new MonitorIntakeError('A request body is required.');
  const parts: Uint8Array[] = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length;
    if (length > 1_048_576) { await reader.cancel(); throw new MonitorIntakeError('Native event body exceeds 1 MiB.', 413); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}
function verifyTimestamp(value: string): void {
  if (!/^\d{13}$/.test(value) || Math.abs(Date.now() - Number(value)) > 300_000) throw new MonitorIntakeError('Missing or expired event signature timestamp.', 401);
}
function constantEquals(a: string, b: string): boolean { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function required(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new MonitorIntakeError('Native event intake is not configured.', 503); return value; }
function parseJson(body: string): unknown { try { return JSON.parse(body); } catch { throw new MonitorIntakeError('Invalid event JSON.'); } }
function boundedString(value: unknown, max: number, label: string): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MonitorIntakeError(`Invalid ${label}.`); return value; }
function timestamp(value: unknown): string { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) throw new MonitorIntakeError('Invalid native event timestamp.'); return new Date(value).toISOString(); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
