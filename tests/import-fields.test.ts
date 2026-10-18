import { describe, expect, it } from 'vitest';
import { csvFieldLabelsForObject, exportContactsCsv, importContactsCsv, previewContactsCsv, suggestCsvMapping } from '../lib/csv-control-tower';
import { customFieldKey, validateCustomFields, type CustomFieldDefinition } from '../lib/import-fields';

const fields: CustomFieldDefinition[] = [
  { key: 'favorite_ice_cream', label: 'Fav. Ice Cream', object: 'contact' },
  { key: 'account_tier', label: 'Account tier', object: 'company' },
];

describe('import fields and object-scoped custom properties', () => {
  it('retains contact and company address fields and custom values through a combined export', () => {
    const csv = 'Email,Company,Country,State,Street Address,City,Postal Code,Department,Persona,Company Country,Company State,Company Address,Company City,Company Postal Code,Favorite icecream,Tier\nada@example.test,Analytical Engines,USA,CA,10 Main St,Oakland,00123,Engineering,Technical buyer,UK,London,20 High St,London,SW1A 1AA,Vanilla,Enterprise';
    const mapping = { [customFieldKey(fields[0])]: 'Favorite icecream', [customFieldKey(fields[1])]: 'Tier' };
    expect(previewContactsCsv(csv, 'contact_company', fields).suggestedMapping).toMatchObject({
      country: 'Country', address: 'Street Address', postalCode: 'Postal Code', department: 'Department', persona: 'Persona',
      associatedCompanyCountry: 'Company Country', associatedCompanyAddress: 'Company Address', associatedCompanyCity: 'Company City', associatedCompanyPostalCode: 'Company Postal Code',
    });
    const rows = importContactsCsv(csv, mapping, 'contact_company', fields).contacts;
    expect(rows[0]).toMatchObject({ country: 'USA', state: 'CA', address: '10 Main St', city: 'Oakland', postalCode: '00123',
      department: 'Engineering', persona: 'Technical buyer', customFields: { favorite_ice_cream: 'Vanilla' },
      associatedCompany: { country: 'UK', state: 'London', address: '20 High St', city: 'London', postalCode: 'SW1A 1AA', customFields: { account_tier: 'Enterprise' } },
    });
    const exported = exportContactsCsv(rows, 'contact_company', fields);
    expect(exported.split('\n')[0]).toContain('custom:contact:favorite_ice_cream,custom:company:account_tier');
    const reimported = importContactsCsv(exported, {}, 'contact_company', fields).contacts;
    expect(reimported).toEqual(rows.map((row, index) => ({ ...row, updatedAt: reimported[index].updatedAt })));
  });

  it('supports company-only fields without offering contact custom properties', () => {
    const labels = csvFieldLabelsForObject('company', fields);
    expect(labels['custom:company:account_tier']).toBe('Account tier');
    expect(labels).not.toHaveProperty('custom:contact:favorite_ice_cream');
    const csv = 'Company,Country,Billing Street,Billing City,Billing Postal Code,Account tier\nExample,Canada,1 King St,Toronto,M5V 3L9,SMB';
    const rows = importContactsCsv(csv, {}, 'company', fields).contacts;
    expect(rows[0]).toMatchObject({ company: 'Example', country: 'Canada', address: '1 King St', city: 'Toronto', postalCode: 'M5V 3L9', customFields: { account_tier: 'SMB' } });
    expect(rows[0]).not.toHaveProperty('associatedCompany');
    const reimported = importContactsCsv(exportContactsCsv(rows, 'company', fields), {}, 'company', fields).contacts;
    expect(reimported).toEqual(rows.map((row, index) => ({ ...row, updatedAt: reimported[index].updatedAt })));
    expect(() => importContactsCsv(csv, { 'custom:contact:favorite_ice_cream': 'Account tier' }, 'company', fields)).toThrow(/another import object/);
  });

  it('preserves separate object values even when the CRM property keys and labels are identical', () => {
    const shared: CustomFieldDefinition[] = [
      { key: 'category', label: 'Category', object: 'contact' },
      { key: 'category', label: 'Category', object: 'company' },
    ];
    expect(suggestCsvMapping(['Category'], 'contact_company', shared)).toEqual({});
    expect(suggestCsvMapping(['custom:contact:category', 'custom:company:category'], 'contact_company', shared)).toEqual({
      'custom:contact:category': 'custom:contact:category', 'custom:company:category': 'custom:company:category',
    });
    const csv = 'Email,Company,custom:contact:category,custom:company:category\nada@example.test,Example,Person category,Company category';
    const [row] = importContactsCsv(csv, {}, 'contact_company', shared).contacts;
    expect(row.customFields).toEqual({ category: 'Person category' });
    expect(row.associatedCompany?.customFields).toEqual({ category: 'Company category' });
    expect(suggestCsvMapping(['Country'], 'contact', [{ key: 'custom_country', label: 'Country', object: 'contact' }])).toEqual({ country: 'Country' });
  });

  it('rejects undeclared custom destinations and leaves explicitly ignored custom fields unused', () => {
    const csv = 'Email,Fav. Ice Cream\nada@example.test,Vanilla';
    expect(() => importContactsCsv(csv, { 'custom:contact:undeclared': 'Fav. Ice Cream' }, 'contact', fields)).toThrow(/another import object/);
    expect(importContactsCsv(csv, { 'custom:contact:favorite_ice_cream': '' }, 'contact', fields).contacts[0]).not.toHaveProperty('customFields');
  });

  it('validates bounded safe definitions, while allowing the same key on distinct objects', () => {
    expect(validateCustomFields(undefined)).toEqual([]);
    expect(validateCustomFields([{ key: 'favorite_ice_cream', label: ' Fav. Ice Cream ', object: 'contact' }])).toEqual([fields[0]]);
    for (const key of ['__proto__', 'constructor', 'Prototype', '1invalid', 'nested.key', 'a'.repeat(81)]) {
      expect(() => validateCustomFields([{ key, label: 'Unsafe', object: 'contact' }])).toThrow(/safe property key/);
    }
    for (const definition of [{ ...fields[0], label: '' }, { ...fields[0], label: 'x'.repeat(121) }, { ...fields[0], object: 'deal' }]) {
      expect(() => validateCustomFields([definition])).toThrow();
    }
    expect(() => validateCustomFields(Array.from({ length: 51 }, (_, index) => ({ ...fields[0], key: `field${index}` })))).toThrow(/50/);
    expect(() => validateCustomFields([fields[0], fields[0]])).toThrow(/unique/);
    expect(() => validateCustomFields([fields[0], { ...fields[0], key: 'Favorite__Ice_Cream' }])).toThrow(/unique/);
    expect(validateCustomFields([fields[0], { ...fields[0], object: 'company' }])).toHaveLength(2);
  });
});
