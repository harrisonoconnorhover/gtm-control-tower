import { hubspotMonitorSource, type MonitorSource } from './monitor-hubspot';
import { inspectMonitorContact, monitorContactLabel } from './monitor-rules';
import {
  assertMonitorLease, checkpointMonitor, claimMonitorRepair, claimMonitorTick, finishMonitorRepair,
  getContactFindings, getPendingMonitorRepairs, getMonitorAccount, getMonitorSnapshot, readMonitorReport, releaseMonitorTick,
  saveMonitorObservation, saveMonitorRun, setMonitorConfig, setMonitorFindingError, updateMonitorTriage,
  type MonitorAccount,
} from './monitor-store';
import { monitorAccountIdentity, monitorRecordKey } from './monitor-types';
import { getIncidentCoverage, recordMonitorCoverage, flushIncidentNotifications, detectNativeEventReversals, queueIncidentRecheck, processIncidentRecheck, processDueIncidentExpectations, hasIncidentRecheck } from './crm-incidents';
import { takePendingMonitorEvents, markMonitorEventProcessed, markMonitorEventFailed, markMonitorEventsReconciled, getMonitorEventStatus } from './monitor-events';
import type { MonitorConfig, MonitorContact, MonitorFinding, MonitorOverview, MonitorRun } from './monitor-types';

const INDEX_LAG_MS = 120_000;
const OVERLAP_MS = 300_000;
const RECONCILE_MS = 86_400_000;

export async function getMonitorOverview(accountId: string): Promise<MonitorOverview> {
  const identity = monitorAccountIdentity(accountId);
  const account = await getMonitorAccount(accountId);
  const report = await readMonitorReport(accountId);
  const count = (status: MonitorFinding['status']) => report.counts.find((row) => row.status === status)?.count ?? 0;
  return {
    ...identity, objectTypes: identity.provider === 'salesforce' ? ['Lead', 'Contact', 'Account', 'Opportunity'] : ['Contact', 'Company', 'Deal'], config: JSON.parse(account.config_json) as MonitorConfig, phase: account.phase,
    lastCheckedAt: account.last_checked_at, watermark: account.watermark, nextCheckAt: account.next_check_at,
    findings: report.findings, runs: report.runs,
    totals: { open: count('open'), inProgress: count('in_progress'), fixed: count('fixed'), resolved: count('resolved'), unknown: count('unknown') },
    coverageNote: `${identity.provider === 'salesforce' ? 'Salesforce: unconverted Leads, Contacts, Accounts, and Opportunities, subject to readable object and field permissions. Only supported person text whitespace repairs may run automatically. ' : ''}${account.phase === 'baseline' ? 'Full record baseline is incomplete; saved pages continue on subsequent ticks.' : 'Record baseline complete; polling changed records.'} Each tick polls at most 50 records, refreshes at most 10 queued native events, and attempts at most 5 repairs within the account repair budgets. Polling uses a 2-minute indexing lag, a 5-minute overlap, and a daily full reconciliation. Optional native event intake schedules fresh reads; it cannot reconstruct intermediate values. Deleted records and replay gaps require reconciliation.${identity.provider === 'salesforce' ? ' Converted Leads leave the scan; their existing findings need human review.' : ''} This report shows up to 100 findings and 25 recent runs; totals include all saved findings.`,
  };
}

export async function configureMonitor(accountId: string, config: MonitorConfig): Promise<MonitorOverview> {
  if (!config || typeof config.enabled !== 'boolean' || typeof config.automaticRepairs !== 'boolean'
    || !Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 60 || config.intervalSeconds > 86_400
    || typeof config.defaultAssignee !== 'string' || config.defaultAssignee.length > 100) {
    throw new Error('Invalid monitor configuration. Use a 60–86400 second interval and an assignee of at most 100 characters.');
  }
  await setMonitorConfig(accountId, { ...config, defaultAssignee: config.defaultAssignee.trim() });
  return getMonitorOverview(accountId);
}

export async function triageMonitorFinding(accountId: string, input: { id: string; status: 'open' | 'in_progress' | 'resolved'; assignee: string; note: string }): Promise<MonitorOverview> {
  if (!input || typeof input.id !== 'string' || !input.id || !['open', 'in_progress', 'resolved'].includes(input.status)
    || typeof input.assignee !== 'string' || input.assignee.length > 100 || typeof input.note !== 'string' || input.note.length > 2000) {
    throw new Error('Invalid monitor review. Choose open, in progress, or resolved; keep assignee under 100 and note under 2000 characters.');
  }
  await getMonitorAccount(accountId);
  await updateMonitorTriage(accountId, { ...input, assignee: input.assignee.trim(), note: input.note.trim() });
  return getMonitorOverview(accountId);
}

/** Routes supply a natively verified account identity and the matching native source; tests may supply fixtures. */
export async function tickMonitor(accountId: string, token: string, options: { force?: boolean; source?: MonitorSource } = {}): Promise<MonitorOverview> {
  // Event hints wake the next runner poll; the account lease still enforces monitoring opt-in.
  const readyEvents = await takePendingMonitorEvents(accountId,1);
  const account = await claimMonitorTick(accountId, options.force === true || readyEvents.length>0);
  if (!account?.lease_id) return getMonitorOverview(accountId);
  const leaseId = account.lease_id;
  const config = JSON.parse(account.config_json) as MonitorConfig;
  const run: MonitorRun = {
    id: crypto.randomUUID(), accountId, startedAt: new Date().toISOString(), finishedAt: null,
    status: 'running', scanned: 0, opened: 0, fixed: 0, needsReview: 0, error: null, phase: account.phase,
  };
  try {
    await saveMonitorRun(run, leaseId);
    const identity = monitorAccountIdentity(accountId);
    const source = options.source ?? hubspotMonitorSource(token);
    if ((source.provider ?? 'hubspot') !== identity.provider || (source.accountId && source.accountId !== identity.accountId)) {
      throw new Error('Monitor source does not match the saved provider and account.');
    }
    if (account.phase === 'changes' && !account.cursor && !account.window_end
      && account.last_baseline_at && Date.now() - Date.parse(account.last_baseline_at) >= RECONCILE_MS) {
      startBaseline(account);
    }
    if (account.phase === 'baseline' && !account.baseline_started_at) account.baseline_started_at = new Date().toISOString();
    if (account.phase === 'changes' && !account.window_end) account.window_end = new Date(Date.now() - INDEX_LAG_MS).toISOString();
    const capabilities = source.capabilities ? await source.capabilities() : [];
    const priorCoverage=await getIncidentCoverage(accountId);
    const scopeExpanded=capabilities.some(capability=>capability.status!=='unavailable'&&(!priorCoverage.objectTypes.includes(capability.objectType)
      || priorCoverage.capabilities?.find(previous=>previous.objectType===capability.objectType)?.missingFields.some(field=>capability.fields.includes(field))));
    // An older object/field may not appear in the change window after access is restored. Rebaseline before declaring full coverage.
    if(scopeExpanded&&(account.phase==='changes'||priorCoverage.lastCheckedAt)) startBaseline(account);
    const coverageIssues = capabilities.filter(item => item.status !== 'available').map(item => `${item.objectType}: ${item.detail}`);
    const nativeEvents = await takePendingMonitorEvents(accountId, 10);
    // Inspect retained native values before any repair. Current reads can legitimately miss an intervening return.
    await detectNativeEventReversals(accountId,nativeEvents.filter(event=>event.recordId).map(event=>monitorRecordKey({id:event.recordId!,provider:event.provider,objectType:event.objectType})),leaseId);
    for (const event of nativeEvents) {
      await assertMonitorLease(accountId, leaseId);
      if (event.kind !== 'refresh' || !event.recordId) {
        coverageIssues.push(event.reason ?? `Native ${event.kind} event requires a new baseline.`);
        startBaseline(account);
        await recordMonitorCoverage(accountId,{status:'degraded',phase:'baseline',scanned:run.scanned,error:coverageIssues.join(' ').slice(0,1000)});
        await markMonitorEventProcessed(accountId,event.id);
        continue;
      }
      try {
        const current = await source.read(event.recordId, event.objectType);
        if (current.id !== event.recordId || (current.objectType ?? 'Contact') !== event.objectType || (current.provider ?? 'hubspot') !== identity.provider) throw new Error('Native event read returned a different record or provider.');
        if (current.coverage?.length) coverageIssues.push(...current.coverage);
        const contact = {...current,source:{...event.source,occurredAt:event.occurredAt}};
        const previous = await getMonitorSnapshot(accountId,monitorRecordKey(contact));
        if (!previous || Date.parse(previous.contact.updatedAt) <= Date.parse(contact.updatedAt)) {
          const inspected=inspectMonitorContact(contact,previous);
          const saved=await saveMonitorObservation(accountId,leaseId,inspected.snapshot,monitorContactLabel(contact),inspected.issues,config.defaultAssignee);
          run.scanned+=1; run.opened+=saved.opened;
        }
        await markMonitorEventProcessed(accountId,event.id);
      } catch (error) {
        await markMonitorEventFailed(accountId,event.id,error instanceof Error ? error.message : 'Native read failed.');
        coverageIssues.push(`A queued ${event.objectType} refresh could not be read: ${error instanceof Error ? error.message : 'Native read failed.'}`);
      }
    }
    run.phase = account.phase;
    // Freeze the window before requesting a page so a restarted worker uses the same bounds.
    await checkpointMonitor(account, leaseId);
    await assertMonitorLease(accountId, leaseId);
    const page = account.phase === 'baseline'
      ? await source.list(account.cursor)
      : await source.changes(new Date(Date.parse(account.watermark!) - OVERLAP_MS).toISOString(), account.window_end!, account.cursor);
    if (page.contacts.length > 50 || (page.after !== null && (!page.after.trim() || page.after === account.cursor || !page.contacts.length))) {
      throw new Error('CRM returned an invalid, empty, or repeated page cursor. The saved cursor was not advanced.');
    }
    if (identity.provider === 'hubspot' && account.phase === 'changes' && (page.total === undefined || page.total >= 10_000)) {
      startBaseline(account);
      account.next_check_at = new Date(Date.now() + 1000).toISOString();
      await checkpointMonitor(account, leaseId);
      throw new Error('HubSpot search reached its 10,000-result boundary or omitted its total. A full contact reconciliation will resume next; the previous watermark is unchanged.');
    }
    const inspectedIds = new Set<string>();
    for (const contact of page.contacts) {
      if (contact.coverage?.length) coverageIssues.push(...contact.coverage);
      await assertMonitorLease(accountId, leaseId);
      if ((contact.provider ?? 'hubspot') !== identity.provider || (identity.provider === 'salesforce' ? !['Lead', 'Contact', 'Account', 'Opportunity'].includes(contact.objectType ?? '') : !['Contact', 'Company', 'Deal'].includes(contact.objectType ?? 'Contact'))) {
        throw new Error('Monitor record does not match the connected provider and object scope.');
      }
      const previous = await getMonitorSnapshot(accountId, monitorRecordKey(contact));
      run.scanned += 1;
      // Search indexing may replay an older value after a verified repair.
      if (previous && Date.parse(previous.contact.updatedAt) > Date.parse(contact.updatedAt)) continue;
      const inspected = inspectMonitorContact(contact, previous);
      const observed = await saveMonitorObservation(accountId, leaseId, inspected.snapshot, monitorContactLabel(contact), inspected.issues, config.defaultAssignee);
      run.opened += observed.opened;
      inspectedIds.add(monitorRecordKey(contact));
    }
    // Drain saved findings as well as this page, including records detected before repair opt-in.
    if (config.automaticRepairs) {
      for (const { finding, snapshot } of await getPendingMonitorRepairs(accountId)) {
        inspectedIds.add(monitorRecordKey(snapshot.contact));
        const fixed = await repairContact(accountId, leaseId, source, snapshot.contact, finding);
        if (fixed) {
          run.fixed += 1;
          // Store the native verified contact so delayed search rows cannot reopen an old issue.
          const verified = inspectMonitorContact(fixed, snapshot);
          await saveMonitorObservation(accountId, leaseId, verified.snapshot, monitorContactLabel(fixed), verified.issues, config.defaultAssignee);
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
        await markMonitorEventsReconciled(accountId, account.baseline_started_at!);
        await queueIncidentRecheck(accountId,account.baseline_started_at!);
        account.phase = 'changes';
        account.window_end = null;
        account.next_check_at = new Date(Date.now() + 1000).toISOString();
      } else {
        account.watermark = account.window_end;
        account.window_end = null;
        account.next_check_at = new Date(Date.now() + config.intervalSeconds * 1000).toISOString();
      }
    } else account.next_check_at = new Date(Date.now() + 1000).toISOString();
    if (config.automaticRepairs && (await getPendingMonitorRepairs(accountId, 1)).length) account.next_check_at = new Date(Date.now() + 1000).toISOString();
    account.last_checked_at = finishedAt;
    await checkpointMonitor(account, leaseId);
    const eventStatus=await getMonitorEventStatus(accountId);
    if(eventStatus.pending) coverageIssues.push(`${eventStatus.pending} native events are awaiting a fresh read.`);
    if(eventStatus.held) coverageIssues.push(`${eventStatus.held} native events are held after repeated read failures.`);
    if(eventStatus.streams.some(stream=>stream.needsReconciliation)) coverageIssues.push('A native event gap requires a complete baseline reconciliation.');
    await recordMonitorCoverage(accountId,{status:coverageIssues.length?'degraded':'healthy',phase:account.phase,observedAt:finishedAt,scanned:run.scanned,
      baselineStartedAt:account.baseline_started_at??undefined,staleAfterSeconds:Math.max(900,config.intervalSeconds*3),error:coverageIssues.length?coverageIssues.join(' ').slice(0,1000):undefined,
      ...(capabilities.length?{capabilities,objectTypes:capabilities.filter(item=>item.status==='available'||item.status==='partial').map(item=>item.objectType)}:{})});
    await processIncidentRecheck(accountId,50,leaseId);
    const dueExpectationsRemain=await processDueIncidentExpectations(accountId,leaseId);
    const readyNativeRemain=(await takePendingMonitorEvents(accountId,1)).length>0;
    if(readyNativeRemain || dueExpectationsRemain || (!coverageIssues.length && account.phase==='changes' && await hasIncidentRecheck(accountId))) {account.next_check_at=new Date(Date.now()+1000).toISOString();await checkpointMonitor(account,leaseId);}
    run.status = 'completed'; run.finishedAt = finishedAt;
    await saveMonitorRun(run, leaseId);
  } catch (error) {
    run.status = 'failed'; run.finishedAt = new Date().toISOString();
    run.error = error instanceof Error ? error.message.slice(0, 600) : 'Monitor tick failed.';
    // A failed page is retried with its saved cursor. Individual observed rows and repair claims are durable.
    account.last_checked_at = run.finishedAt;
    if (!account.next_check_at || account.next_check_at <= run.startedAt) account.next_check_at = new Date(Date.now() + config.intervalSeconds * 1000).toISOString();
    await checkpointMonitor(account, leaseId).catch(() => undefined);
    const previousCoverage=await getIncidentCoverage(accountId);
    await recordMonitorCoverage(accountId,{status:'degraded',phase:account.phase,observedAt:run.finishedAt,scanned:run.scanned,error:run.error,objectTypes:previousCoverage.objectTypes,staleAfterSeconds:Math.max(900,config.intervalSeconds*3)});
    await saveMonitorRun(run, leaseId);
  } finally {
    await releaseMonitorTick(accountId, leaseId);
    await flushIncidentNotifications().catch(() => undefined);
  }
  return getMonitorOverview(accountId);
}

async function repairContact(accountId: string, leaseId: string, source: MonitorSource, observed: MonitorContact, finding: MonitorFinding): Promise<MonitorContact | null> {
  let fresh: MonitorContact;
  try {
    await assertMonitorLease(accountId, leaseId, true);
    fresh = await source.read(observed.id, observed.objectType);
    if (monitorRecordKey(fresh) !== monitorRecordKey(observed) || fresh.updatedAt !== observed.updatedAt
      || Object.keys({ ...fresh.properties, ...observed.properties }).some((key) => (fresh.properties[key] ?? '') !== (observed.properties[key] ?? ''))) {
      await setMonitorFindingError(accountId, leaseId, finding.id, 'Record changed after detection. No repair was sent; review the next observation.');
      return null;
    }
  } catch (error) {
    await setMonitorFindingError(accountId, leaseId, finding.id, error instanceof Error ? error.message.slice(0, 600) : 'Fresh read failed; no repair was sent.');
    return null;
  }
  const recomputed = inspectMonitorContact(fresh, null).issues.find((issue) => issue.rule === 'text_whitespace');
  if (!recomputed || JSON.stringify(recomputed.after) !== JSON.stringify(finding.after) || Object.values(finding.after).some((value) => !value)) {
    await setMonitorFindingError(accountId, leaseId, finding.id, 'Saved repair no longer matches the supported whitespace rule. No repair was sent.');
    return null;
  }
  await assertMonitorLease(accountId, leaseId, true);
  const repairId = await claimMonitorRepair(accountId, leaseId, finding);
  if (!repairId) return null;
  try {
    await assertMonitorLease(accountId, leaseId, true);
    await source.patch(observed.id, finding.after, observed.objectType);
    await assertMonitorLease(accountId, leaseId);
    const verified = await source.read(observed.id, observed.objectType);
    if (monitorRecordKey(verified) !== monitorRecordKey(observed) || Object.entries(finding.after).some(([key, value]) => verified.properties[key] !== value)
      || Object.keys(fresh.properties).filter((key) => !(key in finding.after) && key !== 'lastmodifieddate').some((key) => (verified.properties[key] ?? '') !== (fresh.properties[key] ?? ''))) {
      throw new Error('Repair readback did not match the expected values, or protected fields changed. Verify the record in its CRM.');
    }
    await assertMonitorLease(accountId, leaseId);
    await finishMonitorRepair(accountId, leaseId, repairId, finding.id, 'verified', null);
    return verified;
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 450) : 'Repair request or verification failed.';
    await finishMonitorRepair(accountId, leaseId, repairId, finding.id, 'unknown', `${detail} Outcome is uncertain; this repair will not be replayed automatically.`);
    return null;
  }
}

function startBaseline(account: MonitorAccount): void {
  account.phase = 'baseline'; account.cursor = null; account.window_end = null;
  account.baseline_started_at = new Date().toISOString();
}
