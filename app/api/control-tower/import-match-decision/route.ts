import { operatorAccessError } from '@/lib/operator-auth';
import { getWorkspace, persistenceEnabled, saveWorkspace } from '@/lib/workspace-store';
import { getDuplicateScan, getDuplicateScanRecords } from '@/lib/duplicate-scan-store';
import { snapshotCoverageIssue } from '@/lib/import-create-review';
import { compareImportedContacts, type MatchField } from '@/lib/import-match';
import { importMatchSourceKey, nativeMatchTargetKey, type ConfirmedImportMatch } from '@/lib/import-match-decision';
import { readConfirmedTarget, signImportMatch } from '@/lib/import-match-decision-server';
import { toHubSpotSyncContact } from '@/lib/hubspot-sync';
import { toSalesforceSyncLead } from '@/lib/salesforce-sync';
import { portableCrmFieldNames, type NativeCrmRecord } from '@/lib/crm-workflow';

import type { LiveContactState } from '@/lib/live-control-tower';

const allowedFields = new Set<MatchField>(['name', 'email', 'phone', 'state', 'company']);

export async function POST(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  if (!persistenceEnabled()) return failure('Save a workspace before confirming a match.', 503);
  let payload: unknown;
  try { payload = await request.json(); } catch { return failure('A JSON body is required.', 400); }
  if (!isRecord(payload) || !['confirm', 'clear'].includes(String(payload.action))
    || (payload.connectorId !== 'hubspot' && payload.connectorId !== 'salesforce')
    || typeof payload.workspaceId !== 'string' || !payload.workspaceId
    || typeof payload.contactId !== 'string' || !payload.contactId
    || !Number.isInteger(payload.revision)) return failure('Choose a saved row and CRM match action.', 400);
  const connectorId = payload.connectorId;
  try {
    const workspace = await getWorkspace(payload.workspaceId);
    if (!workspace) return failure('Workspace not found.', 404);
    if (workspace.revision !== payload.revision) return failure('The workspace changed. Reload it before confirming a match.', 409);
    const rows = workspace.state.contacts.filter((row) => row.contactId === payload.contactId);
    if (rows.length !== 1) return failure('Choose a unique saved import row.', 409);
    const row = rows[0];
    const decisions = { ...row.crmMatchDecisions };
    if (payload.action === 'clear') {
      delete decisions[connectorId];
    } else {
      if (row.recordStatus !== 'active' || row.importExclusion) return failure('Restore this active import row before confirming a match.', 409);
      if (payload.sourceKey !== importMatchSourceKey(row)) return failure('The import row changed. Refresh its suggestions before confirming.', 409);
      if (typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.trim().length > 500
        || typeof payload.scanId !== 'string' || !payload.scanId || payload.scanId.length > 120
        || typeof payload.nativeId !== 'string'
        || !(connectorId === 'hubspot' ? /^\d+$/ : /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/).test(payload.nativeId)
        || payload.objectType !== (connectorId === 'hubspot' ? 'contact' : 'lead')
        || !Array.isArray(payload.fields) || !payload.fields.length || payload.fields.length > allowedFields.size
        || !payload.fields.every((field) => allowedFields.has(field as MatchField))
        || new Set(payload.fields).size !== payload.fields.length) {
        return failure('Choose a supported candidate and matching fields, and give a reason of 1–500 characters.', 400);
      }
      let portable;
      try { portable = connectorId === 'hubspot' ? toHubSpotSyncContact(row) : toSalesforceSyncLead(row); }
      catch { return failure('Resolve this row’s import issues before confirming a match.', 409); }
      const scan = await getDuplicateScan(payload.scanId);
      const coverageIssue = snapshotCoverageIssue(workspace.id, connectorId, scan);
      if (coverageIssue) return failure(coverageIssue, 409);
      const records = await getDuplicateScanRecords(scan!.id);
      if (records.length !== scan!.recordsScanned || records.length > 25_000 || records.some((record) => record.connectorId !== connectorId)) {
        return failure('The CRM snapshot is incomplete. Read a fresh complete snapshot.', 409);
      }
      const fullName = [portable.firstName, portable.lastName].filter(Boolean).join(' ');
      const report = compareImportedContacts([{
        contactId: row.contactId, fullName: fullName === row.contactId && row.fullName === row.contactId ? '' : fullName,
        email: portable.email, phone: row.phone || '', state: row.state || '', company: row.company || '',
      }], records, payload.fields as MatchField[]);
      const candidate = report.rows[0]?.candidates.find(({ record }) => record.nativeId === payload.nativeId && record.objectType === payload.objectType)?.record;
      if (!candidate) return failure('This record is not a current candidate for the saved row. Refresh the comparison.', 409);
      const target = await readConfirmedTarget(connectorId, payload.nativeId);
      if (!target || target.objectType !== payload.objectType || target.isConverted) return failure('This CRM record is missing or no longer eligible. Refresh the snapshot.', 409);
      const snapshotTarget: NativeCrmRecord = {
        nativeId: candidate.nativeId, objectType: candidate.objectType, email: candidate.email,
        additionalEmails: candidate.additionalEmails,
        isConverted: false,
        fields: Object.fromEntries(portableCrmFieldNames.map((field) => [field, candidate[field] || null])) as NativeCrmRecord['fields'],
      };
      if (nativeMatchTargetKey(target) !== nativeMatchTargetKey(snapshotTarget)) return failure('The CRM record changed since this suggestion. Refresh the snapshot and review it again.', 409);
      const decision: Omit<ConfirmedImportMatch, 'signature'> = {
        connectorId, scanId: scan!.id, sourceKey: payload.sourceKey as string,
        target, reason: payload.reason.trim(), confirmedAt: new Date().toISOString(),
      };
      decisions[connectorId] = { ...decision, signature: await signImportMatch(workspace.id, decision) };
    }
    // Provider reads may take time; do not replace edits saved while they ran.
    const latest = await getWorkspace(workspace.id);
    if (!latest || latest.revision !== workspace.revision) return failure('The workspace changed during review. Reload it and try again.', 409);
    const updated: LiveContactState = { ...row, lastAction: payload.action === 'confirm' ? 'import_match_confirmed' : 'import_match_cleared', updatedAt: new Date().toISOString(), crmMatchDecisions: decisions };
    if (!Object.keys(decisions).length) delete updated.crmMatchDecisions;
    const saved = await saveWorkspace(workspace.id, { ...workspace.state,
      contacts: workspace.state.contacts.map((contact) => contact.contactId === row.contactId ? updated : contact),
    }, updated.lastAction);
    return Response.json({ workspace: saved }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'The match could not be saved.', 502);
  }
}

function failure(error: string, status: number) { return Response.json({ error }, { status }); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
