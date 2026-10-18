import { describe, expect, it } from 'vitest';
import { importContactsCsv, isDestinationReadyContact } from '../lib/csv-control-tower';
import type { CustomFieldDefinition } from '../lib/import-fields';
import { defaultNormalizationSettings, normalizationFieldLabels, previewNormalization, validateNormalizationSettings } from '../lib/import-normalization';
import type { LiveContactState } from '../lib/live-control-tower';

function row(overrides: Partial<LiveContactState> = {}): LiveContactState {
  return { ...importContactsCsv('contact_id,full_name,email,company,owner_id\nC-1,Ada Lovelace,ada@example.test,Example,owner-1').contacts[0], ...overrides };
}
const customFields: CustomFieldDefinition[] = [
  { key: 'favorite_icecream', label: 'Fav. Ice Cream', object: 'contact' },
  { key: 'tier', label: 'Account Tier', object: 'company' },
];

describe('local import normalization', () => {
  it('defaults to full names, no implicit country, and validates settings without coercing malformed rules', () => {
    expect(validateNormalizationSettings(undefined)).toMatchObject({ countryFormat: 'name', defaultCountry: '', nameCase: 'preserve' });
    expect(validateNormalizationSettings({ defaultCountry: 'United States' }).defaultCountry).toBe('US');
    expect(() => validateNormalizationSettings({ normalizePhones: 'true' })).toThrow('switches');
    expect(() => validateNormalizationSettings({ titleRules: [{ keywords: 'sales' }] })).toThrow('rule');
    expect(() => validateNormalizationSettings({ defaultCountry: 'Atlantis' })).toThrow('country');
    for (const field of ['contactId', 'rawEmail', 'normalizedEmail', 'ownerId', 'recordStatus', 'importExclusion', 'qualityFlags', '__proto__']) {
      expect(() => validateNormalizationSettings({ valueRules: [{ field, from: 'a', to: 'b' }] })).toThrow('data fields');
    }
  });

  it('standardizes country aliases and US / Canadian subdivisions using each row country', () => {
    const source = ['US', 'USA', 'U.S.', 'United States', '840'].map((country, index) => row({ contactId: `C-${index}`, country, state: 'ca' }));
    source.push(row({ contactId: 'C-CA', country: 'CAN', state: 'ON' }));
    source.push(row({ contactId: 'C-GB', country: 'UK', state: '' }));
    const preview = previewNormalization(source, defaultNormalizationSettings());
    expect(preview.contacts.slice(0, 5).map((item) => [item.country, item.state])).toEqual(Array(5).fill(['United States', 'California']));
    expect(preview.contacts[5]).toMatchObject({ country: 'Canada', state: 'Ontario' });
    expect(preview.contacts[6].country).toBe('United Kingdom');
    const code = previewNormalization(preview.contacts, { ...defaultNormalizationSettings(), countryFormat: 'code' });
    expect(code.contacts[0]).toMatchObject({ country: 'US', state: 'CA' });
    expect(code.contacts[5]).toMatchObject({ country: 'CA', state: 'ON' });
  });

  it('leaves uncertain states, unknown countries and national phones unchanged without country context', () => {
    const preview = previewNormalization([row({ state: 'CA', phone: '(202) 555-0123', country: '' }),
      row({ contactId: 'C-2', country: 'Atlantis', state: 'CA', phone: '2025550123' })], defaultNormalizationSettings());
    expect(preview.contacts[0]).toMatchObject({ state: 'CA', phone: '(202) 555-0123', country: '' });
    expect(preview.contacts[1]).toMatchObject({ country: 'Atlantis', state: 'CA', phone: '2025550123' });
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'state' }), expect.objectContaining({ field: 'phone' }), expect.objectContaining({ field: 'country' })]));
    const explicit = previewNormalization([row({ state: 'CA', phone: '(202) 555-0123' })], { ...defaultNormalizationSettings(), defaultCountry: 'US' });
    expect(explicit.contacts[0]).toMatchObject({ state: 'California', phone: '+12025550123' });
    expect(explicit.contacts[0].country).toBeUndefined();
  });

  it('formats valid phones internationally with extensions intact and does not guess invalid phones', () => {
    const preview = previewNormalization([
      row({ country: 'US', phone: '(202) 555-0123 x42' }),
      row({ contactId: 'C-2', country: 'GB', phone: '020 7946 0958' }),
      row({ contactId: 'C-3', phone: '+44 20 7946 0958 ext. 12' }),
      row({ contactId: 'C-4', country: 'US', phone: '12345' }),
    ], defaultNormalizationSettings());
    expect(preview.contacts.map((item) => item.phone)).toEqual(['+12025550123 ext. 42', '+442079460958', '+442079460958 ext. 12', '12345']);
    expect(preview.warnings).toContainEqual(expect.objectContaining({ contactId: 'C-4', field: 'phone' }));
    expect(preview.changes.find((change) => change.field === 'phone')?.reason).toContain('reachability was not verified');
  });

  it('splits simple or comma names without overwriting existing parts or guessing complex names', () => {
    const preview = previewNormalization([
      row({ fullName: 'Lovelace, Ada' }), row({ contactId: 'C-2', fullName: 'Mary Ann Smith' }),
      row({ contactId: 'C-3', fullName: 'Prince' }), row({ contactId: 'C-4', fullName: 'Dr. Smith' }),
      row({ contactId: 'C-5', fullName: 'Ada Lovelace', firstName: 'Augusta', lastName: '' }),
    ], defaultNormalizationSettings());
    expect(preview.contacts[0]).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace' });
    for (const index of [1, 2, 3]) expect(preview.contacts[index].firstName).toBe('');
    expect(preview.contacts[4]).toMatchObject({ firstName: 'Augusta', lastName: '' });
    expect(preview.warnings.filter((warning) => warning.field === 'fullName')).toHaveLength(4);
  });

  it('keeps display casing by default and makes title casing opt-in while cleaning addresses only', () => {
    const source = row({ fullName: '  aDA   O’NEILL  ', address: '  12   Main St.\nSuite 3 ', city: ' SAN   FRANCISCO ', postalCode: ' 94102 ' });
    const normal = previewNormalization([source], defaultNormalizationSettings());
    expect(normal.contacts[0]).toMatchObject({ fullName: 'aDA O’NEILL', address: '12 Main St. Suite 3', city: 'SAN FRANCISCO', postalCode: '94102' });
    const cased = previewNormalization([source], { ...defaultNormalizationSettings(), nameCase: 'title' });
    expect(cased.contacts[0]).toMatchObject({ fullName: 'Ada O’Neill', firstName: 'Ada', lastName: 'O’Neill' });
    expect(cased.changes.find((change) => change.field === 'address')?.reason).toContain('postal accuracy was not verified');
  });

  it('uses whole title phrases, warns on competing categories and preserves existing categories', () => {
    const settings = { ...defaultNormalizationSettings(), titleRules: [
      { keywords: ['sales'], department: 'Sales', persona: 'Seller' },
      { keywords: ['operations'], department: 'Operations', persona: 'Operator' },
    ] };
    const preview = previewNormalization([
      row({ jobTitle: 'Sales Director' }), row({ contactId: 'C-2', jobTitle: 'Wholesale Analyst' }),
      row({ contactId: 'C-3', jobTitle: 'Sales Operations' }),
      row({ contactId: 'C-4', jobTitle: 'Sales Director', department: 'Existing', persona: 'Existing' }),
    ], settings);
    expect(preview.contacts[0]).toMatchObject({ department: 'Sales', persona: 'Seller' });
    expect(preview.contacts[1].department).toBeUndefined();
    expect(preview.contacts[2].department).toBeUndefined();
    expect(preview.warnings).toContainEqual(expect.objectContaining({ contactId: 'C-3', field: 'jobTitle', reason: expect.stringContaining('Multiple title rules') }));
    expect(preview.contacts[3]).toMatchObject({ department: 'Existing', persona: 'Existing' });
  });

  it('keeps company and contact countries, phone formats, addresses and custom values separate', () => {
    const source = row({ importObject: 'contact_company', country: 'USA', state: 'CA', phone: '2025550123',
      associatedCompany: { recordId: 'CO-1', name: ' Example ', website: 'example.test', phone: '4165550123', country: 'CAN', state: 'ON', address: ' 1  Yonge St. ', customFields: { tier: 'large' } },
      customFields: { favorite_icecream: ' Choc ' } });
    const settings = { ...defaultNormalizationSettings(), valueRules: [
      { field: 'custom:contact:favorite_icecream', from: 'choc', to: 'Chocolate' },
      { field: 'custom:company:tier', from: 'large', to: 'Enterprise' },
    ] };
    const preview = previewNormalization([source], settings, customFields);
    expect(preview.contacts[0]).toMatchObject({ country: 'United States', state: 'California', phone: '+12025550123', customFields: { favorite_icecream: 'Chocolate' },
      associatedCompany: { country: 'Canada', state: 'Ontario', phone: '+14165550123', address: '1 Yonge St.', customFields: { tier: 'Enterprise' } } });
    expect(source.associatedCompany?.country).toBe('CAN');
    expect(normalizationFieldLabels('company', customFields)).not.toHaveProperty('firstName');
    expect(normalizationFieldLabels('contact', customFields)).not.toHaveProperty('custom:company:tier');
    expect(previewNormalization([row({ customFields: { favorite_icecream: 'Choc' } })], settings).contacts[0].customFields?.favorite_icecream).toBe('Choc');
  });

  it('resolves replacement chains once and flags ambiguous or cyclic aliases without changing them', () => {
    const settings = { ...defaultNormalizationSettings(), valueRules: [
      { field: 'segment', from: 'smb', to: 'Small' }, { field: 'segment', from: 'Small', to: 'Small Business' },
      { field: 'region', from: 'NE', to: 'East' }, { field: 'region', from: 'NE', to: 'Northeast' },
      { field: 'city', from: 'A', to: 'B' }, { field: 'city', from: 'B', to: 'A' },
    ] };
    const preview = previewNormalization([row({ segment: 'SMB', region: 'NE', city: 'A' })], settings);
    expect(preview.contacts[0]).toMatchObject({ segment: 'Small Business', region: 'NE', city: 'A' });
    expect(preview.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'region', reason: expect.stringContaining('Conflicting') }),
      expect.objectContaining({ field: 'city', reason: expect.stringContaining('cycle') }),
    ]));
    expect(previewNormalization(preview.contacts, settings).changes).toEqual([]);
  });

  it('applies title and full-name aliases before deriving categories and name parts, idempotently', () => {
    const settings = { ...defaultNormalizationSettings(), valueRules: [
      { field: 'fullName', from: 'A. Lovelace', to: 'Ada Lovelace' },
      { field: 'jobTitle', from: 'Rev Ops', to: 'RevOps Manager' },
      { field: 'department', from: 'Revenue Operations', to: 'RevOps' },
    ] };
    const preview = previewNormalization([row({ fullName: 'A. Lovelace', jobTitle: 'Rev Ops' })], settings);
    expect(preview.contacts[0]).toMatchObject({ fullName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', jobTitle: 'RevOps Manager', department: 'RevOps', persona: 'Operations' });
    expect(previewNormalization(preview.contacts, settings).changes).toEqual([]);
  });

  it('leaves merged, skipped and suppressed rows untouched and retains the source snapshot', () => {
    const source = [row({ recordStatus: 'merged', country: 'USA' }),
      row({ contactId: 'C-2', country: 'USA', importExclusion: { reason: 'Leave out', excludedAt: '2026-10-16T00:00:00.000Z' } }),
      row({ contactId: 'C-3', country: 'USA', suppressionMatches: [{ ruleId: 'S-1', listName: 'Vendors', reason: 'Vendor', type: 'email_domain', value: 'example.test' }] }),
      row({ contactId: 'C-4', country: 'USA' })];
    const snapshot = structuredClone(source);
    const preview = previewNormalization(source, defaultNormalizationSettings());
    expect(source).toEqual(snapshot);
    expect(preview.contacts.slice(0, 3)).toEqual(source.slice(0, 3));
    expect(preview.changedRows).toBe(1);
    expect(preview.contacts[3].country).toBe('United States');
    expect(previewNormalization(preview.contacts, defaultNormalizationSettings()).changes).toEqual([]);
  });

  it('refreshes company holds only when identity fields change, including company display and combined fallbacks', () => {
    const source = row();
    expect(isDestinationReadyContact(source)).toBe(true);
    const cleared = previewNormalization([source], { ...defaultNormalizationSettings(), valueRules: [{ field: 'company', from: 'Example', to: '' }] }).contacts[0];
    expect(cleared.qualityFlags).toContain('missing_company');
    expect(isDestinationReadyContact(cleared)).toBe(false);

    const company = importContactsCsv('company_id,company_name,website\nCO-1,Example,example.test', {}, 'company').contacts[0];
    const clearedCompany = previewNormalization([company], { ...defaultNormalizationSettings(), valueRules: [{ field: 'company', from: 'Example', to: '' }] }).contacts[0];
    expect(clearedCompany).toMatchObject({ fullName: 'example.test', qualityFlags: ['missing_company_name'] });

    const combined = row({ importObject: 'contact_company', company: null,
      associatedCompany: { recordId: null, name: 'Example', website: '', phone: '', state: '' } });
    const settings = { ...defaultNormalizationSettings(), valueRules: [{ field: 'associatedCompanyName', from: 'Example', to: '' }] };
    expect(previewNormalization([combined], settings).contacts[0].qualityFlags).toContain('missing_company');
    combined.associatedCompany!.recordId = 'CO-1';
    expect(previewNormalization([combined], settings).contacts[0].qualityFlags).not.toContain('missing_company');
    expect(previewNormalization([row({ qualityFlags: ['missing_company'] })], defaultNormalizationSettings()).contacts[0].qualityFlags).toContain('missing_company');
  });

  it('normalizes a 120-row combined import locally and remains stable on a second preview', () => {
    const contacts = Array.from({ length: 120 }, (_, index) => row({ contactId: `S-${index}`, importObject: 'contact_company',
      fullName: `Ada Tester`, country: ['US', 'USA', 'United States'][index % 3], state: 'CA', phone: '(202) 555-0123', jobTitle: 'VP Revenue Operations',
      customFields: { favorite_icecream: 'choc' }, associatedCompany: { recordId: null, name: `Company ${index}`, website: `company${index}.test`, phone: '4165550123', state: 'ON', country: 'CAN' } }));
    const settings = { ...defaultNormalizationSettings(), valueRules: [{ field: 'custom:contact:favorite_icecream', from: 'choc', to: 'Chocolate' }] };
    const preview = previewNormalization(contacts, settings, customFields);
    expect(preview.changedRows).toBe(120);
    expect(preview.changes.length).toBeGreaterThan(1_000);
    expect(preview.warnings).toEqual([]);
    expect(previewNormalization(preview.contacts, settings, customFields).changes).toEqual([]);
  });
});
