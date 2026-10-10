export type WatchdogProvider = 'hubspot' | 'salesforce';
export type WatchdogObjectType = 'Lead' | 'Contact';

export type WatchdogRule = 'email_missing' | 'email_invalid' | 'owner_missing' | 'lifecycle_regression' | 'text_whitespace';
export type WatchdogStatus = 'open' | 'in_progress' | 'resolved' | 'fixed' | 'unknown';

export type WatchdogConfig = {
  enabled: boolean;
  automaticRepairs: boolean;
  intervalSeconds: number;
  defaultAssignee: string;
};

export type WatchdogContact = {
  provider?: WatchdogProvider;
  objectType?: WatchdogObjectType;
  id: string;
  updatedAt: string;
  properties: Record<string, string>;
};

export type WatchdogFinding = {
  provider: WatchdogProvider;
  objectType: WatchdogObjectType;
  id: string;
  accountId: string;
  contactId: string;
  contactLabel: string;
  rule: WatchdogRule;
  severity: 'warning' | 'critical';
  summary: string;
  detail: string;
  status: WatchdogStatus;
  assignee: string;
  note: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  occurrences: number;
  before: Record<string, string>;
  after: Record<string, string>;
  repairError: string | null;
};

export type WatchdogRun = {
  id: string;
  accountId: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'failed';
  scanned: number;
  opened: number;
  fixed: number;
  needsReview: number;
  error: string | null;
  phase: 'baseline' | 'changes';
};

export type WatchdogOverview = {
  provider: WatchdogProvider;
  objectTypes: WatchdogObjectType[];
  instanceUrl?: string;
  accountId: string;
  config: WatchdogConfig;
  phase: 'baseline' | 'changes';
  lastCheckedAt: string | null;
  watermark: string | null;
  nextCheckAt: string | null;
  findings: WatchdogFinding[];
  runs: WatchdogRun[];
  totals: { open: number; inProgress: number; fixed: number; resolved: number; unknown: number };
  coverageNote: string;
};

export const WATCHDOG_DEFAULT_CONFIG: WatchdogConfig = {
  enabled: false,
  automaticRepairs: false,
  intervalSeconds: 300,
  defaultAssignee: 'RevOps',
};

/** Existing HubSpot keys stay intact; Salesforce is namespaced by provider, org, and object. */
export function watchdogAccountScope(provider: WatchdogProvider, accountId: string): string {
  return provider === 'salesforce' ? `salesforce_${accountId}` : accountId;
}

export function watchdogAccountIdentity(scope: string): { provider: WatchdogProvider; accountId: string } {
  return scope.startsWith('salesforce_')
    ? { provider: 'salesforce', accountId: scope.slice('salesforce_'.length) }
    : { provider: 'hubspot', accountId: scope };
}

export function watchdogRecordKey(contact: Pick<WatchdogContact, 'id' | 'provider' | 'objectType'>): string {
  return contact.provider === 'salesforce' ? `${contact.objectType}:${contact.id}` : contact.id;
}
