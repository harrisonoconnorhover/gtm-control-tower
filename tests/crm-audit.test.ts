import { describe, expect, it } from 'vitest';
import { auditContactsCsv, renderCrmAuditMarkdown } from '../lib/crm-audit';

const messyCsv = `contact_id,full_name,email,normalized_email,company,region,segment,lifecycle_stage,expected_lifecycle_stage,owner_id
C-1,Alex Morgan,alex@example.com,,Example Inc,Northeast,Enterprise,customer,customer,NE-ENT
C-2,Alex Morgan,ALEX+EVENT@EXAMPLE.COM,alex@example.com,Example Inc,Northeast,Enterprise,mql,customer,NE-ENT
C-3,Mia Santos,mia.santos @ gmail.com,,,West,SMB,lead,lead,
C-4,Robin Cho,robin@oak.co,,Oak Co,Northeast,Mid-Market,mql,sql,NE-MM`;

describe('browser-only CRM audit', () => {
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
