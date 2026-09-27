import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit development-only setup. Re-running preserves existing case-owned records.
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/enterprise-import-case.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const provider = args[0];
const seed = args.includes('--seed');
if (args.some((arg, index) => index === 0 ? !['hubspot', 'salesforce'].includes(arg) : arg !== '--seed') || args.length > 2) {
  throw new Error('Usage: node --env-file=.env.local scripts/seed_enterprise_import.mjs hubspot|salesforce [--seed]');
}
for (const record of [...fixture.baseline, ...fixture.review, ...fixture.approved]) {
  if (!/^[^@\s]+@[^@\s]+\.example\.com$/u.test(record.email)
    || (record.phone && !/^1?[2-9]\d{2}55501\d{2}$/.test(record.phone.replace(/\D/g, '')))
    || !record.description?.includes(fixture.caseId)) {
    throw new Error('Fixtures require reserved .example.com email domains, reserved 555-01xx phones, and case ownership descriptions.');
  }
}
if (new Set(fixture.baseline.map((record) => record.email)).size !== fixture.baseline.length
  || new Set(fixture.baseline.map((record) => record.key)).size !== fixture.baseline.length) {
  throw new Error('Baseline fixture keys and emails must be unique.');
}

if (!seed) {
  console.log(JSON.stringify({ writes: false, baselineContacts: fixture.baseline.length,
    salesforceLeads: fixture.baseline.filter((record) => record.key !== 'denise').length,
    salesforceContacts: fixture.baseline.filter((record) => record.key === 'denise').length,
    usage: 'Set GTM_FIXTURE_MANIFEST to a private absolute path; choose hubspot|salesforce and add --seed. HubSpot also requires HUBSPOT_DEVELOPMENT_ACCOUNT_ID.' }));
} else {
  const manifestPath = process.env.GTM_FIXTURE_MANIFEST;
  if (!manifestPath || !isAbsolute(manifestPath)) throw new Error('GTM_FIXTURE_MANIFEST must be an absolute private output path.');
  const localPath = relative(root, manifestPath);
  if (localPath !== '..' && !localPath.startsWith('../')) {
    try { execFileSync('git', ['check-ignore', '--quiet', '--', localPath], { cwd: root }); }
    catch { throw new Error('A manifest inside the checkout must be git-ignored (for example outputs/enterprise-import-private.json).'); }
  }
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { caseId: fixture.caseId, createdAt: new Date().toISOString(), providers: {} };
  if (manifest.caseId !== fixture.caseId || !manifest.providers) throw new Error('The manifest belongs to a different fixture case.');
  const save = () => {
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
    const temporary = `${manifestPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, manifestPath);
  };
  const start = (accountId) => {
    const previous = manifest.providers[provider];
    if (previous && previous.accountId !== String(accountId)) throw new Error('The manifest provider account does not match this connection.');
    const state = manifest.providers[provider] = previous ?? { accountId: String(accountId), records: {} };
    save();
    return state;
  };
  const counts = provider === 'hubspot' ? await seedHubSpot(start, save) : await seedSalesforce(start, save);
  console.log(JSON.stringify({ provider, ...counts, manifestSaved: true }));
}

async function seedHubSpot(start, save) {
  const token = required('HUBSPOT_ACCESS_TOKEN');
  const expectedAccount = required('HUBSPOT_DEVELOPMENT_ACCOUNT_ID');
  const headers = bearer(token);
  const account = await request('https://api.hubapi.com/account-info/v3/details', { headers }, 'HubSpot account check');
  if (String(account.portalId) !== expectedAccount) throw new Error('HubSpot account does not match HUBSPOT_DEVELOPMENT_ACCOUNT_ID.');
  const base = 'https://api.hubapi.com/crm/objects/2026-03/contacts';
  const matches = new Map();
  // Complete every ownership check before the first write. Direct reads also resolve additional emails.
  for (const record of fixture.baseline) {
    const found = new Map();
    const query = new URLSearchParams({ idProperty: 'email', properties: 'email,hs_additional_emails,message' });
    const contact = await request(`${base}/${encodeURIComponent(record.email)}?${query}`, { headers }, 'HubSpot fixture identity', true);
    if (contact) found.set(String(contact.id), contact);
    const search = await request('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST', headers, body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: record.email }] }],
        properties: ['email', 'message'], limit: 100 }),
    }, 'HubSpot fixture lookup');
    if (!Array.isArray(search.results) || search.total > search.results.length) throw new Error('HubSpot fixture lookup was incomplete.');
    for (const match of search.results) found.set(String(match.id), match);
    if (found.size > 1) throw new Error('Multiple HubSpot records match a fixture email; no records were seeded.');
    const match = [...found.values()][0];
    if (match && !match.properties?.message?.includes(fixture.caseId)) throw new Error('A HubSpot fixture email belongs to an unowned record; no records were seeded.');
    matches.set(record.key, match);
  }
  const state = start(account.portalId);
  let created = 0, skipped = 0;
  for (const record of fixture.baseline) {
    const match = matches.get(record.key);
    if (match) {
      state.records[record.key] = { nativeId: String(match.id), email: record.email, objectType: 'contact', action: 'skipped' };
      skipped++;
    } else {
      state.pendingCreate = { key: record.key, objectType: 'contact', at: new Date().toISOString() }; save();
      const result = await request(base, { method: 'POST', headers, body: JSON.stringify({ properties: {
        firstname: record.firstName, lastname: record.lastName, email: record.email, company: record.company,
        phone: record.phone, jobtitle: record.jobTitle, website: record.website, state: record.state,
        city: record.city, message: record.description,
      } }) }, 'HubSpot fixture create');
      if (!result.id) throw new Error('HubSpot create returned no record identifier; reconcile the private manifest before retrying.');
      state.records[record.key] = { nativeId: String(result.id), email: record.email, objectType: 'contact', action: 'created' };
      created++;
    }
    delete state.pendingCreate; save();
  }
  return { created, skipped, updated: 0 };
}

async function seedSalesforce(start, save) {
  const url = new URL(required('SALESFORCE_INSTANCE_URL'));
  if (url.protocol !== 'https:') throw new Error('Salesforce requires an HTTPS instance.');
  const version = process.env.SALESFORCE_API_VERSION ?? '67.0';
  if (!/^\d+\.0$/.test(version)) throw new Error('Invalid Salesforce API version.');
  const base = `${url.origin}/services/data/v${version}`;
  const headers = { ...bearer(required('SALESFORCE_ACCESS_TOKEN')), 'Sforce-Duplicate-Rule-Header': 'allowSave=false' };
  const query = async (soql) => {
    const result = await request(`${base}/query?q=${encodeURIComponent(soql)}`, { headers }, 'Salesforce fixture lookup');
    if (result.done !== true || !Array.isArray(result.records)) throw new Error('Salesforce fixture lookup was incomplete.');
    return result.records;
  };
  const [org] = await query('SELECT Id, OrganizationType, IsSandbox FROM Organization LIMIT 1');
  if (!org || !(org.IsSandbox === true || org.OrganizationType === 'Developer Edition')) throw new Error('Salesforce seeding requires a sandbox or Developer Edition organization.');
  const emails = fixture.baseline.map((record) => `'${escapeSoql(record.email)}'`).join(',');
  const leads = await query(`SELECT Id, Email, Description, IsConverted FROM Lead WHERE Email IN (${emails})`);
  const contacts = await query(`SELECT Id, Email, Description FROM Contact WHERE Email IN (${emails})`);
  const existing = [...leads.map((record) => ({ ...record, type: 'Lead' })), ...contacts.map((record) => ({ ...record, type: 'Contact' }))];
  const matches = new Map();
  for (const record of fixture.baseline) {
    const found = existing.filter((match) => match.Email?.toLowerCase() === record.email.toLowerCase());
    if (found.length > 1) throw new Error('Multiple Salesforce records match a fixture email; no records were seeded.');
    const match = found[0];
    if (match && (!match.Description?.includes(fixture.caseId) || match.IsConverted
      || match.type !== (record.key === 'denise' ? 'Contact' : 'Lead'))) {
      throw new Error('A Salesforce fixture email belongs to an unowned or unexpected record; no records were seeded.');
    }
    matches.set(record.key, match);
  }
  const denise = fixture.baseline.find((record) => record.key === 'denise');
  if (!denise) throw new Error('The fixture requires the Denise Contact.');
  // Description is a long-text field, so ownership is checked after the name query.
  const accounts = (await query(`SELECT Id, Description FROM Account WHERE Name = '${escapeSoql(denise.company)}'`))
    .filter((account) => account.Description?.includes(fixture.caseId));
  if (accounts.length > 1) throw new Error('Multiple case-owned Salesforce Accounts exist; no records were seeded.');
  const leadDescribe = await request(`${base}/sobjects/Lead/describe`, { headers }, 'Salesforce Lead fields');
  const contactDescribe = await request(`${base}/sobjects/Contact/describe`, { headers }, 'Salesforce Contact fields');
  const tradeShowAvailable = leadDescribe.fields?.find((field) => field.name === 'LeadSource')?.picklistValues
    ?.some((value) => value.active && value.value === 'Trade Show');
  const optOutFieldsAvailable = Object.fromEntries([['Lead', leadDescribe], ['Contact', contactDescribe]].map(([type, describe]) =>
    [type, ['HasOptedOutOfEmail', 'DoNotCall'].filter((name) => describe.fields?.some((field) => field.name === name && field.createable))]));
  const codedAddressAvailable = {
    Lead: ['CountryCode', 'StateCode'].every((name) => leadDescribe.fields?.some((field) => field.name === name && field.createable)),
    Contact: ['MailingCountryCode', 'MailingStateCode'].every((name) => contactDescribe.fields?.some((field) => field.name === name && field.createable)),
  };
  const states = { WA: 'Washington', CA: 'California', TX: 'Texas', NY: 'New York' };
  const state = start(org.Id);
  state.optOutFieldsAvailable = optOutFieldsAvailable;
  let accountId = accounts[0]?.Id;
  let accountsCreated = 0, created = 0, skipped = 0;
  if (!accountId && !matches.get('denise')) {
    state.pendingCreate = { objectType: 'account', at: new Date().toISOString() }; save();
    const result = await request(`${base}/sobjects/Account`, { method: 'POST', headers,
      body: JSON.stringify({ Name: denise.company, Website: denise.website, Description: denise.description }) }, 'Salesforce fixture Account create');
    if (!result.id || result.success !== true) throw new Error('Salesforce Account create did not return success.');
    accountId = result.id; accountsCreated++;
  }
  if (accountId) state.fixtureAccountId = accountId;
  delete state.pendingCreate; save();
  for (const record of fixture.baseline) {
    const match = matches.get(record.key);
    const type = record.key === 'denise' ? 'Contact' : 'Lead';
    if (match) {
      state.records[record.key] = { ...state.records[record.key], nativeId: match.Id, email: record.email, objectType: type.toLowerCase(), action: 'skipped' };
      skipped++;
    } else {
      const common = { FirstName: record.firstName, LastName: record.lastName, Email: record.email, Phone: record.phone,
        Title: record.jobTitle, Description: record.description,
        ...Object.fromEntries(optOutFieldsAvailable[type].map((name) => [name, true])) };
      const address = type === 'Contact'
        ? { MailingCity: record.city, ...(codedAddressAvailable.Contact
          ? { MailingCountryCode: 'US', MailingStateCode: record.state }
          : { MailingCountry: 'United States', MailingState: states[record.state] ?? record.state }) }
        : { City: record.city, ...(codedAddressAvailable.Lead
          ? { CountryCode: 'US', StateCode: record.state }
          : { Country: 'United States', State: states[record.state] ?? record.state }) };
      const fields = type === 'Contact' ? { ...common, ...address, AccountId: accountId }
        : { ...common, ...address, Company: record.company, Website: record.website,
          ...(tradeShowAvailable ? { LeadSource: 'Trade Show' } : {}) };
      // A known pair of fictional coworkers can need explicit acknowledgment during fixture setup.
      // This opt-in applies to this one baseline record only; application writes still use allowSave=false.
      const duplicateRuleAcknowledged = record.key === 'jordan_marketing' && process.env.GTM_ALLOW_AMBIGUOUS_FIXTURE === '1';
      const createHeaders = duplicateRuleAcknowledged ? { ...headers, 'Sforce-Duplicate-Rule-Header': 'allowSave=true' } : headers;
      state.pendingCreate = { key: record.key, objectType: type.toLowerCase(), duplicateRuleAcknowledged, at: new Date().toISOString() }; save();
      const result = await request(`${base}/sobjects/${type}`, { method: 'POST', headers: createHeaders, body: JSON.stringify(fields) }, 'Salesforce fixture create');
      if (!result.id || result.success !== true) throw new Error('Salesforce create did not return success; reconcile the private manifest before retrying.');
      state.records[record.key] = { nativeId: result.id, email: record.email, objectType: type.toLowerCase(), action: 'created', duplicateRuleAcknowledged };
      created++;
    }
    delete state.pendingCreate; save();
  }
  return { created, skipped, updated: 0, accountsCreated, optOutFieldsAvailable,
    ambiguousFixtureAcknowledged: state.records.jordan_marketing?.duplicateRuleAcknowledged === true };
}

async function request(url, init, label, allowMissing = false) {
  let response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }); }
  catch { throw new Error(`${label} did not return a response. Reconcile any pending create before retrying.`); }
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const errors = Array.isArray(payload) ? payload : [payload, ...(Array.isArray(payload?.errors) ? payload.errors : [])];
    const codes = [...new Set(errors.flatMap((error) => [error?.code, error?.category, error?.errorCode])
      .filter((value) => typeof value === 'string' && /^[A-Z][A-Z_]{1,79}$/.test(value)))];
    throw new Error(`${label} returned HTTP ${response.status}${codes.length ? ` (${codes.join(', ')})` : ''}; no provider body or identifiers are printed.`);
  }
  try { return await response.json(); }
  catch { throw new Error(`${label} returned invalid JSON.`); }
}
function required(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required.`); return value; }
function bearer(token) { return { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }; }
function escapeSoql(value) { return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'"); }
