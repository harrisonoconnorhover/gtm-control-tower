import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const appUrl = process.argv[2];
assert(appUrl, 'Pass the running local app URL.');
const appOrigin = new URL(appUrl);
assert(['localhost', '127.0.0.1'].includes(appOrigin.hostname), 'The development proof targets a local app.');
const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
const token = process.env.SALESFORCE_ACCESS_TOKEN;
assert(instanceUrl && token, 'Configure the ignored Salesforce environment first.');
const apiRoot = `${new URL(instanceUrl).origin}/services/data/v${process.env.SALESFORCE_API_VERSION || '67.0'}`;
const providerHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const proofPath = '.runtime/demo-intake-proof.json';
mkdirSync('.runtime', { recursive: true });
const tag = randomUUID().slice(0, 8);
const form = (firstName, lastName, email, company) => ({ requestId: randomUUID(), firstName, lastName, email, phone: '+1 202-555-0148', company, source: 'website', campaign: 'intake-development-proof' });
const proof = existsSync(proofPath) ? JSON.parse(readFileSync(proofPath, 'utf8')) : {
  instanceUrl: new URL(instanceUrl).origin,
  createdAt: new Date().toISOString(),
  requests: {
    contact: form('Elena', 'Foster', 'elena.foster@cedar-demo.example', 'Cedar Demo Studio'),
    contactAgain: form('Elena', 'Foster', 'elena.foster@cedar-demo.example', 'Cedar Demo Studio'),
    lead: form('Miles', 'Santos', `miles.santos.${tag}@juniper-demo.example`, 'Juniper Demo Sleep'),
    leadAgain: form('Miles', 'Santos', `miles.santos.${tag}@juniper-demo.example`, 'Juniper Demo Sleep'),
    parallelOne: form('Leah', 'Wilson', `leah.wilson.${tag}@harbor-demo.example`, 'Harbor Demo Goods'),
    parallelTwo: form('Leah', 'Wilson', `leah.wilson.${tag}@harbor-demo.example`, 'Harbor Demo Goods'),
  },
  receipts: {},
};
assert.equal(proof.instanceUrl, new URL(instanceUrl).origin, 'This proof belongs to another org; inspect it before starting a different one.');
const save = () => writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
save();

const identity = await provider('/services/oauth2/userinfo');
const userId = identity.user_id;
assert(userId, 'Could not identify the connected Salesforce user.');
let contacts = await query(`SELECT Id, OwnerId FROM Contact WHERE Email = '${proof.requests.contact.email}'`);
if (!contacts.length) {
  if (!proof.seedAccountId) {
    const accounts = await query(`SELECT Id FROM Account WHERE Name = 'Cedar Demo Studio' AND OwnerId = '${userId}' LIMIT 1`);
    proof.seedAccountId = accounts[0]?.Id ?? (await provider(`${apiRoot}/sobjects/Account`, { method: 'POST', body: JSON.stringify({ Name: 'Cedar Demo Studio' }) })).id;
    save();
  }
  const contact = await provider(`${apiRoot}/sobjects/Contact`, { method: 'POST', body: JSON.stringify({ FirstName: 'Elena', LastName: 'Foster', Email: proof.requests.contact.email, AccountId: proof.seedAccountId, OwnerId: userId }) });
  contacts = [{ Id: contact.id, OwnerId: userId }];
}
assert.equal(contacts.length, 1, 'The seed email is ambiguous; review it before running the proof.');
assert.equal(contacts[0].OwnerId, userId, 'The proof only sends notifications to the connected user.');
const seedContactId = contacts[0].Id;
const initialLeadMatches = await query(`SELECT Id FROM Lead WHERE IsConverted = false AND Email = '${proof.requests.contact.email}'`);
assert.equal(initialLeadMatches.length, 0, 'The Contact seed also matches a Lead. Review the ambiguity.');

const first = await submit('contact');
assert.equal(first.personId, seedContactId);
assert.equal(first.createdPerson, false);
assert.equal(first.personType, 'Contact');
const replay = await submit('contact');
assert.equal(replay.submissionId, first.submissionId);
assert.equal(replay.taskId, first.taskId);
assert.equal(replay.reusedRequest, true);
const again = await submit('contactAgain');
assert.equal(again.personId, first.personId);
assert.notEqual(again.taskId, first.taskId);

const lead = await submit('lead');
assert.equal(lead.personType, 'Lead');
assert.equal(lead.createdPerson, true);
const leadAgain = await submit('leadAgain');
assert.equal(leadAgain.personId, lead.personId);
assert.equal(leadAgain.createdPerson, false);
assert.notEqual(leadAgain.taskId, lead.taskId);

// Both real requests start together. A first-lock collision may need reconciliation.
const parallel = await Promise.allSettled(['parallelOne', 'parallelTwo'].map(name => submit(name)));
for (let index = 0; index < parallel.length; index++) {
  if (parallel[index].status === 'rejected') await submit(['parallelOne', 'parallelTwo'][index]);
}
assert.equal(proof.receipts.parallelOne.personId, proof.receipts.parallelTwo.personId);
assert.notEqual(proof.receipts.parallelOne.taskId, proof.receipts.parallelTwo.taskId);

const receipts = Object.values(proof.receipts);
for (const result of receipts) {
  assert.equal(result.status, 'Routed');
  assert.equal(result.ownerId, userId);
  assert.equal(result.notificationStatus, 'Requested');
}
const personIds = [...new Set(receipts.map(result => result.personId))];
const tasks = await query(`SELECT Id, WhoId, OwnerId, Description FROM Task WHERE WhoId IN (${personIds.map(id => `'${id}'`).join(',')})`);
for (const [name, input] of Object.entries(proof.requests)) {
  const matching = tasks.filter(task => task.Description?.includes(input.requestId));
  assert.equal(matching.length, 1, `${name} must have exactly one follow-up task.`);
  assert.equal(matching[0].Id, proof.receipts[name].taskId);
  assert.equal(matching[0].OwnerId, userId);
}
for (const input of [proof.requests.lead, proof.requests.parallelOne]) {
  assert.equal((await query(`SELECT Id FROM Lead WHERE IsConverted = false AND Email = '${input.email}'`)).length, 1);
}
assert.equal((await query(`SELECT Id FROM Lead WHERE IsConverted = false AND Email = '${proof.requests.contact.email}'`)).length, 0);
const contactAfter = (await query(`SELECT OwnerId, GTM_Last_Demo_Requested_At__c FROM Contact WHERE Id = '${seedContactId}'`))[0];
assert.equal(contactAfter.OwnerId, userId);
assert(contactAfter.GTM_Last_Demo_Requested_At__c);
const nativeRequests = await query(`SELECT Id, Request_Key__c, Status__c, Task_Id__c, Notification_Status__c FROM GTM_Demo_Request__c WHERE Request_Key__c IN (${Object.values(proof.requests).map(input => `'${input.requestId}'`).join(',')})`);
assert.equal(nativeRequests.length, 6);
for (const native of nativeRequests) {
  const result = receipts.find(receipt => receipt.requestId === native.Request_Key__c);
  assert.equal(native.Id, result.submissionId);
  assert.equal(native.Task_Id__c, result.taskId);
  assert.equal(native.Status__c, 'Routed');
  assert.equal(native.Notification_Status__c, 'Requested');
}
proof.nativeRequests = nativeRequests;
proof.verifiedAt = new Date().toISOString();
proof.summary = { requests: 6, tasks: 6, people: 3, newLeads: 2, existingContactReused: true, retryReusedTask: true, concurrentRequestsSharedLead: true, notificationsAccepted: 6 };
save();
console.log(JSON.stringify({ verified: true, ...proof.summary, evidence: proofPath }, null, 2));

async function submit(name) {
  const input = proof.requests[name];
  const response = await fetch(`${appOrigin.origin}/api/control-tower/demo-intake`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.CONTROL_TOWER_SYNC_KEY ? { 'x-control-tower-key': process.env.CONTROL_TOWER_SYNC_KEY } : {}) },
    body: JSON.stringify(input), signal: AbortSignal.timeout(40_000),
  });
  const receipt = await response.json();
  assert(response.ok, `${name}: ${response.status}: ${receipt.error ?? 'No complete receipt'}. Rerun to reconcile the saved request IDs.`);
  assert.equal(receipt.requestId, input.requestId);
  proof.receipts[name] = receipt;
  save();
  return receipt;
}

async function provider(path, options = {}) {
  const response = await fetch(path.startsWith('https:') ? path : `${new URL(instanceUrl).origin}${path}`, { ...options, headers: providerHeaders, signal: AbortSignal.timeout(30_000) });
  const body = await response.json();
  assert(response.ok, `Salesforce ${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

async function query(soql) {
  const records = [];
  let path = `${apiRoot}/query?q=${encodeURIComponent(soql)}`;
  while (path) {
    const page = await provider(path);
    records.push(...page.records);
    path = page.nextRecordsUrl;
  }
  return records;
}
