/** Seed and verify fictional routing scenarios through the unchanged public form endpoint. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const mode = process.argv[2];
if (!['seed', 'verify'].includes(mode)) throw new Error('Use: node scripts/hollis-routing-scenarios.mjs seed|verify');
const org = process.env.SF_TARGET_ORG || 'gtm-control-tower-salesforce';
const origin = 'https://hollis-consulting.harrisonoconnorhoover.workers.dev';
const expectedOrg = 'https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com';
const statePath = '.runtime/hollis-routing-scenarios.json';
mkdirSync('.runtime', { recursive: true });
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { ids: {}, cases: {}, checks: [] };
let auth = await authorize();
async function authorize() {
  const data = JSON.parse(execFileSync('sf', ['org', 'display', '--target-org', org, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(data.status, 0, 'Salesforce connection required');
  assert.equal(data.result.instanceUrl, expectedOrg, 'These fixtures are scoped to the connected development org');
  // CLI display masks its access token. Renew the already-authorized connection
  // in memory, without writing tokens or expanding its permissions.
  const saved = JSON.parse(execFileSync('sf', ['org', 'auth', 'show-sfdx-auth-url', '--target-org', org, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).result;
  const parts = saved.sfdxAuthUrl.replace(/^force:\/\//, '').split('@')[0].split(':');
  const body = new URLSearchParams({ grant_type: 'refresh_token',
    client_id: parts.length === 3 ? parts[0] : data.result.clientId,
    refresh_token: parts.length === 3 ? parts[2] : parts[0] });
  if (parts.length === 3 && parts[1]) body.set('client_secret', parts[1]);
  const response = await fetch(expectedOrg + '/services/oauth2/token', { method: 'POST', body, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Salesforce authorization unavailable (${response.status})`);
  const session = await response.json();
  assert.equal(session.instance_url, expectedOrg);
  assert(session.access_token, 'Salesforce session unavailable');
  return { token: session.access_token, url: expectedOrg };
}
const quote = value => "'" + value.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
async function api(path, method = 'GET', body) {
  const send = () => fetch(auth.url + '/services/data/v67.0' + path, {
    method, headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  let response = await send();
  if (response.status === 401) { auth = await authorize(); response = await send(); }
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(`Salesforce ${method} ${path.split('?')[0]}: ${JSON.stringify(result)}`);
  return result;
}
async function query(soql) { return (await api('/query?q=' + encodeURIComponent(soql))).records; }
async function ensure(object, where, fields) {
  const rows = await query(`SELECT Id FROM ${object} WHERE ${where} LIMIT 2`);
  assert(rows.length < 2, `Multiple fixture matches: ${object} ${where}`);
  if (rows.length) return rows[0].Id;
  return (await api('/sobjects/' + object, 'POST', fields)).id;
}
function input(key, firstName, lastName, domain, company) {
  state.cases[key] ||= { requestId: randomUUID(), firstName, lastName, email: firstName.toLowerCase() + '@' + domain, company, phone: '' };
}
const names = {
  cedar: 'Hollis Lab - Cedar Analytics', harbor: 'Hollis Lab - Harbor Cloud',
  analytics: 'Hollis Lab - Meridian Analytics', commerce: 'Hollis Lab - Meridian Commerce',
  alder: 'Hollis Lab - Alder Systems',
};
async function account(key, domain, owner, employees, region) {
  const id = await ensure('Account', 'Name = ' + quote(names[key]), {
    Name: names[key], Website: 'https://' + domain, OwnerId: owner, Type: 'Prospect',
    NumberOfEmployees: employees, BillingState: region, BillingCountry: 'United States', Industry: 'Technology',
    Description: 'Fictional Hollis routing lab fixture. Simulated trusted CRM enrichment, not a real company or customer. ' +
      'The current Account owner is authoritative for demo follow-up; size and location provide interview context.',
  });
  state.ids[key] = id; save(); return id;
}
async function seed() {
  const reps = await query("SELECT Id, Name, IsActive, Title, Division FROM User WHERE Name IN ('Alex Bennett','Jordan Hayes')");
  for (const [key, name] of [['alex', 'Alex Bennett'], ['jordan', 'Jordan Hayes']]) {
    const matches = reps.filter(rep => rep.Name === name && rep.IsActive);
    assert.equal(matches.length, 1, `One active ${name} required`);
    state.ids[key] = matches[0].Id;
  }
  state.reps = reps;
  const queues = await query("SELECT Id FROM Group WHERE Type = 'Queue' AND DeveloperName = 'GTM_Standard_Review'");
  assert.equal(queues.length, 1); state.ids.queue = queues[0].Id;
  await account('cedar', 'cedar-routing.example', state.ids.alex, 45, 'California');
  await account('harbor', 'harbor-routing.example', state.ids.jordan, 1400, 'New York');
  await account('analytics', 'meridian-routing.example', state.ids.jordan, 900, 'Massachusetts');
  await account('commerce', 'meridian-routing.example', state.ids.alex, 60, 'Oregon');
  input('queued', 'Morgan', 'Reed', 'cedar-routing.example', names.cedar);
  input('handoff', 'Priya', 'Shah', 'harbor-routing.example', names.harbor);
  input('businessUnit', 'Devon', 'Price', 'meridian-routing.example', names.analytics);
  input('ambiguous', 'Sam', 'Lopez', 'meridian-routing.example', 'Hollis Lab - Meridian Group');
  input('lateEnrichment', 'Grace', 'Kim', 'alder-routing.example', names.alder);
  state.ids.priya = await ensure('Contact', 'Email = ' + quote(state.cases.handoff.email), {
    FirstName: 'Priya', LastName: 'Shah', Email: state.cases.handoff.email,
    AccountId: state.ids.harbor, OwnerId: state.ids.alex, LeadSource: 'Partner Referral',
    Title: 'VP Revenue Operations', Phone: '+1 202 555 0115',
    Description: 'Fictional Hollis routing lab. Account has moved to Jordan, but this Contact still belongs to Alex.',
  });
  for (const key of ['queued', 'lateEnrichment']) {
    const person = state.cases[key];
    state.ids[key + 'Lead'] = await ensure('Lead', 'Email = ' + quote(person.email), {
      FirstName: person.firstName, LastName: person.lastName, Email: person.email, Company: person.company,
      OwnerId: state.ids.queue, LeadSource: 'Trade Show',
      Description: 'Fictional Hollis routing lab. Simulated marketing import left this Lead in the SDR review queue.',
    });
  }
  // First-touch LeadSource and request-level Source/Campaign are separate.
  // This org does not permit Campaign creation by the connected user.
  state.ids.readyLead = await ensure('Lead', "Email = 'avery@cedar-routing.example'", {
    FirstName: 'Avery', LastName: 'Collins', Email: 'avery@cedar-routing.example', Company: names.cedar,
    OwnerId: state.ids.queue, LeadSource: 'Trade Show',
    Description: 'Fictional Hollis routing lab. Ready for a manual form demonstration of queue-to-AE conversion.',
  });
  save(); console.log('Seeded fictional company, marketing, and ownership scenarios. Saved ' + statePath);
}
async function submit(key) {
  const body = state.cases[key]; assert(body, 'Run seed first');
  // Retry the same request on the public rate limit or transient failure. No new identity is minted.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = spawnSync('curl', ['--silent', '--show-error', '--max-time', '70', '--write-out', '\n%{http_code}',
      '--request', 'POST', origin + '/api/demo-request', '--header', 'Origin: ' + origin,
      '--header', 'Content-Type: application/json', '--data-binary', '@-'], { input: JSON.stringify(body), encoding: 'utf8' });
    const split = response.stdout.lastIndexOf('\n');
    const code = Number(response.stdout.slice(split + 1));
    if ([429, 502, 503, 504].includes(code) || response.status !== 0) {
      if (attempt === 2) throw new Error(`Public intake not confirmed (${code}); rerun verify with the saved request IDs`);
      console.log(`Waiting for ${code === 429 ? 'the public rate limit' : 'temporary intake failure'}; next attempt reuses ${key}.`);
      await new Promise(resolve => setTimeout(resolve, code === 429 ? 60000 : 2000));
      continue;
    }
    assert.equal(code, 200, response.stdout);
    assert.deepEqual(JSON.parse(response.stdout.slice(0, split)), { accepted: true, requestId: body.requestId });
    return readRequest(key);
  }
}
async function readRequest(key) {
  const rows = await query(`SELECT Id, Request_Key__c, Status__c, Account__c, Contact__c, Task_Id__c, Follow_Up_Owner__c,
    Source__c, Campaign__c, Routing_Detail__c, Reason__c, Notification_Status__c FROM GTM_Demo_Request__c
    WHERE Request_Key__c = '${state.cases[key].requestId}'`);
  assert.equal(rows.length, 1); return rows[0];
}
function check(name, details) {
  state.checks.push({ name, at: new Date().toISOString(), ...details }); save(); console.log('PASS: ' + name);
}
async function routed(key, owner, accountId) {
  const receipt = await submit(key);
  assert.equal(receipt.Status__c, 'Routed');
  assert.equal(receipt.Follow_Up_Owner__c, owner);
  assert.equal(receipt.Account__c, accountId);
  assert.equal(receipt.Source__c, 'hollis-website');
  assert.equal(receipt.Campaign__c, 'request-a-demo');
  const task = (await query(`SELECT Id, WhoId, WhatId, OwnerId, Description FROM Task WHERE Id = '${receipt.Task_Id__c}'`))[0];
  assert.equal(task.WhoId, receipt.Contact__c); assert.equal(task.WhatId, accountId); assert.equal(task.OwnerId, owner);
  assert(task.Description.includes(receipt.Routing_Detail__c));
  return receipt;
}
async function verify() {
  assert(state.ids.priya && state.cases.lateEnrichment, 'Run seed first');
  const queued = await routed('queued', state.ids.alex, state.ids.cedar);
  const converted = (await query(`SELECT IsConverted, ConvertedContactId, ConvertedOpportunityId, LeadSource FROM Lead WHERE Id = '${state.ids.queuedLead}'`))[0];
  assert(converted.IsConverted); assert.equal(converted.ConvertedContactId, queued.Contact__c);
  assert.equal(converted.ConvertedOpportunityId, null); assert.equal(converted.LeadSource, 'Trade Show');
  check('Queued marketing Lead converted for Alex; first-touch source preserved', { receipt: queued });

  const handoff = await routed('handoff', state.ids.jordan, state.ids.harbor);
  const priya = (await query(`SELECT OwnerId, LeadSource, Phone FROM Contact WHERE Id = '${state.ids.priya}'`))[0];
  assert.equal(handoff.Contact__c, state.ids.priya); assert.equal(priya.OwnerId, state.ids.alex);
  assert.equal(priya.LeadSource, 'Partner Referral'); assert.equal(priya.Phone, '+1 202 555 0115');
  check('Jordan receives the task while Priya retains her original owner and first-touch fields', { receipt: handoff });

  const unit = await routed('businessUnit', state.ids.jordan, state.ids.analytics);
  check('Shared-domain business unit matched by exact name and routed to Jordan', { receipt: unit });
  const ambiguous = await submit('ambiguous');
  assert.equal(ambiguous.Status__c, 'Held'); assert.equal(ambiguous.Account__c, null); assert.equal(ambiguous.Contact__c, null);
  assert(ambiguous.Task_Id__c);
  assert.equal((await query('SELECT Id FROM Contact WHERE Email = ' + quote(state.cases.ambiguous.email))).length, 0);
  check('Unknown business unit held without a guessed Account or duplicate Contact', { receipt: ambiguous });

  const late = await submit('lateEnrichment');
  if (late.Status__c === 'Held') {
    assert.equal(late.Contact__c, null);
    check('Missing enrichment held for review before Lead conversion', { receipt: late });
    await account('alder', 'alder-routing.example', state.ids.jordan, 700, 'New York');
  } else assert(state.ids.alder, 'Unexpected pre-existing routing result');
  const resumed = await routed('lateEnrichment', state.ids.jordan, state.ids.alder);
  assert.equal(resumed.Task_Id__c, late.Task_Id__c);
  check('Trusted CRM enrichment resumes the same request and review task', { receipt: resumed });

  // Discarding the first successful response models an integration that never received its acknowledgement.
  const before = await query(`SELECT Id FROM Task WHERE WhoId = '${unit.Contact__c}'`);
  const replay = await routed('businessUnit', state.ids.jordan, state.ids.analytics);
  assert.equal(replay.Id, unit.Id); assert.equal(replay.Task_Id__c, unit.Task_Id__c); assert.equal(replay.Contact__c, unit.Contact__c);
  const after = await query(`SELECT Id FROM Task WHERE WhoId = '${unit.Contact__c}'`);
  assert.deepEqual(after.map(x => x.Id).sort(), before.map(x => x.Id).sort());
  assert.equal((await query('SELECT Id FROM Contact WHERE Email = ' + quote(state.cases.businessUnit.email))).length, 1);
  check('Lost-response replay reused the exact request, Account, Contact, and task', { receipt: replay });
  state.verifiedAt = new Date().toISOString(); save();
  console.log('Verified all scenarios against native Salesforce records: ' + statePath);
}
await (mode === 'seed' ? seed() : verify());
