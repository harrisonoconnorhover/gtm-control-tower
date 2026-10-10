import type { WatchdogContact, WatchdogFinding } from './watchdog-types';

// "other" and account-specific lifecycle values have no inferred ordering.
const orderedStages = ['subscriber', 'lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity', 'customer', 'evangelist'];
export type WatchdogSnapshot = { contact: WatchdogContact; lifecycleHighWater: string | null };
export type WatchdogIssue = Pick<WatchdogFinding, 'rule' | 'severity' | 'summary' | 'detail' | 'before' | 'after'>;

export function inspectWatchdogContact(contact: WatchdogContact, previous: WatchdogSnapshot | null): { issues: WatchdogIssue[]; snapshot: WatchdogSnapshot } {
  const p = contact.properties;
  const issues: WatchdogIssue[] = [];
  if (!p.email?.trim()) {
    issues.push({ rule: 'email_missing', severity: 'critical', summary: 'Email is missing', detail: 'A person should establish the correct email before identity-dependent work.', before: { email: p.email ?? '' }, after: {} });
  } else if (!validWatchdogEmail(p.email)) {
    issues.push({ rule: 'email_invalid', severity: 'critical', summary: 'Email needs review', detail: 'The address fails a basic format check. Watchdog does not guess or rewrite email addresses.', before: { email: p.email }, after: {} });
  }
  if (['salesqualifiedlead', 'opportunity', 'customer'].includes(p.lifecyclestage) && !p.hubspot_owner_id?.trim()) {
    issues.push({ rule: 'owner_missing', severity: 'warning', summary: 'Sales contact has no owner', detail: 'Assign a responsible owner in HubSpot. Watchdog does not infer routing or ownership.', before: { lifecyclestage: p.lifecyclestage, hubspot_owner_id: p.hubspot_owner_id ?? '' }, after: {} });
  }
  const currentRank = orderedStages.indexOf(p.lifecyclestage);
  const previousStage = previous?.lifecycleHighWater ?? '';
  const previousRank = orderedStages.indexOf(previousStage);
  if (currentRank >= 0 && previousRank >= 0 && currentRank < previousRank) {
    issues.push({ rule: 'lifecycle_regression', severity: 'critical', summary: 'Lifecycle stage moved backward', detail: 'A recognized lifecycle stage is below its previously observed stage. Review whether this was intentional; no stage is changed automatically.', before: { lifecyclestage: previousStage }, after: { lifecyclestage: p.lifecyclestage } });
  }
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const key of ['company', 'jobtitle']) {
    const value = p[key] ?? '';
    if (value !== value.trim()) { before[key] = value; after[key] = value.trim(); }
  }
  if (Object.keys(before).length) {
    issues.push({ rule: 'text_whitespace', severity: 'warning', summary: 'Text has surrounding whitespace', detail: Object.values(after).every(Boolean)
      ? 'Only surrounding whitespace in company or job title can be removed automatically, after a fresh read and with verified readback.'
      : 'Trimming would empty a field. A person must review this value.', before, after });
  }
  return {
    issues,
    snapshot: { contact, lifecycleHighWater: currentRank < 0 ? null : (previousRank > currentRank ? previousStage : p.lifecyclestage) },
  };
}

export function validWatchdogEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value);
}

export function watchdogContactLabel(contact: WatchdogContact): string {
  return [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ').trim()
    || contact.properties.email || `Contact ${contact.id}`;
}
