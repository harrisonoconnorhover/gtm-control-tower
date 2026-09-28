import type { ConnectorRun } from '../../lib/connector-run';
import { buildCrmWritePlan, rollbackFromPlan, type NativeCrmRecord } from '../../lib/crm-workflow';

export function verificationFixture(connectorId: 'hubspot' | 'salesforce' = 'hubspot', operation: 'create' | 'update' = 'update') {
  const fields = { firstName: 'Priya', lastName: 'Nair', company: 'Example', phone: '415-555-0123', jobTitle: 'Director', website: null };
  const current: NativeCrmRecord = { nativeId: connectorId === 'hubspot' ? '123' : '00Q000000000001EAA',
    objectType: connectorId === 'hubspot' ? 'contact' : 'lead', isConverted: false, email: 'priya@example.com', fields };
  const proposed = { contactId: 'row-1', email: current.email, ...fields };
  const plan = buildCrmWritePlan(connectorId, 'fictional.csv', [proposed], operation === 'update'
    ? new Map([[proposed.email, [{ ...current, fields: { ...fields, jobTitle: 'Manager' } }]]]) : new Map(),
  new Date(), undefined, { mode: 'replace', fields: ['jobTitle'], clearBlanks: false });
  const status = operation === 'create' ? 'created' as const : 'updated' as const;
  const run: ConnectorRun = {
    id: crypto.randomUUID(), workspaceId: 'workspace-1', connectorId, phase: 'receipt', status: 'executed', createdAt: new Date().toISOString(),
    receipt: { id: '', connectorId, phase: 'receipt', status: 'executed', summary: 'One write accepted.',
      recordsWritten: 1, recordsFailed: 0, undoAvailable: operation === 'update', createdAt: new Date().toISOString() },
    details: { plan, writeback: { accepted: true, status: 'executed', runId: '', connectorId, planId: plan.planId,
      requested: 1, created: operation === 'create' ? 1 : 0, updated: operation === 'update' ? 1 : 0, unchanged: 0, held: 0, failed: 0,
      completedAt: new Date().toISOString(), records: [{ contactId: proposed.contactId, email: proposed.email, nativeId: current.nativeId, status, error: null }],
      rollback: rollbackFromPlan(plan) } },
    undo: rollbackFromPlan(plan),
  };
  run.receipt.id = run.id;
  run.details!.writeback!.runId = run.id;
  return { run, current };
}
