import type { MonitorContact, MonitorFinding } from './monitor-types';

// "other" and account-specific lifecycle values have no inferred ordering.
const orderedStages = ['subscriber', 'lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity', 'customer', 'evangelist'];
export type MonitorSnapshot = { contact: MonitorContact; lifecycleHighWater: string | null };
export type MonitorIssue = Pick<MonitorFinding, 'rule' | 'severity' | 'summary' | 'detail' | 'before' | 'after'>;

export function inspectMonitorContact(contact: MonitorContact, previous: MonitorSnapshot | null): { issues: MonitorIssue[]; snapshot: MonitorSnapshot } {
  const p = contact.properties;
  const salesforce = contact.provider === 'salesforce';
  const issues: MonitorIssue[] = [];
  if (!p.email?.trim()) {
    issues.push({ rule: 'email_missing', severity: 'critical', summary: 'Email is missing', detail: 'A person should establish the correct email before identity-dependent work.', before: { email: p.email ?? '' }, after: {} });
  } else if (!validMonitorEmail(p.email)) {
    issues.push({ rule: 'email_invalid', severity: 'critical', summary: 'Email needs review', detail: 'The address fails a basic format check. Monitor does not guess or rewrite email addresses.', before: { email: p.email }, after: {} });
  }
  if (!salesforce && ['salesqualifiedlead', 'opportunity', 'customer'].includes(p.lifecyclestage) && !p.hubspot_owner_id?.trim()) {
    issues.push({ rule: 'owner_missing', severity: 'warning', summary: 'Sales contact has no owner', detail: 'Assign a responsible owner in HubSpot. Monitor does not infer routing or ownership.', before: { lifecyclestage: p.lifecyclestage, hubspot_owner_id: p.hubspot_owner_id ?? '' }, after: {} });
  }
  const currentRank = salesforce ? -1 : orderedStages.indexOf(p.lifecyclestage);
  const previousStage = previous?.lifecycleHighWater ?? '';
  const previousRank = orderedStages.indexOf(previousStage);
  if (currentRank >= 0 && previousRank >= 0 && currentRank < previousRank) {
    issues.push({ rule: 'lifecycle_regression', severity: 'critical', summary: 'Lifecycle stage moved backward', detail: 'A recognized lifecycle stage is below its previously observed stage. Review whether this was intentional; no stage is changed automatically.', before: { lifecyclestage: previousStage }, after: { lifecyclestage: p.lifecyclestage } });
  }
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const key of salesforce && contact.objectType === 'Contact' ? ['jobtitle'] : ['company', 'jobtitle']) {
    const value = p[key] ?? '';
    if (value !== value.trim()) { before[key] = value; after[key] = value.trim(); }
  }
  if (Object.keys(before).length) {
    issues.push({ rule: 'text_whitespace', severity: 'warning', summary: 'Text has surrounding whitespace', detail: Object.values(after).every(Boolean)
      ? salesforce && contact.objectType === 'Contact'
        ? 'Only surrounding whitespace in Contact Title can be removed automatically, after a fresh read and with verified readback. The linked Account is never changed.'
        : 'Only surrounding whitespace in company or job title can be removed automatically, after a fresh read and with verified readback.'
      : 'Trimming would empty a field. A person must review this value.', before, after });
  }
  return {
    issues,
    snapshot: { contact, lifecycleHighWater: currentRank < 0 ? null : (previousRank > currentRank ? previousStage : p.lifecyclestage) },
  };
}

export function validMonitorEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value);
}

export function monitorContactLabel(contact: MonitorContact): string {
  return [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ').trim()
    || contact.properties.email || `${contact.objectType ?? 'Contact'} ${contact.id}`;
}
