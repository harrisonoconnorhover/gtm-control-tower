import { describe, expect, it } from 'vitest';
import { buildCrmReviewCsv } from '../lib/crm-review-export';
import { buildCrmWritePlan, type CrmPlanRecord, type CrmWritebackReceipt, type CrmWritePlan } from '../lib/crm-workflow';

const fields = { firstName: 'Nina', lastName: 'Shah', company: 'Costco', phone: null, jobTitle: 'Director', website: null };
const now = new Date('2026-09-28T00:00:00Z');
function row(contactId: string, operation: CrmPlanRecord['operation'] = 'create'): CrmPlanRecord {
  return { contactId, email: `${contactId}@example.com`, nativeId: null, operation, matches: [],
    before: null, after: fields, changes: [], reason: null };
}
function plan(records: CrmPlanRecord[]): CrmWritePlan {
  return { ...buildCrmWritePlan('hubspot', 'conference.csv', [], new Map(), now), records,
    requested: records.length, creates: records.filter((item) => item.operation === 'create').length,
    updates: records.filter((item) => item.operation === 'update').length,
    unchanged: records.filter((item) => item.operation === 'unchanged').length,
    held: records.filter((item) => item.operation === 'hold').length };
}
function result(contactId: string, status: CrmWritebackReceipt['records'][number]['status'], error: string | null = null): CrmWritebackReceipt['records'][number] {
  return { contactId, email: `${contactId}@example.com`, nativeId: status === 'failed' ? null : `native-${contactId}`, status, error };
}
function receipt(records: CrmWritebackReceipt['records']): CrmWritebackReceipt {
  return { accepted: true, status: 'partial', runId: 'run-1', connectorId: 'hubspot', planId: 'plan-1',
    requested: records.length, created: records.filter((item) => item.status === 'created').length,
    updated: records.filter((item) => item.status === 'updated' || item.status === 'rolled_back').length,
    unchanged: records.filter((item) => item.status === 'unchanged').length,
    held: records.filter((item) => item.status === 'held').length, failed: records.filter((item) => item.status === 'failed').length,
    completedAt: now.toISOString(), records, rollback: null };
}

// Decode CSV independently so assertions check cell contents after ordinary CSV
// parsing, including quoted newlines and commas, rather than string fragments.
function decode(csv: string): Record<string, string>[] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { cells.push(cell); cell = ''; }
    else if (char === '\r' && csv[index + 1] === '\n' && !quoted) {
      records.push([...cells, cell]); cells = []; cell = ''; index++;
    } else cell += char;
  }
  expect(quoted).toBe(false);
  const [header, ...data] = records;
  return data.map((values) => {
    expect(values).toHaveLength(header.length);
    return Object.fromEntries(header.map((name, index) => [name, values[index]]));
  });
}

describe('CRM spreadsheet review reports', () => {
  it('exports every comparison action without claiming it happened', () => {
    const comparison = plan(['create', 'update', 'unchanged', 'hold'].map((operation) => row(operation, operation as CrmPlanRecord['operation'])));
    const exported = decode(buildCrmReviewCsv({ plan: comparison }));
    expect(exported.map((item) => item.planned_action)).toEqual(['create', 'update', 'unchanged', 'hold']);
    expect(exported.every((item) => item.report_kind === 'comparison' && item.report_scope === 'current_batch' && item.outcome === '' && item.run_id === '')).toBe(true);
    expect(exported[0]).toMatchObject({ plan_requested: '4', plan_creates: '1', plan_updates: '1', plan_unchanged: '1', plan_held: '1', receipt_requested: '' });
  });

  it('joins reordered partial receipts by contact ID, marks absent outcomes, and retains receipt-only rows', () => {
    const comparison = plan([row('one'), row('two', 'update'), row('missing', 'unchanged'), { ...row('held', 'hold'), reason: 'Possible duplicate' }]);
    const writeback = receipt([result('two', 'failed', 'Provider rejected update'), result('extra', 'created'), result('held', 'held'), result('one', 'created')]);
    const exported = decode(buildCrmReviewCsv({ plan: comparison, writeback }));
    expect(exported.map((item) => [item.contact_id, item.planned_action, item.outcome])).toEqual([
      ['one', 'create', 'created'], ['two', 'update', 'failed'], ['missing', 'unchanged', 'no_receipt'],
      ['held', 'hold', 'held'], ['extra', '', 'created'],
    ]);
    expect(exported[1]).toMatchObject({ reason: 'Provider rejected update', native_id: '', run_id: 'run-1', receipt_failed: '1' });
    expect(exported[3].reason).toBe('Possible duplicate');
    expect(exported[4]).toMatchObject({ native_id: 'native-extra', field_changes: '', exact_match_count: '', crm_candidate_total: '' });
  });

  it('exports legacy receipt-only and rollback outcomes without fabricating a comparison', () => {
    const writeback = receipt([result('restored', 'rolled_back'), result('changed', 'held', 'CRM changed since update'), result('retry', 'failed', 'Rate limited'), result('same', 'unchanged')]);
    const exported = decode(buildCrmReviewCsv({ writeback }));
    expect(exported.map((item) => item.outcome)).toEqual(['rolled_back', 'held', 'failed', 'unchanged']);
    expect(exported.every((item) => item.report_kind === 'results' && item.planned_action === '' && item.source_file === '' && item.plan_requested === '' && item.field_changes === '')).toBe(true);
    expect(exported[0]).toMatchObject({ receipt_updated: '1', receipt_held: '1', receipt_failed: '1', receipt_unchanged: '1' });
  });

  it('keeps CRM and import evidence namespaces and total/shown counts distinct', () => {
    const evidence = [{ key: 'name', label: 'Exact name', weight: 32, tone: 'supporting' as const }];
    const comparison = plan([{ ...row('held', 'hold'),
      matches: [{ nativeId: 'shared-id', objectType: 'lead', email: 'crm@example.com' }],
      possibleMatches: [{ nativeId: 'shared-id', objectType: 'contact', email: 'crm@example.com', fullName: 'Nina Shah', score: 72, evidence }],
      possibleImportMatches: [{ contactId: 'shared-id', email: 'import@example.com', fullName: 'Nina Shah', score: 28, evidence }],
      createReview: { status: 'held', scanId: 'scan-1', startedAt: now.toISOString(), ruleVersion: 'test-v1', candidateCount: 8,
        importCandidateCount: 5, warnings: ['Only three candidates are shown.'] },
      reason: 'Review candidates before importing.',
    }]);
    const [exported] = decode(buildCrmReviewCsv({ plan: comparison }));
    expect(exported).toMatchObject({ exact_match_count: '1', crm_candidate_total: '8', crm_candidates_shown: '1',
      import_candidate_total: '5', import_candidates_shown: '1', snapshot_id: 'scan-1', snapshot_started_at: now.toISOString(),
      match_score_basis: 'evidence_score_0_to_100_not_probability' });
    expect(JSON.parse(exported.exact_matches)).toEqual(comparison.records[0].matches);
    expect(JSON.parse(exported.crm_candidates)[0]).toMatchObject({ nativeId: 'shared-id', score: 72, evidence });
    expect(JSON.parse(exported.crm_candidates)[0]).not.toHaveProperty('contactId');
    expect(JSON.parse(exported.import_candidates)[0]).toMatchObject({ contactId: 'shared-id', score: 28, evidence });
    expect(JSON.parse(exported.import_candidates)[0]).not.toHaveProperty('nativeId');
    expect(JSON.parse(exported.review_warnings)).toEqual(['Only three candidates are shown.']);
  });

  it('retains commas, quotes, CRLF, Unicode, and before/after nulls without changing source data', () => {
    const comparison = plan([{ ...row('unicode', 'update'), email: 'Niná, "Shah"\r\n@example.com',
      changes: [{ field: 'jobTitle', before: null, after: 'Directrice, "GTM"\r\n東京' }], reason: 'Check comma, quote " and\r\nnewline — 東京' }]);
    const unchangedInput = structuredClone(comparison);
    const [exported] = decode(buildCrmReviewCsv({ plan: comparison }));
    expect(exported.email).toBe(comparison.records[0].email);
    expect(exported.reason).toBe(comparison.records[0].reason);
    expect(JSON.parse(exported.field_changes)).toEqual(comparison.records[0].changes);
    expect(comparison).toEqual(unchangedInput);
  });

  it.each(['=SUM(1,2)', '  +SUM(1,2)', '\t=SUM(1,2)', '\r\n-CMD()', '\uFEFF@SUM(1,2)', '\u200b=SUM(1,2)', '\tplain text'])('neutralizes spreadsheet formula/control prefix %j only in the report', (input) => {
    const comparison = plan([{ ...row(input), email: input, reason: input }]);
    comparison.sourceFile = input;
    const [exported] = decode(buildCrmReviewCsv({ plan: comparison }));
    for (const column of ['contact_id', 'email', 'reason', 'source_file']) expect(exported[column]).toBe(`'${input}`);
    expect(comparison.records[0].contactId).toBe(input);
    expect(comparison.records[0].reason).toBe(input);
  });

  it('retains an explicit update policy and leaves absent legacy policy blank', () => {
    const comparison = plan([row('one')]);
    comparison.updatePolicy = { mode: 'fill-empty', fields: ['jobTitle'], clearBlanks: false };
    expect(JSON.parse(decode(buildCrmReviewCsv({ plan: comparison }))[0].update_policy)).toEqual(comparison.updatePolicy);
    delete comparison.updatePolicy;
    expect(decode(buildCrmReviewCsv({ plan: comparison }))[0].update_policy).toBe('');
  });

  it('returns a header-only report when no contact evidence is available', () => {
    expect(decode(buildCrmReviewCsv({}))).toEqual([]);
  });
});
