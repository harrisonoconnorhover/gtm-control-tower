import { compareImportedContacts, type ImportMatchInput, type MatchField } from '@/lib/import-match';
import { getDuplicateScan, getDuplicateScanRecords } from '@/lib/duplicate-scan-store';
import { operatorAccessError } from '@/lib/operator-auth';
import { persistenceEnabled } from '@/lib/workspace-store';

const allowedFields = new Set<MatchField>(['name', 'email', 'phone', 'state', 'company']);
const inputLimits = { contactId: 120, fullName: 512, email: 254, phone: 100, state: 100, company: 255 } as const;

export async function POST(request: Request) {
  const accessError = operatorAccessError(request);
  if (accessError) return accessError;
  if (!persistenceEnabled()) return Response.json({ error: 'Saved workspaces are required for a CRM comparison snapshot.' }, { status: 503 });
  let payload: unknown;
  try { payload = await request.json(); } catch { return Response.json({ error: 'A JSON body is required.' }, { status: 400 }); }
  if (!isRecord(payload) || typeof payload.workspaceId !== 'string' || !payload.workspaceId
    || typeof payload.scanId !== 'string' || !payload.scanId
    || (payload.connectorId !== 'hubspot' && payload.connectorId !== 'salesforce')
    || !Array.isArray(payload.fields) || !payload.fields.length || payload.fields.length > allowedFields.size
    || !payload.fields.every((field) => allowedFields.has(field as MatchField))
    || new Set(payload.fields).size !== payload.fields.length
    || !Array.isArray(payload.contacts) || !payload.contacts.length || payload.contacts.length > 100
    || !payload.contacts.every(isInput)
    || new Set(payload.contacts.map((contact) => contact.contactId)).size !== payload.contacts.length) {
    return Response.json({ error: 'Choose matching fields and between 1 and 100 uniquely identified imported rows.' }, { status: 400 });
  }
  try {
    const scan = await getDuplicateScan(payload.scanId);
    if (!scan || scan.workspaceId !== payload.workspaceId || scan.connectorId !== payload.connectorId) {
      return Response.json({ error: 'CRM snapshot not found for this workspace and connector.' }, { status: 404 });
    }
    if (!scan.complete) return Response.json({ error: 'Finish the CRM scan before comparing imported rows.' }, { status: 409 });
    const records = await getDuplicateScanRecords(scan.id);
    const report = compareImportedContacts(payload.contacts, records, payload.fields as MatchField[]);
    return Response.json({
      report,
      scan: {
        id: scan.id, connectorId: scan.connectorId, recordsScanned: scan.recordsScanned,
        sourceComplete: scan.sourceComplete, startedAt: scan.startedAt, completedAt: scan.completedAt,
        analysisWarnings: scan.analysisWarnings,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Import match comparison failed', error);
    return Response.json({ error: 'The CRM snapshot could not be compared. No CRM writes were made.' }, { status: 500 });
  }
}

function isInput(value: unknown): value is ImportMatchInput {
  return isRecord(value) && Object.entries(inputLimits).every(([key, maximum]) =>
    typeof value[key] === 'string' && value[key].length <= maximum)
    && typeof value.contactId === 'string' && Boolean(value.contactId.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
