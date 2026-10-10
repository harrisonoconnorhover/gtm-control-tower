import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const clean = (value) => typeof value === 'string' ? value.trim() : '';
const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;

/**
 * Native, manifest-owned Contact qualification. The caller sets an isolated
 * SQLite path and actual CRM credentials before calling this module, and must
 * not run concurrent work while its temporary fetch guard is installed.
 *
 * nativeRead(record) returns {id, properties} with native field names. Include
 * email, name, phone, title, account/company, owner, and the ownership marker;
 * omit provider-managed modification timestamps. verifyOwnership(record, row)
 * must throw unless both the manifest and the fresh native marker match.
 * Records and all evidence stay in the caller's ignored private output folder.
 */
export async function runNativeSafeImport({ provider, accountId, records, outputDir, nativeRead, verifyOwnership, count = 12 }) {
  assert(['hubspot', 'salesforce'].includes(provider));
  assert(typeof accountId === 'string' && accountId);
  assert(Number.isInteger(count) && count >= 2 && count <= 12);
  assert(typeof nativeRead === 'function' && typeof verifyOwnership === 'function');
  assert(process.env.CONTROL_TOWER_SYNC_KEY, 'The authenticated operator key is required.');
  assert(process.env.CONTROL_TOWER_SQLITE_PATH, 'Set an isolated qualification SQLite path first.');
  const directory = resolve(outputDir, 'safe-import');
  assert(directory.startsWith(resolve(root, 'outputs') + '/'), 'Native evidence belongs in ignored outputs.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const save = (name, value) => {
    const path = resolve(directory, `${name}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  const load = (name) => existsSync(resolve(directory, `${name}.json`))
    ? JSON.parse(readFileSync(resolve(directory, `${name}.json`), 'utf8')) : null;
  const phoneField = provider === 'hubspot' ? 'phone' : 'Phone';
  const emailField = provider === 'hubspot' ? 'email' : 'Email';
  const titleField = provider === 'hubspot' ? 'jobtitle' : 'Title';
  const protectedFields = provider === 'hubspot'
    ? ['email', 'firstname', 'lastname', 'phone', 'jobtitle', 'company', 'hubspot_owner_id']
    : ['Email', 'FirstName', 'LastName', 'Phone', 'Title', 'AccountId', 'OwnerId'];
  const manifest = new Map(records.filter((record) => record.objectType === 'Contact').map((record) => [String(record.nativeId), record]));
  assert(manifest.size >= count, 'The caller must supply the seeded Contact manifest.');
  const read = async (record) => {
    assert(manifest.has(String(record.nativeId)), 'The native read is outside the Contact manifest.');
    const current = await nativeRead(record);
    assert.equal(String(current.id), String(record.nativeId));
    assert(current.properties && typeof current.properties === 'object');
    for (const field of protectedFields) assert(Object.hasOwn(current.properties, field), `The protected native snapshot is missing ${field}.`);
    await verifyOwnership(record, current);
    return current;
  };
  const attempts = load('mutation-attempts') ?? [];
  let checkpoint = load('checkpoint');
  let stage = 'baseline';
  const rawFetch = globalThis.fetch;
  try {
    if (checkpoint) {
      assert.equal(checkpoint.provider, provider);
      assert.equal(checkpoint.accountId, accountId);
      assert.equal(checkpoint.selected.length, count, 'Resume with the original selected-record count.');
      for (const item of [...checkpoint.selected, ...checkpoint.controls]) {
        assert(manifest.has(String(item.record.nativeId)), 'The saved qualification does not belong to this manifest.');
      }
    } else {
      const selected = [], controls = [], emails = new Set();
      // The tail contains clean controls in the shared messy dataset; using it
      // avoids the intentionally duplicated identities at the beginning.
      for (const record of [...manifest.values()].reverse()) {
        const before = await read(record);
        const email = clean(before.properties[emailField]).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || emails.has(email)
          || clean(before.properties[phoneField]) || !clean(before.properties[titleField])) continue;
        emails.add(email);
        if (selected.length < count) selected.push({ record, before, phone: `+1202555${String(100 + selected.length).padStart(4, '0')}` });
        else controls.push({ record, before });
        if (selected.length === count && controls.length === 3) break;
      }
      assert.equal(selected.length, count, 'Not enough manifest-owned Contacts have unique emails and empty phones.');
      assert.equal(controls.length, 3, 'Three unchanged native control Contacts are required.');
      checkpoint = { provider, accountId, startedAt: new Date().toISOString(), selected, controls, workspaceId: null, reviewId: null };
      save('checkpoint', checkpoint);
    }
    const approved = new Map(checkpoint.selected.map((item) => [String(item.record.nativeId), item]));
    const origin = provider === 'hubspot' ? 'https://api.hubapi.com' : new URL(process.env.SALESFORCE_INSTANCE_URL).origin;
    // This guard adds a fixture boundary but never changes native responses or
    // supplies adapter overrides. Every planned lookup and write uses production.
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      assert.equal(url.origin, origin, 'Only this provider may be called during Safe Import qualification.');
      if (method === 'PATCH') {
        const match = provider === 'hubspot' ? url.pathname.match(/^\/crm\/objects\/2026-03\/contacts\/(\d+)$/)
          : url.pathname.match(/^\/services\/data\/v\d+\.\d+\/sobjects\/Contact\/([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)$/);
        assert(match, 'Safe Import may only PATCH a native Contact ID.');
        const id = match[1], item = approved.get(id);
        assert(item, 'No write may address a Contact outside the reviewed fixture cohort.');
        assert(!attempts.some((attempt) => attempt.nativeId === id), 'A previously sent or possibly sent update must not be replayed.');
        const body = JSON.parse(String(init?.body ?? ''));
        assert.deepEqual(body, provider === 'hubspot' ? { properties: { phone: item.phone } } : { Phone: item.phone }, 'Only the reviewed empty phone may be filled.');
        assert.deepEqual(await read(item.record), item.before, 'A protected native value changed after fixture review.');
        const attempt = { nativeId: id, objectType: 'Contact', method, payload: body, sentAt: new Date().toISOString(), outcome: 'unknown' };
        attempts.push(attempt);
        save('mutation-attempts', attempts); // Written before send, including transport-loss cases.
        try {
          const response = await rawFetch(input, init);
          attempt.responseStatus = response.status;
          attempt.outcome = response.ok ? 'accepted-response' : 'non-success-response';
          save('mutation-attempts', attempts);
          return response;
        } catch (error) {
          save('mutation-attempts', attempts);
          throw error;
        }
      }
      assert(method === 'GET' || (provider === 'hubspot' && method === 'POST'
        && /^\/crm\/objects\/2026-03\/contacts\/(batch\/read|search)$/.test(url.pathname)), 'Creates, deletes, unrelated updates and outbound notifications are forbidden.');
      return rawFetch(input, init);
    };

    stage = 'production-entry';
    const entry = resolve(directory, 'production-safe-import.mjs');
    await build({ stdin: { contents: `
      export { POST as safePOST } from './app/api/control-tower/safe-import/route';
      export { createWorkspace, saveWorkspace } from './lib/workspace-store';
      export { emptyWorkspaceState } from './lib/workspace';
      export { importContactsCsv } from './lib/csv-control-tower';
    `, resolveDir: root, sourcefile: 'native-safe-import-entry.ts', loader: 'ts' }, outfile: entry,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
    alias: { 'next/server': 'next/server.js' }, tsconfig: resolve(root, 'tsconfig.json') });
    chmodSync(entry, 0o600);
    const modules = await import(pathToFileURL(entry).href);
    const unauthenticated = await modules.safePOST(new Request('http://qualification.local/api/control-tower/safe-import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'load', workspaceId: 'not-authorized' }),
    }));
    assert.equal(unauthenticated.status, 401, 'The production route must reject requests without the configured operator key.');
    save('authentication', { unauthenticatedStatus: unauthenticated.status });
    const call = async (action, expectedStatus = 200) => {
      const response = await modules.safePOST(new Request('http://qualification.local/api/control-tower/safe-import', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-control-tower-key': process.env.CONTROL_TOWER_SYNC_KEY },
        body: JSON.stringify({ action, workspaceId: checkpoint.workspaceId, ...(checkpoint.reviewId ? { reviewId: checkpoint.reviewId } : {}) }),
      }));
      const body = await response.json();
      save(`${action}-latest`, { responseStatus: response.status, ...body });
      assert.equal(response.status, expectedStatus, `${action}: ${body.error ?? 'Unexpected response'}`);
      return body;
    };
    if (!checkpoint.workspaceId) {
      stage = 'saved-workspace';
      const headers = ['contact_id', 'first_name', 'last_name', 'email', 'company', 'phone', 'job_title'];
      const rows = checkpoint.selected.map(({ record, before, phone }, index) => {
        const properties = before.properties;
        return [`NATIVE-FILL-${index + 1}`, properties[provider === 'hubspot' ? 'firstname' : 'FirstName'],
          properties[provider === 'hubspot' ? 'lastname' : 'LastName'], properties[emailField],
          provider === 'hubspot' ? properties.company : '', phone, `Different imported title ${record.nativeId}`];
      });
      const csv = headers.join(',') + '\n' + rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
      writeFileSync(resolve(directory, 'reviewed-phone-fills.csv'), csv, { mode: 0o600 });
      const contacts = modules.importContactsCsv(csv).contacts;
      const workspace = await modules.createWorkspace(`Native messy dataset — ${provider} safe fills`);
      await modules.saveWorkspace(workspace.id, { ...modules.emptyWorkspaceState(), contacts, originalContacts: contacts,
        fileName: 'reviewed-phone-fills.csv', sourceFileHash: createHash('sha256').update(csv).digest('hex'),
        sourceType: 'csv', destinationType: provider, importRecipe: 'safe-update-contacts', importRecordMode: 'update-existing' }, 'native_messy_dataset_qualification');
      checkpoint.workspaceId = workspace.id;
      save('checkpoint', checkpoint);
    }
    stage = 'prepare';
    let review;
    if (checkpoint.reviewId) ({ review } = await call('load'));
    else {
      assert.equal(attempts.length, 0, 'Sent requests require the existing saved review.');
      ({ review } = await call('prepare'));
      assert.deepEqual(review.account, { connectorId: provider, accountId });
      assert(review.complete);
      assert.equal(review.rows.length, count);
      assert.equal(review.counts['proposed-update'], count);
      for (const row of review.rows) {
        const item = approved.get(row.record?.nativeId);
        assert(item, 'The review matched a Contact outside the manifest-owned selected cohort.');
        assert.equal(row.record.matches[0].objectType, 'contact');
        assert.deepEqual(row.record.changes, [{ field: 'phone', before: null, after: item.phone }]);
        assert(row.record.fieldDecisions.some((decision) => decision.field === 'jobTitle' && decision.action === 'preserve'));
      }
      assert(review.plans.every((plan) => plan.creates === 0));
      checkpoint.reviewId = review.id;
      save('checkpoint', checkpoint);
      save('review', review);
    }
    assert.deepEqual(review.account, { connectorId: provider, accountId });
    stage = 'approve';
    const beforeApprovalWrites = attempts.length;
    let { execution } = await call('approve', 202);
    const firstChunkWrites = attempts.length - beforeApprovalWrites;
    assert(firstChunkWrites <= 10, 'One request exceeded the bounded write count.');
    if (checkpoint.firstChunkWrites === undefined) {
      checkpoint.firstChunkWrites = firstChunkWrites;
      checkpoint.continuations = 0;
      save('first-execution', execution);
      save('checkpoint', checkpoint);
    }
    const repeatedWrites = attempts.length;
    const repeated = await call('approve', 202);
    assert.equal(repeated.execution.id, execution.id);
    assert.equal(attempts.length, repeatedWrites, 'Repeated approval sent another native request.');
    assert.deepEqual(repeated.execution.records, execution.records, 'Repeated approval continued pending work.');
    stage = 'bounded-continuation';
    while (execution.records.some((record) => record.status === 'pending')) {
      const previousPending = execution.records.filter((record) => record.status === 'pending').length;
      const previousWrites = attempts.length;
      ({ execution } = await call('continue', 202));
      checkpoint.continuations += 1;
      save(`continuation-${checkpoint.continuations}`, execution);
      save('checkpoint', checkpoint);
      assert(attempts.length - previousWrites <= 10);
      assert(execution.records.filter((record) => record.status === 'pending').length < previousPending, 'The continuation made no progress; inspect durable execution before retrying.');
    }
    stage = 'native-readback';
    assert.equal(execution.status, 'completed');
    assert.equal(execution.records.length, count);
    assert(execution.records.every((record) => record.status === 'accepted' && record.verification?.status === 'verified'), 'A native write or readback requires reconciliation.');
    assert.equal(attempts.length, count);
    const observed = [];
    for (const item of [...checkpoint.selected, ...checkpoint.controls]) {
      const current = await read(item.record);
      const expected = item.phone ? { ...item.before, properties: { ...item.before.properties, [phoneField]: item.phone } } : item.before;
      observed.push(current);
      assert.deepEqual(current, expected, 'Only the reviewed phone may change; every other protected native field must survive.');
    }
    save('native-readback', observed);
    const loaded = await call('load');
    assert.equal(loaded.execution.id, execution.id);
    assert.deepEqual(loaded.execution.records, execution.records);
    const result = { provider, accountId, startedAt: checkpoint.startedAt, finishedAt: new Date().toISOString(), passed: true, result: 'passed',
      workspaceId: checkpoint.workspaceId, reviewId: review.id, executionId: execution.id, nativePhoneFills: count,
      acceptedAndVerified: count, unchangedControls: checkpoint.controls.length, protectedFieldsPreserved: true,
      firstChunkWrites: checkpoint.firstChunkWrites, continuations: checkpoint.continuations, resumedFromCheckpoint: beforeApprovalWrites > 0,
      unauthenticatedRequestRejected: true, repeatedApprovalSentNoRequests: true, durableReloadVerified: true,
      outsideCohortMutationRequests: 0, created: 0, deleted: 0, evidence: directory,
      limits: ['Local production route and native provider adapters with isolated SQLite; not hosted deployment qualification.',
        'Account and cohort checks precede native writes; native reread and PATCH are separate non-atomic operations.',
        'Native test fixtures and phone fills are retained for inspection.'] };
    save('result', result);
    return result;
  } catch (error) {
    save('failure', { stage, message: error.message, at: new Date().toISOString(), workspaceId: checkpoint?.workspaceId,
      reviewId: checkpoint?.reviewId, nativeAttempts: attempts.length });
    throw error;
  } finally { globalThis.fetch = rawFetch; }
}
