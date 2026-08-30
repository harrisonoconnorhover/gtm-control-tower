import {
  countCsvRepairCandidates,
  importContactsCsv,
  isDestinationReadyContact,
  previewContactsCsv,
  type CsvColumnMapping,
} from './csv-control-tower';

export type CrmAuditPriority = {
  key: string;
  label: string;
  count: number;
  severity: 'blocker' | 'warning';
  recommendation: string;
};

export type CrmAuditReport = {
  fileName: string;
  generatedAt: string;
  sourceRows: number;
  activeRows: number;
  readyRows: number;
  heldRows: number;
  readinessScore: number;
  readinessLabel: 'Ready' | 'Needs cleanup' | 'At risk' | 'Blocked';
  mappedFields: number;
  mappedHeaders: string[];
  duplicateRecords: number;
  duplicateClusters: number;
  invalidEmails: number;
  missingCompanies: number;
  missingOwners: number;
  stageRegressions: number;
  plusAddresses: number;
  unicodeDomains: number;
  automatableCandidates: number;
  priorities: CrmAuditPriority[];
};

export function auditContactsCsv(
  csv: string,
  fileName: string,
  mapping?: CsvColumnMapping,
): CrmAuditReport {
  const preview = previewContactsCsv(csv);
  const effectiveMapping = mapping ?? preview.suggestedMapping;
  const { contacts, sourceRows } = importContactsCsv(csv, effectiveMapping);
  const active = contacts.filter((contact) => contact.recordStatus === 'active');
  const ready = active.filter(isDestinationReadyContact);
  const duplicateRecords = countCsvRepairCandidates(contacts, 'duplicate-surge');
  const stageRegressions = countFlag(active, 'stage_regression');
  const readinessScore = active.length ? Math.round((ready.length / active.length) * 100) : 0;

  const priorities = [
    priority('invalid_email', 'Invalid email', countFlag(active, 'invalid_email'), 'blocker', 'Hold these rows until identity is corrected.'),
    priority('duplicate_identity', 'Duplicate identity', duplicateRecords, 'blocker', 'Merge each duplicate cluster into one canonical contact.'),
    priority('missing_company', 'Missing company', countFlag(active, 'missing_company'), 'blocker', 'Enrich or review the account association before routing.'),
    priority('missing_owner', 'Missing owner', countFlag(active, 'missing_owner'), 'blocker', 'Apply a documented territory or capacity rule.'),
    priority('stage_regression', 'Lifecycle regression', stageRegressions, 'blocker', 'Replay the last valid stage instead of accepting a backward write.'),
    priority('plus_address_present', 'Plus-address identity', countFlag(active, 'plus_address_present'), 'warning', 'Review before collapsing aliases; this behavior is company-specific.'),
    priority('unicode_domain_present', 'Internationalized domain', countFlag(active, 'unicode_domain_present'), 'warning', 'Normalize the domain to its provider-safe ASCII form and retain the raw value.'),
  ].filter((item): item is CrmAuditPriority => item !== null)
    .sort((left, right) => severityRank(left.severity) - severityRank(right.severity) || right.count - left.count);

  const mappedHeaders = [...new Set(Object.values(effectiveMapping).filter((header): header is string => Boolean(header)))];

  return {
    fileName,
    generatedAt: new Date().toISOString(),
    sourceRows,
    activeRows: active.length,
    readyRows: ready.length,
    heldRows: Math.max(active.length - ready.length, 0),
    readinessScore,
    readinessLabel: readinessLabel(readinessScore),
    mappedFields: mappedHeaders.length,
    mappedHeaders,
    duplicateRecords,
    duplicateClusters: new Set(active
      .filter((contact) => contact.qualityFlags.includes('duplicate_identity'))
      .map((contact) => contact.normalizedEmail)
      .filter((email): email is string => Boolean(email))).size,
    invalidEmails: countFlag(active, 'invalid_email'),
    missingCompanies: countFlag(active, 'missing_company'),
    missingOwners: countFlag(active, 'missing_owner'),
    stageRegressions,
    plusAddresses: countFlag(active, 'plus_address_present'),
    unicodeDomains: countFlag(active, 'unicode_domain_present'),
    automatableCandidates: duplicateRecords + stageRegressions,
    priorities,
  };
}

export function renderCrmAuditMarkdown(report: CrmAuditReport): string {
  const priorityRows = report.priorities.length
    ? report.priorities.map((item) => `| ${item.label} | ${item.count} | ${item.severity} | ${item.recommendation} |`).join('\n')
    : '| No blocking issues detected | 0 | ready | Preserve the current controls and monitor new imports. |';

  return `# GTM Control Tower CRM Readiness Audit

Generated ${report.generatedAt} from \`${report.fileName}\`. This report contains aggregate counts only; the source rows remain in the operator's browser.

## Executive summary

- **Destination readiness:** ${report.readinessScore}% (${report.readinessLabel})
- **Source rows:** ${report.sourceRows}
- **Active identities:** ${report.activeRows}
- **Ready for a governed destination:** ${report.readyRows}
- **Held for review:** ${report.heldRows}
- **Immediately automatable merge/replay candidates:** ${report.automatableCandidates}

## Priority controls

| Finding | Records | Severity | Recommended control |
| --- | ---: | --- | --- |
${priorityRows}

## Detection detail

- Extra duplicate records: ${report.duplicateRecords} across ${report.duplicateClusters} identity clusters
- Invalid emails: ${report.invalidEmails}
- Missing companies: ${report.missingCompanies}
- Missing owners: ${report.missingOwners}
- Lifecycle regressions: ${report.stageRegressions}
- Plus-address identities requiring a policy decision: ${report.plusAddresses}
- Internationalized domains requiring provider-safe normalization: ${report.unicodeDomains}

## Boundary

This is a deterministic pre-write audit, not an automatic CRM mutation. Review the mapping and proposed controls before executing a merge, reroute, lifecycle replay, or destination sync.
`;
}

function countFlag(contacts: Array<{ qualityFlags: string[] }>, flag: string): number {
  return contacts.filter((contact) => contact.qualityFlags.includes(flag)).length;
}

function priority(
  key: string,
  label: string,
  count: number,
  severity: CrmAuditPriority['severity'],
  recommendation: string,
): CrmAuditPriority | null {
  return count ? { key, label, count, severity, recommendation } : null;
}

function severityRank(severity: CrmAuditPriority['severity']): number {
  return severity === 'blocker' ? 0 : 1;
}

function readinessLabel(score: number): CrmAuditReport['readinessLabel'] {
  if (score >= 90) return 'Ready';
  if (score >= 70) return 'Needs cleanup';
  if (score >= 40) return 'At risk';
  return 'Blocked';
}
