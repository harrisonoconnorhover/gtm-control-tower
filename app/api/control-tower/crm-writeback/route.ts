import { readHubSpotExisting } from '@/lib/crm-existing-hubspot';
import { readSalesforceExisting } from '@/lib/crm-existing-salesforce';
import { createHubSpotContacts } from '@/app/api/control-tower/hubspot-sync/route';
import {
  buildCrmWritePlan,
  normalizeCrmUpdatePolicy,
  portableCrmFieldNames,
  isCrmRollbackPlan,
  isCrmWritePlan,
  planStillMatches,
  rollbackRecordAlreadyRestored,
  rollbackRecordStillMatches,
  rollbackFromPlan,
  type CrmRollbackPlan,
  type CrmRollbackRecord,
  type CrmWritePlan,
  type CrmWritebackReceipt,
  type PortableCrmContact,
  type CrmUpdatePolicy,
  type CrmMatchDecision,
  type NativeCrmRecord,
} from '@/lib/crm-workflow';
import { toHubSpotFieldPayload, toSalesforceFieldPayload } from '@/lib/crm-field-mapping';
import { operatorAccessError } from '@/lib/operator-auth';
import { getWorkspace, persistenceEnabled } from '@/lib/workspace-store';
import { getDuplicateScanRecords, getLatestDuplicateScan } from '@/lib/duplicate-scan-store';
import { reviewImportCreates, snapshotCoverageIssue } from '@/lib/import-create-review';
import type { SavedWorkspace } from '@/lib/workspace';
import { toHubSpotSyncContact } from '@/lib/hubspot-sync';
import { toSalesforceSyncLead } from '@/lib/salesforce-sync';
import { importMatchSourceKey, isConfirmedImportMatch, nativeMatchTargetKey, type ConfirmedImportMatch } from '@/lib/import-match-decision';
import { readConfirmedTarget, verifyImportMatch } from '@/lib/import-match-decision-server';

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
    let updatePolicy: CrmUpdatePolicy;
    try { updatePolicy = normalizeCrmUpdatePolicy(payload.updatePolicy); }
    catch { return Response.json({ error: 'Choose a valid CRM update policy and supported fields.' }, { status: 400 }); }
    const workspace = typeof payload.workspaceId === 'string' && persistenceEnabled() ? await getWorkspace(payload.workspaceId) : null;
    if (!workspace) return Response.json({ error: 'Save and select this import workspace before comparing or writing CRM records.' }, { status: 400 });
    if (workspace.state.crmUpdatePolicy && JSON.stringify(normalizeCrmUpdatePolicy(workspace.state.crmUpdatePolicy)) !== JSON.stringify(updatePolicy)) {
      return Response.json({ error: 'The saved update policy changed. Reload the workspace and refresh the comparison.' }, { status: 409 });
    }
    const sourceFile = typeof payload.sourceFile === 'string' ? payload.sourceFile : 'crm-workspace';
    const current = await createPlan(payload.connectorId, sourceFile, contacts, workspace, updatePolicy);
    if (payload.action === 'preview') return Response.json(current, { headers: { 'Cache-Control': 'no-store' } });
    if (payload.action !== 'execute' || !isCrmWritePlan(payload.plan) || !planStillMatches(payload.plan, current)) {
      return Response.json({ error: 'The preview is stale. Refresh the change plan before writing.' }, { status: 409 });
    }
    // Revalidate current values, then retain the identity of the reviewed preview
    // so its receipt, rollback and later verification all refer to that same plan.
    return Response.json(await executePlan({ ...current, planId: payload.plan.planId }, contacts), { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('CRM write-back failed', error);
    return Response.json({ error: error instanceof Error ? error.message : 'CRM write-back failed.' }, { status: 502 });
  }
}

async function createPlan(connectorId: CrmWritePlan['connectorId'], sourceFile: string, contacts: PortableCrmContact[], workspace: SavedWorkspace, updatePolicy: CrmUpdatePolicy) {
  const rowHolds = new Map<string, string>();
  for (const contact of contacts) {
    const saved = workspace.state.contacts.filter((row) => row?.contactId === contact.contactId);
    if (saved.length !== 1 || saved[0].recordStatus !== 'active') {
      rowHolds.set(contact.contactId, 'This row is no longer a unique active row in the saved import. Refresh the workspace and comparison.');
      continue;
    }
    if (saved[0].importExclusion) {
      rowHolds.set(contact.contactId, `Skipped for this import: ${saved[0].importExclusion.reason}`);
      continue;
    }
    try {
      const portable = connectorId === 'hubspot' ? toHubSpotSyncContact(saved[0]) : toSalesforceSyncLead(saved[0]);
      if (['contactId', 'email', ...portableCrmFieldNames].some((field) => (portable[field as keyof PortableCrmContact]?.trim() || null) !== (contact[field as keyof PortableCrmContact]?.trim() || null))) {
        rowHolds.set(contact.contactId, 'This row changed in the saved import. Refresh the workspace and comparison.');
      }
    } catch { rowHolds.set(contact.contactId, 'This saved row is not eligible for this CRM. Resolve its import issues before writing.'); }
  }
  const existing = await readExisting(connectorId, contacts);
  const matchDecisions = await applyConfirmedMatches(connectorId, contacts, workspace, existing, rowHolds);
  const now = new Date();
  const exactPlan = buildCrmWritePlan(connectorId, sourceFile, contacts, existing, now, undefined, updatePolicy, rowHolds, matchDecisions);
  if (!exactPlan.creates) return exactPlan;
  const createIds = new Set(exactPlan.records.filter((record) => record.operation === 'create').map((record) => record.contactId));
  const scan = await getLatestDuplicateScan(workspace.id, connectorId);
  const records = scan && !snapshotCoverageIssue(workspace.id, connectorId, scan, now)
    ? await getDuplicateScanRecords(scan.id) : null;
  const reviews = reviewImportCreates(connectorId, contacts.filter((contact) => createIds.has(contact.contactId)), workspace, scan, records, now);
  return buildCrmWritePlan(connectorId, sourceFile, contacts, existing, now, reviews, updatePolicy, rowHolds, matchDecisions);
}

async function applyConfirmedMatches(
  connectorId: CrmWritePlan['connectorId'],
  contacts: PortableCrmContact[],
  workspace: SavedWorkspace,
  existing: Map<string, NativeCrmRecord[]>,
  rowHolds: Map<string, string>,
): Promise<Map<string, CrmMatchDecision>> {
  const included = workspace.state.contacts.filter((row) => row.recordStatus === 'active' && !row.importExclusion);
  const includedIds = new Set(included.map((row) => row.contactId));
  const requestedIds = new Set(contacts.map((row) => row.contactId));
  const selections = new Map<string, ConfirmedImportMatch>();
  const claims = new Map<string, Set<string>>();
  const importedEmails = new Map<string, Set<string>>();
  const hold = (contactId: string, reason: string) => {
    if (requestedIds.has(contactId) && !rowHolds.has(contactId)) rowHolds.set(contactId, reason);
  };
  for (const row of included) {
    const email = (row.normalizedEmail || row.rawEmail).trim().toLowerCase();
    if (email) {
      const rows = importedEmails.get(email) ?? new Set<string>();
      rows.add(row.contactId);
      importedEmails.set(email, rows);
    }
    const decision: unknown = row.crmMatchDecisions?.[connectorId];
    if (decision === undefined) continue;
    if (!isConfirmedImportMatch(decision) || decision.connectorId !== connectorId
      || decision.sourceKey !== importMatchSourceKey(row) || !await verifyImportMatch(workspace.id, decision)) {
      hold(row.contactId, 'The saved match confirmation is invalid or the imported row changed. Review and confirm this person again before importing.');
      continue;
    }
    selections.set(row.contactId, decision);
    const key = `${decision.target.objectType}:${decision.target.nativeId}`;
    const rows = claims.get(key) ?? new Set<string>();
    rows.add(row.contactId);
    claims.set(key, rows);
  }
  // Reuse the identities already read for this batch and saved confirmations.
  // Primary and additional emails can identify one person in separate batches.
  const includeTarget = (target: NativeCrmRecord, contactId?: string) => {
    const key = `${target.objectType}:${target.nativeId}`;
    const rows = claims.get(key) ?? new Set<string>();
    if (contactId) rows.add(contactId);
    for (const email of [target.email, ...target.additionalEmails ?? []]) {
      for (const rowId of importedEmails.get(email.trim().toLowerCase()) ?? []) rows.add(rowId);
    }
    claims.set(key, rows);
  };
  for (const decision of selections.values()) includeTarget(decision.target);
  for (const contact of contacts) {
    if (!includedIds.has(contact.contactId)) continue;
    for (const target of existing.get(contact.email.toLowerCase()) ?? []) includeTarget(target, contact.contactId);
  }
  for (const rows of claims.values()) {
    if (rows.size > 1) for (const contactId of rows) {
      hold(contactId, 'Multiple included import rows target this CRM person. Skip or resolve the other row before writing, including rows in later batches.');
    }
  }
  const decisions = new Map<string, CrmMatchDecision>();
  for (const contact of contacts) {
    const decision = selections.get(contact.contactId);
    if (!decision || rowHolds.has(contact.contactId)) continue;
    const current = await readConfirmedTarget(connectorId, decision.target.nativeId);
    if (!current || current.objectType !== (connectorId === 'hubspot' ? 'contact' : 'lead')
      || (connectorId === 'salesforce' && current.isConverted !== false)
      || nativeMatchTargetKey(current) !== nativeMatchTargetKey(decision.target)) {
      hold(contact.contactId, 'The confirmed CRM record changed or is no longer an eligible update target. Review and confirm this person again before importing.');
      continue;
    }
    if ((existing.get(contact.email.toLowerCase()) ?? []).some((match) => match.nativeId !== current.nativeId || match.objectType !== current.objectType)) {
      hold(contact.contactId, 'This imported email now matches a different CRM record than the person you confirmed. Resolve that identity conflict before importing.');
      continue;
    }
    existing.set(contact.email.toLowerCase(), [current]);
    decisions.set(contact.contactId, { nativeId: current.nativeId, email: current.email, reason: decision.reason, confirmedAt: decision.confirmedAt });
  }
  return decisions;
}

async function readExisting(connectorId: CrmWritePlan['connectorId'], contacts: PortableCrmContact[]) {
  if (connectorId === 'hubspot') {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) throw new Error('HubSpot preview requires a private-app token with contact read and write scopes.');
    return readHubSpotExisting(contacts, token);
  }
  const { apiRoot, headers } = salesforceConnection();
  return readSalesforceExisting(contacts, apiRoot, headers);
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
    const receipt = await createHubSpotContacts({ syncId: runId, sourceFile: plan.sourceFile, contacts }, token);
    records.push(...receipt.records.map((record) => ({
      contactId: record.contactId,
      email: record.email,
      nativeId: record.hubSpotId,
      status: record.status === 'failed' ? 'failed' as const : 'created' as const,
      error: record.error,
    })));
  }

  if (updates.length) {
    const response = await fetch('https://api.hubapi.com/crm/objects/2026-03/contacts/batch/update', {
      method: 'POST', cache: 'no-store', headers: hubSpotHeaders(token), signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ inputs: updates.map((record) => ({
        id: record.nativeId,
        objectWriteTraceId: `${runId}:${record.contactId}`,
        properties: toHubSpotFieldPayload(record.after, record.changes.map((change) => change.field)),
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
        ...(operation === 'create' ? compact({ Email: record.email, ...toSalesforceFieldPayload(record.after) }) : toSalesforceFieldPayload(record.after, record.changes.map((change) => change.field))),
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
      error: errors.map((error) => [stringValue(error.statusCode) || stringValue(error.errorCode), stringValue(error.message)].filter(Boolean).join(': ')).filter(Boolean).join('; ') || 'Salesforce rejected this record.',
    };
  });
}

async function executeRollback(rollback: CrmRollbackPlan): Promise<CrmWritebackReceipt> {
  const proposed = rollback.records.map((record): PortableCrmContact => ({
    contactId: record.contactId, email: record.targetEmail ?? record.email,
    firstName: record.after.firstName ?? '', lastName: record.after.lastName ?? '',
    company: record.after.company, phone: record.after.phone, jobTitle: record.after.jobTitle, website: record.after.website,
  }));
  const current = await readExisting(rollback.connectorId, proposed);
  const eligible: CrmRollbackRecord[] = [];
  const alreadyRestored: CrmWritebackReceipt['records'] = [];
  const conflicts: CrmWritebackReceipt['records'] = [];
  for (const record of rollback.records) {
    const native = (current.get((record.targetEmail ?? record.email).toLowerCase()) ?? []).find((candidate) => candidate.nativeId === record.nativeId) ?? null;
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
        : { contactId: record.contactId, email: record.email, nativeId: record.nativeId, status: 'failed', error: errors.map((error) => [stringValue(error.statusCode) || stringValue(error.errorCode), stringValue(error.message)].filter(Boolean).join(': ')).filter(Boolean).join('; ') || 'Salesforce rejected this rollback.' };
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

function compact(value: Record<string, string | null>) { return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== null)); }
function hubSpotHeaders(token: string) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }; }
function salesforceConnection() {
  const raw = process.env.SALESFORCE_INSTANCE_URL;
  const accessToken = process.env.SALESFORCE_ACCESS_TOKEN;
  if (!raw || !accessToken) throw new Error('Salesforce connection unavailable.');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('Salesforce instance must use HTTPS.');
  const apiVersion = process.env.SALESFORCE_API_VERSION ?? DEFAULT_API_VERSION;
  return { instanceUrl: url.origin, accessToken, apiVersion, apiRoot: `${url.origin}/services/data/v${apiVersion}`, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json', 'Sforce-Duplicate-Rule-Header': 'allowSave=false' } };
}
function stringValue(value: unknown) { return typeof value === 'string' ? value : ''; }
function nullableString(value: unknown): string | null { const cleaned = stringValue(value).trim(); return cleaned || null; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
