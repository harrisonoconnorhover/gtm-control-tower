import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET, POST } from '../app/api/control-tower/handoff-audits/route';
import { incidentDatabase } from '../lib/crm-incidents';
import type { DestinationEvidence, HandoffManifest } from '../lib/handoff-audit';
import type { HandoffAuditOverview } from '../lib/handoff-audit-store';

const directory = mkdtempSync(join(tmpdir(), 'handoff-flow-'));
process.env.CONTROL_TOWER_SQLITE_PATH = join(directory, 'audit.db');
afterAll(() => rmSync(directory, { recursive: true, force: true }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const epoch = Date.parse('2026-10-16T12:00:00.000Z');
const at = (minutes: number) => new Date(epoch + minutes * 60_000).toISOString();
const target = (index: number) => `00Q${String(index).padStart(12, '0')}`;
const owner = '005000000000100';

function syntheticFlow(): { manifest: HandoffManifest; evidence: DestinationEvidence } {
  const manifest: HandoffManifest = {
    version: 1, name: 'Fictional webinar handoff — 250 source rows',
    sourceAccount: 'fictional_hubspot', destinationAccount: 'salesforce_fictional', capturedAt: at(-1),
    policy: {
      syncDeadlineMinutes: 15, routingDeadlineMinutes: 10, evidenceMaxAgeMinutes: 10,
      destinationMatchField: null,
      eligibilityRules: [{ field: 'consent', operator: 'equals', values: ['yes'] }, { field: 'score', operator: 'number_gte', values: ['80'] }],
      routingRules: [{ field: 'owner_id', operator: 'one_of', values: [owner] }],
    },
    rows: Array.from({ length: 250 }, (_, index) => ({
      rowId: `row-${index}`, sourceId: index >= 240 && index < 245 ? null : index >= 245 ? 'duplicate-source' : `source-${index}`,
      label: `Fictional lead ${index}`, observedAt: at(-2), sourceUpdatedAt: at(-50),
      eligibleAt: index >= 190 && index < 210 ? at(-3) : at(-45),
      properties: { consent: index >= 210 && index < 230 ? 'no' : 'yes', score: '90' },
      destinationIds: [{ objectType: 'Lead', id: target(index) }], exclusionReason: null,
      failure: index >= 150 && index < 170 ? { message: 'Synthetic validation rejection', occurredAt: at(-5), evidenceRef: `fixture-error-${index}` } : null,
    })),
  };
  const evidence: DestinationEvidence = {
    accountId: manifest.destinationAccount, observedAt: at(-1), completeThrough: at(-1), coverage: 'complete',
    limitations: ['Fictional full export; no CRM was contacted.'],
    records: manifest.rows.flatMap((_, index) => index < 150 || (index >= 230 && index < 240) ? [{
      objectType: 'Lead' as const, id: target(index), observedAt: at(-1), sourceUpdatedAt: at(-40), firstObservedAt: at(-40),
      properties: { owner_id: index >= 230 ? '00G000000000001' : owner },
    }] : []),
  };
  return { manifest, evidence };
}

async function post(body: unknown): Promise<HandoffAuditOverview> {
  const response = await POST(new Request('http://localhost/api/control-tower/handoff-audits', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-control-tower-key': 'fictional-test-key' }, body: JSON.stringify(body),
  }));
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result as HandoffAuditOverview;
}

describe('synthetic handoff flow through the actual API and SQLite store', () => {
  it('accounts for 250 rows, reconciles later arrivals, and preserves the source contract without CRM or notification actions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(epoch);
    vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'fictional-test-key');
    const fetch = vi.fn(() => { throw new Error('No external or CRM request is permitted in the handoff audit.'); });
    vi.stubGlobal('fetch', fetch);
    const { manifest, evidence } = syntheticFlow();
    const original = JSON.stringify(manifest);
    const created = await post({ action: 'create', requestId: 'synthetic-flow-250', manifest, evidence });
    const audit = created.selected!;
    expect(audit.report.counts).toEqual({ present: 160, failed: 20, missing: 20, awaiting_sync: 20, excluded: 20, unknown: 10 });
    expect(audit.report.routingCounts.routed).toBe(150);
    expect(audit.report.routingCounts.unrouted).toBe(10);
    expect(Object.values(audit.report.counts).reduce((sum, count) => sum + count, 0)).toBe(250);
    expect(new Set(audit.report.rows.map(row => row.rowId)).size).toBe(250);

    vi.setSystemTime(epoch + 3 * 60_000);
    const later: DestinationEvidence = {
      ...evidence, observedAt: at(3), completeThrough: at(3),
      records: [
        ...evidence.records.map(record => ({ ...record, observedAt: at(3),
          sourceUpdatedAt: record.properties.owner_id === owner ? record.sourceUpdatedAt : at(1),
          properties: { owner_id: owner } })),
        ...manifest.rows.slice(150, 210).map((_, offset) => ({ objectType: 'Lead' as const, id: target(150 + offset),
          observedAt: at(3), sourceUpdatedAt: at(1), firstObservedAt: at(2), properties: { owner_id: owner } })),
      ],
    };
    const reconciled = (await post({ action: 'reconcile', id: audit.id, evidence: later })).selected!;
    expect(reconciled.report.counts).toEqual({ present: 220, failed: 0, missing: 0, awaiting_sync: 0, excluded: 20, unknown: 10 });
    expect(reconciled.report.routingCounts.routed).toBe(220);
    expect(JSON.stringify(reconciled.manifest)).toBe(original);
    expect(reconciled.history).toHaveLength(2);
    expect(reconciled.report.rows.find(row => row.rowId === 'row-150')?.evidence.failure?.evidenceRef).toBe('fixture-error-150');

    const db = await incidentDatabase();
    const before = await db.prepare('SELECT COUNT(*) AS count FROM handoff_audit_reports').first();
    const loaded = await GET(new Request(`http://localhost/api/control-tower/handoff-audits?id=${audit.id}`, { headers: { 'x-control-tower-key': 'fictional-test-key' } }));
    expect(loaded.status).toBe(200);
    const saved = await loaded.json() as HandoffAuditOverview;
    expect(saved.selected?.report.counts.present).toBe(220);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM handoff_audit_reports').first()).toEqual(before);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM operation_notification_outbox').first()).toEqual({ count: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM crm_incidents').first()).toEqual({ count: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM crm_observed_records').first()).toEqual({ count: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
