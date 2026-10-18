import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createControlTowerMcp } from '../scripts/control-tower-mcp.mjs';

const key = 'synthetic-operator-key';
const seen: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
const contacts = Array.from({ length: 205 }, (_, index) => ({ contactId: `row-${index}`, company: 'Example',
  website: 'https://example.test/', recordStatus: 'active', qualityFlags: [], ...(index === 0 ? { importExclusion: { reason: 'Skip this row' } } : {}) }));
const workspace = { id: 'workspace-1', name: 'Synthetic import', revision: 2, createdAt: '2026-10-16', updatedAt: '2026-10-16',
  state: { contacts, originalContacts: [{ secretOriginalCopy: 'original-contact-marker' }], repairHistory: [], correctionHistory: [], receipts: [],
    mapping: { company: 'Company' }, sourceType: 'csv', destinationType: 'hubspot', fileName: 'synthetic.csv' } };
const review = { id: 'review-1', workspaceId: workspace.id, complete: true, counts: { 'proposed-update': 205 },
  plans: [{ doNotRepeat: 'full-plan-marker' }], rows: contacts.map((row) => ({ contactId: row.contactId, status: 'proposed-update', reason: null,
    record: { changes: [{ field: 'company', before: '', after: 'Example' }] } })) };
const execution = { id: 'execution-1', status: 'reconciliation-required', records: contacts.map((row, index) => ({ contactId: row.contactId,
  status: index === 0 ? 'unknown' : 'accepted', error: index === 0 ? 'Readback unavailable' : null })) };
const check = { url: 'https://example.test/', status: 'reachable', method: 'browser', checkedAt: '2026-10-16T15:00:00Z' };
const suppressionRules = Array.from({ length: 55 }, (_, index) => ({ id: `rule-${index}`, listName: 'Vendors',
  type: 'domain', value: `vendor-${index}.example`, reason: 'Existing vendor', enabled: true, includeSubdomains: false,
  createdAt: '2026-10-16T15:00:00Z', updatedAt: '2026-10-16T15:00:00Z' }));
const qualification = { qualificationId: 'qualification-fixture', tableId: 'pomade-fixture', stale: false,
  rows: Array.from({ length: 27 }, (_, index) => ({ sourceRowId: `qualification-row-${index}`,
    identity: { assessment: 'Match', explanation: `Evidence for company ${index}`, sources: [{ url: `https://example.test/company-${index}` }] } })) };
let failure: { status: number; body: Record<string, unknown> } | undefined;
let redirect = false;
let readinessFixture = false;
let noQualification = false;
const readiness = { counts: { ready: 1, needsReview: 203, excluded: 1 }, rows: contacts.map((r, i) => ({
  sourceRowId: r.contactId, company: r.company, email: '', status: i === 0 ? 'excluded' : i === 1 ? 'ready' : 'needs_review',
  reasons: [{ code: i === 1 ? 'checks_passed' : 'missing_check', message: i === 1 ? 'All required saved checks passed.' : 'Email verification is missing.' }],
})) };
let http: Server;
let url: string;
let client: Client;
let mcp: ReturnType<typeof createControlTowerMcp>;

async function connect(options: { url: string; key: string }) {
  const server = createControlTowerMcp(options);
  const client = new Client({ name: 'control-tower-fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

beforeAll(async () => {
  http = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = request.url ?? '/';
    seen.push({ method: request.method ?? '', path, body });
    response.setHeader('content-type', 'application/json');
    if (request.headers['x-control-tower-key'] !== key) {
      response.writeHead(401); response.end(JSON.stringify({ error: 'The operator access key is invalid.' })); return;
    }
    if (failure) { response.writeHead(failure.status); response.end(JSON.stringify(failure.body)); return; }
    if (redirect) { response.writeHead(302, { location: '/redirected' }); response.end('{}'); return; }
    const pathname = new URL(path, url).pathname;
    let result: unknown;
    switch (pathname) {
      case '/api/control-tower/connectors': result = { persistenceEnabled: true, accessKeyRequired: true, connectors: [] }; break;
      case '/api/control-tower/workspaces': result = { workspaces: [{ id: workspace.id, name: workspace.name }], pagination: { total: 1, nextOffset: null } }; break;
      case '/api/control-tower/workspace': result = { workspace }; break;
      case '/api/control-tower/safe-import': result = { review, execution: body.action === 'load' ? execution : null }; break;
      case '/api/control-tower/website-checks': result = { checks: [check] }; break;
      case '/api/control-tower/pomade-qualification': result = { configured: true, qualification: noQualification ? null : qualification, ...(readinessFixture ? { readiness } : {}) }; break;
      case '/api/control-tower/suppressions': result = { rules: suppressionRules }; break;
      case '/api/control-tower/local-matches': result = { findings: [], counts: { pending: 0, confirmed: 0, dismissed: 0 }, nextOffset: null }; break;
      default: response.writeHead(404); result = { error: 'Unexpected fixture route' };
    }
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not listen.');
  url = `http://127.0.0.1:${address.port}`;
  ({ client, server: mcp } = await connect({ url, key }));
});
beforeEach(() => { seen.length = 0; failure = undefined; redirect = false; readinessFixture = false; noQualification = false; });
afterAll(async () => {
  await client?.close();
  await mcp?.close();
  http?.closeAllConnections();
  await new Promise<void>((resolve) => http?.close(() => resolve()));
});

describe('Control Tower MCP protocol and local HTTP integration', () => {
  it('initializes with the bounded import and qualification tools, and sends the configured key', async () => {
    expect(client.getServerVersion()).toEqual({ name: 'gtm-control-tower', version: '0.7.0' });
    const catalog = await client.listTools();
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['get_status', 'list_workspaces', 'get_workspace',
      'prepare_import_review', 'get_import_review', 'get_website_checks', 'check_websites', 'send_to_pomade', 'get_pomade_qualification', 'refresh_pomade_qualification', 'preview_pomade_qualification', 'run_pomade_qualification', 'get_pomade_run', 'cancel_pomade_run',
      'list_suppressions', 'save_suppression', 'import_suppressions', 'delete_suppression', 'get_local_matches', 'decide_local_match']);
    expect(catalog.tools.find((tool) => tool.name === 'prepare_import_review')?.annotations?.readOnlyHint).toBe(false);
    expect(catalog.tools.find((tool) => tool.name === 'get_import_review')?.annotations?.readOnlyHint).toBe(true);
    expect((await client.callTool({ name: 'get_status', arguments: {} })).structuredContent).toEqual({ persistenceEnabled: true, accessKeyRequired: true, connectors: [] });
    expect(seen).toEqual([{ method: 'GET', path: '/api/control-tower/connectors', body: undefined }]);
    await client.callTool({ name: 'list_workspaces', arguments: { limit: 10, offset: 20 } });
    expect(seen.at(-1)?.path).toBe('/api/control-tower/workspaces?limit=10&offset=20');
  });

  it('pages current contacts without repeating original rows or histories', async () => {
    const response = await client.callTool({ name: 'get_workspace', arguments: { workspaceId: workspace.id, limit: 100, offset: 100 } });
    const value = response.structuredContent as { workspace: { contacts: unknown[] } };
    expect(value.workspace.contacts).toHaveLength(100);
    expect(value).toMatchObject({ workspace: { id: workspace.id, revision: 2, counts: { contacts: 205, active: 205, included: 204, excluded: 1 },
      contacts: [expect.objectContaining({ contactId: 'row-100' }), ...contacts.slice(101, 200)], pagination: { limit: 100, offset: 100, total: 205, nextOffset: 200 } } });
    expect(JSON.stringify(response)).not.toContain('original-contact-marker');
    expect(seen[0].path).toBe('/api/control-tower/workspace?id=workspace-1');
  });

  it('fixes review actions to prepare/load and preserves paged field decisions and execution errors', async () => {
    const prepared = await client.callTool({ name: 'prepare_import_review', arguments: { workspaceId: workspace.id, limit: 1, offset: 200 } });
    expect(seen.at(-1)?.body).toEqual({ action: 'prepare', workspaceId: workspace.id });
    expect(prepared.structuredContent).toMatchObject({ review: { counts: { 'proposed-update': 205 }, rows: [review.rows[200]],
      pagination: { total: 205, nextOffset: 201 }, planCount: 1 }, execution: null });
    expect(JSON.stringify(prepared)).not.toContain('full-plan-marker');
    const loaded = await client.callTool({ name: 'get_import_review', arguments: { workspaceId: workspace.id, reviewId: review.id, limit: 1 } });
    expect(seen.at(-1)?.body).toEqual({ action: 'load', workspaceId: workspace.id, reviewId: review.id });
    expect(loaded.structuredContent).toMatchObject({ review: { rows: [review.rows[0]] }, execution: { status: 'reconciliation-required',
      counts: { unknown: 1, accepted: 204 }, records: [execution.records[0]] } });
  });

  it('uses saved website reads and forwards only the bounded explicit check request', async () => {
    expect((await client.callTool({ name: 'get_website_checks', arguments: { workspaceId: workspace.id } })).structuredContent).toEqual({ checks: [check] });
    const input = { workspaceId: workspace.id, urls: ['https://example.test/'], recheck: true };
    expect((await client.callTool({ name: 'check_websites', arguments: input })).structuredContent).toEqual({ checks: [check] });
    expect(seen).toEqual([{ method: 'GET', path: '/api/control-tower/website-checks?workspaceId=workspace-1', body: undefined },
      { method: 'POST', path: '/api/control-tower/website-checks', body: input }]);
  });

  it('pages Pomade observations while forwarding only fixed transfer and saved-result operations', async () => {
    const sent = await client.callTool({ name: 'send_to_pomade', arguments: { workspaceId: workspace.id, icpCriteria: 'CRM software' } });
    expect(sent.structuredContent).toEqual({ configured: true, qualification: { ...qualification, rows: qualification.rows.slice(0, 10),
      pagination: { limit: 10, offset: 0, total: 27, nextOffset: 10 } } });
    const loaded = await client.callTool({ name: 'get_pomade_qualification', arguments: { workspaceId: workspace.id, limit: 25, offset: 25 } });
    expect(loaded.structuredContent).toEqual({ configured: true, qualification: { ...qualification, rows: qualification.rows.slice(25),
      pagination: { limit: 25, offset: 25, total: 27, nextOffset: null } } });
    const refreshed = await client.callTool({ name: 'refresh_pomade_qualification', arguments: { workspaceId: workspace.id, limit: 2, offset: 1 } });
    expect(refreshed.structuredContent).toEqual({ configured: true, qualification: { ...qualification, rows: qualification.rows.slice(1, 3),
      pagination: { limit: 2, offset: 1, total: 27, nextOffset: 3 } } });
    expect(seen).toEqual([
      { method: 'POST', path: '/api/control-tower/pomade-qualification', body: { action: 'send', workspaceId: workspace.id, icpCriteria: 'CRM software' } },
      { method: 'GET', path: '/api/control-tower/pomade-qualification?workspaceId=workspace-1', body: undefined },
      { method: 'POST', path: '/api/control-tower/pomade-qualification', body: { action: 'refresh', workspaceId: workspace.id } },
    ]);
  });

  it('pages derived readiness independently and preserves reasons/counts even before a Pomade list exists', async () => {
    readinessFixture = true;
    for (const empty of [false, true]) {
      noQualification = empty;
      const r = await client.callTool({ name: 'get_pomade_qualification', arguments: { workspaceId: workspace.id, limit: 2, offset: 1 } });
      expect(r.structuredContent).toMatchObject({ readiness: { counts: readiness.counts, rows: readiness.rows.slice(1, 3),
        pagination: { total: 205, limit: 2, offset: 1, nextOffset: 3 } } });
      if (empty) expect(r.structuredContent).toMatchObject({ qualification: null });
    }
    expect(seen.every(r => r.method === 'GET')).toBe(true);
  });

  it('requires explicit provider confirmation and preserves the exact run request during progress and cancellation', async () => {
    const scope = { workspaceId: workspace.id, sourceRowIds: ['qualification-row-0'], checks: ['identity', 'email'] };
    const request = { ...scope, previewHash: 'a'.repeat(64), requestId: '321b17d1-7d86-4e66-bb81-8470d5542cc3', confirmExternalRequests: true };
    expect((await client.callTool({ name: 'run_pomade_qualification', arguments: { ...request, confirmExternalRequests: false } })).isError).toBe(true);
    expect(seen).toHaveLength(0);
    await client.callTool({ name: 'preview_pomade_qualification', arguments: scope });
    await client.callTool({ name: 'run_pomade_qualification', arguments: request });
    await client.callTool({ name: 'get_pomade_run', arguments: { workspaceId: workspace.id } });
    await client.callTool({ name: 'cancel_pomade_run', arguments: { workspaceId: workspace.id } });
    expect(seen.map((r) => r.body)).toEqual([{ action: 'preview', ...scope }, { action: 'start', ...request },
      { action: 'status', workspaceId: workspace.id }, { action: 'cancel', workspaceId: workspace.id }]);
    expect(seen.every((r) => r.path === '/api/control-tower/pomade-qualification')).toBe(true);
  });

  it('pages shared suppression rules and forwards only local rule-management operations', async () => {
    const result = await client.callTool({ name: 'list_suppressions', arguments: { limit: 2, offset: 50 } });
    expect(result.structuredContent).toEqual({ rules: suppressionRules.slice(50, 52), pagination: { limit: 2, offset: 50, total: 55, nextOffset: 52 } });
    const rule = { listName: 'Vendors', type: 'domain', value: 'vendor.example', reason: 'Existing vendor', includeSubdomains: true, enabled: true };
    const saved = await client.callTool({ name: 'save_suppression', arguments: { rule } });
    expect(saved.structuredContent).toMatchObject({ rules: suppressionRules.slice(0, 50), pagination: { nextOffset: 50 } });
    await client.callTool({ name: 'save_suppression', arguments: { rule: { ...rule, id: 'rule-0', enabled: false } } });
    await client.callTool({ name: 'import_suppressions', arguments: { rules: [rule] } });
    await client.callTool({ name: 'delete_suppression', arguments: { id: 'rule-0' } });
    expect(seen.map(entry => entry.body)).toEqual([undefined, { action: 'save', rule },
      { action: 'save', rule: { ...rule, id: 'rule-0', enabled: false } }, { action: 'import', rules: [rule] }, { action: 'delete', id: 'rule-0' }]);
    expect(seen.every(entry => entry.path === '/api/control-tower/suppressions')).toBe(true);
    const catalog = await client.listTools();
    expect(catalog.tools.find(tool => tool.name === 'list_suppressions')?.annotations?.readOnlyHint).toBe(true);
    expect(catalog.tools.find(tool => tool.name === 'save_suppression')?.annotations?.openWorldHint).toBe(false);
    expect(catalog.tools.find(tool => tool.name === 'get_local_matches')?.annotations?.readOnlyHint).toBe(true);
    expect(catalog.tools.find(tool => tool.name === 'decide_local_match')?.annotations?.openWorldHint).toBe(false);
  });

  it('reads local suggestions and saves only explicitly selected assessments through fixed endpoints', async () => {
    await client.callTool({ name: 'get_local_matches', arguments: { workspaceId: workspace.id, status: 'pending', limit: 2, offset: 4 } });
    const decision = { workspaceId: workspace.id, id: 'a'.repeat(64), fingerprint: 'b'.repeat(64), action: 'confirm' };
    await client.callTool({ name: 'decide_local_match', arguments: decision });
    expect(seen).toEqual([
      { method: 'GET', path: '/api/control-tower/local-matches?workspaceId=workspace-1&limit=2&offset=4&status=pending&kind=all', body: undefined },
      { method: 'POST', path: '/api/control-tower/local-matches', body: decision },
    ]);
  });

  it('rejects invalid page sizes, website schemes, extra action/path arguments and unregistered writes before HTTP', async () => {
    for (const [name, args] of [
      ['get_workspace', { workspaceId: workspace.id, limit: 101 }],
      ['list_workspaces', { offset: -1 }],
      ['check_websites', { workspaceId: workspace.id, urls: ['file:///etc/passwd'] }],
      ['check_websites', { workspaceId: workspace.id, urls: Array(4).fill('https://example.test/') }],
      ['prepare_import_review', { workspaceId: workspace.id, action: 'approve' }],
      ['get_status', { url: 'https://unrelated.test', path: '/crm-writeback' }],
      ['send_to_pomade', { workspaceId: workspace.id, icpCriteria: 'CRM software', rows: [] }],
      ['refresh_pomade_qualification', { workspaceId: workspace.id, action: 'run_recipe' }],
      ['get_pomade_qualification', { workspaceId: workspace.id, limit: 26 }],
      ['send_to_pomade', { workspaceId: workspace.id, icpCriteria: 'CRM software', offset: -1 }],
      ['approve_import', { workspaceId: workspace.id }],
      ['save_suppression', { rule: { type: 'domain', value: 'example.test', reason: '' } }],
      ['save_suppression', { rule: { type: 'regex', value: '.*', reason: 'Unsupported broad rule' } }],
      ['import_suppressions', { rules: [] }],
      ['delete_suppression', { id: 'rule-0', action: 'execute' }],
      ['get_local_matches', { workspaceId: workspace.id, status: 'approved' }],
      ['decide_local_match', { workspaceId: workspace.id, id: 'a'.repeat(64), fingerprint: 'b'.repeat(64), action: 'merge' }],
      ['decide_local_match', { workspaceId: workspace.id, id: 'a'.repeat(64), fingerprint: 'stale', action: 'confirm' }],
    ] as const) {
      expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
    }
    expect(seen).toHaveLength(0);
  });

  it('retains authorization/provider failure details and never retries an uncertain preparation', async () => {
    const other = await connect({ url, key: 'incorrect-synthetic-key' });
    try {
      const denied = await other.client.callTool({ name: 'get_status', arguments: {} });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({ httpStatus: 401, error: 'The operator access key is invalid.' });
    } finally { await other.client.close(); await other.server.close(); }
    failure = { status: 503, body: { error: 'CRM cooldown', retryable: true, retryAt: '2026-10-16T16:00:00Z', guidance: 'Load saved progress.' } };
    const failed = await client.callTool({ name: 'prepare_import_review', arguments: { workspaceId: workspace.id } });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toEqual({ ...failure.body, httpStatus: 503 });
    expect(seen.filter((entry) => entry.method === 'POST')).toHaveLength(1);
  });

  it('rejects non-local origins or missing keys and refuses HTTP redirects', async () => {
    for (const invalid of ['https://example.com', 'http://127.0.0.1:3100/path', 'http://user:pass@localhost:3100', 'http://localhost:3100?token=x']) {
      expect(() => createControlTowerMcp({ url: invalid, key })).toThrow(/local Control Tower origin/);
    }
    expect(() => createControlTowerMcp({ url })).toThrow(/CONTROL_TOWER_SYNC_KEY/);
    redirect = true;
    expect((await client.callTool({ name: 'check_websites', arguments: { workspaceId: workspace.id, urls: ['https://example.test/'] } })).isError).toBe(true);
    expect(seen).toHaveLength(1);
  });
});
