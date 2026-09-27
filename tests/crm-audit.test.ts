import { describe, expect, it } from 'vitest';
import { auditContactsCsv, lifecycleComparisonSummary, renderCrmAuditMarkdown } from '../lib/crm-audit';

const messyCsv = `contact_id,full_name,email,normalized_email,company,region,segment,lifecycle_stage,expected_lifecycle_stage,owner_id
C-1,Alex Morgan,alex@example.com,,Example Inc,Northeast,Enterprise,customer,customer,NE-ENT
C-2,Alex Morgan,ALEX+EVENT@EXAMPLE.COM,alex@example.com,Example Inc,Northeast,Enterprise,mql,customer,NE-ENT
C-3,Mia Santos,mia.santos @ gmail.com,,,West,SMB,lead,lead,
C-4,Robin Cho,robin@oak.co,,Oak Co,Northeast,Mid-Market,mql,sql,NE-MM`;

describe('browser-only CRM audit', () => {
  it('refuses to report readiness for a row with shifted columns', () => {
    const csv = 'email,company,owner_id\nada@example.com,Acme, Inc,rep-1';
    expect(() => auditContactsCsv(csv, 'shifted.csv')).toThrow('CSV row 2 has 4 columns; the header has 3.');
  });

  it('turns a common CRM export into an aggregate readiness report', () => {
    const report = auditContactsCsv(messyCsv, 'messy.csv');

    expect(report).toMatchObject({
      fileName: 'messy.csv',
      sourceRows: 4,
      activeRows: 4,
      readyRows: 0,
      heldRows: 4,
      readinessScore: 0,
      readinessLabel: 'Blocked',
      duplicateRecords: 1,
      duplicateClusters: 1,
      invalidEmails: 1,
      missingCompanies: 1,
      missingOwners: 1,
      stageRegressions: 2,
      automatableCandidates: 3,
    });
    expect(report.priorities[0].severity).toBe('blocker');
  });

  it('reports a fully destination-ready file without inventing findings', () => {
    const report = auditContactsCsv('email,company,owner_id\nada@example.com,Analytical Engines,AE-1', 'clean.csv');

    expect(report.readinessScore).toBe(100);
    expect(report.readinessLabel).toBe('Ready');
    expect(report.readyRows).toBe(1);
    expect(report.priorities).toEqual([]);
    expect(report.expectedStageMapped).toBe(false);
    expect(report.lifecycleComparedRows).toBe(0);
    expect(lifecycleComparisonSummary(report)).toContain('no expected lifecycle stage column was mapped');
    expect(renderCrmAuditMarkdown(report)).toContain('Backward-stage comparison unavailable');
  });

  it('does not treat blank or unsupported stage values as a completed comparison', () => {
    const report = auditContactsCsv(`email,company,owner_id,lifecycle_stage,expected_stage
blank@example.com,Acme,rep-1,customer,
unknown@example.com,Acme,rep-1,customer,renewal
no-current@example.com,Acme,rep-1,,lead`, 'incomplete-stages.csv');

    expect(report).toMatchObject({ expectedStageMapped: true, lifecycleComparedRows: 0, activeRows: 3 });
    expect(lifecycleComparisonSummary(report)).toContain('none of the 3 active rows');
    expect(renderCrmAuditMarkdown(report)).toContain('Backward-stage comparison unavailable');
  });

  it('counts lifecycle coverage beyond the five-row preview and excludes merged rows', () => {
    const rows = Array.from({ length: 5 }, (_, index) => `person${index}@example.com,Acme,rep-1,mql,mql,active`);
    rows.push('blank@example.com,Acme,rep-1,mql,,active');
    rows.push('merged@example.com,Acme,rep-1,mql,,merged');
    const report = auditContactsCsv(`email,company,owner_id,lifecycle_stage,expected_stage,record_status\n${rows.join('\n')}`, 'partial.csv');

    expect(report).toMatchObject({ sourceRows: 7, activeRows: 6, expectedStageMapped: true, lifecycleComparedRows: 5 });
    expect(lifecycleComparisonSummary(report)).toContain('5 of 6 active rows');
    expect(lifecycleComparisonSummary(report)).toContain('1 row lacks a recognized current or expected stage');
  });

  it('reports a real regression with full comparison coverage and the headers actually used', () => {
    const report = auditContactsCsv(`email,company,owner_id,lifecycle_stage,Target Stage
ada@example.com,Acme,rep-1,mql,customer`, 'regression.csv', { expectedLifecycleStage: 'Target Stage' });

    expect(report).toMatchObject({ expectedStageMapped: true, lifecycleComparedRows: 1, stageRegressions: 1, readyRows: 0 });
    expect(report.mappedHeaders).toEqual(['email', 'company', 'lifecycle_stage', 'Target Stage', 'owner_id']);
    const markdown = renderCrmAuditMarkdown(report);
    expect(markdown).toContain('comparison available for every active row (1)');
    expect(markdown).toContain('Mapped CSV headers: "email", "company", "lifecycle_stage", "Target Stage", "owner_id".');
    expect(markdown).toContain('Lifecycle regressions: 1');
    expect(markdown).not.toContain('ada@example.com');
  });

  it('exports an aggregate Markdown report without contact-level identities', () => {
    const report = auditContactsCsv(messyCsv, 'messy.csv');
    const markdown = renderCrmAuditMarkdown(report);

    expect(markdown).toContain('Destination readiness:** 0%');
    expect(markdown).toContain('| Duplicate identity | 1 | blocker |');
    expect(markdown).not.toContain('alex@example.com');
    expect(markdown).not.toContain('Mia Santos');
  });
});
