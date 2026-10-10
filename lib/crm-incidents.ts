import { getDatabase, type DatabaseAdapter, type PreparedQuery } from '@/db';
import { monitorAccountIdentity, monitorRecordKey, type MonitorCapability, type MonitorContact, type MonitorObjectType } from './monitor-types';
import { getRecentMonitorEvents, type MonitorNativeEvent } from './monitor-events';
import { enqueueSlackNotification, type SlackNotificationEvent } from './slack-notifications';

export type IncidentKind = 'mass_field_clearing' | 'value_reversal' | 'expectation' | 'relationship' | 'coverage' | 'repair_pause' | 'activity_drop' | 'invalid_value' | 'duplicate_candidate';
export type IncidentResolution = 'intentional_change' | 'broken_integration' | 'incorrect_expectation' | 'resolved_upstream' | 'inconclusive';
export type IncidentPolicy = {
  version: number;
  windowMinutes: number;
  minimumRecords: number;
  clearingFraction: number;
  reversalsBeforePause: number;
  repairLimitPerHour: number;
  repairsPerRecordPerDay: number;
  retentionDays: number;
  maxObservations: number;
  expectations: { id: string; objectType: MonitorObjectType; whenField: string; whenValues: string[]; requiredField: string; deadlineMinutes: number }[];
  relationships: { id: string; objectType: MonitorObjectType; field: string; targetType: MonitorObjectType; required: boolean }[];
  plannedChanges: { id: string; objectType: MonitorObjectType; fields: string[]; until: string; reason: string }[];
  disallowNegativeAmounts: boolean;
  activity: { enabled: boolean; minimumPreviousRecords: number; quietMinutes: number };
};
export const DEFAULT_INCIDENT_POLICY: IncidentPolicy = {
  version: 1, windowMinutes: 30, minimumRecords: 10, clearingFraction: 0.2, reversalsBeforePause: 3,
  repairLimitPerHour: 50, repairsPerRecordPerDay: 2, retentionDays: 30, maxObservations: 50_000,
  expectations: [], relationships: [], plannedChanges: [], disallowNegativeAmounts: false, activity: { enabled: false, minimumPreviousRecords: 20, quietMinutes: 60 },
};
export type Incident = {
  id: string; accountId: string; kind: IncidentKind; objectType: string; field: string;
  title: string; severity: 'warning' | 'critical'; status: 'open' | 'investigating' | 'resolved';
  firstSeenAt: string; lastSeenAt: string; affectedRecords: number; policyVersion: number; version: number;
  assignee: string; note: string; resolution: IncidentResolution | null; resolvedAt: string | null;
  evidence: Record<string, unknown>;
};
export type IncidentObservation = {
  id: string; recordKey: string; objectType: string; recordId: string; observedAt: string; providerUpdatedAt: string;
  phase: 'baseline' | 'changes'; changes: { field: string; before: string; after: string }[];
  source: Record<string, unknown>; suppressed: string[];
};
export type IncidentDetail = Incident & { timeline: { at: string; event: string; detail: string }[]; observations: IncidentObservation[]; records: string[] };
export type IncidentCoverage = {
  status: 'unknown' | 'healthy' | 'degraded' | 'stale' | 'baseline'; phase: 'baseline' | 'changes'; lastCheckedAt: string | null; baselineStartedAt: string | null; lastSuccessAt: string | null; staleAfterSeconds: number;
  lastChangedAt: string | null; scanned: number; error: string | null; objectTypes: string[]; capabilities?:MonitorCapability[]; limitations: string[];
};
type IncidentRow = { id: string; account_id: string; fingerprint: string; kind: IncidentKind; object_type: string; field: string; title: string; severity: Incident['severity']; status: Incident['status']; first_seen_at: string; last_seen_at: string; policy_version: number; version: number; assignee: string; note: string; resolution: IncidentResolution | null; resolved_at: string | null; evidence_json: string; affected_records: number };
type ObservationRow = { id: string; record_key: string; object_type: string; record_id: string; observed_at: string; provider_updated_at: string; phase: 'baseline' | 'changes'; changes_json: string; source_json: string; suppressed_json: string };
let schema: Promise<void> | null = null;
const accountQueues = new Map<string, Promise<unknown>>();

/** SQLite transactions protect evidence and notification intent together. Source observations are data, never instructions. */
export async function incidentDatabase(): Promise<DatabaseAdapter> {
  const db = await getDatabase();
  if (db.kind !== 'sqlite') throw new Error('Incident operations require the self-hosted SQLite runtime.');
  schema ??= db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_incident_policies (account_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, version INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_incident_policy_history (account_id TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL, changed_at TEXT NOT NULL, PRIMARY KEY(account_id, version))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_observed_records (account_id TEXT NOT NULL, record_key TEXT NOT NULL, object_type TEXT NOT NULL, record_id TEXT NOT NULL, provider_updated_at TEXT NOT NULL, observed_at TEXT NOT NULL, first_seen_at TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(account_id, record_key))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_observations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, record_key TEXT NOT NULL, object_type TEXT NOT NULL, record_id TEXT NOT NULL, observed_at TEXT NOT NULL, provider_updated_at TEXT NOT NULL, phase TEXT NOT NULL, changes_json TEXT NOT NULL, source_json TEXT NOT NULL, suppressed_json TEXT NOT NULL, UNIQUE(account_id,record_key,provider_updated_at,id))`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_crm_observations_record ON crm_observations(account_id,record_key,observed_at)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_crm_observations_window ON crm_observations(account_id,object_type,observed_at)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_incidents (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, object_type TEXT NOT NULL, field TEXT NOT NULL, title TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, policy_version INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, assignee TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', resolution TEXT, resolved_at TEXT, evidence_json TEXT NOT NULL, UNIQUE(account_id,fingerprint))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_incident_records (incident_id TEXT NOT NULL, record_key TEXT NOT NULL, PRIMARY KEY(incident_id,record_key))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_incident_resolutions (id TEXT PRIMARY KEY,account_id TEXT NOT NULL,incident_id TEXT NOT NULL,resolved_at TEXT NOT NULL,payload_json TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_incident_timeline (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_native_reversal_checks (account_id TEXT NOT NULL,record_key TEXT NOT NULL,field TEXT NOT NULL,evidence_key TEXT NOT NULL,PRIMARY KEY(account_id,record_key,field))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_incident_rechecks (account_id TEXT PRIMARY KEY,cursor TEXT NOT NULL DEFAULT '',since TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_expectation_checks (account_id TEXT NOT NULL,record_key TEXT NOT NULL,checked_at TEXT NOT NULL,PRIMARY KEY(account_id,record_key))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_expectation_clocks (account_id TEXT NOT NULL,record_key TEXT NOT NULL,rule_id TEXT NOT NULL,since TEXT NOT NULL,PRIMARY KEY(account_id,record_key,rule_id))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_incident_coverage (account_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS crm_repair_control (account_id TEXT PRIMARY KEY, paused_at TEXT, reason TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS operation_notification_outbox (event_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, dispatched_at TEXT)`),
  ]).then(() => undefined).catch((error) => { schema = null; throw error; });
  await schema;
  return db;
}

export function notificationIntent(db: DatabaseAdapter, event: SlackNotificationEvent, guard = '1 = 1', values: unknown[] = []): PreparedQuery {
  return db.prepare(`INSERT INTO operation_notification_outbox (event_key,payload_json,created_at) SELECT ?,?,? WHERE ${guard} ON CONFLICT(event_key) DO NOTHING`)
    .bind(event.key, JSON.stringify(event), new Date().toISOString(), ...values);
}

/** A failed queue insertion leaves durable intent for the next tick. Slack's key makes a crash after insertion safe. */
export async function flushIncidentNotifications(): Promise<void> {
  const db = await incidentDatabase();
  const rows = (await db.prepare('SELECT event_key,payload_json FROM operation_notification_outbox WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 100').all<{ event_key: string; payload_json: string }>()).results;
  for (const row of rows) {
    await enqueueSlackNotification(JSON.parse(row.payload_json) as SlackNotificationEvent);
    await db.prepare('UPDATE operation_notification_outbox SET dispatched_at = ? WHERE event_key = ?').bind(new Date().toISOString(), row.event_key).run();
  }
  await db.prepare('DELETE FROM operation_notification_outbox WHERE dispatched_at < ?').bind(new Date(Date.now() - 30 * 86_400_000).toISOString()).run();
}

export async function getIncidentPolicy(accountId: string): Promise<IncidentPolicy> {
  validateScope(accountId);
  const db = await incidentDatabase();
  await db.prepare('INSERT INTO crm_incident_policies (account_id,payload_json,version) VALUES (?,?,1) ON CONFLICT(account_id) DO NOTHING').bind(accountId, JSON.stringify(DEFAULT_INCIDENT_POLICY)).run();
  const row = (await db.prepare('SELECT payload_json FROM crm_incident_policies WHERE account_id = ?').bind(accountId).first<{ payload_json: string }>() )!;
  return JSON.parse(row.payload_json) as IncidentPolicy;
}

export async function configureIncidentPolicy(accountId: string, policy: IncidentPolicy, expectedVersion = policy.version): Promise<IncidentPolicy> {
  const previous = await getIncidentPolicy(accountId);
  validatePolicy(policy);
  if (previous.version !== expectedVersion) throw new Error('Incident policy changed. Reload before saving.');
  const next = { ...policy, version: previous.version + 1 };
  const db = await incidentDatabase();
  await db.batch([
    db.prepare('INSERT INTO crm_incident_policy_history (account_id,version,payload_json,changed_at) SELECT account_id,version,payload_json,? FROM crm_incident_policies WHERE account_id = ? AND version = ? ON CONFLICT DO NOTHING').bind(new Date().toISOString(), accountId, expectedVersion),
    db.prepare('UPDATE crm_incident_policies SET payload_json = ?,version = ? WHERE account_id = ? AND version = ?').bind(JSON.stringify(next), next.version, accountId, expectedVersion),
  ]);
  const saved = await getIncidentPolicy(accountId);
  if (JSON.stringify(saved) !== JSON.stringify(next)) throw new Error('Incident policy changed. Reload before saving.');
  await queueIncidentRecheck(accountId);
  return saved;
}

function serialized<T>(scope: string, work: () => Promise<T>): Promise<T> {
  const previous = accountQueues.get(scope) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  accountQueues.set(scope, current);
  void current.finally(() => { if (accountQueues.get(scope) === current) accountQueues.delete(scope); }).catch(() => undefined);
  return current;
}

export async function ingestObservation(accountId: string, record: MonitorContact, options: { phase: 'baseline' | 'changes'; observedAt?: string; source?: Record<string, unknown>; leaseId?: string; cached?:boolean } = { phase: 'changes' }): Promise<{ accepted: boolean; changedFields: number; incidents: string[]; reason?: string }> {
  return serialized(accountId, async () => {
    validateScope(accountId);
    const identity = monitorAccountIdentity(accountId);
    if ((record.provider ?? 'hubspot') !== identity.provider || !record.id || record.id.length > 200 || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error('Observation has an invalid provider, record identity, or timestamp.');
    record = {...record,updatedAt:new Date(record.updatedAt).toISOString()};
    const now = options.observedAt ? new Date(options.observedAt).toISOString() : new Date().toISOString();
    if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid observation time.');
    const db = await incidentDatabase();
    const policy = await getIncidentPolicy(accountId);
    const key = monitorRecordKey(record);
    const objectType = record.objectType ?? 'Contact';
    const previous = await db.prepare('SELECT * FROM crm_observed_records WHERE account_id = ? AND record_key = ?').bind(accountId, key).first<{ provider_updated_at: string; payload_json: string; first_seen_at: string }>();
    const before = previous ? JSON.parse(previous.payload_json) as MonitorContact : null;
    if (previous && Date.parse(previous.provider_updated_at) > Date.parse(record.updatedAt)) return { accepted: false, changedFields: 0, incidents: [], reason: 'out_of_order' };
    const properties = Object.keys(record.properties).sort();
    const added = before ? properties.filter(field=>!(field in before.properties)) : [];
    const changed = before ? properties.filter((field) => field in before.properties && before.properties[field] !== record.properties[field]).map((field) => ({ field, before: before.properties[field] ?? '', after: record.properties[field] })) : [];
    // Missing requested properties are coverage loss, never evidence that a value became blank.
    const absent = before ? Object.keys(before.properties).filter((field) => !(field in record.properties)) : [];
    const duplicate = Boolean(before && !changed.length && !absent.length && !added.length && previous!.provider_updated_at === record.updatedAt);
    const observationId = await digest(`${accountId}\n${key}\n${record.updatedAt}\n${JSON.stringify(properties.map((field) => [field,record.properties[field]]))}`);
    const alreadySeen = await db.prepare('SELECT id FROM crm_observations WHERE id = ?').bind(observationId).first();
    if (alreadySeen && !duplicate) return { accepted: false, changedFields: 0, incidents: [], reason: 'duplicate' };
    if(previous&&previous.provider_updated_at===record.updatedAt&&changed.length) {
      const id=await digest(`ordering:${observationId}`);
      const prepared=await incidentStatements(db,accountId,{kind:'coverage',objectType,field:'timestamp_order',records:[key],title:'Conflicting values have the same native timestamp',severity:'warning',evidence:{recordKey:key,providerUpdatedAt:record.updatedAt,possibleChanges:changed,limitation:'The order of these values is uncertain. The saved record and repair evidence are unchanged until a newer native version is observed.'}},policy,now);
      await db.batch([
        db.prepare('INSERT INTO crm_observations(id,account_id,record_key,object_type,record_id,observed_at,provider_updated_at,phase,changes_json,source_json,suppressed_json) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING').bind(id,accountId,key,objectType,record.id,now,record.updatedAt,options.phase,'[]',JSON.stringify({...options.source,...record.source,kind:record.source?.kind??'poll',ordering:'ambiguous',possibleChanges:changed}),'[]'),
        ...prepared.statements,
      ]);
      await pruneObservations(db,accountId,policy,now);
      return {accepted:false,changedFields:0,incidents:[prepared.id],reason:'ambiguous_timestamp'};
    }
    const suppressed = changed.filter((change) => policy.plannedChanges.some((plan) => plan.objectType === objectType && plan.fields.includes(change.field) && plan.until > now)).map((change) => change.field);
    const changes = changed.filter((change) => !['lastmodifieddate','updatedAt','hs_lastmodifieddate','LastModifiedDate'].includes(change.field));
    const source = options.source ?? ('source' in record ? record.source as Record<string, unknown> : undefined) ?? { kind: 'poll' };
    const statements: PreparedQuery[] = [];
    const guard = options.leaseId ? 'EXISTS (SELECT 1 FROM monitor_accounts WHERE account_id = ? AND lease_id = ? AND lease_expires_at > ?)' : '1 = 1';
    const guardValues = options.leaseId ? [accountId, options.leaseId, new Date().toISOString()] : [];
    if (!duplicate && !alreadySeen) {
      statements.push(db.prepare(`INSERT INTO crm_observations (id,account_id,record_key,object_type,record_id,observed_at,provider_updated_at,phase,changes_json,source_json,suppressed_json) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT DO NOTHING`)
        .bind(observationId, accountId,key,objectType,record.id,now,record.updatedAt,options.phase,JSON.stringify(changes),JSON.stringify(source),JSON.stringify(suppressed),...guardValues));
      statements.push(db.prepare(`INSERT INTO crm_observed_records (account_id,record_key,object_type,record_id,provider_updated_at,observed_at,first_seen_at,payload_json) SELECT ?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(account_id,record_key) DO UPDATE SET provider_updated_at=excluded.provider_updated_at,observed_at=excluded.observed_at,payload_json=excluded.payload_json WHERE excluded.provider_updated_at >= crm_observed_records.provider_updated_at`)
        .bind(accountId,key,objectType,record.id,record.updatedAt,now,now,JSON.stringify(record),...guardValues));
    }
    if(duplicate&&!options.cached) statements.push(db.prepare(`UPDATE crm_observed_records SET observed_at=? WHERE account_id=? AND record_key=? AND ${guard}`).bind(now,accountId,key,...guardValues));
    const detections: Detection[] = [];
    for (const field of objectType==='Company'||objectType==='Account'?['domain']:objectType==='Contact'||objectType==='Lead'?['email']:[]) {
      const value=record.properties[field]?.trim().toLowerCase();
      if(value && (field!=='email'||/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value))) {
        const matches=await db.prepare('SELECT record_key FROM crm_observed_records WHERE account_id=? AND object_type=? AND lower(trim(json_extract(payload_json,?)))=? AND record_key!=? LIMIT 100').bind(accountId,objectType,`$.properties.${field}`,value,key).all<{record_key:string}>();
        if(matches.results.length) detections.push({kind:'duplicate_candidate',objectType,field:`${field}:${(await digest(value)).slice(0,20)}`,records:[key,...matches.results.map(r=>r.record_key)],title:`${objectType} records share a ${field}`,severity:'warning',evidence:{field,limitation:'A shared email or domain is a review candidate, not proof of identity. No merge is proposed or executed.'}});
      }
    }
    if(objectType==='Deal'||objectType==='Opportunity') {
      const amount=record.properties.amount;
      if(amount?.trim() && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(amount.trim())||!Number.isFinite(Number(amount))||(policy.disallowNegativeAmounts&&Number(amount)<0))) detections.push({kind:'invalid_value',objectType,field:'amount',records:[key],title:'A deal amount violates its configured format or policy',severity:'warning',evidence:{field:'amount',disallowNegativeAmounts:policy.disallowNegativeAmounts,limitation:'No amount is inferred or rewritten.'}});
      const close=record.properties.close_date;
      if(close?.trim()&&(!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(close)||!Number.isFinite(Date.parse(close))||new Date(close).toISOString().slice(0,10)!==close.slice(0,10))) detections.push({kind:'invalid_value',objectType,field:'close_date',records:[key],title:'A deal close date is invalid',severity:'warning',evidence:{field:'close_date',limitation:'Past dates and custom stages are not automatically considered invalid.'}});
    }
    if (record.coverage?.length) detections.push({kind:'coverage',objectType,field:'relationships',records:[key],title:'Some native relationships could not be read',severity:'warning',evidence:{limitations:record.coverage}});
    if (absent.length) detections.push({ kind:'coverage',objectType,field:'fields',records:[key],title:'Previously observed fields are absent',severity:'warning',evidence:{ missingFields:absent, limitation:'Omitted properties do not prove that values were cleared.' } });
    if (!duplicate) {
      for (const change of changes.filter((item) => !suppressed.includes(item.field))) {
        const windowStart = new Date(Date.parse(now) - policy.windowMinutes * 60_000).toISOString();
        if (change.before.trim() && !change.after.trim()) {
          const recent = await db.prepare(`SELECT DISTINCT o.record_key FROM crm_observations o, json_each(o.changes_json) c WHERE o.account_id=? AND o.object_type=? AND o.observed_at>=? AND json_extract(c.value,'$.field')=? AND trim(json_extract(c.value,'$.before'))!='' AND trim(json_extract(c.value,'$.after'))='' AND NOT EXISTS(SELECT 1 FROM json_each(o.suppressed_json) s WHERE s.value=?)`).bind(accountId,objectType,windowStart,change.field,change.field).all<{record_key:string}>();
          const records = [...new Set([...recent.results.map((row) => row.record_key),key])];
          const total = (await db.prepare('SELECT COUNT(*) AS count FROM crm_observed_records WHERE account_id=? AND object_type=?').bind(accountId,objectType).first<{count:number}>())!.count;
          if (records.length >= policy.minimumRecords && records.length / Math.max(1,total) >= policy.clearingFraction) detections.push({kind:'mass_field_clearing',objectType,field:change.field,records,title:`Many ${objectType} records lost a populated field`,severity:'critical',evidence:{field:change.field,affected:records.length,observedPopulation:total,fraction:records.length/Math.max(1,total),minimumRecords:policy.minimumRecords,thresholdFraction:policy.clearingFraction,windowMinutes:policy.windowMinutes,attribution:'A shared cause is not established.'}});
        }
        const recent = await db.prepare('SELECT changes_json,suppressed_json FROM crm_observations WHERE account_id=? AND record_key=? AND observed_at>=? ORDER BY observed_at DESC,rowid DESC LIMIT 100').bind(accountId,key,new Date(Date.parse(now)-86_400_000).toISOString()).all<{changes_json:string;suppressed_json:string}>();
        const transitions = recent.results.filter(row=>!(JSON.parse(row.suppressed_json) as string[]).includes(change.field)).flatMap((row) => (JSON.parse(row.changes_json) as typeof changes).filter((item) => item.field===change.field));
        const reversals = transitions.filter((item) => item.before===change.after && item.after===change.before).length;
        if (reversals >= policy.reversalsBeforePause) detections.push({kind:'value_reversal',objectType,field:change.field,records:[key],title:'A field repeatedly returned to an earlier value',severity:'critical',evidence:{field:change.field,reversals,windowHours:24,threshold:policy.reversalsBeforePause,attribution:'Competing integrations are a hypothesis; source identity is not inferred.'},pause:'Repeated field reversals require investigation before more automatic repairs.'});
      }
    }
    for (const rule of policy.expectations.filter((rule) => rule.objectType===objectType)) {
      const missingCondition=!(rule.whenField in record.properties);
      const missingRequired=rule.whenValues.includes(record.properties[rule.whenField]??'')&&!(rule.requiredField in record.properties);
      if(missingCondition||missingRequired) {
        detections.push({kind:'coverage',objectType,field:`expectation:${rule.id}`,records:[key],title:'A configured expectation cannot be evaluated',severity:'warning',evidence:{rule,missingFields:[...(missingCondition?[rule.whenField]:[]),...(missingRequired?[rule.requiredField]:[])],limitation:'An unobserved field may reflect a policy typo or unavailable permissions. It is not an empty value; any existing deadline is preserved.'}});
        continue;
      }
      const qualifies = rule.whenValues.includes(record.properties[rule.whenField] ?? '') && !record.properties[rule.requiredField]?.trim();
      const clock=await db.prepare('SELECT since FROM crm_expectation_clocks WHERE account_id=? AND record_key=? AND rule_id=?').bind(accountId,key,rule.id).first<{since:string}>();
      if(qualifies) statements.push(db.prepare(`INSERT INTO crm_expectation_clocks(account_id,record_key,rule_id,since) SELECT ?,?,?,? WHERE ${guard} ON CONFLICT DO NOTHING`).bind(accountId,key,rule.id,now,...guardValues));
      else statements.push(db.prepare(`DELETE FROM crm_expectation_clocks WHERE account_id=? AND record_key=? AND rule_id=? AND ${guard}`).bind(accountId,key,rule.id,...guardValues));
      if (qualifies && Date.parse(now)-Date.parse(clock?.since ?? now) >= rule.deadlineMinutes*60_000 && !isPlanned(policy,objectType,rule.requiredField,now)) detections.push({kind:'expectation',objectType,field:rule.id,records:[key],title:'A configured business expectation was missed',severity:'warning',evidence:{rule,recordKey:key,requiredField:rule.requiredField,deadlineMinutes:rule.deadlineMinutes,qualifyingSince:clock?.since??now,limitation:'Deadline begins when the unmet condition is first observed; prior source timing is unknown.'}});
    }
    for (const rule of policy.relationships.filter((rule) => rule.objectType===objectType)) {
      if (isPlanned(policy,objectType,rule.field,now)) continue;
      const value = record.properties[rule.field];
      // Absence can mean insufficient API scope; an explicitly blank field is evidence of no link.
      if (value===undefined) {
        if(rule.required)detections.push({kind:'coverage',objectType,field:`relationship:${rule.id}`,records:[key],title:'A required relationship policy cannot be evaluated',severity:'warning',evidence:{rule,missingFields:[rule.field],limitation:'The relationship field was not observed. Review the policy and connection permissions; absence does not prove a missing link.'}});
        continue;
      }
      const relationship = relationshipIds(value);
      if (relationship === null) detections.push({kind:'invalid_value',objectType,field:rule.id,records:[key],title:'A relationship value has an invalid format',severity:'warning',evidence:{rule,limitation:'Expected a native record ID or JSON array of native record IDs. No relationship is rewritten.'}});
      else if (!relationship.length && rule.required) detections.push({kind:'relationship',objectType,field:rule.id,records:[key],title:'A required relationship is missing',severity:'warning',evidence:{rule,recordKey:key,observedValue:value,limitation:'Relationships are never created automatically.'}});
      else if (relationship.length) {
        const coverage = await getIncidentCoverage(accountId);
        if (coverage.status==='healthy' && coverage.phase==='changes' && coverage.objectTypes.includes(rule.targetType)) {
          const missing:string[]=[];
          for(const targetId of relationship) {
            const target=await db.prepare('SELECT record_key FROM crm_observed_records WHERE account_id=? AND object_type=? AND record_id=? AND (? IS NULL OR observed_at>=?)').bind(accountId,rule.targetType,targetId,coverage.baselineStartedAt,coverage.baselineStartedAt).first();
            if(!target)missing.push(targetId);
          }
          if(missing.length) detections.push({kind:'relationship',objectType,field:rule.id,records:[key],title:'A linked record is outside the completed baseline',severity:'warning',evidence:{rule,targetIds:missing,limitation:'A deleted record, filtered scope, or permissions can explain the missing target; this is not proof of a broken native link.'}});
        }
      }
    }
    const incidentIds: string[] = [];
    for (const detection of detections) {
      const prepared = await incidentStatements(db,accountId,detection,policy,now,duplicate,guard,guardValues);
      statements.push(...prepared.statements); incidentIds.push(prepared.id);
    }
    if (statements.length) await db.batch(statements);
    await pruneObservations(db,accountId,policy,now);
    return {accepted:!duplicate&&!alreadySeen,changedFields:changes.length,incidents:incidentIds,...(duplicate?{reason:'duplicate'}:{})};
  });
}

type Detection = {kind:IncidentKind;objectType:string;field:string;records:string[];title:string;severity:'warning'|'critical';evidence:Record<string,unknown>;pause?:string};
async function incidentStatements(db:DatabaseAdapter,accountId:string,d:Detection,policy:IncidentPolicy,now:string,duplicate=false,guard='1 = 1',values:unknown[]=[]):Promise<{id:string;statements:PreparedQuery[]}> {
  const fingerprint = `${d.kind}:${d.objectType}:${d.field}`;
  const previous = await db.prepare('SELECT id,status,version,evidence_json FROM crm_incidents WHERE account_id=? AND fingerprint=?').bind(accountId,fingerprint).first<{id:string;status:string;version:number;evidence_json:string}>();
  const id = previous?.id ?? crypto.randomUUID();
  if (previous?.status==='resolved' && duplicate) return {id,statements:[]};
  const newIncident = !previous || previous.status==='resolved';
  const oldCount=previous?(await db.prepare('SELECT COUNT(*) AS count FROM crm_incident_records WHERE incident_id=?').bind(id).first<{count:number}>())!.count:0;
  const grew=Boolean(previous&&d.records.length>oldCount&&Math.floor(Math.log2(d.records.length/policy.minimumRecords))>Math.floor(Math.log2(Math.max(policy.minimumRecords,oldCount)/policy.minimumRecords)));
  const version = previous ? previous.version+1 : 1;
  const statements = [db.prepare(`INSERT INTO crm_incidents (id,account_id,fingerprint,kind,object_type,field,title,severity,status,first_seen_at,last_seen_at,policy_version,evidence_json) SELECT ?,?,?,?,?,?,?,?,'open',?,?,?,? WHERE ${guard} ON CONFLICT(account_id,fingerprint) DO UPDATE SET last_seen_at=excluded.last_seen_at,evidence_json=excluded.evidence_json,policy_version=excluded.policy_version,version=crm_incidents.version+1,status=CASE WHEN crm_incidents.status='resolved' THEN 'open' ELSE crm_incidents.status END,resolution=NULL,resolved_at=NULL`)
    .bind(id,accountId,fingerprint,d.kind,d.objectType,d.field,d.title,d.severity,now,now,policy.version,JSON.stringify(d.evidence),...values),
    ...d.records.map((key)=>db.prepare(`INSERT INTO crm_incident_records (incident_id,record_key) SELECT ?,? WHERE ${guard} ON CONFLICT DO NOTHING`).bind(id,key,...values)),
  ];
  if (newIncident || grew) {
    statements.push(db.prepare(`INSERT INTO crm_incident_timeline (id,incident_id,at,event,detail) SELECT ?,?,?,?,? WHERE ${guard}`).bind(crypto.randomUUID(),id,now,grew?'scope_expanded':previous?'reopened':'detected',d.title,...values));
    statements.push(notificationIntent(db,{key:`incident:${accountId}:${id}:${version}:open`,provider:monitorAccountIdentity(accountId).provider,title:grew?'CRM Monitor incident expanded':'CRM Monitor incident needs investigation',summary:`${d.title}. ${d.records.length} affected records in this detection. Open the incident to review affected records, evidence, and next steps.`,path:`/app/incidents?provider=${monitorAccountIdentity(accountId).provider}&account=${encodeURIComponent(accountId)}&incident=${id}`},guard,values));
  }
  if(d.pause) statements.push(...pauseStatements(db,accountId,d.pause,now,guard,values));
  return {id,statements};
}

function pauseStatements(db:DatabaseAdapter,accountId:string,reason:string,now:string,guard='1 = 1',values:unknown[]=[]):PreparedQuery[] {
  return [db.prepare(`INSERT INTO crm_repair_control(account_id,paused_at,reason) SELECT ?,?,? WHERE ${guard} ON CONFLICT(account_id) DO UPDATE SET paused_at=COALESCE(crm_repair_control.paused_at,excluded.paused_at),reason=excluded.reason`).bind(accountId,now,reason,...values)];
}

export async function getRepairControl(accountId:string):Promise<{paused:boolean;pausedAt:string|null;reason:string|null}> {
  const db=await incidentDatabase(); const row=await db.prepare('SELECT paused_at,reason FROM crm_repair_control WHERE account_id=?').bind(accountId).first<{paused_at:string|null;reason:string|null}>();
  return {paused:Boolean(row?.paused_at),pausedAt:row?.paused_at??null,reason:row?.reason??null};
}
export async function resumeIncidentRepairs(accountId:string):Promise<void> {
  validateScope(accountId); const db=await incidentDatabase(); await db.prepare('UPDATE crm_repair_control SET paused_at=NULL,reason=NULL WHERE account_id=?').bind(accountId).run();
}
/** Counts include uncertain and sending attempts. Resuming does not reset the budget or allow replay. */
export async function checkIncidentRepairBudget(accountId:string,recordKey:string):Promise<boolean> {
  const db=await incidentDatabase();const control=await getRepairControl(accountId);if(control.paused)return false;
  const policy=await getIncidentPolicy(accountId);const now=new Date().toISOString();
  const counts=await db.prepare(`SELECT SUM(CASE WHEN started_at>=? THEN 1 ELSE 0 END) AS hourly,SUM(CASE WHEN contact_id=? AND started_at>=? THEN 1 ELSE 0 END) AS record_daily FROM monitor_repairs WHERE account_id=?`).bind(new Date(Date.now()-3_600_000).toISOString(),recordKey,new Date(Date.now()-86_400_000).toISOString(),accountId).first<{hourly:number;record_daily:number}>();
  const reason=(counts?.record_daily??0)>=policy.repairsPerRecordPerDay?'A record reached the daily repair recurrence limit. Investigate its upstream changes.':(counts?.hourly??0)>=policy.repairLimitPerHour?'The account reached its hourly automatic repair budget. Review the incident before resuming.':null;
  if(!reason)return true;
  const prepared=await incidentStatements(db,accountId,{kind:'repair_pause',objectType:'all',field:'budget',records:[recordKey],title:'Automatic repairs are paused',severity:'critical',evidence:{reason,counts,repairLimitPerHour:policy.repairLimitPerHour,repairsPerRecordPerDay:policy.repairsPerRecordPerDay},pause:reason},policy,now);
  await db.batch(prepared.statements);return false;
}

export async function listIncidents(accountId:string,options:{status?:Incident['status'];limit?:number}={}):Promise<Incident[]> {
  validateScope(accountId);const db=await incidentDatabase();
  const rows=await db.prepare(`SELECT i.*,(SELECT COUNT(*) FROM crm_incident_records r WHERE r.incident_id=i.id) AS affected_records FROM crm_incidents i WHERE account_id=? ${options.status?'AND status=?':''} ORDER BY CASE status WHEN 'resolved' THEN 1 ELSE 0 END,CASE severity WHEN 'critical' THEN 0 ELSE 1 END,last_seen_at DESC LIMIT ?`).bind(accountId,...(options.status?[options.status]:[]),Math.min(200,Math.max(1,options.limit??100))).all<IncidentRow>();
  return rows.results.map(hydrate);
}
export async function getIncident(accountId:string,id:string):Promise<IncidentDetail|null> {
  const db=await incidentDatabase();const row=await db.prepare('SELECT i.*,(SELECT COUNT(*) FROM crm_incident_records r WHERE r.incident_id=i.id) AS affected_records FROM crm_incidents i WHERE account_id=? AND id=?').bind(accountId,id).first<IncidentRow>();if(!row)return null;
  const [timeline,observations,records]=await Promise.all([
    db.prepare('SELECT at,event,detail FROM crm_incident_timeline WHERE incident_id=? ORDER BY at DESC,rowid DESC LIMIT 100').bind(id).all<{at:string;event:string;detail:string}>(),
    db.prepare('SELECT o.* FROM crm_observations o JOIN crm_incident_records r ON r.record_key=o.record_key AND r.incident_id=? WHERE o.account_id=? ORDER BY observed_at DESC,o.rowid DESC LIMIT 100').bind(id,accountId).all<ObservationRow>(),
    db.prepare('SELECT record_key FROM crm_incident_records WHERE incident_id=? ORDER BY record_key LIMIT 500').bind(id).all<{record_key:string}>(),
  ]);
  return {...hydrate(row),timeline:timeline.results,observations:observations.results.map(observation),records:records.results.map(r=>r.record_key)};
}
export async function triageIncident(accountId:string,input:{id:string;status:Incident['status'];assignee:string;note:string;resolution?:IncidentResolution}):Promise<IncidentDetail> {
  if(!input||!['open','investigating','resolved'].includes(input.status)||typeof input.assignee!=='string'||input.assignee.length>100||typeof input.note!=='string'||input.note.length>2000||input.status==='resolved'&&!['intentional_change','broken_integration','incorrect_expectation','resolved_upstream','inconclusive'].includes(input.resolution??''))throw new Error('Choose an incident status, assignee, note, and a structured resolution when resolving.');
  const current=await getIncident(accountId,input.id);if(!current)throw new Error('Incident not found in this account.');
  const db=await incidentDatabase();const now=new Date().toISOString();const provider=monitorAccountIdentity(accountId).provider;
  await db.batch([
    db.prepare('UPDATE crm_incidents SET status=?,assignee=?,note=?,resolution=?,resolved_at=?,version=version+1 WHERE account_id=? AND id=?').bind(input.status,input.assignee.trim(),input.note.trim(),input.status==='resolved'?input.resolution:null,input.status==='resolved'?now:null,accountId,input.id),
    db.prepare('INSERT INTO crm_incident_timeline(id,incident_id,at,event,detail) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),input.id,now,input.status,input.status==='resolved'?`Resolution: ${input.resolution}. ${input.note.trim()}`:input.note.trim()),
    ...(input.status==='resolved'?[db.prepare('INSERT INTO crm_incident_resolutions(id,account_id,incident_id,resolved_at,payload_json) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),accountId,input.id,now,JSON.stringify({...current,status:'resolved',assignee:input.assignee.trim(),note:input.note.trim(),resolution:input.resolution,resolvedAt:now}))]:[]),
    notificationIntent(db,{key:`incident:${accountId}:${input.id}:triage:${crypto.randomUUID()}`,provider,title:input.status==='resolved'?'CRM Monitor incident resolved':'CRM Monitor incident follow-up updated',summary:input.status==='resolved'?`Resolution recorded: ${input.resolution!.replaceAll('_',' ')}. Review the retained incident evidence in Control Tower.`:'An incident owner or investigation state changed. Open Control Tower for the current evidence and next step.',path:`/app/incidents?provider=${provider}&incident=${input.id}`}),
  ]);return (await getIncident(accountId,input.id))!;
}

export async function getIncidentCoverage(accountId:string):Promise<IncidentCoverage> {
  const db=await incidentDatabase();const row=await db.prepare('SELECT payload_json FROM crm_incident_coverage WHERE account_id=?').bind(accountId).first<{payload_json:string}>();
  const coverage:IncidentCoverage=row?JSON.parse(row.payload_json):{status:'unknown',phase:'baseline',lastCheckedAt:null,baselineStartedAt:null,lastSuccessAt:null,staleAfterSeconds:900,lastChangedAt:null,scanned:0,error:null,objectTypes:[],limitations:['Initial baseline has not completed.','Polling cannot reconstruct intermediate changes or prove deletion.']};
  if(coverage.lastCheckedAt&&Date.now()-Date.parse(coverage.lastCheckedAt)>(coverage.staleAfterSeconds??900)*1000) return {...coverage,status:'stale',error:'No monitoring attempt was recorded within the expected interval.'};
  return coverage;
}
export async function recordMonitorCoverage(accountId:string,input:{status:'healthy'|'degraded';phase:'baseline'|'changes';observedAt?:string;baselineStartedAt?:string;staleAfterSeconds?:number;scanned:number;error?:string;objectTypes?:string[];capabilities?:MonitorCapability[];limitations?:string[]}):Promise<void> {
  const db=await incidentDatabase();const previous=await getIncidentCoverage(accountId);const now=input.observedAt??new Date().toISOString();
  const last=await db.prepare("SELECT MAX(observed_at) AS at FROM crm_observations WHERE account_id=? AND changes_json!='[]'").bind(accountId).first<{at:string|null}>();
  const objects=await db.prepare('SELECT DISTINCT object_type FROM crm_observed_records WHERE account_id=?').bind(accountId).all<{object_type:string}>();
  const coverage:IncidentCoverage={status:input.status==='healthy'&&input.phase==='baseline'?'baseline':input.status,phase:input.phase,lastCheckedAt:now,baselineStartedAt:input.baselineStartedAt??previous.baselineStartedAt??null,lastSuccessAt:input.status==='healthy'?now:previous.lastSuccessAt,staleAfterSeconds:input.staleAfterSeconds??previous.staleAfterSeconds??900,lastChangedAt:last?.at??null,scanned:input.scanned,error:input.error??null,objectTypes:input.objectTypes??objects.results.map(r=>r.object_type),capabilities:input.capabilities??previous.capabilities,limitations:input.limitations??['Polling may miss intermediate changes. Missing fields and unavailable objects are coverage gaps; they are not evidence of deletion.']};
  const statements=[db.prepare('INSERT INTO crm_incident_coverage(account_id,payload_json) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET payload_json=excluded.payload_json').bind(accountId,JSON.stringify(coverage))];
  const policy=await getIncidentPolicy(accountId);
  if(input.status==='degraded')statements.push(...(await incidentStatements(db,accountId,{kind:'coverage',objectType:'all',field:'connection',records:[],title:'Monitoring coverage is degraded',severity:'critical',evidence:{error:input.error??'The latest check did not complete.',lastHealthyAt:previous.status==='healthy'?previous.lastCheckedAt:null}},policy,now,true)).statements);
  if(policy.activity.enabled&&input.phase==='changes'&&input.status==='healthy') {
    const boundary=new Date(Date.parse(now)-policy.activity.quietMinutes*60_000).toISOString();
    const prior=new Date(Date.parse(boundary)-policy.activity.quietMinutes*60_000).toISOString();
    const counts=await db.prepare("SELECT COUNT(DISTINCT CASE WHEN observed_at>=? THEN record_key END) AS recent,COUNT(DISTINCT CASE WHEN observed_at>=? AND observed_at<? THEN record_key END) AS prior FROM crm_observations WHERE account_id=? AND phase='changes' AND changes_json!='[]'").bind(boundary,prior,boundary,accountId).first<{recent:number;prior:number}>();
    if(counts&&counts.recent===0&&counts.prior>=policy.activity.minimumPreviousRecords)statements.push(...(await incidentStatements(db,accountId,{kind:'activity_drop',objectType:'all',field:'activity',records:[],title:'Previously active CRM changes went quiet',severity:'warning',evidence:{...counts,quietMinutes:policy.activity.quietMinutes,limitation:'Quiet activity can be legitimate. Investigate business volume and ingestion health separately.'}},policy,now,true)).statements);
  }
  await db.batch(statements);
}
/** Native reported values are independent evidence. They never become a current snapshot or a repair proposal. */
export async function detectNativeEventReversals(accountId:string,recordKeys:string[],leaseId?:string):Promise<string[]> {
  return serialized(accountId,async()=>{
    const db=await incidentDatabase();const policy=await getIncidentPolicy(accountId);const now=new Date().toISOString();
    const identity=monitorAccountIdentity(accountId);const ids:string[]=[];
    const guard=leaseId?'EXISTS (SELECT 1 FROM monitor_accounts WHERE account_id=? AND lease_id=? AND lease_expires_at>?)':'1 = 1';
    const guardValues=leaseId?[accountId,leaseId,now]:[];
    for(const recordKey of [...new Set(recordKeys)].slice(0,10)) {
      const retained=await getRecentMonitorEvents(accountId,[recordKey],100);
      const native=retained.filter(event=>event.scope===accountId&&event.provider===identity.provider&&event.kind==='refresh'
        && event.recordId && !event.source.reportedValuesTruncated && ['hubspot_webhook','salesforce_cdc'].includes(event.source.kind)
        && Date.parse(event.occurredAt)>=Date.parse(now)-86_400_000 && Date.parse(event.occurredAt)<=Date.parse(now)+300_000);
      const fields=new Map<string,{field:string;nativeField:string;objectType:string;samples:{eventId:string;at:string;value:string;excluded:boolean}[]}>();
      for(const event of native) {
        for(const [nativeField,value] of Object.entries(event.source.reportedValues??{})) {
          // Unchanged nullable fields from decoded CDC schemas cannot be mistaken for reported clears.
          if(!event.source.changedFields?.includes(nativeField))continue;
          const field=nativeNormalizedField(event.provider,event.objectType,nativeField);if(!field)continue;
          const group=fields.get(field)??{field,nativeField,objectType:event.objectType,samples:[]};
          group.samples.push({eventId:event.id,at:event.occurredAt,value:value===null?'':String(value),excluded:isPlanned(policy,event.objectType,field,event.occurredAt)});
          fields.set(field,group);
        }
      }
      for(const group of fields.values()) {
        const ordered=group.samples.sort((a,b)=>a.at.localeCompare(b.at)||a.eventId.localeCompare(b.eventId));
        let sequence:typeof ordered=[];let witness:typeof ordered=[];let returns=0;let witnessReturns=0;
        for(let index=0;index<ordered.length;) {
          const sameTime:typeof ordered=[];const at=ordered[index].at;
          while(index<ordered.length&&ordered[index].at===at)sameTime.push(ordered[index++]);
          // Tied conflicting values or a planned change split the sequence; do not infer an order through them.
          if(sameTime.some(sample=>sample.excluded)||new Set(sameTime.map(sample=>sample.value)).size!==1) {sequence=[];returns=0;continue;}
          const sample=sameTime[0];
          if(sequence.at(-1)?.value===sample.value)continue;
          if(sequence.some(previous=>previous.value===sample.value))returns+=1;
          sequence.push(sample);
          if(returns>=policy.reversalsBeforePause){witness=[...sequence];witnessReturns=returns;}
        }
        if(!witness.length)continue;
        const latestReturn=witness[witness.length-1];
        const evidenceKey=await digest(JSON.stringify([latestReturn.at,latestReturn.value]));
        const checked=await db.prepare('SELECT evidence_key FROM crm_native_reversal_checks WHERE account_id=? AND record_key=? AND field=?').bind(accountId,recordKey,group.field).first<{evidence_key:string}>();
        if(checked?.evidence_key===evidenceKey)continue;
        const prepared=await incidentStatements(db,accountId,{kind:'value_reversal',objectType:group.objectType,field:group.field,records:[recordKey],
          title:'Native events report repeated returns to earlier values',severity:'critical',
          evidence:{evidenceSource:'native_event_reported_values',recordKey,field:group.field,nativeField:group.nativeField,returns:witnessReturns,threshold:policy.reversalsBeforePause,windowHours:24,
            eventIds:witness.map(sample=>sample.eventId),reportedSequence:witness.map(sample=>({eventId:sample.eventId,occurredAt:sample.at,reportedValue:sample.value})),
            limitation:'These are native event-reported values, not observed before/after snapshots. Intermediate unreported changes and the cause remain unknown. Event actors are not attributed to a later fresh read.'},
          pause:'Native events show repeated returns to earlier field values. Investigate before resuming automatic repairs.'},policy,now,false,guard,guardValues);
        await db.batch([...prepared.statements,db.prepare(`INSERT INTO crm_native_reversal_checks(account_id,record_key,field,evidence_key) SELECT ?,?,?,? WHERE ${guard} ON CONFLICT(account_id,record_key,field) DO UPDATE SET evidence_key=excluded.evidence_key`).bind(accountId,recordKey,group.field,evidenceKey,...guardValues)]);
        ids.push(prepared.id);
      }
    }
    return ids;
  });
}
function nativeNormalizedField(provider:string,objectType:string,field:string):string|null {
  const person={email:'email',firstname:'firstname',lastname:'lastname',jobtitle:'jobtitle',hubspot_owner_id:'owner_id'};
  const hubspot:Record<string,Record<string,string>>={Contact:{...person,company:'company',lifecyclestage:'lifecyclestage',associatedcompanyid:'company_id'},Company:{name:'name',domain:'domain',hubspot_owner_id:'owner_id'},Deal:{dealname:'name',dealstage:'stage',pipeline:'pipeline',amount:'amount',closedate:'close_date',hubspot_owner_id:'owner_id'}};
  const sfPerson={Email:'email',FirstName:'firstname',LastName:'lastname',Title:'jobtitle',OwnerId:'owner_id'};
  const salesforce:Record<string,Record<string,string>>={Lead:{...sfPerson,Company:'company',Status:'status'},Contact:{...sfPerson,AccountId:'company_id'},Account:{Name:'name',Website:'domain',OwnerId:'owner_id'},Opportunity:{Name:'name',StageName:'stage',Amount:'amount',CloseDate:'close_date',OwnerId:'owner_id',AccountId:'company_id',IsClosed:'is_closed',IsWon:'is_won'}};
  return (provider==='hubspot'?hubspot:salesforce)[objectType]?.[field]??null;
}

/** Re-evaluate cached records after a complete baseline or a policy edit. This makes unchanged routing deadlines visible. */
export async function queueIncidentRecheck(accountId:string,since?:string):Promise<void> {
  const db=await incidentDatabase();
  await db.prepare("INSERT INTO crm_incident_rechecks(account_id,cursor,since) VALUES(?,'',?) ON CONFLICT(account_id) DO UPDATE SET cursor='',since=excluded.since").bind(accountId,since??null).run();
}
export async function hasIncidentRecheck(accountId:string):Promise<boolean> {
  const db=await incidentDatabase();return Boolean(await db.prepare('SELECT account_id FROM crm_incident_rechecks WHERE account_id=?').bind(accountId).first());
}
export async function processIncidentRecheck(accountId:string,limit=50,leaseId?:string):Promise<number> {
  const coverage=await getIncidentCoverage(accountId);if(coverage.status!=='healthy'||coverage.phase!=='changes')return 0;
  const db=await incidentDatabase();const queue=await db.prepare('SELECT cursor,since FROM crm_incident_rechecks WHERE account_id=?').bind(accountId).first<{cursor:string;since:string|null}>();if(!queue)return 0;
  const rows=(await db.prepare('SELECT record_key,payload_json FROM crm_observed_records WHERE account_id=? AND record_key>? AND (? IS NULL OR observed_at>=?) ORDER BY record_key LIMIT ?').bind(accountId,queue.cursor,queue.since,queue.since,Math.min(50,Math.max(1,limit))).all<{record_key:string;payload_json:string}>()).results;
  for(const row of rows) await ingestObservation(accountId,JSON.parse(row.payload_json),{phase:'changes',leaseId,cached:true});
  if(rows.length)await db.prepare('UPDATE crm_incident_rechecks SET cursor=? WHERE account_id=? AND cursor=?').bind(rows[rows.length-1].record_key,accountId,queue.cursor).run();
  else await db.prepare('DELETE FROM crm_incident_rechecks WHERE account_id=? AND cursor=?').bind(accountId,queue.cursor).run();
  return rows.length;
}

/** Unchanged records still need deadline checks. Round-robin checks are bounded and do not claim a fresh CRM read. */
export async function processDueIncidentExpectations(accountId:string,leaseId?:string):Promise<boolean> {
  const db=await incidentDatabase();const now=new Date().toISOString();
  const coverage=await getIncidentCoverage(accountId);if(coverage.status!=='healthy'||coverage.phase!=='changes')return false;
  const rows=(await db.prepare(`SELECT DISTINCT r.record_key,r.payload_json,k.checked_at FROM crm_expectation_clocks c
    JOIN crm_observed_records r ON r.account_id=c.account_id AND r.record_key=c.record_key
    JOIN crm_incident_policies p ON p.account_id=c.account_id
    LEFT JOIN crm_expectation_checks k ON k.account_id=c.account_id AND k.record_key=c.record_key
    WHERE c.account_id=? AND (k.checked_at IS NULL OR k.checked_at<?)
    AND EXISTS(SELECT 1 FROM json_each(json_extract(p.payload_json,'$.expectations')) rule WHERE json_extract(rule.value,'$.id')=c.rule_id AND julianday(c.since)+json_extract(rule.value,'$.deadlineMinutes')/1440.0<=julianday(?))
    ORDER BY k.checked_at,r.record_key LIMIT 51`).bind(accountId,new Date(Date.now()-300_000).toISOString(),now).all<{record_key:string;payload_json:string}>()).results;
  for(const row of rows.slice(0,50)) {
    await ingestObservation(accountId,JSON.parse(row.payload_json),{phase:'changes',leaseId,cached:true});
    await db.prepare('INSERT INTO crm_expectation_checks(account_id,record_key,checked_at) VALUES(?,?,?) ON CONFLICT(account_id,record_key) DO UPDATE SET checked_at=excluded.checked_at').bind(accountId,row.record_key,now).run();
  }
  return rows.length>50;
}

export type IncidentEvidence = {
  incident: IncidentDetail; policy: IncidentPolicy; coverage: IncidentCoverage;
  records: { recordKey: string; record: MonitorContact; observedAt: string }[];
  relatedRecords: { recordKey: string; record: MonitorContact; observedAt: string }[];
  priorResolutions: Incident[]; nativeEvents: (MonitorNativeEvent & {receivedAt:string;processedAt:string|null})[]; limitations: string[];
};
/** Restricted investigator input, bounded to source-linked evidence. It conveys no CRM write or approval capability. */
export async function readIncidentEvidence(accountId:string,id:string):Promise<IncidentEvidence|null> {
  const incident=await getIncident(accountId,id);if(!incident)return null;
  const db=await incidentDatabase();
  const rows=await db.prepare('SELECT r.record_key,r.payload_json,r.observed_at FROM crm_observed_records r JOIN crm_incident_records i ON i.record_key=r.record_key AND i.incident_id=? WHERE r.account_id=? ORDER BY r.observed_at DESC LIMIT 50').bind(id,accountId).all<{record_key:string;payload_json:string;observed_at:string}>();
  const records=rows.results.map(r=>({recordKey:r.record_key,record:JSON.parse(r.payload_json) as MonitorContact,observedAt:r.observed_at}));
  const relatedIds=new Map<string,{id:string;type:string}>();
  for(const item of records) {
    const companyType=item.record.provider==='salesforce'?'Account':'Company';
    for(const [field,targetType] of [['company_id',companyType],['company_ids',companyType],['account_id','Account'],['contact_ids','Contact']]) {
      for(const nativeId of relationshipIds(item.record.properties[field]??'')??[]) relatedIds.set(`${targetType}:${nativeId}`,{id:nativeId,type:targetType});
    }
  }
  const relatedRecords:IncidentEvidence['relatedRecords']=[];
  for(const {id:nativeId,type} of [...relatedIds.values()].slice(0,30)) {
    const related=await db.prepare('SELECT record_key,payload_json,observed_at FROM crm_observed_records WHERE account_id=? AND record_id=? AND object_type=? LIMIT 1').bind(accountId,nativeId,type).all<{record_key:string;payload_json:string;observed_at:string}>();
    relatedRecords.push(...related.results.map(r=>({recordKey:r.record_key,record:JSON.parse(r.payload_json),observedAt:r.observed_at})));
  }
  const savedPolicy=await db.prepare('SELECT payload_json FROM crm_incident_policy_history WHERE account_id=? AND version=?').bind(accountId,incident.policyVersion).first<{payload_json:string}>();
  const decisions=await db.prepare('SELECT payload_json FROM crm_incident_resolutions WHERE account_id=? ORDER BY resolved_at DESC,rowid DESC LIMIT 20').bind(accountId).all<{payload_json:string}>();
  return {incident,policy:savedPolicy?JSON.parse(savedPolicy.payload_json):await getIncidentPolicy(accountId),coverage:await getIncidentCoverage(accountId),records,relatedRecords,nativeEvents:await getRecentMonitorEvents(accountId,incident.records,100),priorResolutions:decisions.results.map(row=>JSON.parse(row.payload_json) as Incident),limitations:['Observation history is bounded by the configured retention period and count.','At most 100 recent observations, 50 current affected records, and 30 related native IDs are included.','Native event actor and reported values describe the refresh trigger. A later fresh read may include other writes; its observed change is not attributed to that actor without additional evidence.']};
}

/** Called by an independent scheduled check or the incident API; never fabricates a successful monitoring attempt. */
export async function heartbeatIncidentCoverage(accountId:string):Promise<IncidentCoverage> {
  const coverage=await getIncidentCoverage(accountId);
  if(coverage.status==='stale') {
    const db=await incidentDatabase();const policy=await getIncidentPolicy(accountId);
    const prepared=await incidentStatements(db,accountId,{kind:'coverage',objectType:'all',field:'runner',records:[],title:'The monitoring runner is overdue',severity:'critical',evidence:{lastAttemptAt:coverage.lastCheckedAt,lastSuccessAt:coverage.lastSuccessAt,staleAfterSeconds:coverage.staleAfterSeconds}},policy,new Date().toISOString(),true);
    await db.batch(prepared.statements);
  }
  return coverage;
}

export async function getIncidentOverview(accountId:string) {
  const [policy,incidents,coverage,repairControl]=await Promise.all([getIncidentPolicy(accountId),listIncidents(accountId),heartbeatIncidentCoverage(accountId),getRepairControl(accountId)]);
  const db=await incidentDatabase();
  const counts=(await db.prepare('SELECT status,COUNT(*) AS count FROM crm_incidents WHERE account_id=? GROUP BY status').bind(accountId).all<{status:string;count:number}>()).results;
  const totals={open:0,investigating:0,resolved:0,...Object.fromEntries(counts.map(row=>[row.status,row.count]))};
  return {policy,incidents,coverage,repairControl,totals,recheckPending:await hasIncidentRecheck(accountId),truncated:counts.reduce((sum,row)=>sum+row.count,0)>incidents.length};
}

async function pruneObservations(db:DatabaseAdapter,accountId:string,policy:IncidentPolicy,now:string) {
  await db.batch([
    db.prepare('DELETE FROM crm_observations WHERE account_id=? AND observed_at<?').bind(accountId,new Date(Date.parse(now)-policy.retentionDays*86_400_000).toISOString()),
    db.prepare('DELETE FROM crm_incident_timeline WHERE id IN (SELECT t.id FROM crm_incident_timeline t JOIN crm_incidents i ON i.id=t.incident_id WHERE i.account_id=? AND t.at<?)').bind(accountId,new Date(Date.parse(now)-policy.retentionDays*86_400_000).toISOString()),
    db.prepare('DELETE FROM crm_observations WHERE id IN (SELECT id FROM crm_observations WHERE account_id=? ORDER BY observed_at DESC,rowid DESC LIMIT -1 OFFSET ?)').bind(accountId,policy.maxObservations),
  ]);
}
function hydrate(row:IncidentRow):Incident{return {id:row.id,accountId:row.account_id,kind:row.kind,objectType:row.object_type,field:row.field,title:row.title,severity:row.severity,status:row.status,firstSeenAt:row.first_seen_at,lastSeenAt:row.last_seen_at,affectedRecords:row.affected_records,policyVersion:row.policy_version,version:row.version,assignee:row.assignee,note:row.note,resolution:row.resolution,resolvedAt:row.resolved_at,evidence:JSON.parse(row.evidence_json)};}
function observation(row:ObservationRow):IncidentObservation{return {id:row.id,recordKey:row.record_key,objectType:row.object_type,recordId:row.record_id,observedAt:row.observed_at,providerUpdatedAt:row.provider_updated_at,phase:row.phase,changes:JSON.parse(row.changes_json),source:JSON.parse(row.source_json),suppressed:JSON.parse(row.suppressed_json)};}
function relationshipIds(value:string):string[]|null {
  if(!value.trim())return [];
  if(!value.trimStart().startsWith('['))return [value.trim()];
  try {const parsed:unknown=JSON.parse(value);return Array.isArray(parsed)&&parsed.length<=200&&parsed.every(item=>typeof item==='string'&&item.trim()&&item.length<=200)?[...new Set(parsed as string[])]:null;}
  catch{return null;}
}
function isPlanned(policy:IncidentPolicy,objectType:string,field:string,now:string){return policy.plannedChanges.some(p=>p.objectType===objectType&&p.fields.includes(field)&&p.until>now);}
function validateScope(scope:string){if(!/^[a-zA-Z0-9_-]{1,120}$/.test(scope))throw new Error('Invalid CRM account scope.');}
function validatePolicy(p:IncidentPolicy){
  const integer=(n:number,min:number,max:number)=>Number.isInteger(n)&&n>=min&&n<=max;
  if(!p||!integer(p.windowMinutes,1,1440)||!integer(p.minimumRecords,2,10000)||!Number.isFinite(p.clearingFraction)||p.clearingFraction<=0||p.clearingFraction>1||!integer(p.reversalsBeforePause,2,20)||!integer(p.repairLimitPerHour,1,1000)||!integer(p.repairsPerRecordPerDay,1,20)||!integer(p.retentionDays,1,90)||!integer(p.maxObservations,100,100000)||!Array.isArray(p.expectations)||p.expectations.length>30||!Array.isArray(p.relationships)||p.relationships.length>30||!Array.isArray(p.plannedChanges)||p.plannedChanges.length>30||typeof p.disallowNegativeAmounts!=='boolean'||!p.activity||typeof p.activity.enabled!=='boolean'||!integer(p.activity.minimumPreviousRecords,2,10000)||!integer(p.activity.quietMinutes,1,1440))throw new Error('Invalid incident policy thresholds or collection limits.');
  const types=['Contact','Lead','Company','Deal','Account','Opportunity'];const text=(v:unknown,max=100)=>typeof v==='string'&&v.length>0&&v.length<=max;const field=(v:unknown)=>text(v)&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(v as string);
  for(const r of p.expectations)if(!r||!text(r.id)||!types.includes(r.objectType)||!field(r.whenField)||!field(r.requiredField)||!Array.isArray(r.whenValues)||!r.whenValues.length||r.whenValues.length>50||!r.whenValues.every(v=>text(v,200))||!integer(r.deadlineMinutes,0,10080))throw new Error('Invalid business expectation.');
  for(const r of p.relationships)if(!r||!text(r.id)||!types.includes(r.objectType)||!types.includes(r.targetType)||!field(r.field)||typeof r.required!=='boolean')throw new Error('Invalid relationship expectation.');
  for(const r of p.plannedChanges)if(!r||!text(r.id)||!types.includes(r.objectType)||!text(r.reason,500)||!Array.isArray(r.fields)||!r.fields.length||r.fields.length>50||!r.fields.every(field)||!Number.isFinite(Date.parse(r.until)))throw new Error('Invalid planned change exception.');
}
async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
