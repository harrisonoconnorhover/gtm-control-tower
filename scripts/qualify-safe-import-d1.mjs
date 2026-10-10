import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// This isolated Worker uses production stores and actual D1 SQL. Its CRM
// adapter is explicitly fictional and never calls HubSpot or reads credentials.
const workerSource = `
import { env } from 'cloudflare:workers';
import { getDatabase } from './db/index';
import { createWorkspace } from './lib/workspace-store';
import { saveSafeImportReview, getSafeImportReview, claimSafeImportExecution, getSafeImportExecution, updateSafeImportExecution } from './lib/safe-import-store';
import { executeSafeImportReview, continueSafeImportExecution, reconcileSafeImportExecution } from './lib/safe-import-execution';
import { safeImportReviewFixture } from './tests/fixtures/safe-import-review';

let metrics = { bindingCalls: 0, sqlStatements: 0 };
let budget = null;
let instrumented = false;
async function instrument() {
  const db = await getDatabase();
  if (db.kind !== 'd1') throw new Error('This probe requires an actual D1 binding.');
  if (instrumented) return;
  instrumented = true;
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db), raw = new WeakMap();
  function count(statements = 1) {
    metrics.bindingCalls++; metrics.sqlStatements += statements;
    if (budget !== null && metrics.bindingCalls > budget) throw new Error('SIMULATED_D1_INVOCATION_BUDGET_' + budget);
  }
  function wrap(statement) {
    const wrapper = {
      bind(...values) { return wrap(statement.bind(...values)); },
      async first() { count(); return statement.first(); },
      async all() { count(); return statement.all(); },
      async run() { count(); return statement.run(); },
    };
    raw.set(wrapper, statement); return wrapper;
  }
  db.prepare = (sql) => wrap(prepare(sql));
  db.batch = async (statements) => { count(statements.length); return batch(statements.map((statement) => raw.get(statement))); };
}
async function seed(count = 106) {
  const workspace = await createWorkspace('Isolated D1 qualification');
  const review = safeImportReviewFixture(workspace.id, count);
  review.createdAt = new Date().toISOString(); review.expiresAt = new Date(Date.now() + 900000).toISOString();
  review.sourceFile = 'Événement 🧪 Contacts.csv';
  review.rows.forEach((row) => { row.record.fieldDecisions.forEach((decision) => {
    if (decision.field === 'jobTitle') decision.importedValue = 'Opérations 🧪';
  }); });
  await saveSafeImportReview(review); return review;
}
function executionSeed(review) {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), executionKey: 'safe-import:' + review.id, reviewId: review.id, workspaceId: review.workspaceId,
    account: review.account, approvedAt: now, createdAt: now, updatedAt: now, status: 'running',
    records: review.rows.map((row) => ({ contactId: row.contactId, nativeId: row.record.nativeId, status: 'pending', error: null })) };
}
function fakeCrm(review, after = false) {
  let writes = 0;
  const records = new Map(review.rows.map((row) => [row.record.nativeId, { nativeId: row.record.nativeId,
    objectType: 'contact', email: row.email, fields: structuredClone(after ? row.record.after : row.record.before) }]));
  return {
    get writes() { return writes; },
    dependencies: { readAccount: async () => review.account,
      readRecord: async (id) => structuredClone(records.get(id) ?? null),
      writeRecord: async (record) => { writes++; records.get(record.nativeId).fields = structuredClone(record.after); return { status: 'accepted', error: null }; },
      assertWorkspace: async () => {},
    },
  };
}
export default { async fetch(request) {
  if (!env.SAFE_IMPORT_D1_PROBE_KEY || request.headers.get('authorization') !== 'Bearer ' + env.SAFE_IMPORT_D1_PROBE_KEY) return new Response('Probe authorization required.', { status: 403 });
  try {
    await instrument();
    const input = await request.json();
    let output;
    if (input.action === 'ping') output = { ready: true };
    else if (input.action === 'seed') {
      const review = await seed(input.count);
      const loaded = await getSafeImportReview(review.workspaceId, review.id);
      let immutable = false;
      try { await saveSafeImportReview({ ...review, mapping: { rawEmail: 'Changed column' } }); } catch { immutable = true; }
      const original = await getSafeImportReview(review.workspaceId, review.id);
      output = { workspaceId: review.workspaceId, reviewId: review.id, count: loaded.rows.length,
        exactRoundtrip: JSON.stringify(loaded) === JSON.stringify(review), immutable: immutable && JSON.stringify(original) === JSON.stringify(review),
        unicode: loaded.sourceFile, bytes: new TextEncoder().encode(JSON.stringify(review)).byteLength };
    } else if (input.action === 'claim') {
      const review = await getSafeImportReview(input.workspaceId, input.reviewId);
      const claim = await claimSafeImportExecution(review, executionSeed(review));
      output = { claimed: claim.claimed, executionId: claim.execution.id, count: claim.execution.records.length };
    } else if (input.action === 'cas') {
      const baseline = await getSafeImportExecution(input.workspaceId, input.reviewId);
      const updates = ['one', 'two'].map((error) => ({ ...baseline, records: baseline.records.map((row, index) => index === 0 ? { ...row, status: 'held', error } : row) }));
      const results = await Promise.allSettled(updates.map((next) => updateSafeImportExecution(next, baseline)));
      const current = await getSafeImportExecution(input.workspaceId, input.reviewId);
      let staleRejected = false;
      try { await updateSafeImportExecution(baseline, baseline); } catch { staleRejected = true; }
      output = { winners: results.filter((result) => result.status === 'fulfilled').length, staleRejected,
        savedWinner: current.records[0].error, otherRowsPending: current.records.slice(1).every((row) => row.status === 'pending') };
    } else if (input.action === 'interrupt') {
      const current = await getSafeImportExecution(input.workspaceId, input.reviewId);
      const changed = { ...current, records: current.records.map((row, index) => index < 3 ? { ...row,
        status: ['sending', 'unknown', 'accepted'][index], error: index === 1 ? 'Fictional lost response.' : null } : row) };
      await updateSafeImportExecution(changed, current); output = { statuses: changed.records.slice(0, 3).map((row) => row.status) };
    } else if (input.action === 'recover') {
      const review = await getSafeImportReview(input.workspaceId, input.reviewId);
      const loaded = await getSafeImportExecution(input.workspaceId, input.reviewId);
      const crm = fakeCrm(review, true);
      const recovered = await reconcileSafeImportExecution(review, loaded, crm.dependencies);
      output = { writes: crm.writes, before: loaded.records.slice(0, 3).map((row) => row.status),
        after: recovered.records.slice(0, 3).map((row) => row.status),
        held: recovered.records.filter((row) => row.status === 'held').length, pending: recovered.records.filter((row) => row.status === 'pending').length, status: recovered.status,
        verified: recovered.records.filter((row) => row.verification?.status === 'verified').length };
    } else if (input.action === 'execute' || input.action === 'continue') {
      const review = input.action === 'execute' ? await seed(input.count ?? 99) : await getSafeImportReview(input.workspaceId, input.reviewId), crm = fakeCrm(review);
      metrics = { bindingCalls: 0, sqlStatements: 0 }; budget = input.budget ?? null;
      let error = null, result = null;
      try { result = await (input.action === 'execute' ? executeSafeImportReview : continueSafeImportExecution)(review, crm.dependencies); } catch (failure) { error = failure.message; }
      const counted = { ...metrics }; budget = null;
      const saved = await getSafeImportExecution(review.workspaceId, review.id);
      output = { ...counted, workspaceId: review.workspaceId, reviewId: review.id, fakeCrmWrites: crm.writes, error, status: result?.status ?? saved?.status,
        verified: saved?.records.filter((row) => row.verification?.status === 'verified').length ?? 0,
        durableStatuses: saved?.records.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }), {}) ?? {} };
    } else throw new Error('Unsupported isolated qualification action.');
    return Response.json({ engine: 'd1', crm: 'fictional injected adapter; no CRM requests', ...output });
  } catch (error) { budget = null; return Response.json({ error: error.message }, { status: 500 }); }
} };
`;

export async function buildSafeImportD1ProbeWorker() {
  const result = await build({ stdin: { contents: workerSource, sourcefile: 'safe-import-d1-probe.ts', resolveDir: root, loader: 'ts' },
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:workers', 'node:*', 'better-sqlite3'], alias: { '@': root }, write: false, logLevel: 'silent' });
  return result.outputFiles[0].text;
}

/** Uses a disposable local D1 database. Never deploys or touches Cloudflare accounts. */
export async function runSafeImportD1Qualification({ maxStorage = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'safe-import-d1-'));
  const key = randomUUID();
  const script = await buildSafeImportD1ProbeWorker();
  const options = { modules: true, script, compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], d1Persist: directory, bindings: { SAFE_IMPORT_D1_PROBE_KEY: key } };
  const runtimeOptions = convertV4MiniflareOptions(options);
  runtimeOptions.resourcePersistencePath = directory;
  runtimeOptions.logRequests = false;
  let worker = new Miniflare(runtimeOptions);
  async function call(input) {
    const response = await worker.dispatchFetch('http://localhost/qualify', { method: 'POST', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json',
    }, body: JSON.stringify(input) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }
  async function completeExecution(budget) {
    const chunks = [await call({ action: 'execute', count: 99, budget })];
    while (!chunks.at(-1).error && chunks.at(-1).status === 'running' && chunks.length < 20) {
      const last = chunks.at(-1);
      chunks.push(await call({ action: 'continue', workspaceId: last.workspaceId, reviewId: last.reviewId, budget }));
    }
    const last = chunks.at(-1);
    return { ...last, sqlStatements: chunks.reduce((sum, chunk) => sum + chunk.sqlStatements, 0), bindingCalls: chunks.reduce((sum, chunk) => sum + chunk.bindingCalls, 0),
      maxInvocationBindingCalls: Math.max(...chunks.map((chunk) => chunk.bindingCalls)),
      maxInvocationWrites: Math.max(...chunks.map((chunk) => chunk.fakeCrmWrites)),
      fakeCrmWrites: chunks.reduce((sum, chunk) => sum + chunk.fakeCrmWrites, 0), chunks: chunks.length };
  }
  try {
    const database = await worker.getD1Database('DB');
    const migrationFiles = (await readdir(join(root, 'drizzle'))).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of migrationFiles) {
      const sql = await readFile(join(root, 'drizzle', name), 'utf8');
      const statements = sql.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean);
      await database.batch(statements.map((statement) => database.prepare(statement)));
    }
    const seed = await call({ action: 'seed', count: 106 });
    const claims = await Promise.all(Array.from({ length: 3 }, () => call({ action: 'claim', ...seed })));
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    assert.equal(new Set(claims.map((claim) => claim.executionId)).size, 1);
    const cas = await call({ action: 'cas', ...seed });
    assert.equal(cas.winners, 1); assert(cas.staleRejected && cas.otherRowsPending);
    await call({ action: 'interrupt', ...seed });
    // New workerd isolate exercises durable reconstruction without the store's cache.
    await worker.dispose(); worker = new Miniflare(runtimeOptions);
    const recovery = await call({ action: 'recover', ...seed });
    assert.equal(recovery.writes, 0);
    assert.deepEqual(recovery.before, ['sending', 'unknown', 'accepted']);
    assert.deepEqual(recovery.after, ['unknown', 'unknown', 'accepted']);
    assert.equal(recovery.held, 0); assert.equal(recovery.pending, 103);
    const execution = await completeExecution();
    const freeBudget = await completeExecution(50);
    const paidBudget = await completeExecution(1000);
    const maxReview = maxStorage ? await call({ action: 'seed', count: 5000 }) : null;
    return { mode: 'local actual D1 / workerd', noRemoteResources: true, migrations: migrationFiles,
      review: seed, concurrentClaims: { winners: 1, sameExecution: true }, cas, recovery,
      execution, simulatedFreeInvocationBudget: freeBudget, simulatedPaidInvocationBudget: paidBudget,
      ...(maxReview ? { maxStorageReview: maxReview } : {}) };
  } finally { await worker.dispose(); await rm(directory, { recursive: true, force: true }); }
}

/** Explicit opt-in: local Worker, caller-supplied remote synthetic D1 binding.
 * Does not create/delete resources, publish a Worker, or change plans/billing.
 * Apply migrations separately before using this mode.
 */
export async function runRemoteSafeImportD1Qualification(configPath, { recoverySeed = null } = {}) {
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  assert(config.d1_databases?.some((binding) => binding.binding === 'DB' && binding.remote === true), 'Remote qualification requires an explicit remote:true DB binding.');
  const key = config.vars?.SAFE_IMPORT_D1_PROBE_KEY;
  assert(typeof key === 'string' && key.length >= 20, 'Configure an isolated probe key.');
  assert(Object.keys(config.vars ?? {}).every((name) => name === 'SAFE_IMPORT_D1_PROBE_KEY'), 'Do not supply CRM environment variables to this probe.');
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  let child, stderr = '';
  async function start() {
    child = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--config', resolve(configPath), '--ip', '127.0.0.1', '--port', String(port), '--show-interactive-dev-session=false'],
      { cwd: dirname(resolve(configPath)), stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(`Local runner stopped: ${stderr}`);
      try { if ((await call({ action: 'ping' })).ready) return; } catch { /* runner warming up */ }
      await delay(500);
    }
    throw new Error(`Local runner did not become ready: ${stderr}`);
  }
  async function stop() {
    if (!child) return;
    const ended = child.exitCode !== null ? Promise.resolve() : new Promise((done) => child.once('exit', done));
    // Wrangler's launcher creates a nested CLI. Stop its whole owned process
    // group, so a restart cannot silently reuse an orphan's local Worker/cache.
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await Promise.race([ended, delay(5000)]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  async function call(input) {
    const response = await fetch(`http://127.0.0.1:${port}/qualify`, { method: 'POST', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json',
    }, body: JSON.stringify(input) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  async function completeExecution(budget) {
    const chunks = [await call({ action: 'execute', count: 99, budget })];
    while (!chunks.at(-1).error && chunks.at(-1).status === 'running' && chunks.length < 20) {
      const last = chunks.at(-1);
      chunks.push(await call({ action: 'continue', workspaceId: last.workspaceId, reviewId: last.reviewId, budget }));
    }
    const last = chunks.at(-1);
    return { ...last, sqlStatements: chunks.reduce((sum, chunk) => sum + chunk.sqlStatements, 0), bindingCalls: chunks.reduce((sum, chunk) => sum + chunk.bindingCalls, 0),
      maxInvocationBindingCalls: Math.max(...chunks.map((chunk) => chunk.bindingCalls)),
      maxInvocationWrites: Math.max(...chunks.map((chunk) => chunk.fakeCrmWrites)),
      fakeCrmWrites: chunks.reduce((sum, chunk) => sum + chunk.fakeCrmWrites, 0), chunks: chunks.length };
  }
  try {
    await start();
    if (recoverySeed) {
      await call({ action: 'interrupt', ...recoverySeed });
      await stop(); await start();
      const recovery = await call({ action: 'recover', ...recoverySeed });
      assert.equal(recovery.writes, 0);
      assert.deepEqual(recovery.before, ['sending', 'unknown', 'accepted']);
      assert.deepEqual(recovery.after, ['unknown', 'unknown', 'accepted']);
      return { mode: 'cloud D1 / restarted local Worker through remote binding', noPublicDeployment: true,
        reviewId: recoverySeed.reviewId, workspaceId: recoverySeed.workspaceId, recovery,
        note: 'Cold-isolate reconstruction qualified. CRM adapter fictional; zero CRM requests.' };
    }
    const seed = await call({ action: 'seed', count: 106 });
    const claims = await Promise.all(Array.from({ length: 3 }, () => call({ action: 'claim', ...seed })));
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    assert.equal(new Set(claims.map((claim) => claim.executionId)).size, 1);
    const cas = await call({ action: 'cas', ...seed });
    assert.equal(cas.winners, 1); assert(cas.staleRejected && cas.otherRowsPending);
    await call({ action: 'interrupt', ...seed });
    await stop(); await start();
    const recovery = await call({ action: 'recover', ...seed });
    assert.equal(recovery.writes, 0); assert.deepEqual(recovery.after, ['unknown', 'unknown', 'accepted']);
    assert.equal(recovery.held, 0); assert.equal(recovery.pending, 103);
    const execution = await completeExecution();
    assert.equal(execution.fakeCrmWrites, 99); assert.equal(execution.verified, 99); assert.equal(execution.error, null);
    return { mode: 'cloud D1 / local Worker through remote binding', noPublicDeployment: true,
      cloudDatabaseId: config.d1_databases.find((binding) => binding.binding === 'DB').database_id,
      review: seed, concurrentClaims: { winners: 1, sameExecution: true }, cas, recovery, execution,
      note: 'Cloud SQL/storage semantics qualified. Hosted Worker invocation limits were not exercised. CRM adapter fictional; zero CRM requests.' };
  } finally { await stop(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const emitIndex = process.argv.indexOf('--emit-worker');
  if (emitIndex !== -1) {
    const destination = process.argv[emitIndex + 1];
    assert(destination, '--emit-worker requires an output path.');
    await writeFile(resolve(destination), await buildSafeImportD1ProbeWorker());
    process.stdout.write(`Saved local probe bundle to ${resolve(destination)}. No deployment performed. Bind DB and SAFE_IMPORT_D1_PROBE_KEY only in a separately authorized qualification environment.\n`);
  } else {
    const remoteIndex = process.argv.indexOf('--remote-config');
    const result = remoteIndex === -1 ? await runSafeImportD1Qualification({ maxStorage: process.argv.includes('--max-storage') })
      : await runRemoteSafeImportD1Qualification(process.argv[remoteIndex + 1]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
