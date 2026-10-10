import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const TYPES = { hubspot: ['Company', 'Contact', 'Deal'], salesforce: ['Account', 'Contact', 'Lead', 'Opportunity'] };
const HS_OBJECTS = { Contact: 'contacts', Company: 'companies', Deal: 'deals' };
const MARKER_FIELDS = { hubspot: { Contact: 'message', Company: 'description', Deal: 'description' }, salesforce: { Account: 'Description', Contact: 'Description', Lead: 'Description', Opportunity: 'Description' } };
const SF_PREFIXES = { Account: '001', Contact: '003', Lead: '00Q', Opportunity: '006' };
const PAUSE = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const requestSchedulers = new Map();
function requestScheduler(origin) {
  if (requestSchedulers.has(origin)) return requestSchedulers.get(origin);
  let queue = Promise.resolve(), nextAllowedAt = 0;
  const scheduler = {
    async wait() {
      const turn = queue.then(async () => {
        while (nextAllowedAt > Date.now()) await PAUSE(Math.min(60_000, nextAllowedAt - Date.now()));
        nextAllowedAt = Date.now() + (origin === 'https://api.hubapi.com' ? 225 : 50);
      });
      queue = turn.catch(() => {}); await turn;
    },
    defer(milliseconds) { nextAllowedAt = Math.max(nextAllowedAt, Date.now() + milliseconds); },
  };
  requestSchedulers.set(origin, scheduler); return scheduler;
}
function retryDelay(value, attempt) {
  if (value) {
    const seconds = Number(value);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.max(225, milliseconds);
  }
  return Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
}

/** No credentials are retained in this module's output or written to disk. */
export function createNativeFixtureClient({ provider, token, accountId, instanceUrl, apiVersion = '67.0', fetchImpl = globalThis.fetch }) {
  assert(TYPES[provider], 'Unsupported native fixture provider.');
  assert(typeof token === 'string' && token.trim(), 'A native test account access token is required.');
  assert(typeof accountId === 'string' && (provider === 'hubspot' ? /^\d+$/.test(accountId) : /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(accountId)), 'Pin the expected native account identifier.');
  let origin = 'https://api.hubapi.com';
  if (provider === 'salesforce') {
    const url = new URL(instanceUrl);
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && ['/', ''].includes(url.pathname), 'Use the verified Salesforce HTTPS instance origin.');
    assert(/^\d+\.0$/.test(apiVersion), 'Invalid Salesforce API version.');
    origin = url.origin;
  }
  const api = provider === 'salesforce' ? `/services/data/v${apiVersion}` : '';
  const scheduler = requestScheduler(origin);
  let verified = false;
  let metadataCache;
  const calls = { reads: 0, creates: 0, patches: 0, associations: 0, requests: 0, rateLimitRetries: 0, readRetries: 0 };
  async function request(path, { method = 'GET', body } = {}) {
    assert(path.startsWith('/') && !path.startsWith('//') && !path.includes('..'), 'Invalid native fixture path.');
    const mutating = method !== 'GET';
    if (mutating) assert(verified, 'Verify the pinned test account before mutations.');
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' };
    if (provider === 'salesforce') {
      headers['Sforce-Auto-Assign'] = 'FALSE';
      headers['Sforce-Duplicate-Rule-Header'] = 'allowSave=false';
    }
    for (let attempt = 0; ; attempt++) {
      await scheduler.wait(); calls.requests++;
      let response;
      try {
        response = await fetchImpl(`${origin}${api}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
      } catch {
        if (!mutating) { calls.readRetries++; scheduler.defer(retryDelay(null, attempt)); continue; }
        throw new NativeFixtureError('The native response was lost; reconcile the saved pending operation before another attempt.', 0, true);
      }
      // A 429 explicitly rejects the attempt before execution. Never apply this retry to an uncertain write.
      if (response.status === 429 || (!mutating && response.status >= 500)) {
        if (response.status === 429) calls.rateLimitRetries++; else calls.readRetries++;
        scheduler.defer(retryDelay(response.headers.get('retry-after'), attempt));
        await response.body?.cancel(); continue;
      }
      let payload;
      try { const text = await response.text(); payload = text ? JSON.parse(text) : null; }
      catch { throw new NativeFixtureError('Native response was not valid JSON; reconcile the saved pending operation.', response.status, mutating); }
      if (!response.ok || response.status === 207) {
        const errors = Array.isArray(payload) ? payload : [payload];
        // Retain only provider validation codes, not arbitrary response text or URLs.
        const codes = errors.map(error => String(error?.errorCode ?? error?.category ?? 'HTTP_ERROR').slice(0, 100));
        const diagnostic = JSON.stringify(payload, (key, value) => /authorization|access.?token|refresh.?token|client.?secret|api.?key/i.test(key) ? '[redacted]'
          : typeof value === 'string' ? value.replaceAll(token, '[redacted]') : value);
        const details = diagnostic.length <= 16_000 ? JSON.parse(diagnostic) : { truncated: true, detail: diagnostic.slice(0, 16_000) };
        throw new NativeFixtureError(`Native ${provider} request rejected (HTTP ${response.status}; ${codes.join(', ')}).`, response.status, mutating && (response.status >= 500 || response.status === 207), codes, details);
      }
      return payload;
    }
  }
  async function verifyIdentity() {
    const identity = provider === 'hubspot'
      ? await request('/account-info/v3/details')
      : (await request(`/query?q=${encodeURIComponent('SELECT Id, OrganizationType, IsSandbox FROM Organization LIMIT 1')}`))?.records?.[0];
    assert(identity && String(provider === 'hubspot' ? identity.portalId : identity.Id) === accountId, 'Native account does not match the explicitly pinned test account.');
    if (provider === 'salesforce') assert(identity.IsSandbox === true || identity.OrganizationType === 'Developer Edition', 'Native fixture writes require a Salesforce sandbox or Developer Edition.');
    verified = true;
    return provider === 'hubspot' ? { accountId, accountType: identity.accountType } : { accountId, accountType: identity.OrganizationType, isSandbox: identity.IsSandbox };
  }
  function assertType(type) { assert(TYPES[provider].includes(type), 'Unsupported fixture object type.'); }
  function assertId(type, id) {
    assertType(type);
    assert(typeof id === 'string' && (provider === 'hubspot' ? /^\d{1,30}$/.test(id) : new RegExp(`^${SF_PREFIXES[type]}[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$`).test(id)), 'Invalid native fixture record ID.');
  }
  const pathFor = (type, id) => provider === 'hubspot' ? `/crm/v3/objects/${HS_OBJECTS[type]}${id ? `/${id}` : ''}` : `/sobjects/${type}${id ? `/${id}` : ''}`;
  async function read(type, id) {
    assertId(type, id); calls.reads++;
    const fields = provider === 'hubspot'
      ? { Contact: ['email', 'firstname', 'lastname', 'company', 'jobtitle', 'message', 'hubspot_owner_id', 'lifecyclestage', 'phone', 'associatedcompanyid'], Company: ['name', 'domain', 'description', 'hubspot_owner_id'], Deal: ['dealname', 'dealstage', 'pipeline', 'amount', 'closedate', 'description', 'hubspot_owner_id'] }[type]
      : { Contact: ['Id', 'FirstName', 'LastName', 'Email', 'Title', 'AccountId', 'Description', 'OwnerId', 'Phone', 'SystemModstamp'], Lead: ['Id', 'FirstName', 'LastName', 'Email', 'Title', 'Company', 'Status', 'Description', 'OwnerId', 'Phone', 'SystemModstamp'], Account: ['Id', 'Name', 'Website', 'Description', 'OwnerId', 'SystemModstamp'], Opportunity: ['Id', 'Name', 'StageName', 'Amount', 'CloseDate', 'AccountId', 'Description', 'OwnerId', 'SystemModstamp'] }[type];
    const row = await request(`${pathFor(type, id)}?${provider === 'hubspot' ? 'properties' : 'fields'}=${fields.join(',')}`);
    assert(String(provider === 'hubspot' ? row?.id : row?.Id) === id && row?.archived !== true, 'Native read returned a different or archived fixture.');
    return row;
  }
  async function verifyOwnership(type, id, marker) {
    assert(typeof marker === 'string' && /^GTMCT messy [a-z0-9-]+$/.test(marker), 'Invalid fixture ownership marker.');
    const row = await read(type, id);
    const text = provider === 'hubspot' ? row.properties?.[MARKER_FIELDS[provider][type]] : row[MARKER_FIELDS[provider][type]];
    assert(typeof text === 'string' && text.startsWith(`${marker}; `), 'Native fixture ownership marker is missing or changed.');
    return row;
  }
  async function verifyMissing(type, id) {
    try { await read(type, id); }
    catch (error) {
      if (error instanceof NativeFixtureError && [400, 404].includes(error.status)) return;
      throw error;
    }
    throw new Error('The intended missing-reference fixture ID exists natively; no unrelated record may be linked.');
  }
  async function metadata() {
    if (metadataCache) return metadataCache;
    await verifyIdentity();
    const objects = {};
    for (const type of TYPES[provider]) {
      const payload = await request(provider === 'hubspot' ? `/crm/v3/properties/${HS_OBJECTS[type]}` : `/sobjects/${type}/describe`);
      const fields = provider === 'hubspot' ? payload.results : payload.fields;
      assert(Array.isArray(fields), 'Native field metadata is incomplete.');
      if (provider === 'salesforce') assert(payload.createable && payload.queryable, `${type} must be creatable and readable in the test org.`);
      objects[type] = Object.fromEntries(fields.map(field => [field.name, {
        name: field.name, type: field.type, required: provider === 'salesforce' && field.createable && !field.nillable && !field.defaultedOnCreate,
        writable: provider === 'hubspot' ? !field.modificationMetadata?.readOnlyValue : field.createable,
        options: (provider === 'hubspot' ? field.options : field.picklistValues)?.filter(option => provider === 'hubspot' ? !option.hidden : option.active).map(option => ({ value: option.value, label: option.label, defaultValue: option.defaultValue })) ?? [],
      }]));
    }
    let pipelines = [], ownerId = null;
    const associations = {};
    const limitations = [];
    if (provider === 'hubspot') {
      const response = await request('/crm/v3/pipelines/deals');
      assert(Array.isArray(response.results) && response.results.length, 'A HubSpot Deal pipeline is required.');
      pipelines = response.results.map(pipeline => ({ id: pipeline.id, label: pipeline.label, stages: pipeline.stages.map(stage => ({ id: stage.id, label: stage.label, probability: stage.metadata?.probability })) }));
      try { ownerId = String((await request('/crm/v3/owners?limit=1&archived=false'))?.results?.[0]?.id ?? '') || null; }
      catch (error) { if (!(error instanceof NativeFixtureError && [403, 404].includes(error.status))) throw error; limitations.push('Owner reads unavailable; synthetic owner IDs are omitted and owner-missing warnings may be expected.'); }
      for (const [from, to] of [['Contact', 'Company'], ['Deal', 'Company'], ['Deal', 'Contact']]) {
        const labels = await request(`/crm/v4/associations/${HS_OBJECTS[from]}/${HS_OBJECTS[to]}/labels`);
        assert(Array.isArray(labels.results), 'Native association labels are unavailable.');
        const label = labels.results.find(row => row.category === 'HUBSPOT_DEFINED' && (from === 'Contact' ? row.label === 'Primary' : row.label === null))
          ?? labels.results.find(row => row.category === 'HUBSPOT_DEFINED');
        assert(label && Number.isInteger(label.typeId), 'A native association type is required.');
        associations[`${from}:${to}`] = { associationCategory: label.category, associationTypeId: label.typeId };
      }
    }
    metadataCache = { provider, accountId, objects, pipelines, ownerId, associations, limitations };
    return metadataCache;
  }
  async function create(type, properties) {
    assertType(type); calls.creates++;
    const result = await request(pathFor(type), { method: 'POST', body: provider === 'hubspot' ? { properties } : properties });
    const id = String(result?.id ?? '');
    try { assertId(type, id); } catch { throw new NativeFixtureError('A create response did not contain a usable native identifier; reconcile before retrying.', 200, true); }
    return id;
  }
  async function patchOwned(type, id, properties, marker) {
    await verifyIdentity(); await verifyOwnership(type, id, marker);
    assert(properties && typeof properties === 'object' && !Array.isArray(properties) && Object.keys(properties).length, 'A concrete fixture patch is required.');
    assert(!(MARKER_FIELDS[provider][type] in properties) && !('Id' in properties) && !('id' in properties), 'Fixture patches cannot replace ownership or native identity.');
    calls.patches++;
    await request(pathFor(type, id), { method: 'PATCH', body: provider === 'hubspot' ? { properties } : properties });
    return read(type, id);
  }
  async function associateOwned(fromType, fromId, toType, toId, marker, { probeMissing = false } = {}) {
    await verifyOwnership(fromType, fromId, marker);
    if (!probeMissing) await verifyOwnership(toType, toId, marker);
    else { assert(toType === (provider === 'hubspot' ? 'Company' : 'Account'), 'Only a missing-company probe is supported.'); await verifyMissing(toType, toId); }
    calls.associations++;
    if (provider === 'hubspot') {
      assertId(toType, toId);
      const label = (await metadata()).associations[`${fromType}:${toType}`];
      assert(label, 'Unsupported fixture association.');
      await request(`/crm/v4/objects/${HS_OBJECTS[fromType]}/${fromId}/associations/${HS_OBJECTS[toType]}/${toId}`, { method: 'PUT', body: [label] });
      return { id: `${fromId}:${toId}` };
    }
    assert(fromType === 'Opportunity' && toType === 'Contact' && !probeMissing, 'Only native Opportunity contact-role creation is supported here.');
    const result = await request('/sobjects/OpportunityContactRole', { method: 'POST', body: { OpportunityId: fromId, ContactId: toId } });
    assert(typeof result?.id === 'string', 'Native contact-role creation returned no identifier.');
    return result;
  }
  return { provider, accountId, origin, apiVersion, calls, verifyIdentity, metadata, read, verifyOwnership, verifyMissing, patchOwned, create, associateOwned };
}

export class NativeFixtureError extends Error {
  /** @param {string} message @param {number} status @param {boolean} [unknown] @param {string[]} [codes] @param {unknown} [details] */
  constructor(message, status, unknown = false, codes = [], details = null) {
    super(message); this.name = 'NativeFixtureError'; this.status = status; this.unknown = unknown; this.codes = codes;
    // Provider details belong in the private rejection manifest, never generic console/error serialization.
    Object.defineProperty(this, 'details', { value: details, enumerable: false });
  }
}

export function loadNativeFixtureManifest(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; }
function saveManifest(path, manifest) {
  assert(isAbsolute(path), 'Native fixture manifests require an absolute private path.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }); chmodSync(temporary, 0o600); renameSync(temporary, path);
}
const keyFor = (record) => `${record.objectType}:${record.id}`;
const nativeKey = (type, id) => `${type}:${id}`;
const present = (value) => value !== undefined && value !== null;

/** Maps the original world without changing its independent labels or values. */
export function buildNativeSeedProperties(record, { provider, metadata, manifest, fallback = false }) {
  const p = record.properties, type = record.objectType;
  const namePrefix = `[${manifest.runId}] `;
  const description = `${manifest.marker}; ${type}:${record.id}; synthetic messy-crm-v1 seed ${manifest.seed}.`;
  const mappedEmail = p.email ? (/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(p.email)
    ? p.email.replace('@', `@${manifest.runId}.`).replace(/\.example$/, provider === 'hubspot' ? '.example.com' : '.example') : p.email) : '';
  const fallbackEmail = `${type.toLowerCase()}-${record.id}@${manifest.runId}.${provider === 'hubspot' ? 'example.com' : 'example'}`;
  const fallbackFields = fallback === true ? { email: true, amount: true, closeDate: true, company: true } : fallback || {};
  const alphabeticToken = createHash('sha256').update(`${manifest.runId}:${type}:${record.id}`).digest('hex').slice(0, 16).replace(/[0-9a-f]/g, character => 'abcdefghijklmnop'[Number.parseInt(character, 16)]);
  const firstName = fallbackFields.names ? `Fixture${alphabeticToken}` : p.firstname;
  const lastName = fallbackFields.names ? `Record${[...alphabeticToken].reverse().join('')}` : `${namePrefix}${p.lastname} ${alphabeticToken}`;
  // Apply the same native-valid reserved suffix as Contact emails. Do not change
  // the source domain itself: deliberate duplicate-domain mismatches remain data.
  const mappedDomain = p.domain ? `${manifest.runId}.${p.domain}`.replace(/\.example$/, provider === 'hubspot' ? '.example.com' : '.example') : '';
  const companyType = provider === 'hubspot' ? 'Company' : 'Account';
  const linked = p.company_id ? manifest.records[nativeKey(companyType, p.company_id)]?.nativeId : undefined;
  const stage = (options, desired) => options.find(option => option.value.toLowerCase() === String(desired ?? '').toLowerCase())?.value
    ?? options.find(option => option.defaultValue)?.value ?? options[0]?.value;
  let properties;
  if (provider === 'hubspot') {
    if (type === 'Contact') properties = { firstname: firstName, lastname: lastName, email: fallbackFields.email ? fallbackEmail : mappedEmail, company: namePrefix + p.company, jobtitle: p.jobtitle, message: description,
      lifecyclestage: stage(metadata.objects.Contact.lifecyclestage?.options ?? [], p.lifecyclestage) };
    if (type === 'Company') properties = { name: namePrefix + p.name, domain: mappedDomain, description };
    if (type === 'Deal') {
      const pipeline = metadata.pipelines[0];
      const matching = pipeline.stages.find(item => item.id.toLowerCase() === p.stage.toLowerCase() || item.label.toLowerCase() === p.stage.toLowerCase());
      properties = { dealname: namePrefix + p.name, pipeline: pipeline.id, dealstage: matching?.id ?? pipeline.stages[0]?.id, amount: fallbackFields.amount && !Number.isFinite(Number(p.amount)) ? undefined : p.amount,
        closedate: fallbackFields.closeDate && !validDate(p.close_date) ? '2026-11-28T00:00:00.000Z' : validDate(p.close_date) ? new Date(p.close_date).toISOString() : p.close_date, description };
    }
    if (metadata.ownerId) properties.hubspot_owner_id = metadata.ownerId;
  } else {
    if (type === 'Account') properties = { Name: namePrefix + p.name, Website: mappedDomain ? `https://${mappedDomain}` : '', Description: description };
    if (type === 'Contact' || type === 'Lead') {
      properties = { FirstName: firstName, LastName: lastName, Email: fallbackFields.email ? fallbackEmail : mappedEmail, Title: p.jobtitle, Description: description };
      if (type === 'Contact' && linked) properties.AccountId = linked;
      if (type === 'Lead') { properties.Company = namePrefix + p.company; properties.Status = stage(metadata.objects.Lead.Status?.options ?? [], p.stage); }
    }
    if (type === 'Opportunity') properties = { Name: namePrefix + p.name, StageName: stage(metadata.objects.Opportunity.StageName?.options ?? [], p.stage), Amount: fallbackFields.amount && !Number.isFinite(Number(p.amount)) ? undefined : Number.isFinite(Number(p.amount)) ? Number(p.amount) : p.amount,
      CloseDate: fallbackFields.closeDate && !validDate(p.close_date) ? '2026-11-28' : p.close_date, AccountId: linked ?? (p.company_id && !fallbackFields.company ? p.company_id : undefined), Description: description };
  }
  assert(properties, 'Unsupported seed record.');
  properties = Object.fromEntries(Object.entries(properties).filter(([, value]) => present(value)));
  const fields = metadata.objects[type];
  for (const field of Object.keys(properties)) assert(fields[field]?.writable, `${type}.${field} is not writable in the connected test account.`);
  for (const field of Object.values(fields)) if (field.required) assert(field.name in properties, `The test org requires ${type}.${field.name}; no value is inferred.`);
  return properties;
}
function validDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }

/** Creates only the requested synthetic world. Unknown outcomes are durable and never replayed. */
export async function seedNativeWorld({ world, client, manifestPath, runId = 'native-20261010', onProgress = () => {} }) {
  assert(client.provider === world.provider && /^[a-z0-9][a-z0-9-]{2,50}$/.test(runId), 'Provider and stable fixture run ID are required.');
  assert(isAbsolute(manifestPath), 'An absolute private manifest path is required.');
  const identity = await client.verifyIdentity();
  const metadata = await client.metadata();
  const existing = loadNativeFixtureManifest(manifestPath);
  const manifest = existing ?? { version: 1, datasetVersion: world.version, seed: world.seed, provider: world.provider, accountId: client.accountId, runId, marker: `GTMCT messy ${runId}`, createdAt: new Date().toISOString(), identity, records: {}, associations: {}, pending: {}, rejected: [], transformations: [
    'Fixture IDs map to native IDs; native timestamps are assigned by the provider.',
    'Names and ownership fields carry the stable run marker; emails and domains use run-specific reserved .example domains.',
    'Synthetic owners are replaced with a visible HubSpot owner or native Salesforce default; currency fields are omitted because monitoring does not read them.',
    'Stages/statuses map to active native options; no CRM configuration or validation rule is changed.',
    'Native rejections and provider-normalized values are recorded separately from Control Tower detections.',
  ] };
  assert(manifest.version === 1 && manifest.provider === world.provider && manifest.accountId === client.accountId && manifest.runId === runId && manifest.datasetVersion === world.version && manifest.seed === world.seed, 'The saved native fixture manifest belongs to another run or account.');
  assert(!Object.keys(manifest.pending).length, 'Pending native operations require reconciliation before resuming. They will not be replayed.');
  manifest.metadata = metadata; saveManifest(manifestPath, manifest);
  const save = () => saveManifest(manifestPath, manifest);
  const nameMapping = 'New person names include a deterministic alphabetic fixture token to avoid accidental fuzzy-name matches; existing acknowledged records retain their original native names.';
  if (!manifest.transformations.includes(nameMapping)) { manifest.transformations.push(nameMapping); save(); }
  const emailMapping = 'HubSpot rejected the reserved .example email suffix, so newly created HubSpot email addresses use reserved .example.com subdomains. Existing company domains and Salesforce email mappings remain unchanged.';
  if (world.provider === 'hubspot' && !manifest.transformations.includes(emailMapping)) { manifest.transformations.push(emailMapping); save(); }
  const companyDomainMapping = 'New HubSpot Company domains use the same reserved .example.com suffix as Contact emails. Source-domain duplicate cases and acknowledged existing native records remain unchanged.';
  if (world.provider === 'hubspot' && !manifest.transformations.includes(companyDomainMapping)) { manifest.transformations.push(companyDomainMapping); save(); }
  const expectedFor = (record) => world.expected.filter(label => label.objectType === record.objectType && (label.recordId === record.id || label.relatedRecordIds?.includes(record.id))).map(label => label.scenario);
  const rejection = (key, error, properties, step) => {
    manifest.rejected.push({ key, step, at: new Date().toISOString(), status: error.status, codes: error.codes, properties, providerDetails: error.details ?? null });
  };
  // Known successful IDs are read and ownership checked on every resume, without rewriting them.
  const confirmedRecords = Object.values(manifest.records);
  for (let offset = 0; offset < confirmedRecords.length; offset += 4) await Promise.all(confirmedRecords.slice(offset, offset + 4).map(record => client.verifyOwnership(record.objectType, record.nativeId, manifest.marker)));
  for (const type of TYPES[world.provider]) {
    const source = world.records.filter(record => record.objectType === type);
    for (let offset = 0; offset < source.length; offset += 25) {
      const chunk = source.slice(offset, offset + 25);
      for (let index = 0; index < chunk.length; index += 4) {
        const results = await Promise.allSettled(chunk.slice(index, index + 4).map(async record => {
          const key = keyFor(record);
          if (manifest.records[key]) return;
          const expectedScenarios = expectedFor(record);
          if (world.provider === 'salesforce' && expectedScenarios.includes('orphan_company')) await client.verifyMissing('Account', record.properties.company_id);
          let properties = buildNativeSeedProperties(record, { provider: world.provider, metadata, manifest });
          const notes = [];
          for (let attempt = 0; attempt < 2; attempt++) {
            manifest.pending[key] = { kind: 'create', objectType: type, fixtureId: record.id, properties, sentAt: new Date().toISOString() }; save();
            let nativeId;
            try { nativeId = await client.create(type, properties); }
            catch (error) {
              if (!(error instanceof NativeFixtureError) || error.unknown) throw error;
              delete manifest.pending[key]; rejection(key, error, properties, 'create'); save();
              const nameDuplicate = world.provider === 'salesforce' && error.codes.includes('DUPLICATES_DETECTED') && !expectedScenarios.includes('duplicate_email_candidate');
              const canFallback = nameDuplicate || expectedScenarios.some(scenario => ['invalid_email', 'duplicate_email_candidate', 'invalid_amount', 'invalid_close_date', 'orphan_company'].includes(scenario));
              if (attempt || ![400, 409, 422].includes(error.status) || !canFallback) throw error;
              const fallbackFields = { names: nameDuplicate,
                email: expectedScenarios.includes('invalid_email') || (!nameDuplicate && expectedScenarios.includes('duplicate_email_candidate')),
                amount: expectedScenarios.includes('invalid_amount'), closeDate: expectedScenarios.includes('invalid_close_date'), company: expectedScenarios.includes('orphan_company') };
              const fallback = buildNativeSeedProperties(record, { provider: world.provider, metadata, manifest, fallback: fallbackFields });
              assert(JSON.stringify(fallback) !== JSON.stringify(properties), 'Native rejection has no defined legal fallback; inspect the private manifest.');
              notes.push(nameDuplicate ? 'Salesforce rejected a fuzzy-name duplicate; unique fixture names were substituted without changing the email or disabling duplicate rules.' : `Native rejected the original planted defect (${error.status}); a documented legal fallback preserves record count. This is not a Monitor detection.`);
              properties = fallback; continue;
            }
            // Save the acknowledgement before readback: a failed read must never lose a created ID.
            manifest.records[key] = { fixtureId: record.id, objectType: type, nativeId, marker: manifest.marker, expectedScenarios, seedPayload: properties, notes, status: 'created', createdAt: new Date().toISOString() };
            delete manifest.pending[key]; save();
            manifest.records[key].readback = await client.verifyOwnership(type, nativeId, manifest.marker); save();
            return;
          }
        }));
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        await PAUSE(110);
      }
      onProgress({ provider: world.provider, phase: 'seed', objectType: type, created: Object.keys(manifest.records).length, total: world.records.length });
    }
  }
  const edges = [];
  for (const record of world.records) {
    if (world.provider === 'hubspot' && ['Contact', 'Deal'].includes(record.objectType) && record.properties.company_id) edges.push({ from: record, toType: 'Company', toFixtureId: record.properties.company_id, missing: !manifest.records[nativeKey('Company', record.properties.company_id)] });
    if (['Deal', 'Opportunity'].includes(record.objectType)) for (const id of JSON.parse(record.properties.contact_ids ?? '[]')) edges.push({ from: record, toType: 'Contact', toFixtureId: id });
  }
  for (let offset = 0; offset < edges.length; offset += 4) {
    const results = await Promise.allSettled(edges.slice(offset, offset + 4).map(async edge => {
      const from = manifest.records[keyFor(edge.from)], target = manifest.records[nativeKey(edge.toType, edge.toFixtureId)];
      const key = `association:${keyFor(edge.from)}:${edge.toType}:${edge.toFixtureId}`;
      if (manifest.associations[key]) return;
      const toId = target?.nativeId ?? edge.toFixtureId;
      manifest.pending[key] = { kind: 'association', fromType: from.objectType, fromId: from.nativeId, toType: edge.toType, toId, sentAt: new Date().toISOString() }; save();
      try {
        const result = await client.associateOwned(from.objectType, from.nativeId, edge.toType, toId, manifest.marker, { probeMissing: edge.missing });
        manifest.associations[key] = { from: from.nativeId, to: toId, nativeId: result.id, status: 'created' };
        if (edge.missing) manifest.associations[key].note = 'Unexpectedly accepted the missing-reference probe; inspect native state before claiming orphan detection.';
      } catch (error) {
        if (!(error instanceof NativeFixtureError) || error.unknown) throw error;
        delete manifest.pending[key]; rejection(key, error, { from: from.nativeId, to: toId }, 'association');
        if (!edge.missing || ![400, 404, 409, 422].includes(error.status)) { save(); throw error; }
        manifest.associations[key] = { from: from.nativeId, to: toId, status: 'provider_rejected', note: 'The native API prevented a nonexistent-company association; no orphan was inserted. The deal remains unassociated.' };
      }
      delete manifest.pending[key]; save();
    }));
    const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    if (offset % 100 === 0) onProgress({ provider: world.provider, phase: 'associations', completed: Object.keys(manifest.associations).length, total: edges.length });
    await PAUSE(110);
  }
  manifest.seedCompletedAt = new Date().toISOString(); manifest.calls = client.calls; save();
  return { manifest, metadata, records: Object.values(manifest.records), transformations: manifest.transformations };
}
