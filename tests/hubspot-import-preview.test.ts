import { describe, expect, it, vi } from 'vitest';
import { buildHubSpotImportDryRun } from '../lib/hubspot-import-preview';
import type { HubSpotImportBinding, HubSpotImportLookups, HubSpotImportProperty, HubSpotImportRecord, HubSpotImportSchema } from '../lib/hubspot-import';
import type { LiveContactState } from '../lib/live-control-tower';

const now = new Date('2026-10-16T16:00:00.000Z');
const property = (name: string, overrides: Partial<HubSpotImportProperty> = {}): HubSpotImportProperty => ({
  name, label: name, type: 'string', fieldType: 'text', options: [], readOnly: false, calculated: false,
  externalOptions: false, hidden: false, ...overrides,
});
const row = (overrides: Partial<LiveContactState> = {}): LiveContactState => ({
  importObject: 'contact', contactId: 'CSV-001', fullName: 'Ada Example', firstName: 'Ada', lastName: 'Example',
  rawEmail: 'ada@example.test', normalizedEmail: 'ada@example.test', company: null, ownerId: null,
  region: 'Unassigned', segment: 'Unassigned', lifecycleStage: 'lead', expectedLifecycleStage: 'lead',
  canonicalContactId: null, recordStatus: 'active', lastAction: 'csv_imported', qualityFlags: [], updatedAt: now.toISOString(), ...overrides,
});
const baseFields: HubSpotImportBinding['fields'] = {
  rawEmail: { object: 'contact', propertyName: 'email' }, firstName: { object: 'contact', propertyName: 'firstname' },
  lastName: { object: 'contact', propertyName: 'lastname' },
};
function input(contacts = [row()]) {
  const lookups: HubSpotImportLookups = { contacts: {}, companies: {} };
  for (const contact of contacts) {
    lookups.contacts[contact.contactId] = { status: 'absent', records: [] };
    lookups.companies[contact.contactId] = { status: 'absent', records: [] };
  }
  return {
    workspaceId: 'workspace', workspaceRevision: 2, fingerprint: 'a'.repeat(64),
    originalContacts: structuredClone(contacts), contacts, customFields: [], normalizedChanges: 0, now,
    binding: { portalId: '123', fields: { ...baseFields } } as HubSpotImportBinding,
    schema: { portalId: '123', fetchedAt: now.toISOString(), warnings: [], properties: {
      contact: ['email', 'firstname', 'lastname'].map((name) => property(name)), company: [],
    } } as HubSpotImportSchema, lookups,
  };
}
function current(properties: Record<string, string | null> = {}, id = '100'): HubSpotImportRecord {
  return { id, properties: { email: 'ada@example.test', firstname: 'Ada', lastname: 'Example', ...properties } };
}
function bindExtra(config: ReturnType<typeof input>, field: keyof HubSpotImportBinding['fields'], destination: HubSpotImportProperty) {
  config.binding.fields[field] = { object: 'contact', propertyName: destination.name };
  config.schema.properties.contact.push(destination);
}
const options = [{ value: 'us_internal', label: 'United States', hidden: false }, { value: 'ca_internal', label: 'Canada', hidden: false }];

describe('read-only normalized HubSpot import preview', () => {
  it('uses live enum internal values, distinguishes all three inputs, and leaves source rows untouched', () => {
    const config = input([row({ country: 'United States' })]);
    config.originalContacts[0].country = 'USA';
    config.normalizedChanges = 1;
    bindExtra(config, 'country', property('country', { type: 'enumeration', fieldType: 'select', options }));
    config.lookups.contacts['CSV-001'] = { status: 'matched', records: [current({ country: null })] };
    const before = structuredClone(config);
    const result = buildHubSpotImportDryRun(config);
    expect(result.objects[0].status).toBe('update');
    expect(result.objects[0].fields.find((field) => field.field === 'country')).toMatchObject({
      original: 'USA', normalized: 'United States', current: null, proposed: 'us_internal', action: 'set',
    });
    expect(result).toMatchObject({ readOnly: true, normalizedChanges: 1, checkedAt: now.toISOString(), counts: { contact: { update: 1 } } });
    expect(config).toEqual(before);
  });

  it('preserves real free-text country values when HubSpot has no picklist', () => {
    const config = input([row({ country: 'United States' })]);
    bindExtra(config, 'country', property('country'));
    const result = buildHubSpotImportDryRun(config);
    expect(result.objects[0].status).toBe('create');
    expect(result.objects[0].fields.find((field) => field.field === 'country')?.proposed).toBe('United States');
  });

  it.each([
    ['exact internal value', 'us_internal', options, 'set', 'us_internal'],
    ['case-insensitive label', 'united states', options, 'set', 'us_internal'],
    ['unknown value', 'Mars', options, 'review', null],
    ['hidden choice', 'us_internal', [{ ...options[0], hidden: true }], 'review', null],
    ['duplicate label', 'United States', [...options, { value: 'other_us', label: 'UNITED STATES', hidden: false }], 'review', null],
    ['internal name wins over a label', 'us_internal', [...options, { value: 'different', label: 'us_internal', hidden: false }], 'set', 'us_internal'],
  ] as const)('handles %s without guessing enum values', (_title, value, choices, action, proposed) => {
    const config = input([row({ country: value })]);
    bindExtra(config, 'country', property('country', { type: 'enumeration', fieldType: 'select', options: [...choices] }));
    const field = buildHubSpotImportDryRun(config).objects[0].fields.find((item) => item.field === 'country');
    expect(field).toMatchObject({ action, proposed });
  });

  it('only splits semicolon choices for checkbox multi-selects', () => {
    const config = input([row({ country: 'United States; Canada' })]);
    bindExtra(config, 'country', property('country', { type: 'enumeration', fieldType: 'checkbox', options }));
    expect(buildHubSpotImportDryRun(config).objects[0].fields.at(-1)).toMatchObject({ action: 'set', proposed: 'us_internal;ca_internal' });
    config.schema.properties.contact.at(-1)!.fieldType = 'select';
    expect(buildHubSpotImportDryRun(config).objects[0].status).toBe('review');
    config.schema.properties.contact.at(-1)!.fieldType = 'checkbox';
    config.lookups.contacts['CSV-001'] = { status: 'matched', records: [current({ country: 'ca_internal;us_internal' })] };
    expect(buildHubSpotImportDryRun({ ...config, policy: 'overwrite' }).objects[0].fields.at(-1)?.action).toBe('unchanged');
  });

  it.each([
    ['read-only', { readOnly: true }], ['calculated', { calculated: true }], ['hidden', { hidden: true }], ['external options', { externalOptions: true }],
    ['unknown type', { type: 'mystery' }],
  ])('holds a populated %s property', (_label, overrides) => {
    const config = input([row({ country: 'United States' })]);
    bindExtra(config, 'country', property('country', overrides));
    expect(buildHubSpotImportDryRun(config).objects[0]).toMatchObject({ status: 'review', fields: expect.arrayContaining([expect.objectContaining({ field: 'country', action: 'review' })]) });
  });

  it('flags missing properties, unreadable current values, and unmapped populated custom fields', () => {
    const config = input([row({ country: 'United States', customFields: { flavor: 'Vanilla' } })]);
    config.binding.fields.country = { object: 'contact', propertyName: 'old_country' };
    const customFields = [{ object: 'contact' as const, key: 'flavor', label: 'Favorite flavor' }];
    const missing = buildHubSpotImportDryRun({ ...config, customFields });
    expect(missing.objects[0].reasons.join(' ')).toContain('no longer exists');
    expect(missing.objects[0].reasons.join(' ')).toContain('Favorite flavor: populated import field has no HubSpot mapping');
    config.schema.properties.contact.push(property('old_country'));
    config.lookups.contacts['CSV-001'] = { status: 'matched', records: [current()] };
    expect(buildHubSpotImportDryRun({ ...config, customFields }).objects[0].reasons.join(' ')).toContain('current HubSpot value was not returned');
  });

  it('uses fill-empty by default; overwrite remains advisory and blanks never clear data', () => {
    const config = input([row({ country: 'United States' })]);
    bindExtra(config, 'country', property('country'));
    config.lookups.contacts['CSV-001'] = { status: 'matched', records: [current({ country: 'Canada' })] };
    expect(buildHubSpotImportDryRun(config).objects[0].fields.at(-1)).toMatchObject({ action: 'preserve', current: 'Canada', proposed: 'Canada' });
    expect(buildHubSpotImportDryRun({ ...config, policy: 'overwrite' }).objects[0].fields.at(-1)).toMatchObject({ action: 'set', proposed: 'United States' });
    config.contacts[0].country = '';
    expect(buildHubSpotImportDryRun({ ...config, policy: 'overwrite' }).objects[0].fields.at(-1)).toMatchObject({ action: 'preserve', proposed: 'Canada' });
  });

  it('preserves native IDs and the existing primary email even when the import matched an alias', () => {
    const config = input([row({ rawEmail: 'alias@example.test', normalizedEmail: 'alias@example.test' })]);
    bindExtra(config, 'contactId', property('hs_object_id', { readOnly: true }));
    config.lookups.contacts['CSV-001'] = { status: 'matched', records: [current()] };
    const result = buildHubSpotImportDryRun({ ...config, policy: 'overwrite' });
    expect(result.objects[0].status).toBe('unchanged');
    expect(result.objects[0].fields.find((field) => field.field === 'rawEmail')).toMatchObject({ current: 'ada@example.test', proposed: 'ada@example.test', action: 'preserve' });
    expect(result.objects[0].fields.at(-1)).toMatchObject({ current: '100', proposed: '100', action: 'preserve' });
  });

  it('never treats a missing, failed, or ambiguous lookup as a new record', () => {
    const config = input();
    for (const lookup of [undefined, { status: 'unresolved' as const, records: [], reason: 'Read failed' }, { status: 'ambiguous' as const, records: [current(), current({}, '101')] }]) {
      if (lookup) config.lookups.contacts['CSV-001'] = lookup;
      else delete config.lookups.contacts['CSV-001'];
      expect(buildHubSpotImportDryRun(config).objects[0].status).toBe('review');
    }
  });

  it.each(['contact', 'company', 'contact_company'] as const)('holds a missing explicitly supplied native ID for %s imports', (object) => {
    const company = { recordId: '200', name: 'Example', website: 'example.test', phone: '', state: '' };
    const config = input([row({ importObject: object, contactId: '100',
      ...(object === 'company' ? { company: 'Example', website: 'example.test', fullName: 'Example', firstName: '', lastName: '', rawEmail: '', normalizedEmail: null, lifecycleStage: '' } : {}),
      ...(object === 'contact_company' ? { associatedCompany: company } : {}),
    })]);
    if (object === 'contact') {
      bindExtra(config, 'contactId', property('hs_object_id', { readOnly: true }));
    } else {
      config.schema.properties.company = [property('name'), property('website'), property('hs_object_id', { readOnly: true })];
      if (object === 'company') config.binding.fields = {
        company: { object: 'company', propertyName: 'name' }, website: { object: 'company', propertyName: 'website' },
        contactId: { object: 'company', propertyName: 'hs_object_id' },
      };
      else Object.assign(config.binding.fields, { associatedCompanyName: { object: 'company', propertyName: 'name' }, associatedCompanyWebsite: { object: 'company', propertyName: 'website' } });
    }
    const target = buildHubSpotImportDryRun(config).objects.find((item) => item.object === (object === 'contact' ? 'contact' : 'company'))!;
    expect(target.status).toBe('review');
    expect(target.reasons.join(' ')).toContain('record ID was not found');
  });

  it('does not interpret numeric company row IDs as native IDs unless explicitly bound', () => {
    const company = row({ importObject: 'company', contactId: '201', company: 'Example', website: 'example.test',
      fullName: 'Example', firstName: '', lastName: '', rawEmail: '', normalizedEmail: null, lifecycleStage: '' });
    const config = input([company, { ...company, contactId: '202' }]);
    config.binding.fields = { company: { object: 'company', propertyName: 'name' }, website: { object: 'company', propertyName: 'website' } };
    config.schema.properties.company = [property('name'), property('website'), property('hs_object_id', { readOnly: true })];
    let result = buildHubSpotImportDryRun(config);
    expect(result.counts.company.create).toBe(1);
    expect(result.objects[0]).toMatchObject({ key: 'company:domain:example.test', sourceRowIds: ['201', '202'] });
    config.binding.fields.contactId = { object: 'company', propertyName: 'hs_object_id' };
    result = buildHubSpotImportDryRun(config);
    expect(result.counts.company).toMatchObject({ create: 0, review: 2 });
    expect(result.objects.map((item) => item.key)).toEqual(['company:id:201', 'company:id:202']);
  });

  it('holds duplicate contact emails and separate proposals for the same native target', () => {
    const config = input([row(), row({ contactId: 'CSV-002' })]);
    let result = buildHubSpotImportDryRun(config);
    expect(result.counts.contact.review).toBe(2);
    expect(result.objects.every((object) => object.reasons.join(' ').includes('uses this contact email'))).toBe(true);
    config.contacts[1].rawEmail = config.contacts[1].normalizedEmail = 'alias@example.test';
    for (const contact of config.contacts) config.lookups.contacts[contact.contactId] = { status: 'matched', records: [current()] };
    result = buildHubSpotImportDryRun(config);
    expect(result.objects.every((object) => object.reasons.join(' ').includes('same HubSpot record'))).toBe(true);
  });

  it('retains import holds and skips merged, suppressed, and manually excluded rows', () => {
    const config = input([row({ qualityFlags: ['missing_owner'] }), row({ contactId: 'merged', recordStatus: 'merged' }),
      row({ contactId: 'excluded', importExclusion: { reason: 'Not a prospect', excludedAt: now.toISOString() } }),
      row({ contactId: 'suppressed', suppressionMatches: [{ ruleId: 'rule', listName: 'Vendors', type: 'email', value: 'ada@example.test', reason: 'Vendor' }] }),
    ]);
    const result = buildHubSpotImportDryRun(config);
    expect(result.counts.contact).toMatchObject({ review: 1, skipped: 3 });
    expect(result.objects[0].reasons).toContain('Existing import hold: missing owner.');
  });

  it('groups identical company proposals once and holds conflicting values without choosing a winner', () => {
    const company = { recordId: null, name: 'Example', website: 'https://example.test', phone: '', state: '', country: 'United States' };
    const config = input([row({ importObject: 'contact_company', associatedCompany: company }),
      row({ importObject: 'contact_company', contactId: 'CSV-002', rawEmail: 'other@example.test', normalizedEmail: 'other@example.test', associatedCompany: { ...company } })]);
    config.schema.properties.company = ['name', 'website', 'country'].map((name) => property(name));
    Object.assign(config.binding.fields, {
      associatedCompanyName: { object: 'company', propertyName: 'name' }, associatedCompanyWebsite: { object: 'company', propertyName: 'website' }, associatedCompanyCountry: { object: 'company', propertyName: 'country' },
    });
    let result = buildHubSpotImportDryRun(config);
    expect(result.counts.company.create).toBe(1);
    expect(result.objects.find((object) => object.object === 'company')?.sourceRowIds).toEqual(['CSV-001', 'CSV-002']);
    config.contacts[1].associatedCompany!.country = 'Canada';
    result = buildHubSpotImportDryRun(config);
    expect(result.counts.company.review).toBe(1);
    expect(result.objects.find((object) => object.object === 'company')?.fields.find((field) => field.field === 'associatedCompanyCountry')).toMatchObject({ normalized: 'United States | Canada', proposed: null, action: 'review' });
    expect(result.warnings.join(' ')).toContain('no association operations');
  });

  it('holds missing company identity and differing matched company names', () => {
    const config = input([row({ importObject: 'contact_company', associatedCompany: { recordId: null, name: 'Example', website: '', phone: '', state: '' } })]);
    config.binding.fields.associatedCompanyName = { object: 'company', propertyName: 'name' };
    config.schema.properties.company = [property('name')];
    expect(buildHubSpotImportDryRun(config).objects.find((object) => object.object === 'company')?.reasons.join(' ')).toContain('valid website hostname');
    config.contacts[0].associatedCompany!.website = 'example.test';
    config.binding.fields.associatedCompanyWebsite = { object: 'company', propertyName: 'website' };
    config.schema.properties.company.push(property('website'));
    config.lookups.companies['CSV-001'] = { status: 'matched', records: [{ id: '200', properties: { name: 'Different Business', website: 'example.test' } }] };
    expect(buildHubSpotImportDryRun(config).objects.find((object) => object.object === 'company')?.reasons.join(' ')).toContain('different name');
  });

  it.each([
    ['number', '123.5', 'set'], ['number', '$123', 'review'], ['bool', 'true', 'set'], ['bool', 'Yes', 'review'],
    ['date', '2026-10-16', 'set'], ['date', '2026-02-30', 'review'], ['date', '10/16/2026', 'review'],
    ['datetime', '2026-10-16T16:00:00Z', 'set'], ['datetime', '2026-02-30T16:00:00Z', 'review'],
  ])('validates %s value %s without inventing a conversion', (type, value, action) => {
    const config = input([row({ country: value })]);
    bindExtra(config, 'country', property('country', { type }));
    expect(buildHubSpotImportDryRun(config).objects[0].fields.at(-1)?.action).toBe(action);
  });

  it('has no network or CRM side effects and rejects a different portal as review', () => {
    const fetch = vi.fn(() => { throw new Error('Network calls are forbidden in this pure preview'); });
    vi.stubGlobal('fetch', fetch);
    try {
      const config = input();
      config.binding.portalId = '999';
      expect(buildHubSpotImportDryRun(config).objects[0].status).toBe('review');
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
