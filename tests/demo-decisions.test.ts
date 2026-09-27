import { describe, expect, it } from 'vitest';
import { buildDemoDecisionReport } from '../lib/demo-decisions';
import { executeCsvRepair, importContactsCsv } from '../lib/csv-control-tower';
import { messyLeadDemoCsv, runMessyLeadDemo } from '../lib/messy-lead-demo';

const demoReport = () => buildDemoDecisionReport(runMessyLeadDemo(), messyLeadDemoCsv());

describe('public demo decision report', () => {
  it('reconciles every source row, final status and actual field changes with the engine receipt', () => {
    const report = demoReport();
    expect(report.decisions).toHaveLength(report.summary.inputRows);
    expect(new Set(report.decisions.map((decision) => decision.contactId)).size).toBe(report.summary.inputRows);
    expect(report.decisions.filter((decision) => decision.status === 'Ready')).toHaveLength(report.summary.readyRows);
    expect(report.decisions.filter((decision) => decision.status === 'Held')).toHaveLength(report.summary.heldRows);
    expect(report.decisions.filter((decision) => decision.status === 'Merged')).toHaveLength(report.summary.mergedRows);
    expect(report.summary.readyRows + report.summary.heldRows).toBe(report.summary.activeRows);
    expect(report.summary.activeRows + report.summary.mergedRows).toBe(report.summary.inputRows);
    expect(report.decisions.filter((decision) => decision.before.ownerId !== decision.after.ownerId)).toHaveLength(report.summary.reroutedRows);
    expect(report.decisions.filter((decision) => decision.before.lifecycleStage !== decision.after.lifecycleStage)).toHaveLength(report.summary.replayedRows);
    for (const decision of report.decisions.filter((row) => row.status === 'Merged')) {
      const canonical = report.decisions.find((row) => row.contactId === decision.canonicalContactId);
      expect(canonical?.mergedContactIds).toContain(decision.contactId);
      expect(canonical?.after.normalizedEmail).toBe(decision.after.normalizedEmail);
    }
  });

  it('pairs snapshots by stable ID and leaves original snapshots and CSV unchanged', () => {
    const result = runMessyLeadDemo();
    const before = structuredClone(result);
    const csv = messyLeadDemoCsv();
    const report = buildDemoDecisionReport({ ...result, repairedContacts: [...result.repairedContacts].reverse() }, csv);
    expect(report.originalCsv).toBe(csv);
    expect(result).toEqual(before);
    for (const decision of report.decisions) {
      expect(decision.before.contactId).toBe(decision.after.contactId);
      expect(decision.before).toEqual(result.initialContacts.find((row) => row.contactId === decision.contactId));
      expect(decision.before).not.toBe(result.initialContacts.find((row) => row.contactId === decision.contactId));
    }
    const download = JSON.parse(JSON.stringify(report));
    expect(download.decisions).toEqual(report.decisions);
    expect(download.summary).toEqual(report.summary);
    expect(download.scope).toMatchObject({ execution: 'Browser only', crmWrites: 0, originalInputModified: false });
  });

  it('shows every remaining hold after both owner and stage repairs, independently of the last action', () => {
    const csv = 'contact_id,full_name,email,company,region,segment,owner_id,lifecycle_stage,expected_lifecycle_stage\nTEST-1,Example Person,invalid address,,Northeast,Enterprise,,mql,opportunity';
    const initialContacts = importContactsCsv(csv).contacts;
    const routed = executeCsvRepair(initialContacts, 'routing-overload');
    const replayed = executeCsvRepair(routed.contacts, 'stage-regression');
    const report = buildDemoDecisionReport({
      ...runMessyLeadDemo(), initialContacts, repairedContacts: replayed.contacts,
      rawRows: 1, activeRows: 1, readyRows: 0, heldRows: 1, mergedRows: 0,
      reroutedRows: routed.receipt.affectedRecords, replayedRows: replayed.receipt.affectedRecords,
    }, csv);
    const decision = report.decisions[0];
    expect(decision.status).toBe('Held');
    expect(decision.lastAction).toBe('lifecycle_replayed');
    expect(decision.holdReasons.map((reason) => reason.flag).sort()).toEqual(['invalid_email', 'missing_company']);
    expect(decision.fields.filter((field) => field.changed).map((field) => field.field)).toEqual(['ownerId', 'lifecycleStage']);
    expect(decision.explanations.some((text) => text.includes('Example routing policy'))).toBe(true);
    expect(decision.explanations.some((text) => text.includes('Replayed lifecycle'))).toBe(true);
  });

  it('distinguishes import normalization from repair changes and preserves corporate plus addresses', () => {
    const report = demoReport();
    const unicode = report.decisions.find((decision) => decision.contactId === 'LAB-042')!;
    expect(unicode.inputNormalization).toEqual({
      rawEmail: 'signal@mañana.example', normalizedEmail: 'signal@xn--maana-pta.example', changed: true,
    });
    expect(unicode.fields.find((field) => field.field === 'normalizedEmail')?.changed).toBe(false);
    const plus = report.decisions.find((decision) => decision.contactId === 'LAB-008')!;
    expect(plus.after.normalizedEmail).toContain('+');
    expect(plus.status).not.toBe('Merged');
    expect(plus.informationalFlags).toContain('plus_address_present');
    expect(plus.holdReasons.some((reason) => reason.flag === 'plus_address_present')).toBe(false);
  });
});
