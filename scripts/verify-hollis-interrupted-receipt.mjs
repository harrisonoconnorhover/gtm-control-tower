/** Inject a local response-body failure after a REAL Salesforce commit, then verify recovery. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const origin = 'https://hollis-consulting.harrisonoconnorhoover.workers.dev';
const instance = 'https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com';
const org = 'gtm-control-tower-salesforce';
const native = JSON.parse(execFileSync('sf', ['org', 'auth', 'show-access-token', '--target-org', org, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const connection = JSON.parse(execFileSync('sf', ['org', 'display', '--target-org', org, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).result;
assert.equal(connection.instanceUrl, instance);
assert(native.result.accessToken && !native.result.accessToken.startsWith('*'));
const build = 'hollis/.runtime/hollis-worker-build/worker.js';
// Test the current source, rather than a stale bundle left by a previous run.
execFileSync(resolve('node_modules/.bin/wrangler'), ['deploy', '--config', 'hollis/wrangler.jsonc', '--dry-run', '--outdir', '.runtime/hollis-worker-build'], { stdio: ['ignore', 'pipe', 'pipe'] });
assert(existsSync(build), 'The Hollis Worker build did not produce its expected bundle.');
const proofPath = '.runtime/hollis-interrupted-receipt-proof.json';
mkdirSync('.runtime', { recursive: true });
const previous = existsSync(proofPath) ? JSON.parse(readFileSync(proofPath, 'utf8')) : {};
const input = previous.input || { requestId: randomUUID(), firstName: 'Leo', lastName: 'Brooks',
  email: 'leo@willow-routing.example', phone: '', company: 'Hollis Lab - Willow Systems' };
writeFileSync(proofPath, JSON.stringify({ input, verified: false }, null, 2));
const realFetch = globalThis.fetch;
const receipts = [], payloads = [];
let deliveries = 0;
globalThis.fetch = async (url, init) => {
  if (url === instance + '/services/oauth2/token') {
    // Authentication is supplied by the existing CLI session. Only the routing
    // calls below go to Salesforce; no fake credentials leave this harness.
    return Response.json({ access_token: native.result.accessToken, instance_url: instance });
  }
  assert.equal(url, instance + '/services/apexrest/gtm/demo-intake');
  payloads.push(String(init.body));
  const response = await realFetch(url, init);
  assert.equal(response.status, 200, 'Native intake must commit successfully before fault injection');
  const receipt = await response.json(); receipts.push(receipt);
  if (++deliveries === 1) {
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"requestId":'));
      controller.error(new TypeError('Deliberate local interruption after the Salesforce commit'));
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return Response.json(receipt);
};
try {
  const worker = (await import(pathToFileURL(resolve(build)).href)).default;
  const response = await worker.fetch(new Request(origin + '/api/demo-request', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.19' },
    body: JSON.stringify(input),
  }), {
    PUBLIC_ORIGIN: origin, SALESFORCE_INSTANCE_URL: instance,
    SALESFORCE_CLIENT_ID: 'local-fixture-only', SALESFORCE_REFRESH_TOKEN: 'local-fixture-only',
    INTAKE_RATE_LIMIT: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => { throw new Error('Asset access is outside this drill'); } },
  });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { accepted: true, requestId: input.requestId });
  assert.equal(deliveries, 2); assert.equal(payloads[0], payloads[1]);
  assert.equal(receipts[1].reusedRequest, true);
  for (const key of ['submissionId', 'accountId', 'personId', 'taskId']) assert.equal(receipts[0][key], receipts[1][key]);
  assert.equal(receipts[1].status, 'Routed');
  const q = `SELECT Id, OwnerId, WhoId, WhatId FROM Task WHERE WhoId = '${receipts[1].personId}'`;
  const result = await realFetch(instance + '/services/data/v67.0/query?q=' + encodeURIComponent(q), {
    headers: { Authorization: 'Bearer ' + native.result.accessToken },
  });
  assert.equal(result.status, 200);
  const tasks = (await result.json()).records;
  assert.equal(tasks.length, 1); assert.equal(tasks[0].Id, receipts[1].taskId);
  assert.equal(tasks[0].WhoId, receipts[1].personId); assert.equal(tasks[0].WhatId, receipts[1].accountId);
  assert.equal(tasks[0].OwnerId, receipts[1].ownerId);
  const email = input.email.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
  const peopleResponse = await realFetch(instance + '/services/data/v67.0/query?q=' + encodeURIComponent(`SELECT Id FROM Contact WHERE Email = '${email}'`), {
    headers: { Authorization: 'Bearer ' + native.result.accessToken },
  });
  assert.equal(peopleResponse.status, 200);
  const contacts = (await peopleResponse.json()).records;
  assert.equal(contacts.length, 1); assert.equal(contacts[0].Id, receipts[1].personId);
  writeFileSync(proofPath, JSON.stringify({ input, receipts, tasks, contacts, verified: true, verifiedAt: new Date().toISOString(),
    boundary: 'Locally injected transport failure; real Salesforce intake and native record readback. This does not interrupt the public site.' }, null, 2));
  console.log('PASS: interrupted receipt after a real Salesforce commit recovered with one request, one Contact, and one task.');
} finally { globalThis.fetch = realFetch; }
