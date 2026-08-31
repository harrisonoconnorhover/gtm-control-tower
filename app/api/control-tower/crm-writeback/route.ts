import { syncDirectlyToHubSpot } from '@/app/api/control-tower/hubspot-sync/route';
import {
  buildCrmWritePlan,
  isCrmRollbackPlan,
  isCrmWritePlan,
  planStillMatches,
  portableCrmFieldNames,
  rollbackRecordAlreadyRestored,
  rollbackRecordStillMatches,
  rollbackFromPlan,
  type CrmRollbackPlan,
  type CrmRollbackRecord,
  type CrmWritePlan,
  type CrmWritebackReceipt,
  type NativeCrmRecord,
  type PortableCrmContact,
} from '@/lib/crm-workflow';
import { toHubSpotFieldPayload, toSalesforceFieldPayload } from '@/lib/crm-field-mapping';
import { operatorAccessError } from '@/lib/operator-auth';

const HUBSPOT_PROPERTIES = ['email', 'firstname', 'lastname', 'company', 'phone', 'jobtitle', 'website'];
const DEFAULT_API_VERSION = '67.0';

export async function POST(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  let payload: unknown;
  try { payload = await request.json(); } catch { return Response.json({ error: 'A JSON body is required.' }, { status: 400 }); }
  if (!isRecord(payload) || (payload.connectorId !== 'hubspot' && payload.connectorId !== 'salesforce')) return Response.json({ error: 'Choose HubSpot or Salesforce.' }, { status: 400 });
  try {
    if (payload.action === 'rollback') {
      if (!isCrmRollbackPlan(payload.rollback) || payload.rollback.connectorId !== payload.connectorId) return Response.json({ error: 'A valid rollback plan is required.' }, { status: 400 });
      return Response.json(await executeRollback(payload.rollback), { status: 202, headers: { 'Cache-Control': 'no-store' } });
    }
    const contacts = parseContacts(payload.contacts);
    if (!contacts.length || contacts.length > 100) return Response.json({ error: 'Use between 1 and 100 governed contacts.' }, { status: 400 });
    if (!contactsAreValid(payload.connectorId, contacts)) return Response.json({ error: 'The governed contacts contain duplicate identity, invalid email, missing provider-required fields, or overlong portable values.' }, { status: 400 });
    const sourceFile = typeof payload.sourceFile === 'string' ? payload.sourceFile : 'crm-workspace';
    const current = await createPlan(payload.connectorId, sourceFile, contacts);
    if (payload.action === 'preview') return Response.json(current, { headers: { 'Cache-Control': 'no-store' } });
    if (payload.action !== 'execute' || !isCrmWritePlan(payload.plan) || !planStillMatches(payload.plan, current)) {
      return Response.json({ error: 'The preview is stale. Refresh the change plan before writing.' }, { status: 409 });
    }
    return Response.json(await executePlan(current, contacts), { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('CRM write-back failed', error);
    return Response.json({ error: error instanceof Error ? error.message : 'CRM write-back failed.' }, { status: 502 });
  }
}

async function createPlan(connectorId: CrmWritePlan['connectorId'], sourceFile: string, contacts: PortableCrmContact[]) {
  return buildCrmWritePlan(connectorId, sourceFile, contacts, await readExisting(connectorId, contacts));
}

async function readExisting(connectorId: CrmWritePlan['connectorId'], contacts: PortableCrmContact[]) {
  if (connectorId === 'hubspot') return readHubSpotExisting(contacts);
  return readSalesforceExisting(contacts);
}

async function readHubSpotExisting(contacts: PortableCrmContact[]): Promise<Map<string, NativeCrmRecord[]>> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('Safe HubSpot preview requires a private-app token with contact read and write scopes.');
  const response = await fetch('https://api.hubapi.com/crm/objects/2026-03/contacts/batch/read', {
    method: 'POST', cache: 'no-store', headers: hubSpotHeaders(token), signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ idProperty: 'email', properties: HUBSPOT_PROPERTIES, inputs: contacts.map((contact) => ({ id: contact.email })) }),
  });
  const payload: unknown = await response.json();
  if (!response.ok && response.status !== 207) throw new Error(`HubSpot preview returned ${response.status}`);
  const map = new Map<string, NativeCrmRecord[]>();
  const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results.filter(isRecord) : [];
  for (const result of results) {
    const props = isRecord(result.properties) ? result.properties : {};
    const email = stringValue(props.email).toLowerCase();
    const nativeId = stringValue(result.id);
    if (!email || !nativeId) continue;
    const record = nativeRecord(nativeId, email, {
      firstName: props.firstname, lastName: props.lastname, company: props.company, phone: props.phone,
      jobTitle: props.jobtitle, website: props.website,
    });
    map.set(email, [...(map.get(email) ?? []), record]);
  }
  return map;
}

async function readSalesforceExisting(contacts: PortableCrmContact[]): Promise<Map<string, NativeCrmRecord[]>> {
  const { apiRoot, headers } = salesforceConnection();
  const emails = contacts.map((contact) => `'${escapeSoql(contact.email)}'`).join(',');
  const query = `SELECT Id, Email, FirstName, LastName, Company, Phone, Title, Website FROM Lead WHERE IsConverted = FALSE AND Email IN (${emails})`;
  const response = await fetch(`${apiRoot}/query?q=${encodeURIComponent(query)}`, { cache: 'no-store', headers, signal: AbortSignal.timeout(30_000) });
  const payload: unknown = await response.json();
  if (!response.ok || !isRecord(payload) || !Array.isArray(payload.records)) throw new Error(`Salesforce preview returned ${response.status}`);
  const map = new Map<string, NativeCrmRecord[]>();
  for (const result of payload.records.filter(isRecord)) {
    const email = stringValue(result.Email).toLowerCase();
    const nativeId = stringValue(result.Id);
    if (!email || !nativeId) continue;
    const record = nativeRecord(nativeId, email, {
      firstName: result.FirstName, lastName: result.LastName, company: result.Company, phone: result.Phone,
      jobTitle: result.Title, website: result.Website,
    });
    map.set(email, [...(map.get(email) ?? []), record]);
  }
  return map;
}

async function executePlan(plan: CrmWritePlan, contacts: PortableCrmContact[]): Promise<CrmWritebackReceipt> {
  const runId = crypto.randomUUID();
  const contactById = new Map(contacts.map((contact) => [contact.contactId, contact]));
  const providerRecords = plan.connectorId === 'hubspot'
    ? await executeHubSpotPlan(plan, contactById, runId)
    : await executeSalesforcePlan(plan, runId);
  const passive = plan.records.filter((record) => record.operation === 'unchanged' || record.operation === 'hold').map((record) => ({
    contactId: record.contactId, email: record.email, nativeId: record.nativeId,
    status: record.operation === 'hold' ? 'held' as const : 'unchanged' as const, error: record.reason,
  }));
  const records = [...providerRecords, ...passive];
  const failed = records.filter((record) => record.status === 'failed').length;
  const held = records.filter((record) => record.status === 'held').length;
  return {
    accepted: true, status: failed || held ? 'partial' : 'executed', runId, connectorId: plan.connectorId, planId: plan.planId,
    requested: records.length, created: records.filter((record) => record.status === 'created').length,
    updated: records.filter((record) => record.status === 'updated').length,
    unchanged: records.filter((record) => record.status === 'unchanged').length, held, failed,
    completedAt: new Date().toISOString(), records, rollback: rollbackFromPlan(plan),
  };
}

async function executeHubSpotPlan(
  plan: CrmWritePlan,
  contactById: Map<string, PortableCrmContact>,
  runId: string,
): Promise<CrmWritebackReceipt['records']> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('HubSpot private-app token unavailable.');
  const creates = plan.records.filter((record) => record.operation === 'create');
  const updates = plan.records.filter((record) => record.operation === 'update' && record.nativeId);
  const records: CrmWritebackReceipt['records'] = [];

  if (creates.length) {
    const contacts = creates.flatMap((record) => {
      const contact = contactById.get(record.contactId);
      return contact ? [contact] : [];
    });
    if (contacts.length !== creates.length) throw new Error('The HubSpot plan no longer matches the governed contacts.');
    const receipt = await syncDirectlyToHubSpot({ syncId: runId, sourceFile: plan.sourceFile, contacts }, token);
    records.push(...receipt.records.map((record) => ({
      contactId: record.contactId,
      email: record.email,
      nativeId: record.hubSpotId,
      status: record.status === 'failed' ? 'failed' as const : record.created === false ? 'updated' as const : 'created' as const,
      error: record.error ?? (record.created === false ? 'HubSpot found this identity during the create request; the write succeeded without a pre-write rollback snapshot.' : null),
    })));
  }

  if (updates.length) {
    const response = await fetch('https://api.hubapi.com/crm/objects/2026-03/contacts/batch/update', {
      method: 'POST', cache: 'no-store', headers: hubSpotHeaders(token), signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ inputs: updates.map((record) => ({
        id: record.nativeId,
        objectWriteTraceId: `${runId}:${record.contactId}`,
        properties: toHubSpotFieldPayload(record.after),
      })) }),
    });
    const payload: unknown = await response.json();
    if (!response.ok && response.status !== 207) throw new Error(`HubSpot update returned ${response.status}`);
    records.push(...shapeHubSpotUpdateRecords(updates, payload, runId));
  }
  return records;
}

function shapeHubSpotUpdateRecords(
  updates: CrmWritePlan['records'],
  payload: unknown,
  runId: string,
): CrmWritebackReceipt['records'] {
  const body = isRecord(payload) ? payload : {};
  const results = Array.isArray(body.results) ? body.results.filter(isRecord) : [];
  const errors = Array.isArray(body.errors) ? body.errors.filter(isRecord) : [];
  const resultByTrace = new Map(results.map((result) => [stringValue(result.objectWriteTraceId), result]));
  const errorByTrace = new Map(errors.map((error) => {
    const context = isRecord(error.context) ? error.context : {};
    const trace = Array.isArray(context.objectWriteTraceId) ? context.objectWriteTraceId[0] : context.objectWriteTraceId;
    return [stringValue(trace), error];
  }));
  return updates.map((record, index) => {
    const traceId = `${runId}:${record.contactId}`;
    const result = resultByTrace.get(traceId) ?? (results.length === updates.length ? results[index] : null);
    if (result) return { contactId: record.contactId, email: record.email, nativeId: stringValue(result.id) || record.nativeId, status: 'updated', error: null };
    const error = errorByTrace.get(traceId);
    return { contactId: record.contactId, email: record.email, nativeId: record.nativeId, status: 'failed', error: stringValue(error?.message) || 'HubSpot did not return an update result.' };
  });
}

async function executeSalesforcePlan(plan: CrmWritePlan, runId: string): Promise<CrmWritebackReceipt['records']> {
  const { apiRoot, headers } = salesforceConnection();
  const actionable = plan.records.filter((record) => record.operation === 'create' || record.operation === 'update');
  if (!actionable.length) return [];
  const results: Array<{ record: CrmWritePlan['records'][number]; operation: 'create' | 'update'; result: unknown }> = [];
  for (const operation of ['create', 'update'] as const) {
    const batch = actionable.filter((record) => record.operation === operation);
    if (!batch.length) continue;
    const response = await fetch(`${apiRoot}/composite/sobjects`, {
      method: operation === 'create' ? 'POST' : 'PATCH', cache: 'no-store', headers, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ allOrNone: false, records: batch.map((record) => ({
        attributes: { type: 'Lead', referenceId: `${runId}:${record.contactId}` },
        ...(record.nativeId ? { Id: record.nativeId } : {}),
        ...(operation === 'create' ? compact({ Email: record.email, ...toSalesforceFieldPayload(record.after) }) : toSalesforceFieldPayload(record.after)),
      })) }),
    });
    const payload: unknown = await response.json();
    if (!response.ok || !Array.isArray(payload)) throw new Error(`Salesforce ${operation} returned ${response.status}`);
    results.push(...batch.map((record, index) => ({ record, operation, result: payload[index] })));
  }
  return results.map((entry) => {
    const record = entry.record;
    const result = isRecord(entry.result) ? entry.result : {};
    if (result.success === true) return {
      contactId: record.contactId, email: record.email, nativeId: stringValue(result.id) || record.nativeId,
      status: entry.operation === 'create' ? 'created' : 'updated', error: null,
    };
    const errors = Array.isArray(result.errors) ? result.errors.filter(isRecord) : [];
    return {
      contactId: record.contactId, email: record.email, nativeId: record.nativeId, status: 'failed',
      error: errors.map((error) => stringValue(error.message)).filter(Boolean).join('; ') || 'Salesforce rejected this record.',
    };
  });
}

async function executeRollback(rollback: CrmRollbackPlan): Promise<CrmWritebackReceipt> {
  const proposed = rollback.records.map((record): PortableCrmContact => ({
    contactId: record.contactId, email: record.email,
    firstName: record.after.firstName ?? '', lastName: record.after.lastName ?? '',
    company: record.after.company, phone: record.after.phone, jobTitle: record.after.jobTitle, website: record.after.website,
  }));
  const current = await readExisting(rollback.connectorId, proposed);
  const eligible: CrmRollbackRecord[] = [];
  const alreadyRestored: CrmWritebackReceipt['records'] = [];
  const conflicts: CrmWritebackReceipt['records'] = [];
  for (const record of rollback.records) {
    const native = (current.get(record.email.toLowerCase()) ?? []).find((candidate) => candidate.nativeId === record.nativeId) ?? null;
    if (rollbackRecordStillMatches(record, native)) eligible.push(record);
    else if (rollbackRecordAlreadyRestored(record, native)) alreadyRestored.push({
      contactId: record.contactId, email: record.email, nativeId: record.nativeId, status: 'unchanged', error: null,
    });
    else conflicts.push({
      contactId: record.contactId, email: record.email, nativeId: record.nativeId, status: 'held',
      error: 'Held: the CRM changed after this write, so automatic rollback would overwrite newer state.',
    });
  }
  let providerRecords: CrmWritebackReceipt['records'] = [];
  if (eligible.length && rollback.connectorId === 'hubspot') {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) throw new Error('HubSpot private-app token unavailable.');
    const response = await fetch('https://api.hubapi.com/crm/objects/2026-03/contacts/batch/update', {
      method: 'POST', cache: 'no-store', headers: hubSpotHeaders(token), signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ inputs: eligible.map((record) => ({
        id: record.nativeId,
        objectWriteTraceId: `${rollback.rollbackId}:${record.contactId}`,
        properties: toHubSpotFieldPayload(record.before, record.changedFields),
      })) }),
    });
    const payload: unknown = await response.json();
    if (!response.ok && response.status !== 207) throw new Error(`HubSpot rollback returned ${response.status}`);
    const body = isRecord(payload) ? payload : {};
    const results = Array.isArray(body.results) ? body.results.filter(isRecord) : [];
    const errors = Array.isArray(body.errors) ? body.errors.filter(isRecord) : [];
    const resultByTrace = new Map(results.map((result) => [stringValue(result.objectWriteTraceId), result]));
    const errorByTrace = new Map(errors.map((error) => {
      const context = isRecord(error.context) ? error.context : {};
      const trace = Array.isArray(context.objectWriteTraceId) ? context.objectWriteTraceId[0] : context.objectWriteTraceId;
      return [stringValue(trace), error];
    }));
    providerRecords = eligible.map((record, index) => {
      const traceId = `${rollback.rollbackId}:${record.contactId}`;
      const result = resultByTrace.get(traceId) ?? (results.length === eligible.length ? results[index] : null);
      const error = errorByTrace.get(traceId);
      return result
        ? { contactId: record.contactId, email: record.email, nativeId: stringValue(result.id) || record.nativeId, status: 'rolled_back', error: null }
        : { contactId: record.contactId, email: record.email, nativeId: record.nativeId, status: 'failed', error: stringValue(error?.message) || 'HubSpot did not return a rollback result.' };
    });
  } else if (eligible.length) {
    const { apiRoot, headers } = salesforceConnection();
    const response = await fetch(`${apiRoot}/composite/sobjects`, {
      method: 'PATCH', cache: 'no-store', headers, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ allOrNone: false, records: eligible.map((record) => ({ attributes: { type: 'Lead' }, Id: record.nativeId, ...toSalesforceFieldPayload(record.before, record.changedFields) })) }),
    });
    const results: unknown = await response.json();
    if (!response.ok || !Array.isArray(results)) throw new Error(`Salesforce rollback returned ${response.status}`);
    providerRecords = eligible.map((record, index) => {
      const result = isRecord(results[index]) ? results[index] : {};
      const errors = Array.isArray(result.errors) ? result.errors.filter(isRecord) : [];
      return result.success === true
        ? { contactId: record.contactId, email: record.email, nativeId: stringValue(result.id) || record.nativeId, status: 'rolled_back', error: null }
        : { contactId: record.contactId, email: record.email, nativeId: record.nativeId, status: 'failed', error: errors.map((error) => stringValue(error.message)).filter(Boolean).join('; ') || 'Salesforce rejected this rollback.' };
    });
  }
  const completedAt = new Date().toISOString();
  const records = [...providerRecords, ...alreadyRestored, ...conflicts];
  const failed = records.filter((record) => record.status === 'failed').length;
  const held = records.filter((record) => record.status === 'held').length;
  return {
    accepted: true, status: failed || held ? 'partial' : 'undone', runId: rollback.rollbackId, connectorId: rollback.connectorId,
    planId: rollback.sourcePlanId, requested: rollback.records.length, created: 0,
    updated: records.filter((record) => record.status === 'rolled_back').length,
    unchanged: alreadyRestored.length, held, failed, completedAt, records,
    rollback: null,
  };
}

function parseContacts(value: unknown): PortableCrmContact[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((contact): PortableCrmContact[] => {
    if (typeof contact.contactId !== 'string' || typeof contact.email !== 'string') return [];
    return [{
      contactId: contact.contactId.trim(), email: contact.email.trim().toLowerCase(), firstName: stringValue(contact.firstName).trim(), lastName: stringValue(contact.lastName).trim(),
      company: nullableString(contact.company), phone: nullableString(contact.phone), jobTitle: nullableString(contact.jobTitle), website: nullableString(contact.website),
    }];
  });
}

function contactsAreValid(connectorId: CrmWritePlan['connectorId'], contacts: PortableCrmContact[]): boolean {
  const contactIds = new Set(contacts.map((contact) => contact.contactId));
  const emails = new Set(contacts.map((contact) => contact.email));
  if (contactIds.size !== contacts.length || emails.size !== contacts.length) return false;
  const maximums = connectorId === 'salesforce'
    ? { email: 80, firstName: 40, lastName: 80, company: 255, phone: 40, jobTitle: 128, website: 255 }
    : { email: 254, firstName: 255, lastName: 255, company: 255, phone: 50, jobTitle: 255, website: 500 };
  return contacts.every((contact) => {
    const lengthsFit = contact.contactId.length >= 1 && contact.contactId.length <= 120
      && contact.email.length <= maximums.email
      && contact.firstName.length <= maximums.firstName
      && contact.lastName.length <= maximums.lastName
      && (contact.company?.length ?? 0) <= maximums.company
      && (contact.phone?.length ?? 0) <= maximums.phone
      && (contact.jobTitle?.length ?? 0) <= maximums.jobTitle
      && (contact.website?.length ?? 0) <= maximums.website;
    const emailIsValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(contact.email);
    const providerRequired = connectorId !== 'salesforce' || Boolean(contact.company && contact.lastName);
    return lengthsFit && emailIsValid && providerRequired;
  });
}

function nativeRecord(nativeId: string, email: string, raw: Record<string, unknown>): NativeCrmRecord {
  return { nativeId, email, fields: Object.fromEntries(portableCrmFieldNames.map((field) => [field, nullableString(raw[field])])) as NativeCrmRecord['fields'] };
}

function compact(value: Record<string, string | null>) { return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== null)); }
function hubSpotHeaders(token: string) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }; }
function salesforceConnection() {
  const raw = process.env.SALESFORCE_INSTANCE_URL;
  const accessToken = process.env.SALESFORCE_ACCESS_TOKEN;
  if (!raw || !accessToken) throw new Error('Salesforce connection unavailable.');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('Salesforce instance must use HTTPS.');
  const apiVersion = process.env.SALESFORCE_API_VERSION ?? DEFAULT_API_VERSION;
  return { instanceUrl: url.origin, accessToken, apiVersion, apiRoot: `${url.origin}/services/data/v${apiVersion}`, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json' } };
}
function escapeSoql(value: string) { return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'"); }
function stringValue(value: unknown) { return typeof value === 'string' ? value : ''; }
function nullableString(value: unknown): string | null { const cleaned = stringValue(value).trim(); return cleaned || null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
