export type DemoSubmission = {
  requestId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  source: string;
  campaign: string;
};

export type DemoIntakeReceipt = {
  requestId: string;
  submissionId: string;
  status: 'Routed' | 'Held' | 'Notification pending';
  reason: string;
  personId: string | null;
  personType: 'Lead' | 'Contact' | null;
  createdPerson: boolean;
  ownerId: string | null;
  ownerName: string | null;
  taskId: string | null;
  notificationStatus: 'Requested' | 'Pending' | 'Not requested';
  reusedRequest: boolean;
  links: { submission: string; person: string | null; task: string | null };
};

export function parseDemoSubmission(value: unknown): DemoSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Supply a demo request.');
  const row = value as Record<string, unknown>;
  const text = (key: string) => typeof row[key] === 'string' ? row[key].trim() : '';
  const result: DemoSubmission = {
    requestId: text('requestId'), firstName: text('firstName'), lastName: text('lastName'),
    email: text('email').toLowerCase(), phone: text('phone'), company: text('company'),
    source: text('source'), campaign: text('campaign'),
  };
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(result.requestId)) throw new Error('A stable request ID between 16 and 80 characters is required.');
  if (!result.firstName || !result.lastName || !result.company || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) {
    throw new Error('First name, last name, company, and a valid email are required.');
  }
  const limits = { firstName: 40, lastName: 80, email: 80, phone: 40, company: 255, source: 128, campaign: 128 };
  for (const [field, limit] of Object.entries(limits)) {
    if (result[field as keyof typeof limits].length > limit) throw new Error(`${field} must be ${limit} characters or fewer.`);
  }
  return result;
}

/** Validate the provider receipt before displaying a successful Salesforce operation. */
export function parseDemoReceipt(value: unknown, requestId: string, instanceUrl: string): DemoIntakeReceipt {
  if (!value || typeof value !== 'object') throw new Error('Salesforce returned an unreadable receipt. Retry the same request.');
  const row = value as Record<string, unknown>;
  const id = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value);
  if (row.requestId !== requestId || !id(row.submissionId) || !['Routed', 'Held', 'Notification pending'].includes(String(row.status)) ||
      typeof row.reason !== 'string' || typeof row.createdPerson !== 'boolean' || typeof row.reusedRequest !== 'boolean' ||
      !['Requested', 'Pending', 'Not requested'].includes(String(row.notificationStatus))) {
    throw new Error('Salesforce returned an incomplete receipt. Retry the same request.');
  }
  for (const key of ['personId', 'ownerId', 'taskId']) if (row[key] != null && !id(row[key])) throw new Error('Salesforce returned an invalid record reference.');
  if (row.personType != null && !['Lead', 'Contact'].includes(String(row.personType))) throw new Error('Salesforce returned an invalid person type.');
  if (row.ownerName != null && typeof row.ownerName !== 'string') throw new Error('Salesforce returned an invalid owner.');
  if (row.status !== 'Held' && (!row.personId || !row.ownerId || !row.taskId)) throw new Error('Salesforce did not confirm the follow-up task. Retry the same request.');
  if (row.status === 'Routed' && row.notificationStatus !== 'Requested') throw new Error('Salesforce did not confirm the notification request.');
  const base = new URL(instanceUrl).origin;
  return {
    ...(row as Omit<DemoIntakeReceipt, 'links'>),
    personId: (row.personId as string | null) ?? null,
    personType: (row.personType as DemoIntakeReceipt['personType']) ?? null,
    ownerId: (row.ownerId as string | null) ?? null,
    ownerName: (row.ownerName as string | null) ?? null,
    taskId: (row.taskId as string | null) ?? null,
    links: {
      submission: `${base}/${row.submissionId}`,
      person: row.personId ? `${base}/${row.personId}` : null,
      task: row.taskId ? `${base}/${row.taskId}` : null,
    },
  };
}
