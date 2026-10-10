export type MonitorProvider = 'hubspot' | 'salesforce';
export type MonitorObjectType = 'Lead' | 'Contact';

export type MonitorRule = 'email_missing' | 'email_invalid' | 'owner_missing' | 'lifecycle_regression' | 'text_whitespace';
export type MonitorStatus = 'open' | 'in_progress' | 'resolved' | 'fixed' | 'unknown';

export type MonitorConfig = {
  enabled: boolean;
  automaticRepairs: boolean;
  intervalSeconds: number;
  defaultAssignee: string;
};

export type MonitorContact = {
  provider?: MonitorProvider;
  objectType?: MonitorObjectType;
  id: string;
  updatedAt: string;
  properties: Record<string, string>;
};

export type MonitorFinding = {
  provider: MonitorProvider;
  objectType: MonitorObjectType;
  id: string;
  accountId: string;
  contactId: string;
  contactLabel: string;
  rule: MonitorRule;
  severity: 'warning' | 'critical';
  summary: string;
  detail: string;
  status: MonitorStatus;
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

export type MonitorRun = {
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

export type MonitorOverview = {
  provider: MonitorProvider;
  objectTypes: MonitorObjectType[];
  instanceUrl?: string;
  accountId: string;
  config: MonitorConfig;
  phase: 'baseline' | 'changes';
  lastCheckedAt: string | null;
  watermark: string | null;
  nextCheckAt: string | null;
  findings: MonitorFinding[];
  runs: MonitorRun[];
  totals: { open: number; inProgress: number; fixed: number; resolved: number; unknown: number };
  coverageNote: string;
};

export const MONITOR_DEFAULT_CONFIG: MonitorConfig = {
  enabled: false,
  automaticRepairs: false,
  intervalSeconds: 300,
  defaultAssignee: 'RevOps',
};

/** Existing HubSpot keys stay intact; Salesforce is namespaced by provider, org, and object. */
export function monitorAccountScope(provider: MonitorProvider, accountId: string): string {
  return provider === 'salesforce' ? `salesforce_${accountId}` : accountId;
}

export function monitorAccountIdentity(scope: string): { provider: MonitorProvider; accountId: string } {
  return scope.startsWith('salesforce_')
    ? { provider: 'salesforce', accountId: scope.slice('salesforce_'.length) }
    : { provider: 'hubspot', accountId: scope };
}

export function monitorRecordKey(contact: Pick<MonitorContact, 'id' | 'provider' | 'objectType'>): string {
  return contact.provider === 'salesforce' ? `${contact.objectType}:${contact.id}` : contact.id;
}
