export type CustomFieldDefinition = {
  /** The destination CRM property's internal name, retained separately from its label. */
  key: string;
  label: string;
  object: 'contact' | 'company';
};

export type CustomFieldKey = `custom:${CustomFieldDefinition['object']}:${string}`;

export function customFieldKey(field: CustomFieldDefinition): CustomFieldKey {
  return `custom:${field.object}:${field.key}`;
}

export function validateCustomFields(value: unknown): CustomFieldDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new Error('Use at most 50 custom fields per import template.');
  const seen = new Set<string>();
  return value.map((field) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)
      || typeof field.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(field.key)
      || ['__proto__', 'constructor', 'prototype'].includes(field.key.toLowerCase())
      || typeof field.label !== 'string' || !field.label.trim() || field.label.trim().length > 120
      || !['contact', 'company'].includes(field.object)) {
      throw new Error('Custom fields need a contact or company object, a label of 1–120 characters, and a safe property key of 1–80 letters, numbers or underscores starting with a letter.');
    }
    const definition: CustomFieldDefinition = { key: field.key, label: field.label.trim(), object: field.object };
    // These keys would collapse into one exported CSV header after normalization.
    const identity = customFieldKey(definition).toLowerCase().replace(/_+/g, '_');
    if (seen.has(identity)) throw new Error('Custom property keys must be unique within each object.');
    seen.add(identity);
    return definition;
  });
}
