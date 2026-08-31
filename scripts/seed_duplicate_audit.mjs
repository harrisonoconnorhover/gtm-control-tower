const mode = process.argv[2] ?? 'both';
if (!['both', 'hubspot', 'salesforce'].includes(mode)) throw new Error('Choose both, hubspot, or salesforce.');
const hubSpotToken = process.env.HUBSPOT_ACCESS_TOKEN;
const salesforceInstance = normalizeOrigin(process.env.SALESFORCE_INSTANCE_URL);
const salesforceToken = process.env.SALESFORCE_ACCESS_TOKEN;
const salesforceVersion = process.env.SALESFORCE_API_VERSION ?? '67.0';

const people = [
  person('Alex', 'Rivera', 'alex.rivera.old@example.com', 'Northstar Labs', '8145550101', 'Former revenue lead', 'https://northstar.example'),
  person('Alex', 'Rivera', 'alex.rivera@example.com', 'Northstar Labs', '+1 (814) 555-0101', 'VP Revenue', 'https://northstar.example'),
  person('Maya', 'Chen', 'maya.chen+event@gmail.com', 'Lighthouse AI', '', 'Growth Operations', 'https://lighthouse.example'),
  person('Maya', 'Chen', 'mayachen@gmail.com', 'Lighthouse AI', '', 'Director, Growth Operations', 'https://lighthouse.example'),
  person('Jordan', 'Lee', 'jordan.sales@example.com', 'Northstar Labs', '', 'Account Executive', 'https://northstar.example'),
  person('Jordan', 'Lee', 'jordan.success@example.com', 'Northstar Labs', '', 'Customer Success Manager', 'https://northstar.example'),
  person('小明', '王', 'ming.one@example.com', '北星科技', '8145550115', 'Revenue Systems', 'https://beixing.example'),
  person('小明', '王', 'ming.two@example.com', '北星科技', '+1 814 555 0115', 'Revenue Systems Lead', 'https://beixing.example'),
  person('Avery', 'Stone', 'avery.fixture@example.com', 'Front Desk Demo', '8145550199', 'Sales', 'https://frontdesk.example'),
  person('Diego', 'Morales', 'diego.fixture@example.com', 'Front Desk Demo', '8145550199', 'Support', 'https://frontdesk.example'),
  person('Priya', 'Patel', 'priya.fixture@example.com', 'Front Desk Demo', '8145550199', 'Operations', 'https://frontdesk.example'),
  person('Sam', 'Okafor', 'sam.fixture@example.com', 'Front Desk Demo', '8145550199', 'Finance', 'https://frontdesk.example'),
];

const result = { hubspot: null, salesforce: null };
if (mode === 'both' || mode === 'hubspot') {
  if (!hubSpotToken) throw new Error('HUBSPOT_ACCESS_TOKEN is required.');
  result.hubspot = await seedHubSpot(people, hubSpotToken);
}
if (mode === 'both' || mode === 'salesforce') {
  if (!salesforceInstance || !salesforceToken) throw new Error('A Salesforce instance and token are required.');
  result.salesforce = await seedSalesforce(salesforceInstance, salesforceToken, salesforceVersion);
}
console.log(JSON.stringify(result));

async function seedHubSpot(records, token) {
  let created = 0;
  let updated = 0;
  for (const record of records) {
    const existing = await hubSpotContactByEmail(record.email, token);
    const properties = {
      firstname: record.firstName,
      lastname: record.lastName,
      email: record.email,
      company: `GTMCT Fixture · ${record.company}`,
      phone: record.phone,
      jobtitle: `[Synthetic duplicate audit] ${record.jobTitle}`,
      website: record.website,
    };
    const url = existing
      ? `https://api.hubapi.com/crm/objects/2026-03/contacts/${encodeURIComponent(existing)}`
      : 'https://api.hubapi.com/crm/objects/2026-03/contacts';
    await jsonRequest(url, {
      method: existing ? 'PATCH' : 'POST',
      headers: bearer(token),
      body: JSON.stringify({ properties }),
    }, 'HubSpot fixture write');
    if (existing) updated += 1;
    else created += 1;
  }
  return { created, updated, records: records.length };
}

async function hubSpotContactByEmail(email, token) {
  const payload = await jsonRequest('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], limit: 1 }),
  }, 'HubSpot fixture lookup');
  return Array.isArray(payload.results) && payload.results[0]?.id ? String(payload.results[0].id) : null;
}

async function seedSalesforce(instance, token, version) {
  const root = `${instance}/services/data/v${version}`;
  const accountName = 'GTM Control Tower Fixture · Northstar Labs';
  let accountId = await salesforceId(root, token, `SELECT Id FROM Account WHERE Name = '${escapeSoql(accountName)}' LIMIT 1`);
  if (!accountId) {
    const account = await jsonRequest(`${root}/sobjects/Account`, {
      method: 'POST', headers: salesforceBearer(token), body: JSON.stringify({ Name: accountName, Website: 'https://northstar.example' }),
    }, 'Salesforce fixture Account');
    accountId = String(account.id);
  }

  const leads = [
    { FirstName: 'Alex', LastName: 'Rivera', Email: 'alex.sf.lead@example.com', Company: accountName, Phone: '8145550120', Title: '[Synthetic duplicate audit] Former revenue lead', Website: 'https://northstar.example' },
    { FirstName: 'Priya', LastName: 'Patel', Email: 'priya.shared.sf@example.com', Company: accountName, Phone: '8145550130', Title: '[Synthetic duplicate audit] Revenue Analyst A', Website: 'https://northstar.example' },
    { FirstName: 'Maya', LastName: 'Chen', Email: 'maya.chen+event@gmail.com', Company: 'GTM Control Tower Fixture · Lighthouse AI', Title: '[Synthetic duplicate audit] Growth Operations A', Website: 'https://lighthouse.example' },
    { FirstName: 'Maya', LastName: 'Chen', Email: 'mayachen@gmail.com', Company: 'GTM Control Tower Fixture · Lighthouse AI', Title: '[Synthetic duplicate audit] Growth Operations B', Website: 'https://lighthouse.example' },
    { FirstName: 'Jordan', LastName: 'Lee', Email: 'jordan.sales.sf@example.com', Company: accountName, Title: '[Synthetic duplicate audit] Account Executive', Website: 'https://northstar.example' },
    { FirstName: 'Jordan', LastName: 'Lee', Email: 'jordan.success.sf@example.com', Company: accountName, Title: '[Synthetic duplicate audit] Customer Success Manager', Website: 'https://northstar.example' },
  ];
  let leadsCreated = 0;
  let leadsUpdated = 0;
  for (const lead of leads) {
    const query = `SELECT Id FROM Lead WHERE Email = '${escapeSoql(lead.Email)}' AND Title = '${escapeSoql(lead.Title)}' AND IsConverted = FALSE LIMIT 1`;
    const id = await salesforceId(root, token, query);
    await jsonRequest(id ? `${root}/sobjects/Lead/${id}` : `${root}/sobjects/Lead`, {
      method: id ? 'PATCH' : 'POST', headers: salesforceBearer(token), body: JSON.stringify(lead),
    }, 'Salesforce fixture Lead', id ? [204] : []);
    if (id) leadsUpdated += 1;
    else leadsCreated += 1;
  }

  const contactEmail = 'alex.sf.contact@example.com';
  const contactId = await salesforceId(root, token, `SELECT Id FROM Contact WHERE Email = '${escapeSoql(contactEmail)}' LIMIT 1`);
  await jsonRequest(contactId ? `${root}/sobjects/Contact/${contactId}` : `${root}/sobjects/Contact`, {
    method: contactId ? 'PATCH' : 'POST', headers: salesforceBearer(token), body: JSON.stringify({
      FirstName: 'Alex', LastName: 'Rivera', Email: contactEmail, AccountId: accountId,
      Phone: '8145550998', MobilePhone: '+1 814 555 0120', Title: '[Synthetic duplicate audit] VP Revenue',
    }),
  }, 'Salesforce fixture Contact', contactId ? [204] : []);
  return { leadsCreated, leadsUpdated, contactCreated: !contactId, records: leads.length + 1 };
}

async function salesforceId(root, token, query) {
  const payload = await jsonRequest(`${root}/query?q=${encodeURIComponent(query)}`, { headers: bearer(token) }, 'Salesforce fixture lookup');
  return Array.isArray(payload.records) && payload.records[0]?.Id ? String(payload.records[0].Id) : null;
}

async function jsonRequest(url, init, label, acceptedEmptyStatuses = []) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (acceptedEmptyStatuses.includes(response.status)) return {};
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* status checked below */ }
  if (!response.ok) throw new Error(`${label} returned ${response.status}: ${errorMessage(payload)}`);
  return payload;
}

function person(firstName, lastName, email, company, phone, jobTitle, website) {
  return { firstName, lastName, email, company, phone, jobTitle, website };
}
function bearer(token) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }; }
function salesforceBearer(token) { return { ...bearer(token), 'sforce-duplicate-rule-header': 'allowSave=true; includeRecordDetails=true' }; }
function normalizeOrigin(value) { if (!value) return null; try { const url = new URL(value); return url.protocol === 'https:' ? url.origin : null; } catch { return null; } }
function escapeSoql(value) { return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'"); }
function errorMessage(payload) { if (Array.isArray(payload)) return payload.map((item) => item?.message).filter(Boolean).join('; '); return payload?.message ?? 'provider rejected the request'; }
