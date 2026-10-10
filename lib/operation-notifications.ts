import { enqueueSlackNotification, type SlackNotificationEvent } from './slack-notifications';
import type { WatchdogFinding, WatchdogRun } from './watchdog-types';
import { watchdogAccountIdentity } from './watchdog-types';
import type { SafeImportExecution, SafeImportReview } from './safe-import';

/** Notification failures never change an already-saved CRM or workspace outcome. */
async function publish(event: SlackNotificationEvent): Promise<void> {
  try { await enqueueSlackNotification(event); }
  catch { console.warn('A Control Tower notification could not be queued. CRM results remain saved; inspect server storage and Slack notification status.'); }
}

export async function notifyWatchdogObservation(before: WatchdogFinding[], after: WatchdogFinding[]): Promise<void> {
  for (const finding of after) {
    const previous = before.find((candidate) => candidate.id === finding.id);
    if (previous?.status === finding.status && previous.occurrences === finding.occurrences) continue;
    if (!['open', 'resolved'].includes(finding.status)) continue;
    await publish({ key: `finding:${finding.provider}:${finding.accountId}:${finding.id}:${finding.occurrences}:${finding.status}`,
      provider: finding.provider, title: finding.status === 'open' ? 'Watchdog finding needs review' : 'Watchdog finding resolved',
      summary: `${finding.objectType}: ${ruleLabel(finding.rule)}. ${finding.status === 'open' ? 'Open Control Tower to inspect the evidence and assign follow-up.' : 'The issue was no longer present on the latest observation.'}`,
      path: `/app/watchdog?provider=${finding.provider}&finding=${encodeURIComponent(finding.id)}` });
  }
}

export async function notifyWatchdogRepair(scope: string, findingId: string, repairId: string, state: 'verified' | 'unknown'): Promise<void> {
  const { provider } = watchdogAccountIdentity(scope);
  await publish({ key: `repair:${scope}:${repairId}:${state}`, provider,
    title: state === 'verified' ? 'Watchdog repair verified' : 'Watchdog repair needs verification',
    summary: state === 'verified' ? 'One supported whitespace repair was accepted and checked against the CRM.' : 'A repair outcome is uncertain. Review the saved evidence; the CRM write will not be replayed automatically.',
    path: `/app/watchdog?provider=${provider}&finding=${encodeURIComponent(findingId)}` });
}

export async function notifyWatchdogFailure(run: WatchdogRun, lastCompletedRunId: string): Promise<void> {
  if (run.status !== 'failed') return;
  const { provider } = watchdogAccountIdentity(run.accountId);
  await publish({ key: `scan:${run.accountId}:${lastCompletedRunId}:${await digest(run.error ?? '')}`, provider,
    title: 'Watchdog check failed', summary: 'The latest monitoring page did not complete. Inspect connection health and the saved run report in Control Tower.',
    path: `/app/watchdog?provider=${provider}` });
}

/** Connection errors precede a saved scan. Limit these notices to one per provider per day. */
export async function notifyWatchdogConnectionFailure(provider: 'hubspot' | 'salesforce'): Promise<void> {
  await publish({ key: `connection:${provider}:${new Date().toISOString().slice(0, 10)}`, provider,
    title: 'Watchdog connection needs attention', summary: 'A scheduled check could not verify its CRM connection. Inspect the connection in Control Tower; no scan started.',
    path: `/app/watchdog?provider=${provider}` });
}

export async function notifyImportReview(review: SafeImportReview): Promise<void> {
  const counts = review.counts;
  await publish({ key: `review:${review.id}:prepared`, provider: review.connectorId,
    title: review.complete ? (counts['proposed-update'] ? 'Safe Import review is ready' : 'Safe Import review prepared') : 'Safe Import needs information',
    summary: `${counts['proposed-update']} proposed updates; ${counts.held} held, ${counts.unmatched} unmatched, ${counts.unresolved} unresolved, ${counts.unchanged} unchanged, ${counts.skipped} skipped. ${counts['proposed-update'] ? 'Review and approve the saved proposal in Control Tower. Reviews expire after 15 minutes.' : 'Open the review for next steps.'}`,
    path: reviewPath(review) });
}

export async function notifyImportExecution(review: SafeImportReview, execution: SafeImportExecution): Promise<void> {
  const verified = execution.records.filter((record) => record.status === 'accepted' && record.verification?.status === 'verified').length;
  const uncertain = execution.records.filter((record) => ['unknown', 'sending'].includes(record.status) || (record.status === 'accepted' && record.verification?.status !== 'verified')).length;
  const remaining = review.counts.held + review.counts.unmatched + review.counts.unresolved
    + execution.records.filter((record) => ['held', 'failed', 'pending'].includes(record.status)).length;
  const fingerprint = await digest(JSON.stringify(execution.records.map((record) => ({ id: record.contactId, status: record.status, verification: record.verification?.status ?? null }))));
  await publish({ key: `execution:${execution.id}:${fingerprint}`, provider: review.connectorId,
    title: uncertain ? 'Safe Import outcomes need verification' : remaining ? 'Safe Import has follow-up work' : 'Safe Import updates verified',
    summary: `${verified} verified updates; ${uncertain} uncertain or unverified outcomes; ${remaining} records still need attention. Open the saved execution for details.`, path: reviewPath(review) });
}

export async function notifyImportReceived(id: string, workspaceId: string, provider: 'hubspot' | 'salesforce', rowCount: number): Promise<void> {
  await publish({ key: `work:${id}:received`, provider, title: 'New import request received',
    summary: `${rowCount} CSV rows saved. Prepare and inspect the review in Control Tower; receiving a file does not authorize CRM updates.`,
    path: `/app/lab?workspaceId=${encodeURIComponent(workspaceId)}` });
}

export async function notifyAssignment(provider: 'hubspot' | 'salesforce', path: string, assigned: boolean): Promise<void> {
  await publish({ key: `assignment:${crypto.randomUUID()}`, provider, title: 'Operations follow-up updated',
    summary: assigned ? 'An assignee or review decision changed. Open Control Tower to see the current owner and next step.' : 'This item needs an owner. Open Control Tower to review the next step.', path });
}

function reviewPath(review: SafeImportReview): string { return `/app/lab?workspaceId=${encodeURIComponent(review.workspaceId)}&reviewId=${encodeURIComponent(review.id)}`; }
function ruleLabel(rule: WatchdogFinding['rule']): string {
  return { email_missing: 'Missing email', email_invalid: 'Invalid email', owner_missing: 'Missing owner', lifecycle_regression: 'Lifecycle moved backward', text_whitespace: 'Extra spaces in a supported text field' }[rule];
}
async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
