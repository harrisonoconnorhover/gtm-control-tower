import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

// The optional handoff and workspace persistence use the real local app. CRM
// comparison responses are simulated; every native/legacy write is blocked.
const base = new URL(process.env.CONTROL_TOWER_BROWSER_BASE_URL || 'http://127.0.0.1:3000');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Use a disposable local app with persistence enabled.');
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');
assert(existsSync(executablePath), 'Set CHROMIUM_PATH to Chrome or Chromium.');
const holdReason = 'This Pomade handoff permits existing-record updates only. No new CRM person will be created.';
const reviewReason = 'Two people share this company; confirm the correct person.';
const csv = 'contact_id,first_name,last_name,email,company,job_title\nCSV-ONLY,Sam,Reed,sam.reed@cisco.example.com,Cisco,Sales Manager\n';
const portableFields = ['firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website'];

function handoff(provider, tag) {
  const proposedFields = { fullName: 'Priya Nair', firstName: 'Priya', lastName: 'Nair', email: 'priya.nair@salesforce.example.com',
    company: 'Salesforce', phone: '415-555-0142', jobTitle: 'Director, Sales Strategy', website: null };
  return { source: 'pomade', schemaVersion: 1, exportId: `${tag}-export`, exportedAt: '2026-09-28T10:00:00.000Z',
    sourceInstanceId: `${tag}-source`, workspaceId: 'research-table', workspaceName: 'Fictional sales research', sourceRevision: 'revision-7',
    mode: 'preview', destination: { provider, objectType: provider === 'hubspot' ? 'contact' : 'lead' },
    fieldMappings: [{ sourceColumnId: 'title', sourceColumnTitle: 'Researched title', contactField: 'jobTitle', destinationFields: [provider === 'hubspot' ? 'jobtitle' : 'Title'] }],
    guards: { maxRecords: 100, allowCreate: false }, records: [
      { rowId: 'priya', externalKey: 'reference-only-not-a-crm-id', sourceStatus: 'Ready', reviewReason: null, proposedFields,
        evidence: [{ field: 'jobTitle', value: proposedFields.jobTitle, sourceUrl: 'https://example.com/team/priya',
          quote: 'Fictional research fixture: Director, Sales Strategy', observedAt: '2026-09-28T09:30:00.000Z', reference: 'manual browser fixture' }] },
      { rowId: 'marcus', externalKey: null, sourceStatus: 'Review', reviewReason,
        proposedFields: { ...proposedFields, fullName: 'Marcus Bell', firstName: 'Marcus', lastName: 'Bell', email: 'marcus.bell@adobe.example.com', company: 'Adobe' }, evidence: [] },
      { rowId: 'company-only', externalKey: null, sourceStatus: 'Ready', reviewReason: null,
        proposedFields: { fullName: null, firstName: null, lastName: null, email: null, company: 'Cisco', phone: null, jobTitle: null, website: null }, evidence: [] },
      { rowId: 'elena', externalKey: null, sourceStatus: 'Ready', reviewReason: null,
        proposedFields: { ...proposedFields, fullName: 'Elena Park', firstName: 'Elena', lastName: 'Park', email: 'elena.park@oracle.example.com', company: 'Oracle' }, evidence: [] },
    ] };
}

async function activeWorkspace(page, context) {
  const id = await page.evaluate(() => localStorage.getItem('gtm-control-tower-workspace-id'));
  assert(id, 'A saved workspace must be active.');
  const response = await context.request.get(new URL(`/api/control-tower/workspace?id=${encodeURIComponent(id)}`, base).href);
  assert.equal(response.status(), 200);
  return (await response.json()).workspace;
}

function parseCsv(text) {
  const rows = [];
  let cells = [], cell = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { cells.push(cell); cell = ''; }
    else if (char === '\r' && text[index + 1] === '\n' && !quoted) { rows.push([...cells, cell]); cells = []; cell = ''; index++; }
    else cell += char;
  }
  assert(!quoted);
  const [header, ...data] = rows;
  header[0] = header[0].replace(/^\uFEFF/u, '');
  return data.map((row) => {
    assert.equal(row.length, header.length);
    return Object.fromEntries(header.map((column, index) => [column, row[index]]));
  });
}

const browser = await chromium.launch({ executablePath, headless: true });
const outcomes = [];
try {
  for (const provider of ['hubspot', 'salesforce']) {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const tag = `pomade-browser-${provider}-${randomUUID()}`, input = handoff(provider, tag);
    const errors = [], apiCalls = [], previews = [];
    let failNextSave = true, delegated = false;
    page.on('pageerror', (error) => errors.push(error.message));
    await context.route('**/*', async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base.origin) { errors.push(`Blocked external request: ${url.origin}`); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const endpoint = url.pathname.replace('/api/control-tower/', '');
      const body = request.method() === 'POST' ? request.postDataJSON() : null;
      apiCalls.push({ endpoint, method: request.method(), action: body?.action });
      if (endpoint === 'workspace') {
        if (body?.action === 'save' && body.reason === 'pomade_handoff_loaded' && failNextSave) {
          failNextSave = false;
          return route.fulfill({ status: 500, json: { error: 'Simulated new-workspace storage failure. Your previous workspace is still active.' } });
        }
        return route.continue();
      }
      if (endpoint === 'runs') return route.continue();
      if (endpoint === 'connectors') return route.fulfill({ json: { persistenceEnabled: true, accessKeyRequired: false,
        connectors: ['csv', provider].map((id) => ({ id, label: id, configured: true, directions: ['source', 'destination'], phases: [],
          mode: delegated && id === provider ? 'n8n' : 'direct', features: delegated && id === provider ? ['write'] : ['safe-writeback', 'account-scan'] })) } });
      if (endpoint === 'state') return route.fulfill({ status: 503, json: { error: 'Warehouse excluded from this browser regression.' } });
      if (endpoint === 'duplicate-scan' && request.method() === 'GET') return route.fulfill({ json: { scan: null } });
      try {
        assert.equal(endpoint, 'crm-writeback', `Unhandled private endpoint ${endpoint}; no research or legacy sync is allowed.`);
        assert.equal(body.action, 'preview', 'No CRM execution or rollback is permitted in this regression.');
        assert.equal(body.connectorId, provider);
        assert.equal(body.contacts.length, 2, 'Source-review and company-only rows must stay out of comparison.');
        assert.deepEqual(body.contacts.map((contact) => contact.email).sort(), ['elena.park@oracle.example.com', 'priya.nair@salesforce.example.com']);
        const at = new Date().toISOString();
        previews.push(body);
        const records = body.contacts.map((contact) => {
          const matches = contact.email.startsWith('priya.');
          const after = Object.fromEntries(portableFields.map((field) => [field, contact[field] ?? null]));
          const nativeId = matches ? provider === 'hubspot' ? '993001' : '00Q000000000001AAA' : null;
          return { contactId: contact.contactId, email: contact.email, nativeId, operation: matches ? 'update' : 'hold',
            matches: matches ? [{ nativeId, objectType: input.destination.objectType, email: contact.email }] : [],
            before: matches ? { ...after, jobTitle: null } : null, after,
            changes: matches ? [{ field: 'jobTitle', before: null, after: contact.jobTitle }] : [], reason: matches ? null : holdReason };
        });
        return route.fulfill({ json: { planId: `${tag}-plan`, fingerprint: 'simulated-pomade-comparison', connectorId: provider,
          sourceFile: body.sourceFile, updatePolicy: body.updatePolicy, createdAt: at, expiresAt: new Date(Date.now() + 900_000).toISOString(),
          requested: 2, creates: 0, updates: 1, unchanged: 0, held: 1, records } });
      } catch (error) { errors.push(error.message); return route.fulfill({ status: 400, json: { error: error.message } }); }
    });
    try {
      await page.goto(new URL('/app/lab', base).href);
      await page.getByText('SQLite r0 · saved', { exact: true }).waitFor({ timeout: 45_000 });
      await page.locator('input[type=file][accept=".csv,text/csv"]').setInputFiles({ name: 'ordinary.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      const savedCsv = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/control-tower/workspace'
        && response.request().method() === 'POST' && response.request().postDataJSON()?.state?.contacts?.[0]?.contactId === 'CSV-ONLY');
      await page.getByRole('button', { name: 'Validate + load', exact: true }).click();
      assert.equal((await savedCsv).status(), 200);
      await page.getByText(/SQLite r\d+ · saved/u).waitFor();
      const original = await activeWorkspace(page, context);
      assert.equal(original.state.contacts.length, 1);
      assert.equal(original.state.contacts[0].sourceOrigins, undefined, 'Ordinary CSV does not require Pomade metadata.');
      assert.equal(previews.length, 0);
      const beforePreview = apiCalls.length;
      const fileInput = page.getByLabel('Pomade handoff file', { exact: true });
      const preview = page.locator('[aria-label="Pomade handoff preview"]');
      const load = () => page.getByRole('button', { name: 'Load in new saved workspace', exact: true });
      await fileInput.setInputFiles({ name: 'pomade-preview.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(input)) });
      await preview.getByText('Fictional sales research · 4 proposals', { exact: true }).waitFor();
      await preview.getByText('1 source-review rows skipped', { exact: true }).waitFor();
      assert.deepEqual(await activeWorkspace(page, context), original, 'Preview must not change the active saved workspace.');
      assert.equal(apiCalls.length, beforePreview, 'Handoff preview is local and must not make network calls.');
      const previewContext = preview.locator('details').first();
      await previewContext.locator('summary').click();
      await previewContext.getByText('Original proposed values', { exact: true }).waitFor();
      await previewContext.getByText('Source status: Ready', { exact: true }).waitFor();
      assert.equal(await previewContext.getByRole('link', { name: 'Source reference', exact: true }).getAttribute('href'), input.records[0].evidence[0].sourceUrl);
      await preview.screenshot({ path: `/tmp/gtm-pomade-${provider}-preview.png` });
      await load().click();
      await page.getByText('Simulated new-workspace storage failure. Your previous workspace is still active.', { exact: true }).waitFor();
      assert.deepEqual(await activeWorkspace(page, context), original, 'Failed new-workspace save must preserve the active import.');
      assert(await preview.isVisible(), 'A failed save preserves the validated preview for retry.');
      await load().click();
      await page.getByText('4 proposals loaded in a new saved workspace for review. No CRM writes were made.', { exact: true }).waitFor();
      const imported = await activeWorkspace(page, context);
      assert.notEqual(imported.id, original.id);
      assert.equal(imported.state.contacts.length, 4);
      assert.equal(imported.state.originalContacts.length, 4);
      assert.equal(imported.state.destinationType, provider);
      const review = imported.state.contacts.find((contact) => contact.sourceOrigins[0].rowId === 'marcus');
      assert.equal(review.importExclusion.reason, `Pomade Review: ${reviewReason}`);
      for (const contact of imported.state.contacts) {
        const source = input.records.find((record) => record.rowId === contact.sourceOrigins[0].rowId);
        assert.deepEqual(contact.sourceOrigins[0].evidence, source.evidence);
        assert.equal(contact.sourceOrigins[0].allowCreate, false);
        assert.equal(contact.sourceOrigins[0].sourceRevision, 'revision-7');
        assert.equal(contact.crmMatchDecisions, undefined, 'Source Ready must not import approval or CRM identity.');
        assert.equal(contact.nativeId, undefined);
      }
      const previousResponse = await context.request.get(new URL(`/api/control-tower/workspace?id=${encodeURIComponent(original.id)}`, base).href);
      assert.deepEqual((await previousResponse.json()).workspace, original, 'The ordinary CSV workspace remains recoverable unchanged.');
      await page.reload();
      await page.getByRole('button', { name: 'Compare 2 with CRM', exact: true }).waitFor();
      const reloaded = await activeWorkspace(page, context);
      assert.deepEqual(reloaded.state.contacts, imported.state.contacts);
      await page.locator('summary').filter({ hasText: 'Choose rows to import · 1 skipped' }).click();
      await page.getByRole('region', { name: 'Import row decisions', exact: true }).getByText(`Skipped: Pomade Review: ${reviewReason}`, { exact: true }).waitFor();
      const sourceContext = page.locator('tbody details').filter({ hasText: 'source row priya' });
      await sourceContext.locator('summary').click();
      await sourceContext.getByText('Original proposed values', { exact: true }).waitFor();
      await sourceContext.getByText('Source status: Ready', { exact: true }).waitFor();
      await sourceContext.screenshot({ path: `/tmp/gtm-pomade-${provider}-saved-context.png` });
      const malformed = [
        ['malformed.json', '{', 'The Pomade handoff must be valid JSON.'],
        ['unsupported.json', JSON.stringify({ ...input, schemaVersion: 99 }), 'This Pomade handoff version is not supported. Re-export version 1.'],
        ['oversized.json', ' '.repeat(2 * 1024 * 1024 + 1), 'Use a Pomade handoff smaller than 2 MB.'],
      ];
      for (const [name, content, message] of malformed) {
        const before = apiCalls.length;
        await fileInput.setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(content) });
        await page.getByText(message, { exact: true }).waitFor();
        assert.equal(await preview.count(), 0, 'Invalid input cannot leave a loadable partial preview.');
        assert.deepEqual(await activeWorkspace(page, context), reloaded, 'Rejected handoff must preserve the saved workspace.');
        assert.equal(apiCalls.length, before, 'Invalid input must be rejected before network work.');
      }
      await page.getByRole('button', { name: 'Compare 2 with CRM', exact: true }).click();
      await page.getByText('0 create · 1 update · 0 unchanged · 1 held', { exact: true }).waitFor();
      const comparison = page.locator('[aria-label="CRM comparison records"]');
      const held = comparison.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'elena.park@oracle.example.com' }) }).first();
      await held.locator('summary').first().click();
      await held.getByText(holdReason, { exact: true }).waitFor();
      await held.locator('details > summary').click();
      await held.getByText('Original proposed values', { exact: true }).waitFor();
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download comparison CSV', exact: true }).click()]);
      const chunks = [];
      for await (const chunk of await download.createReadStream()) chunks.push(chunk);
      const rows = parseCsv(Buffer.concat(chunks).toString('utf8'));
      assert.equal(rows.length, 2);
      for (const row of rows) {
        const origin = imported.state.contacts.find((contact) => contact.contactId === row.contact_id).sourceOrigins;
        assert.deepEqual(JSON.parse(row.source_context), origin);
        assert.equal(row.source_create_scope, 'existing_record_updates_only');
        assert.equal(row.outcome, '', 'Preview must not invent a write outcome.');
      }
      await comparison.screenshot({ path: `/tmp/gtm-pomade-${provider}-comparison.png` });
      delegated = true;
      await page.reload();
      await page.getByText('Pomade proposals need the direct CRM connector for reviewed, existing-record updates. Delegated sync is unavailable for this import.', { exact: true }).waitFor();
      const blockedSync = page.getByRole('button', { name: provider === 'hubspot' ? 'Sync 2 to HubSpot' : 'Sync 2 to Salesforce', exact: true });
      assert(await blockedSync.isDisabled(), 'Pomade cannot bypass reviewed updates through delegated sync.');
      let exporterCompatibility = null;
      if (provider === 'hubspot' && process.env.GTM_POMADE_COMPATIBILITY_FILE) {
        const actualBytes = readFileSync(process.env.GTM_POMADE_COMPATIBILITY_FILE);
        const actual = JSON.parse(actualBytes.toString('utf8'));
        const beforeImport = await activeWorkspace(page, context), beforeCalls = apiCalls.length;
        await fileInput.setInputFiles({ name: 'actual-pomade-export.json', mimeType: 'application/json', buffer: actualBytes });
        await preview.getByText(`${actual.workspaceName} · ${actual.records.length} proposals`, { exact: true }).waitFor();
        assert.deepEqual(await activeWorkspace(page, context), beforeImport);
        assert.equal(apiCalls.length, beforeCalls, 'The actual exporter file previews locally.');
        await load().click();
        await page.getByText(`${actual.records.length} proposals loaded in a new saved workspace for review. No CRM writes were made.`, { exact: true }).waitFor();
        const actualSaved = await activeWorkspace(page, context);
        assert.notEqual(actualSaved.id, beforeImport.id);
        assert.equal(actualSaved.state.contacts.length, actual.records.length);
        for (const contact of actualSaved.state.contacts) {
          const originalRow = actual.records.find((record) => record.rowId === contact.sourceOrigins[0].rowId);
          assert.deepEqual(contact.sourceOrigins[0].evidence, originalRow.evidence ?? []);
          assert.equal(contact.sourceOrigins[0].exportId, actual.exportId);
          if (!originalRow.proposedFields.email) assert.equal(contact.normalizedEmail, null, 'Missing email in the exporter output must stay held.');
        }
        assert(actual.records.every((record) => !record.proposedFields.email), 'This optional compatibility fixture intentionally lacks email.');
        assert(await page.getByRole('button', { name: 'Fix held records first', exact: true }).isDisabled());
        await page.reload();
        await page.getByRole('button', { name: 'Fix held records first', exact: true }).waitFor();
        assert.deepEqual((await activeWorkspace(page, context)).state.contacts, actualSaved.state.contacts);
        exporterCompatibility = { records: actual.records.length, missingEmailHeld: true, reloaded: true };
      }
      assert.equal(previews.length, 1);
      assert(!apiCalls.some((call) => call.endpoint === 'crm-writeback' && call.action !== 'preview'));
      assert.deepEqual(errors, []);
      outcomes.push({ provider, passed: true, ordinaryCsv: true, localPreview: true, separateSavedWorkspace: true,
        failedSavePreservesActiveWorkspace: true, provenanceAndExclusionsReloaded: true, malformedInputsRejected: malformed.length,
        simulatedUpdatesOnlyComparison: true, delegatedSyncBlocked: true, exporterCompatibility, crmWrites: 0 });
    } catch (error) { outcomes.push({ provider, passed: false, error: error.message, errors, previews: previews.length }); }
    finally { await context.close(); }
  }
  console.log(JSON.stringify({ outcomes, liveCrmRequests: 0, comparisonResponses: 'simulated; handoff parsing and workspace persistence are real' }));
  assert(outcomes.every((outcome) => outcome.passed), 'Pomade-handoff browser regression failed.');
} finally { await browser.close(); }
