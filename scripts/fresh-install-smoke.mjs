const baseUrl = process.env.CONTROL_TOWER_SMOKE_BASE_URL;
const n8nUrl = process.env.CONTROL_TOWER_SMOKE_N8N_URL;
const phase = process.argv[2];

if (!baseUrl || !n8nUrl) throw new Error('The smoke-test app and n8n URLs are required.');
if (!['prepare', 'verify'].includes(phase)) throw new Error('Use prepare or verify.');

await waitFor(`${baseUrl}/api/control-tower/connectors`);
await waitFor(`${n8nUrl}/healthz`);

if (phase === 'prepare') {
  await expectStatus(`${baseUrl}/app`, 200);
  await expectStatus(`${baseUrl}/setup`, 200);
  const catalog = await getJson(`${baseUrl}/api/control-tower/connectors`);
  assert(catalog.persistenceEnabled === true, 'Fresh SQLite persistence was not enabled.');
  const csv = catalog.connectors.find((connector) => connector.id === 'csv');
  assert(csv?.configured === true, 'CSV mode was not ready without credentials.');
  for (const id of ['google-sheets', 'hubspot', 'salesforce', 'bigquery']) {
    assert(catalog.connectors.find((connector) => connector.id === id)?.configured === false, `${id} unexpectedly reported configured.`);
  }

  const created = await postJson(`${baseUrl}/api/control-tower/workspace`, {
    action: 'create',
    name: 'Fresh stranger proof',
  });
  const id = created.workspace?.id;
  assert(typeof id === 'string' && id.length > 0, 'Fresh workspace did not return an ID.');
  const contact = publicCompanyContact();
  const state = workspaceState(contact, 'NVIDIA CORP');
  const first = await postJson(`${baseUrl}/api/control-tower/workspace`, {
    action: 'save', id, state, reason: 'fresh_install_import',
  });
  assert(first.workspace?.revision === 1, 'First saved revision was not 1.');
  const second = await postJson(`${baseUrl}/api/control-tower/workspace`, {
    action: 'save', id, state: workspaceState(contact, 'Changed after save'), reason: 'fresh_install_second_revision',
  });
  assert(second.workspace?.revision === 2, 'Second saved revision was not 2.');
  process.stdout.write(id);
}

if (phase === 'verify') {
  const id = process.argv[3];
  assert(Boolean(id), 'A workspace ID is required for verification.');
  const reloaded = await getJson(`${baseUrl}/api/control-tower/workspace?id=${encodeURIComponent(id)}`);
  assert(reloaded.workspace?.revision === 2, 'Restart did not preserve revision 2.');
  assert(reloaded.workspace?.state?.contacts?.[0]?.company === 'Changed after save', 'Restart did not preserve workspace state.');
  const undone = await postJson(`${baseUrl}/api/control-tower/workspace`, { action: 'undo', id });
  assert(undone.workspace?.revision === 1, 'Undo did not restore revision 1.');
  assert(undone.workspace?.state?.contacts?.[0]?.company === 'NVIDIA CORP', 'Undo did not restore the original company.');
  console.log(JSON.stringify({
    app: 'ready',
    n8n: 'ready',
    credentials: 'none',
    persistedRevision: 2,
    undoRevision: 1,
  }));
}

function publicCompanyContact() {
  return {
    contactId: 'SEC-SMOKE-001',
    fullName: 'Synthetic Avery Stone',
    firstName: 'Synthetic Avery',
    lastName: 'Stone',
    rawEmail: 'synthetic.avery@example.com',
    normalizedEmail: 'synthetic.avery@example.com',
    company: 'NVIDIA CORP',
    phone: '+14125550101',
    jobTitle: 'Revenue Operations Manager',
    website: 'https://nvda.example',
    region: 'Northeast',
    segment: 'Enterprise',
    lifecycleStage: 'lead',
    expectedLifecycleStage: 'lead',
    ownerId: 'NE-ENT',
    canonicalContactId: null,
    recordStatus: 'active',
    lastAction: 'csv_imported',
    qualityFlags: [],
    updatedAt: new Date().toISOString(),
  };
}

function workspaceState(contact, company) {
  const row = { ...contact, company };
  return {
    contacts: [row],
    originalContacts: [contact],
    repairHistory: [],
    receipts: [],
    mapping: { rawEmail: 'email_address', company: 'account_name' },
    fileName: 'sec-public-company-messy-crm.csv',
    sourceType: 'csv',
    destinationType: 'csv',
    sourceLabel: 'SEC public company snapshot plus synthetic contacts',
  };
}

async function waitFor(url) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError ?? new Error(`${url} did not become ready.`);
}

async function expectStatus(url, expected) {
  const response = await fetch(url);
  assert(response.status === expected, `${url} returned ${response.status}, expected ${expected}.`);
}

async function getJson(url) {
  const response = await fetch(url);
  const json = await response.json();
  assert(response.ok, `${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  assert(response.ok, `${url} returned ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
