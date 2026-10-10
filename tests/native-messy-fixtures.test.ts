import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNativeSeedProperties, createNativeFixtureClient, NativeFixtureError, seedNativeWorld } from '../scripts/native-messy-fixtures.mjs';
import { generateMessyCrm } from '../fixtures/messy-crm.mjs';

function metadata() {
  const fields = (names: string) => Object.fromEntries(names.split(' ').map(name => [name, { name, writable: true, options: [] }]));
  return { objects: {
    Contact: fields('FirstName LastName Email Title Description AccountId'),
    Lead: { ...fields('FirstName LastName Email Title Description Company Status'), Status: { writable: true, options: [{ value: 'Open - Not Contacted', defaultValue: true }] } },
    Account: fields('Name Website Description'),
    Opportunity: { ...fields('Name Amount CloseDate AccountId Description'), StageName: { writable: true, options: [{ value: 'Prospecting', defaultValue: true }] } },
  } };
}
function manifest() { return { runId: 'native-test', marker: 'GTMCT messy native-test', seed: 42, records: {} }; }

test('native mapping preserves duplicate equivalence and records legal fallbacks without changing the dataset', () => {
  const world = generateMessyCrm('salesforce');
  const before = JSON.stringify(world);
  const context = { provider: 'salesforce', metadata: metadata(), manifest: manifest() };
  const shared = world.expected.find(label => label.scenario === 'duplicate_email_candidate');
  assert(shared && 'relatedRecordIds' in shared && Array.isArray(shared.relatedRecordIds));
  const relatedId = shared.relatedRecordIds[0];
  const duplicate = world.records.find(record => record.id === shared.recordId);
  const original = world.records.find(record => record.id === relatedId);
  assert.equal(buildNativeSeedProperties(duplicate, context).Email, buildNativeSeedProperties(original, context).Email);
  assert.match(buildNativeSeedProperties(duplicate, { ...context, fallback: true }).Email, /@native-test\.example$/);
  const orphan = world.deals[0];
  assert.equal(buildNativeSeedProperties(orphan, context).AccountId, orphan.properties.company_id);
  assert.equal(buildNativeSeedProperties(orphan, { ...context, fallback: true }).AccountId, undefined);
  assert.equal(buildNativeSeedProperties(world.deals[18], { ...context, fallback: true }).Amount, undefined);
  assert.equal(buildNativeSeedProperties(world.deals[24], { ...context, fallback: true }).CloseDate, '2026-11-28');
  assert.equal(buildNativeSeedProperties(world.deals[24], context).StageName, 'Prospecting');
  assert.notEqual(buildNativeSeedProperties(world.contacts[0], context).LastName, buildNativeSeedProperties(world.contacts[60], context).LastName);
  assert.equal(JSON.stringify(world), before);
});

test('HubSpot uses reserved example.com email subdomains while preserving duplicate equivalence', () => {
  const world = generateMessyCrm('hubspot');
  const hsMetadata = { objects: {
    Contact: Object.fromEntries('firstname lastname email company jobtitle message lifecyclestage'.split(' ').map(name => [name, { writable: true, options: [] }])),
    Company: Object.fromEntries('name domain description'.split(' ').map(name => [name, { writable: true, options: [] }])),
  } };
  const context = { provider: 'hubspot', metadata: hsMetadata, manifest: manifest() };
  const original = buildNativeSeedProperties(world.contacts[44], context).email;
  const duplicate = buildNativeSeedProperties(world.contacts[54], context).email;
  assert.equal(original, duplicate);
  assert.match(original, /@native-test\.company-\d+\.example\.com$/);
  assert.equal(buildNativeSeedProperties(world.contacts[12], { ...context, fallback: true }).email, 'contact-100013@native-test.example.com');
  const normalContact = buildNativeSeedProperties(world.contacts[200], context);
  const normalCompany = buildNativeSeedProperties(world.companies[201], context);
  assert.equal(normalContact.email.split('@')[1], normalCompany.domain, 'An ordinary native Company and Contact share the same reserved suffix.');
  assert.equal(buildNativeSeedProperties(world.companies[0], context).domain, buildNativeSeedProperties(world.companies[101], context).domain,
    'The deliberately shared Company domain remains duplicated.');
  assert.notEqual(buildNativeSeedProperties(world.contacts[349], context).email.split('@')[1], buildNativeSeedProperties(world.companies[0], context).domain,
    'Source-domain mismatches introduced by the deliberate Company-domain scenario are not rewritten.');
});

test('resuming preserves an acknowledged HubSpot Company with the previous suffix', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-seed-'));
  const path = join(directory, 'manifest.json');
  const world = generateMessyCrm('hubspot'); world.records = [world.companies[201]];
  const savedRecord = { fixtureId: world.records[0].id, objectType: 'Company', nativeId: '987654321', marker: 'GTMCT messy native-test',
    seedPayload: { name: 'Previously acknowledged Company', domain: 'native-test.company-202.example' }, status: 'created' };
  const state = { ...manifest(), version: 1, datasetVersion: world.version, provider: 'hubspot', accountId: '12345',
    records: { [`Company:${world.records[0].id}`]: savedRecord }, associations: {}, pending: {}, rejected: [], transformations: [] };
  writeFileSync(path, JSON.stringify(state));
  let checked = 0, created = 0;
  const client = { provider: 'hubspot', accountId: '12345', calls: {}, verifyIdentity: async () => ({}), metadata: async () => ({ objects: {} }),
    create: async () => { created++; throw new Error('Existing Companies must not be recreated or patched.'); },
    verifyOwnership: async () => { checked++; return { id: savedRecord.nativeId, properties: savedRecord.seedPayload }; },
  };
  try {
    const result = await seedNativeWorld({ world, client, manifestPath: path, runId: 'native-test' });
    assert.equal(created, 0); assert.equal(checked, 1);
    assert.deepEqual(result.records, [savedRecord]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('confirmed native validation rejection is retained and a fallback is verified', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-seed-'));
  const path = join(directory, 'manifest.json');
  const world = generateMessyCrm('salesforce');
  world.records = [world.contacts[12]];
  let creates = 0;
  const client = { provider: 'salesforce', accountId: '00D000000000042', calls: {}, verifyIdentity: async () => ({}), metadata: async () => metadata(),
    create: async () => { if (++creates === 1) throw new NativeFixtureError('Invalid email', 400, false, ['INVALID_EMAIL_ADDRESS'], { message: 'Fixture email was invalid.' }); return '003000000000013'; },
    verifyOwnership: async () => ({ Id: '003000000000013', Description: 'GTMCT messy native-test; fixture' }),
  };
  try {
    const result = await seedNativeWorld({ world, client, manifestPath: path, runId: 'native-test' });
    assert.equal(creates, 2);
    assert.equal(result.manifest.rejected.length, 1);
    assert.equal(result.manifest.rejected[0].properties.Email, 'invalid address 13');
    assert.deepEqual(result.manifest.rejected[0].providerDetails, { message: 'Fixture email was invalid.' });
    assert.match(result.records[0].seedPayload.Email, /@native-test\.example$/);
    assert.equal(Object.keys(result.manifest.pending).length, 0);
    await seedNativeWorld({ world, client, manifestPath: path, runId: 'native-test' });
    assert.equal(creates, 2, 'A confirmed existing record is checked, not recreated.');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('provider diagnostics are private and credentials are removed', async () => {
  const client = createNativeFixtureClient({ provider: 'salesforce', accountId: '00D000000000042', token: 'fake-private-secret', instanceUrl: 'https://diagnostic-test.salesforce.com',
    fetchImpl: async (_url, init) => init?.method === 'GET'
      ? Response.json({ records: [{ Id: '00D000000000042', OrganizationType: 'Developer Edition', IsSandbox: false }] })
      : Response.json([{ errorCode: 'INVALID_EMAIL_ADDRESS', message: 'Invalid fixture email; fake-private-secret', access_token: 'another-secret' }], { status: 400 }),
  });
  await client.verifyIdentity();
  await assert.rejects(client.create('Contact', { Email: 'invalid' }), error => {
    assert(error instanceof NativeFixtureError);
    const serialized = JSON.stringify(error);
    assert(!serialized.includes('Invalid fixture email'));
    assert(!serialized.includes('fake-private-secret'));
    assert('details' in error);
    const privateDetails = JSON.stringify(error.details);
    assert(privateDetails.includes('Invalid fixture email'));
    assert(!privateDetails.includes('fake-private-secret'));
    assert(!privateDetails.includes('another-secret'));
    return true;
  });
});

test('lost native create response is saved and never replayed on resume', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-seed-'));
  const path = join(directory, 'manifest.json');
  const world = generateMessyCrm('salesforce'); world.records = [world.contacts[100]];
  let creates = 0;
  const client = { provider: 'salesforce', accountId: '00D000000000042', calls: {}, verifyIdentity: async () => ({}), metadata: async () => metadata(),
    create: async () => { creates++; throw new NativeFixtureError('Lost response', 0, true); },
  };
  try {
    await assert.rejects(seedNativeWorld({ world, client, manifestPath: path, runId: 'native-test' }), /Lost response/);
    assert.equal(Object.keys(JSON.parse(readFileSync(path, 'utf8')).pending).length, 1);
    await assert.rejects(seedNativeWorld({ world, client, manifestPath: path, runId: 'native-test' }), /require reconciliation/);
    assert.equal(creates, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Salesforce fuzzy-name rejection changes only names and preserves the original email', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-seed-'));
  const world = generateMessyCrm('salesforce'); world.records = [world.contacts[60]];
  let creates = 0;
  const client = { provider: 'salesforce', accountId: '00D000000000042', calls: {}, verifyIdentity: async () => ({}), metadata: async () => metadata(),
    create: async () => { if (++creates === 1) throw new NativeFixtureError('Fuzzy duplicate', 400, false, ['DUPLICATES_DETECTED']); return '003000000000061'; },
    verifyOwnership: async () => ({ Id: '003000000000061', Description: 'GTMCT messy native-test; fixture' }),
  };
  try {
    // This record has a deliberately duplicated email. A separate clean record repeats the same generated name.
    world.records = [world.contacts[120]];
    const result = await seedNativeWorld({ world, client, manifestPath: join(directory, 'manifest.json'), runId: 'native-test' });
    const original = result.manifest.rejected[0].properties;
    assert.equal(creates, 2);
    assert.equal(result.records[0].seedPayload.Email, original.Email);
    assert.notEqual(result.records[0].seedPayload.FirstName, original.FirstName);
    assert.notEqual(result.records[0].seedPayload.LastName, original.LastName);
    assert.deepEqual({ ...result.records[0].seedPayload, FirstName: original.FirstName, LastName: original.LastName }, original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an explicit rate rejection observes Retry-After and unknown writes are not replayed', async () => {
  const postedAt: number[] = [];
  let loseNextWrite = false;
  const client = createNativeFixtureClient({ provider: 'salesforce', accountId: '00D000000000042', token: 'fake-local-only', instanceUrl: 'https://rate-test.salesforce.com',
    fetchImpl: async (_url, init) => {
      if (init?.method === 'GET') return Response.json({ records: [{ Id: '00D000000000042', OrganizationType: 'Developer Edition', IsSandbox: false }] });
      postedAt.push(Date.now());
      if (loseNextWrite) throw new Error('Lost response');
      if (postedAt.length === 1) return Response.json({ errorCode: 'REQUEST_LIMIT_EXCEEDED' }, { status: 429, headers: { 'retry-after': '0.3' } });
      return Response.json({ id: '003000000000061' }, { status: 201 });
    },
  });
  await client.verifyIdentity();
  assert.equal(await client.create('Contact', { LastName: 'Fixture' }), '003000000000061');
  assert.equal(postedAt.length, 2);
  assert(postedAt[1] - postedAt[0] >= 290, 'The retry honors the server cooldown.');
  assert.equal(client.calls.rateLimitRetries, 1);
  loseNextWrite = true;
  await assert.rejects(client.create('Contact', { LastName: 'Fixture' }), error => error instanceof NativeFixtureError && error.unknown);
  assert.equal(postedAt.length, 3, 'A lost create response is never replayed.');
});

test('native patches reject wrong account and unowned records before sending', async () => {
  const methods: string[] = [];
  let wrongOrg = true;
  const client = createNativeFixtureClient({ provider: 'salesforce', accountId: '00D000000000042', token: 'fake-local-only', instanceUrl: 'https://native-test.salesforce.com',
    fetchImpl: async (url, init) => {
      methods.push(init?.method ?? 'GET');
      const payload = String(url).includes('/query?') ? { records: [{ Id: wrongOrg ? '00D000000000099' : '00D000000000042', OrganizationType: 'Developer Edition', IsSandbox: false }] }
        : { Id: '003000000000001', Description: 'Unrelated record' };
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  await assert.rejects(client.patchOwned('Contact', '003000000000001', { Title: 'Updated' }, 'GTMCT messy native-test'), /pinned test account/);
  wrongOrg = false;
  await assert.rejects(client.patchOwned('Contact', '003000000000001', { Title: 'Updated' }, 'GTMCT messy native-test'), /ownership marker/);
  assert.equal(methods.includes('PATCH'), false);
});
