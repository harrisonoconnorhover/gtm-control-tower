export type WatchdogRule = 'email_missing' | 'email_invalid' | 'owner_missing' | 'lifecycle_regression' | 'text_whitespace';
export type WatchdogStatus = 'open' | 'in_progress' | 'resolved' | 'fixed' | 'unknown';

export type WatchdogConfig = {
  enabled: boolean;
  automaticRepairs: boolean;
  intervalSeconds: number;
  defaultAssignee: string;
};

export type WatchdogContact = {
  id: string;
  updatedAt: string;
  properties: Record<string, string>;
};

export type WatchdogFinding = {
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
