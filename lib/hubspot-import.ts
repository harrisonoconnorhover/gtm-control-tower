import { csvFieldLabelsForObject, type CsvFieldKey } from './csv-control-tower';
import type { CustomFieldDefinition } from './import-fields';
import type { ImportObject, LiveContactState } from './live-control-tower';

export type HubSpotImportObject = 'contact' | 'company';
export type HubSpotImportProperty = { name: string; label: string; type: string; fieldType: string; options: { value: string; label: string; hidden: boolean }[]; readOnly: boolean; calculated: boolean; externalOptions: boolean; hidden: boolean };
export type HubSpotImportSchema = { portalId: string; fetchedAt: string; properties: { contact: HubSpotImportProperty[]; company: HubSpotImportProperty[] }; warnings: string[] };
export type HubSpotImportBinding = { portalId: string; fields: Partial<Record<CsvFieldKey, { object: HubSpotImportObject; propertyName: string }>> };
export type HubSpotImportRecord = { id: string; properties: Record<string, string | null> };
export type HubSpotImportLookup = { status: 'matched' | 'absent' | 'ambiguous' | 'unresolved'; records: HubSpotImportRecord[]; reason?: string };
export type HubSpotImportLookups = { contacts: Record<string, HubSpotImportLookup>; companies: Record<string, HubSpotImportLookup> };
export type HubSpotImportFieldReview = { field: string; propertyName: string; label: string; original: string; normalized: string; current: string | null; proposed: string | null; action: 'set' | 'unchanged' | 'preserve' | 'review'; reason: string };
export type HubSpotImportObjectReview = { key: string; object: HubSpotImportObject; sourceRowIds: string[]; nativeId: string | null; status: 'create' | 'update' | 'unchanged' | 'review' | 'skipped'; reasons: string[]; fields: HubSpotImportFieldReview[] };
export type HubSpotImportDryRun = { portalId: string; checkedAt: string; workspaceId: string; workspaceRevision: number; fingerprint: string; schemaFetchedAt: string; normalizedChanges: number; policy: 'fill-empty' | 'overwrite'; objects: HubSpotImportObjectReview[]; counts: Record<'contact' | 'company', Record<'create' | 'update' | 'unchanged' | 'review' | 'skipped', number>>; warnings: string[]; readOnly: true };

export function importFieldObject(field: string, object: ImportObject): HubSpotImportObject {
  return field.startsWith('associatedCompany') || field.startsWith('custom:company:') || object === 'company' ? 'company' : 'contact';
}

export function validateHubSpotImportBinding(value: unknown, object: ImportObject, customFields: CustomFieldDefinition[] = []): HubSpotImportBinding | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('HubSpot field binding is invalid.');
  const binding = value as HubSpotImportBinding;
  if (typeof binding.portalId !== 'string' || !/^\d{1,20}$/.test(binding.portalId) || !binding.fields || typeof binding.fields !== 'object' || Array.isArray(binding.fields)) throw new Error('HubSpot bindings require a verified portal and field mappings.');
  const labels = csvFieldLabelsForObject(object, customFields);
  const entries = Object.entries(binding.fields);
  const destinations = new Set<string>();
  if (entries.length > 100) throw new Error('Use at most 100 HubSpot field bindings.');
  for (const [field, target] of entries) {
    if (!Object.hasOwn(labels, field) || !target || !['contact', 'company'].includes(target.object)
      || target.object !== importFieldObject(field, object) || typeof target.propertyName !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,119}$/.test(target.propertyName)) throw new Error('HubSpot bindings must use valid properties on the matching contact or company object.');
    const key = `${target.object}:${target.propertyName}`;
    if (destinations.has(key)) throw new Error('Map each HubSpot property from only one local field.');
    if (target.propertyName === 'hs_object_id' && !['contactId', 'associatedCompanyId'].includes(field)) throw new Error('HubSpot record IDs can only be used as explicitly mapped lookup IDs.');
    if (['contactId', 'associatedCompanyId'].includes(field) && target.propertyName !== 'hs_object_id') throw new Error('Map record IDs only to HubSpot record IDs for lookup.');
    if (target.propertyName === 'email' && (target.object !== 'contact' || !['rawEmail', 'normalizedEmail'].includes(field))) throw new Error('Map the contact email identity to HubSpot Email.');
    if (['rawEmail', 'normalizedEmail'].includes(field) && target.propertyName !== 'email') throw new Error('Map the contact email identity to HubSpot Email.');
    destinations.add(key);
  }
  return { portalId: binding.portalId, fields: Object.fromEntries(entries.map(([field, target]) => [field, { object: target!.object, propertyName: target!.propertyName }])) };
}

/** Keep email and record IDs as lookup identity; other fields remain a preview-only projection. */
export function hubspotImportValue(row: LiveContactState, field: string): string {
  if (field.startsWith('custom:')) {
    const [, object, key] = field.split(':');
    return (object === 'company' && row.importObject === 'contact_company' ? row.associatedCompany?.customFields : row.customFields)?.[key] ?? '';
  }
  if (field.startsWith('associatedCompany')) {
    const part = field.slice('associatedCompany'.length);
    const key = part === 'Id' ? 'recordId' : `${part[0]?.toLowerCase()}${part.slice(1)}`;
    const value = (row.associatedCompany as unknown as Record<string, unknown> | undefined)?.[key];
    return typeof value === 'string' ? value : '';
  }
  const value = (row as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

export function suggestHubSpotBindings(schema: HubSpotImportSchema, object: ImportObject, customFields: CustomFieldDefinition[], rows: LiveContactState[]): HubSpotImportBinding {
  const standard: Record<string, string> = { rawEmail: 'email', firstName: 'firstname', lastName: 'lastname', company: object === 'company' ? 'name' : 'company', phone: 'phone', jobTitle: 'jobtitle', website: 'website', country: 'country', state: 'state', address: 'address', city: 'city', postalCode: 'zip', department: 'department', persona: 'hs_persona', associatedCompanyName: 'name', associatedCompanyWebsite: 'website', associatedCompanyPhone: 'phone', associatedCompanyCountry: 'country', associatedCompanyState: 'state', associatedCompanyAddress: 'address', associatedCompanyCity: 'city', associatedCompanyPostalCode: 'zip' };
  const fields: HubSpotImportBinding['fields'] = {};
  for (const field of Object.keys(csvFieldLabelsForObject(object, customFields)) as CsvFieldKey[]) {
    if (!rows.some((row) => hubspotImportValue(row, field).trim())) continue;
    const scope = importFieldObject(field, object);
    const name = field.startsWith('custom:') ? field.split(':')[2] : standard[field];
    if (name && schema.properties[scope].some((property) => property.name === name && !property.readOnly && !property.calculated)) fields[field] = { object: scope, propertyName: name };
  }
  return { portalId: schema.portalId, fields };
}
