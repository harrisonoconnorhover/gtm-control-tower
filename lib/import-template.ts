import { csvFieldLabelsForObject, suggestCsvMapping, type CsvColumnMapping, type CsvFieldKey } from './csv-control-tower';
import { customFieldKey, validateCustomFields, type CustomFieldDefinition } from './import-fields';
import { validateNormalizationSettings, type NormalizationSettings } from './import-normalization';
import type { ImportObject } from './live-control-tower';
import { validateHubSpotImportBinding, type HubSpotImportBinding } from './hubspot-import';

export type ImportTemplate = {
  id: string;
  name: string;
  importObject: ImportObject;
  mapping: CsvColumnMapping;
  customFields: CustomFieldDefinition[];
  normalization: NormalizationSettings;
  hubspotBinding?: HubSpotImportBinding;
  createdAt: string;
  updatedAt: string;
};

export function validateImportTemplate(value: unknown): Omit<ImportTemplate, 'id' | 'createdAt' | 'updatedAt'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('An import template is required.');
  const input = value as Record<string, unknown>;
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('Use a template name of 1–120 characters.');
  if (!['contact', 'company', 'contact_company'].includes(String(input.importObject))) throw new Error('Choose an import object for the template.');
  const importObject = input.importObject as ImportObject;
  const customFields = validateCustomFields(input.customFields ?? []);
  if (customFields.some((field) => importObject !== 'contact_company' && field.object !== importObject)) throw new Error('Custom fields must belong to the selected import object.');
  const labels = csvFieldLabelsForObject(importObject, customFields);
  if (!input.mapping || typeof input.mapping !== 'object' || Array.isArray(input.mapping)) throw new Error('A template needs a column mapping.');
  const entries = Object.entries(input.mapping);
  if (entries.length > 120 || entries.some(([key, source]) => !Object.hasOwn(labels, key) || typeof source !== 'string' || source.length > 300)) throw new Error('The template includes an unsupported field or source header.');
  const mapped = entries.filter(([, source]) => source);
  if (!mapped.length) throw new Error('Map at least one source column before saving a template.');
  if (new Set(mapped.map(([, source]) => headerKey(source as string))).size !== mapped.length) throw new Error('Each source column can map to only one destination.');
  const hubspotBinding = validateHubSpotImportBinding(input.hubspotBinding, importObject, customFields);
  return { name: input.name.trim(), importObject, customFields, mapping: Object.fromEntries(entries), normalization: validateNormalizationSettings(input.normalization), ...(hubspotBinding ? { hubspotBinding } : {}) };
}

const headerKey = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Saved mappings are header aliases, scoped to the object. Disagreements never pick the latest template. */
export function resolveImportTemplates(headers: string[], object: ImportObject, templates: ImportTemplate[], existingFields: CustomFieldDefinition[] = []) {
  const applicable = templates.filter((template) => template.importObject === object);
  const matching = applicable.filter((template) => Object.values(template.mapping).some((source) => source && headers.some((header) => headerKey(header) === headerKey(source))));
  const definitions = new Map(existingFields.filter((field) => object === 'contact_company' || field.object === object).map((field) => [customFieldKey(field), field]));
  const conflicts: string[] = [];
  const incompatibleDefinitions = new Set<string>();
  for (const template of matching) for (const field of template.customFields) {
    const key = customFieldKey(field);
    const previous = definitions.get(key);
    if (previous && previous.label !== field.label) {
      incompatibleDefinitions.add(key);
      conflicts.push(`Custom field ${key} has different labels in saved templates. Select a template to choose its definition.`);
    } else definitions.set(key, field);
  }
  const mergedFields = [...definitions.entries()].filter(([key]) => !incompatibleDefinitions.has(key)).map(([, field]) => field);
  if (mergedFields.length > 50) conflicts.push('Matching templates contain more than 50 custom fields. Choose one template before importing.');
  let customFields: CustomFieldDefinition[];
  try { customFields = validateCustomFields(mergedFields.slice(0, 50)); }
  catch { customFields = existingFields; conflicts.push('Matching templates contain conflicting custom property keys. Choose one template before importing.'); }
  const labels = csvFieldLabelsForObject(object, customFields);
  const mapping = Object.fromEntries(Object.keys(labels).map((field) => [field, ''])) as CsvColumnMapping;
  const provenance: Record<string, { templateId: string; templateName: string }> = {};
  const guesses = suggestCsvMapping(headers, object, customFields);
  const candidates: Array<{ field: CsvFieldKey; header: string; template?: ImportTemplate }> = [];
  for (const header of headers) {
    const saved = matching.flatMap((template) => Object.entries(template.mapping)
      .filter(([, source]) => source && headerKey(source) === headerKey(header))
      .map(([field]) => ({ field: field as CsvFieldKey, header, template })));
    const fields = new Set(saved.map((candidate) => candidate.field));
    if (fields.size > 1 || saved.some((candidate) => incompatibleDefinitions.has(candidate.field))) {
      conflicts.push(`“${header}” has conflicting saved destinations. Choose its field manually.`);
      continue;
    }
    if (saved.length) candidates.push(saved[0]);
    else for (const [field, source] of Object.entries(guesses)) if (source === header) candidates.push({ field: field as CsvFieldKey, header });
  }
  for (const field of Object.keys(labels) as CsvFieldKey[]) {
    if (matching.length === 1 && matching[0].mapping[field] === '') continue;
    const choices = candidates.filter((candidate) => candidate.field === field);
    const savedChoices = choices.filter((candidate) => candidate.template);
    const preferred = savedChoices.length ? savedChoices : choices;
    if (preferred.length > 1) { conflicts.push(`More than one source column matches ${labels[field]}. Choose one manually.`); continue; }
    const choice = preferred[0];
    if (!choice) continue;
    mapping[field] = choice.header;
    if (choice.template) provenance[field] = { templateId: choice.template.id, templateName: choice.template.name };
  }
  for (const header of headers) {
    const fields = Object.entries(mapping).filter(([, source]) => source === header).map(([field]) => field as CsvFieldKey);
    if (fields.length < 2) continue;
    for (const field of fields) { mapping[field] = ''; delete provenance[field]; }
    conflicts.push(`“${header}” matches more than one destination. Choose its field manually.`);
  }
  // Rules must not come from a template whose mapping was only partly or ambiguously selected.
  const contributing = matching.filter((template) => Object.entries(template.mapping).some(([field, source]) => source && mapping[field as CsvFieldKey] && headerKey(source) === headerKey(mapping[field as CsvFieldKey]!)));
  if (contributing.length > 1) conflicts.push('Multiple templates match this file. Column aliases are shown; choose one template to reuse its normalization rules.');
  return { mapping, customFields, provenance, conflicts: [...new Set(conflicts)], template: contributing.length === 1 && !conflicts.length ? contributing[0] : undefined };
}
