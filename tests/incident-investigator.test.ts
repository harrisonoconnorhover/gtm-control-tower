import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { incidentAccess } from '../lib/incident-access';
import { explainIncident, investigateIncident, latestIncidentInvestigation } from '../lib/incident-investigator';
import { configureIncidentPolicy, getIncident, getIncidentPolicy, ingestObservation, listIncidents, type IncidentDetail } from '../lib/crm-incidents';
import { getMonitorAccount } from '../lib/monitor-store';
import { GET, POST } from '../app/api/control-tower/incidents/route';
import { POST as approveImport } from '../app/api/control-tower/safe-import/route';

const directory = mkdtempSync(join(tmpdir(), 'incident-investigation-'));
process.env.CONTROL_TOWER_SQLITE_PATH = join(directory, 'test.db');
const scope = 'investigation-fixture';
let detail: IncidentDetail;
beforeAll(async () => {
  await getMonitorAccount(scope);
  const policy = await getIncidentPolicy(scope);
  await configureIncidentPolicy(scope, { ...policy, minimumRecords: 2 });
  for (let index = 0; index < 3; index++) {
    await ingestObservation(scope, { id: String(index), updatedAt: '2026-10-10T08:00:00Z', properties: { jobtitle: 'Director', email: `${index}@example.com` } }, { phase: 'baseline', observedAt: '2026-10-10T08:00:00Z' });
  }
  for (let index = 0; index < 3; index++) {
    await ingestObservation(scope, { id: String(index), updatedAt: '2026-10-10T08:10:00Z', properties: { jobtitle: '', email: `${index}@example.com` } }, { phase: 'changes', observedAt: '2026-10-10T08:10:00Z' });
  }
  const incident = (await listIncidents(scope)).find((item) => item.kind === 'mass_field_clearing')!;
  detail = (await getIncident(scope, incident.id))!;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('bounded evidence investigation', () => {
  it('prepares and saves a factual report without any external calls', async () => {
    const fetcher = vi.fn(() => { throw new Error('External request forbidden.'); });
    vi.stubGlobal('fetch', fetcher);
    const report = await investigateIncident(scope, detail.id);
    expect(report.mode).toBe('evidence');
    expect(report.facts[0].text).toContain('3 records');
    expect(report.unknowns.join(' ')).toContain('does not establish who caused the later observed record state');
    expect(report.nextSteps.join(' ')).toContain('no write authority');
    expect(await latestIncidentInvestigation(scope, detail.id)).toEqual(report);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses only supplied citation IDs and never turns source instructions into authority', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fictional-model-key'); vi.stubEnv('CONTROL_TOWER_INVESTIGATION_MODEL', 'configured-fixture-model');
    const body = { hypotheses: [{ text: 'A source update may explain the change.', evidenceIds: [`incident:${detail.id}`] }], unknowns: ['No source actor is known.'], nextSteps: ['Inspect upstream history.'], ruleSuggestion: null };
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(_url).toBe('https://api.openai.com/v1/responses');
      const sent = JSON.parse(String(init.body));
      expect(sent.store).toBe(false); expect(sent.tools).toBeUndefined();
      expect(sent.input[0].content).toContain('untrusted data');
      const packet = JSON.parse(sent.input[1].content);
      expect(packet.records).toHaveLength(3);
      expect(packet.records[0].record.properties.jobtitle).toBe('');
      expect(packet.nativeEvents).toEqual([]);
      expect(JSON.stringify(sent)).not.toContain('CONTROL_TOWER_SYNC_KEY');
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(body) }] }] });
    });
    vi.stubGlobal('fetch', fetcher);
    const report = await investigateIncident(scope, detail.id, true);
    expect(report.mode).toBe('model'); expect(report.hypotheses).toEqual(body.hypotheses);
    expect(report.facts).toEqual(explainIncident(detail).facts);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['invented-citation', 'incomplete', 'refusal', 'network'])('falls back without changing evidence when model returns %s', async (failure) => {
    vi.stubEnv('OPENAI_API_KEY', 'fictional-model-key'); vi.stubEnv('CONTROL_TOWER_INVESTIGATION_MODEL', 'configured-fixture-model');
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'network') throw new Error('fictional provider unavailable');
      return Response.json({ status: failure === 'incomplete' ? 'incomplete' : 'completed', output: [{ type: 'message', content: [{ type: failure === 'refusal' ? 'refusal' : 'output_text', text: JSON.stringify({ hypotheses: [{ text: 'Unsupported source claim', evidenceIds: ['made-up'] }], unknowns: [], nextSteps: [], ruleSuggestion: null }) }] }] });
    }));
    const report = await investigateIncident(scope, detail.id, true);
    expect(report.mode).toBe('fallback'); expect(report.facts).toEqual(explainIncident(detail).facts);
    expect(report.unknowns.join(' ')).toContain('unsupported evidence references');
  });
});

describe('server-enforced investigator access', () => {
  function headers() { return { 'content-type': 'application/json', 'x-control-tower-investigator-key': 'fixture-investigator' }; }
  function authenticate() { vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'fixture-operator'); vi.stubEnv('CONTROL_TOWER_INVESTIGATOR_KEY', 'fixture-investigator'); }
  it('allows evidence inspection through a separate credential even when native connections are unavailable', async () => {
    authenticate(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No native calls during inspection.'); }));
    const response = await GET(new Request(`http://local/api/control-tower/incidents?provider=hubspot&account=${scope}&incident=${detail.id}`, { headers: headers() }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ role: 'investigator', scope });
  });
  it.each(['policy', 'triage', 'resume_repairs', 'retry_events', 'flush_notifications'])('denies investigator mutation %s', async (action) => {
    authenticate();
    const response = await POST(new Request('http://local/api/control-tower/incidents', { method: 'POST', headers: headers(), body: JSON.stringify({ action, provider: 'hubspot', account: scope, id: detail.id }) }));
    expect(response.status).toBe(403);
  });
  it('does not let the investigation credential approve a Safe Import or fall through to permissive dev access', async () => {
    authenticate();
    const response = await approveImport(new Request('http://local/api/control-tower/safe-import', { method: 'POST', headers: headers(), body: JSON.stringify({ action: 'approve' }) }));
    expect(response.status).toBe(401);
    vi.stubEnv('CONTROL_TOWER_INVESTIGATOR_KEY', 'fixture-operator');
    expect(incidentAccess(new Request('http://local', { headers: { 'x-control-tower-investigator-key': 'fixture-operator' } }))).toBeInstanceOf(Response);
  });
});
