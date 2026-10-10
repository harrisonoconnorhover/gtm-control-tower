import { hubspotWatchdogSource, WATCHDOG_PROPERTIES, type WatchdogSource } from './watchdog-hubspot';
import { inspectWatchdogContact, watchdogContactLabel } from './watchdog-rules';
import {
  assertWatchdogLease, checkpointWatchdog, claimWatchdogRepair, claimWatchdogTick, finishWatchdogRepair,
  getContactFindings, getPendingWatchdogRepairs, getWatchdogAccount, getWatchdogSnapshot, readWatchdogReport, releaseWatchdogTick,
  saveWatchdogObservation, saveWatchdogRun, setWatchdogConfig, setWatchdogFindingError, updateWatchdogTriage,
  type WatchdogAccount,
} from './watchdog-store';
import type { WatchdogConfig, WatchdogContact, WatchdogFinding, WatchdogOverview, WatchdogRun } from './watchdog-types';

const INDEX_LAG_MS = 120_000;
const OVERLAP_MS = 300_000;
const RECONCILE_MS = 86_400_000;

export async function getWatchdogOverview(accountId: string): Promise<WatchdogOverview> {
  const account = await getWatchdogAccount(accountId);
  const report = await readWatchdogReport(accountId);
  const count = (status: WatchdogFinding['status']) => report.counts.find((row) => row.status === status)?.count ?? 0;
  return {
    accountId, config: JSON.parse(account.config_json) as WatchdogConfig, phase: account.phase,
    lastCheckedAt: account.last_checked_at, watermark: account.watermark, nextCheckAt: account.next_check_at,
    findings: report.findings, runs: report.runs,
    totals: { open: count('open'), inProgress: count('in_progress'), fixed: count('fixed'), resolved: count('resolved'), unknown: count('unknown') },
    coverageNote: `${account.phase === 'baseline' ? 'Full contact baseline is incomplete; saved pages continue on subsequent ticks.' : 'Contact baseline complete; polling changed contacts.'} Each tick scans at most 50 contacts and attempts at most 5 repairs. Polling uses a 2-minute indexing lag, a 5-minute overlap, and a daily full reconciliation. It is not an event stream: intermediate changes and archived/deleted contacts are outside coverage. This report shows up to 100 findings and 25 recent runs; totals include all saved findings.`,
  };
}

export async function configureWatchdog(accountId: string, config: WatchdogConfig): Promise<WatchdogOverview> {
  if (!config || typeof config.enabled !== 'boolean' || typeof config.automaticRepairs !== 'boolean'
    || !Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 60 || config.intervalSeconds > 86_400
    || typeof config.defaultAssignee !== 'string' || config.defaultAssignee.length > 100) {
    throw new Error('Invalid watchdog configuration. Use a 60–86400 second interval and an assignee of at most 100 characters.');
  }
  await setWatchdogConfig(accountId, { ...config, defaultAssignee: config.defaultAssignee.trim() });
  return getWatchdogOverview(accountId);
}

export async function triageWatchdogFinding(accountId: string, input: { id: string; status: 'open' | 'in_progress' | 'resolved'; assignee: string; note: string }): Promise<WatchdogOverview> {
  if (!input || typeof input.id !== 'string' || !input.id || !['open', 'in_progress', 'resolved'].includes(input.status)
    || typeof input.assignee !== 'string' || input.assignee.length > 100 || typeof input.note !== 'string' || input.note.length > 2000) {
    throw new Error('Invalid watchdog review. Choose open, in progress, or resolved; keep assignee under 100 and note under 2000 characters.');
  }
  await getWatchdogAccount(accountId);
  await updateWatchdogTriage(accountId, { ...input, assignee: input.assignee.trim(), note: input.note.trim() });
  return getWatchdogOverview(accountId);
}

/** Routes supply a natively verified account identity. A source override is only for local fixture tests. */
export async function tickWatchdog(accountId: string, token: string, options: { force?: boolean; source?: WatchdogSource } = {}): Promise<WatchdogOverview> {
  const account = await claimWatchdogTick(accountId, options.force === true);
  if (!account?.lease_id) return getWatchdogOverview(accountId);
  const leaseId = account.lease_id;
  const config = JSON.parse(account.config_json) as WatchdogConfig;
  const run: WatchdogRun = {
    id: crypto.randomUUID(), accountId, startedAt: new Date().toISOString(), finishedAt: null,
    status: 'running', scanned: 0, opened: 0, fixed: 0, needsReview: 0, error: null, phase: account.phase,
  };
  try {
    await saveWatchdogRun(run, leaseId);
    const source = options.source ?? hubspotWatchdogSource(token);
    if (account.phase === 'changes' && !account.cursor && !account.window_end
      && account.last_baseline_at && Date.now() - Date.parse(account.last_baseline_at) >= RECONCILE_MS) {
      startBaseline(account);
    }
    if (account.phase === 'baseline' && !account.baseline_started_at) account.baseline_started_at = new Date().toISOString();
    if (account.phase === 'changes' && !account.window_end) account.window_end = new Date(Date.now() - INDEX_LAG_MS).toISOString();
    run.phase = account.phase;
    // Freeze the window before requesting a page so a restarted worker uses the same bounds.
    await checkpointWatchdog(account, leaseId);
    await assertWatchdogLease(accountId, leaseId);
    const page = account.phase === 'baseline'
      ? await source.list(account.cursor)
      : await source.changes(new Date(Date.parse(account.watermark!) - OVERLAP_MS).toISOString(), account.window_end!, account.cursor);
    if (page.contacts.length > 50 || (page.after !== null && (!page.after.trim() || page.after === account.cursor || !page.contacts.length))) {
      throw new Error('HubSpot returned an invalid, empty, or repeated page cursor. The saved cursor was not advanced.');
    }
    if (account.phase === 'changes' && (page.total === undefined || page.total >= 10_000)) {
      startBaseline(account);
      account.next_check_at = new Date(Date.now() + 1000).toISOString();
      await checkpointWatchdog(account, leaseId);
      throw new Error('HubSpot search reached its 10,000-result boundary or omitted its total. A full contact reconciliation will resume next; the previous watermark is unchanged.');
    }
    const inspectedIds = new Set<string>();
    for (const contact of page.contacts) {
      await assertWatchdogLease(accountId, leaseId);
      const previous = await getWatchdogSnapshot(accountId, contact.id);
      run.scanned += 1;
      // Search indexing may replay an older value after a verified repair.
      if (previous && Date.parse(previous.contact.updatedAt) > Date.parse(contact.updatedAt)) continue;
      const inspected = inspectWatchdogContact(contact, previous);
      const observed = await saveWatchdogObservation(accountId, leaseId, inspected.snapshot, watchdogContactLabel(contact), inspected.issues, config.defaultAssignee);
      run.opened += observed.opened;
      inspectedIds.add(contact.id);
    }
    // Drain saved findings as well as this page, including records detected before repair opt-in.
    if (config.automaticRepairs) {
      for (const { finding, snapshot } of await getPendingWatchdogRepairs(accountId)) {
        inspectedIds.add(snapshot.contact.id);
        const fixed = await repairContact(accountId, leaseId, source, snapshot.contact, finding);
        if (fixed) {
          run.fixed += 1;
          // Store the native verified contact so delayed search rows cannot reopen an old issue.
          const verified = inspectWatchdogContact(fixed, snapshot);
          await saveWatchdogObservation(accountId, leaseId, verified.snapshot, watchdogContactLabel(fixed), verified.issues, config.defaultAssignee);
        }
      }
    }
    for (const contactId of inspectedIds) {
      run.needsReview += (await getContactFindings(accountId, contactId))
        .filter((finding) => ['open', 'in_progress', 'unknown'].includes(finding.status)).length;
    }
    const finishedAt = new Date().toISOString();
    account.cursor = page.after;
    if (!page.after) {
      if (account.phase === 'baseline') {
        account.watermark = new Date(Date.parse(account.baseline_started_at!) - INDEX_LAG_MS).toISOString();
        account.last_baseline_at = finishedAt;
        account.phase = 'changes';
        account.window_end = null;
        account.next_check_at = new Date(Date.now() + 1000).toISOString();
      } else {
        account.watermark = account.window_end;
        account.window_end = null;
        account.next_check_at = new Date(Date.now() + config.intervalSeconds * 1000).toISOString();
      }
    } else account.next_check_at = new Date(Date.now() + 1000).toISOString();
    if (config.automaticRepairs && (await getPendingWatchdogRepairs(accountId, 1)).length) account.next_check_at = new Date(Date.now() + 1000).toISOString();
    account.last_checked_at = finishedAt;
    await checkpointWatchdog(account, leaseId);
    run.status = 'completed'; run.finishedAt = finishedAt;
    await saveWatchdogRun(run, leaseId);
  } catch (error) {
    run.status = 'failed'; run.finishedAt = new Date().toISOString();
    run.error = error instanceof Error ? error.message.slice(0, 600) : 'Watchdog tick failed.';
    // A failed page is retried with its saved cursor. Individual observed rows and repair claims are durable.
    account.last_checked_at = run.finishedAt;
    if (!account.next_check_at || account.next_check_at <= run.startedAt) account.next_check_at = new Date(Date.now() + config.intervalSeconds * 1000).toISOString();
    await checkpointWatchdog(account, leaseId).catch(() => undefined);
    await saveWatchdogRun(run, leaseId);
  } finally {
    await releaseWatchdogTick(accountId, leaseId);
  }
  return getWatchdogOverview(accountId);
}

async function repairContact(accountId: string, leaseId: string, source: WatchdogSource, observed: WatchdogContact, finding: WatchdogFinding): Promise<WatchdogContact | null> {
  let fresh: WatchdogContact;
  try {
    await assertWatchdogLease(accountId, leaseId, true);
    fresh = await source.read(observed.id);
    if (fresh.id !== observed.id || fresh.updatedAt !== observed.updatedAt
      || WATCHDOG_PROPERTIES.some((key) => (fresh.properties[key] ?? '') !== (observed.properties[key] ?? ''))) {
      await setWatchdogFindingError(accountId, leaseId, finding.id, 'Contact changed after detection. No repair was sent; review the next observation.');
      return null;
    }
  } catch (error) {
    await setWatchdogFindingError(accountId, leaseId, finding.id, error instanceof Error ? error.message.slice(0, 600) : 'Fresh read failed; no repair was sent.');
    return null;
  }
  await assertWatchdogLease(accountId, leaseId, true);
  const repairId = await claimWatchdogRepair(accountId, leaseId, finding);
  if (!repairId) return null;
  try {
    await assertWatchdogLease(accountId, leaseId, true);
    await source.patch(observed.id, finding.after);
    await assertWatchdogLease(accountId, leaseId);
    const verified = await source.read(observed.id);
    if (verified.id !== observed.id || Object.entries(finding.after).some(([key, value]) => verified.properties[key] !== value)
      || ['email', 'hubspot_owner_id', 'lifecyclestage'].some((key) => (verified.properties[key] ?? '') !== (fresh.properties[key] ?? ''))) {
      throw new Error('Repair readback did not match the expected values, or protected fields changed. Verify the contact in HubSpot.');
    }
    await assertWatchdogLease(accountId, leaseId);
    await finishWatchdogRepair(accountId, leaseId, repairId, finding.id, 'verified', null);
    return verified;
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 450) : 'Repair request or verification failed.';
    await finishWatchdogRepair(accountId, leaseId, repairId, finding.id, 'unknown', `${detail} Outcome is uncertain; this repair will not be replayed automatically.`);
    return null;
  }
}

function startBaseline(account: WatchdogAccount): void {
  account.phase = 'baseline'; account.cursor = null; account.window_end = null;
  account.baseline_started_at = new Date().toISOString();
}
