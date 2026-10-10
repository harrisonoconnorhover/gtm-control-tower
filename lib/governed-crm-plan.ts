import { hasPomadeOrigin } from './pomade-handoff';
import { readHubSpotExisting } from './crm-existing-hubspot';
import { readSalesforceExisting } from './crm-existing-salesforce';
import { buildCrmWritePlan, normalizeImportRecordMode, portableCrmFieldNames, type CrmWritePlan, type CrmUpdatePolicy, type PortableCrmContact, type CrmMatchDecision, type NativeCrmRecord } from './crm-workflow';
import { getDuplicateScanRecords, getLatestDuplicateScan } from './duplicate-scan-store';
import { reviewImportCreates, snapshotCoverageIssue } from './import-create-review';
import type { SavedWorkspace } from './workspace';
import { toHubSpotSyncContact } from './hubspot-sync';
import { toSalesforceSyncLead, toSalesforceUpdateContact } from './salesforce-sync';
import { salesforceConnection } from './crm-account';
import { importMatchSourceKey, isConfirmedImportMatch, nativeMatchTargetKey, type ConfirmedImportMatch } from './import-match-decision';
import { readConfirmedTarget, verifyImportMatch } from './import-match-decision-server';

export async function createGovernedCrmPlan(connectorId: CrmWritePlan['connectorId'], sourceFile: string, contacts: PortableCrmContact[], workspace: SavedWorkspace, updatePolicy: CrmUpdatePolicy) {
  const recordMode = normalizeImportRecordMode(workspace.state.importRecordMode);
  const safeImport = workspace.state.importRecipe === 'safe-update-contacts' && recordMode === 'update-existing';
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
      const portable = connectorId === 'hubspot' ? toHubSpotSyncContact(saved[0])
        : safeImport ? toSalesforceUpdateContact(saved[0]) : toSalesforceSyncLead(saved[0]);
      if (['contactId', 'email', ...portableCrmFieldNames].some((field) => (portable[field as keyof PortableCrmContact]?.trim() || null) !== (contact[field as keyof PortableCrmContact]?.trim() || null))) {
        rowHolds.set(contact.contactId, 'This row changed in the saved import. Refresh the workspace and comparison.');
      }
    } catch { rowHolds.set(contact.contactId, 'This saved row is not eligible for this CRM. Resolve its import issues before writing.'); }
  }
  const existing = await readExisting(connectorId, contacts, safeImport);
  const matchDecisions = await applyConfirmedMatches(connectorId, contacts, workspace, existing, rowHolds, safeImport);
  const now = new Date();
  const initialPlan = buildCrmWritePlan(connectorId, sourceFile, contacts, existing, now, undefined, updatePolicy, rowHolds, matchDecisions, recordMode, safeImport);
  for (const record of initialPlan.records) {
    if (record.operation === 'create' && workspace.state.contacts.some((row) => row.contactId === record.contactId && hasPomadeOrigin(row))) {
      rowHolds.set(record.contactId, 'This Pomade handoff permits existing-record updates only. No new CRM person will be created.');
    }
  }
  const exactPlan = buildCrmWritePlan(connectorId, sourceFile, contacts, existing, now, undefined, updatePolicy, rowHolds, matchDecisions, recordMode, safeImport);
  const createIds = new Set(exactPlan.records.filter((record) => recordMode === 'update-existing'
    ? !record.matches.length && !rowHolds.has(record.contactId)
    : record.operation === 'create').map((record) => record.contactId));
  if (!createIds.size) return exactPlan;
  const scan = await getLatestDuplicateScan(workspace.id, connectorId);
  const records = scan && !snapshotCoverageIssue(workspace.id, connectorId, scan, now)
    ? await getDuplicateScanRecords(scan.id) : null;
  const reviews = reviewImportCreates(connectorId, contacts.filter((contact) => createIds.has(contact.contactId)), workspace, scan, records, now);
  if (recordMode === 'update-existing') for (const reviewed of reviews.values()) {
    reviewed.reason = reviewed.possibleMatches.length || reviewed.possibleImportMatches?.length
      ? 'Possible existing identity or duplicate import row. Compare the evidence and confirm the person, or skip this row. No update is scheduled.'
      : 'No confirmed existing match. This row will not be imported.';
    reviewed.review.status = 'held';
  }
  return buildCrmWritePlan(connectorId, sourceFile, contacts, existing, now, reviews, updatePolicy, rowHolds, matchDecisions, recordMode, safeImport);
}

async function applyConfirmedMatches(
  connectorId: CrmWritePlan['connectorId'],
  contacts: PortableCrmContact[],
  workspace: SavedWorkspace,
  existing: Map<string, NativeCrmRecord[]>,
  rowHolds: Map<string, string>,
  allowSalesforceContacts: boolean,
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
    const current = await readConfirmedTarget(connectorId, decision.target.nativeId, decision.target.objectType);
    if (!current || (connectorId === 'hubspot' ? current.objectType !== 'contact'
      : current.objectType === 'contact' ? !allowSalesforceContacts : current.isConverted !== false)
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

export async function readExisting(connectorId: CrmWritePlan['connectorId'], contacts: PortableCrmContact[], includeContactFields = false) {
  if (connectorId === 'hubspot') {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) throw new Error('HubSpot preview requires a private-app token with contact read and write scopes.');
    return readHubSpotExisting(contacts, token);
  }
  const { apiRoot, headers } = salesforceConnection();
  return readSalesforceExisting(contacts, apiRoot, headers, includeContactFields);
}
