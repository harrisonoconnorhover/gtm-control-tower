import { csvFieldLabelsForObject, destinationHoldFlags, type CsvFieldKey } from './csv-control-tower';
import { companyHostname } from './company-associations';
import type { CustomFieldDefinition } from './import-fields';
import {
  hubspotImportValue, importFieldObject,
  type HubSpotImportBinding, type HubSpotImportDryRun, type HubSpotImportFieldReview,
  type HubSpotImportLookup, type HubSpotImportLookups, type HubSpotImportObject,
  type HubSpotImportObjectReview, type HubSpotImportProperty, type HubSpotImportRecord, type HubSpotImportSchema,
} from './hubspot-import';
import type { LiveContactState } from './live-control-tower';
import { isSuppressed } from './suppression';

type DryRunInput = {
  workspaceId: string;
  workspaceRevision: number;
  fingerprint: string;
  originalContacts: LiveContactState[];
  contacts: LiveContactState[];
  customFields: CustomFieldDefinition[];
  binding: HubSpotImportBinding;
  schema: HubSpotImportSchema;
  lookups: HubSpotImportLookups;
  normalizedChanges: number;
  policy?: 'fill-empty' | 'overwrite';
  now?: Date;
};
type Group = { key: string; object: HubSpotImportObject; rows: LiveContactState[] };
const metadataFields = new Set(['contactId', 'normalizedEmail', 'canonicalContactId', 'recordStatus', 'lastAction',
  'qualityFlags', 'importExclusionReason', 'importExcludedAt', 'expectedLifecycleStage', 'associatedCompanyId']);

/** Advisory projection only: this result cannot be submitted to either CRM writer. */
export function buildHubSpotImportDryRun(input: DryRunInput): HubSpotImportDryRun {
  const policy = input.policy ?? 'fill-empty';
  const originals = new Map(input.originalContacts.map((row) => [row.contactId, row]));
  const groups = new Map<string, Group>();
  for (const row of input.contacts) {
    if (row.importObject !== 'company') addGroup(`contact:${row.contactId}`, 'contact', row);
    if (row.importObject === 'company' || row.importObject === 'contact_company') {
      // Excluded rows must not contribute values or lookup failures to an active company proposal.
      const identity = companyIdentity(row, input.binding);
      addGroup(skippedReason(row) ? `company:skipped:${row.contactId}` : `company:${identity || `unresolved:${row.contactId}`}`, 'company', row);
    }
  }
  function addGroup(key: string, object: HubSpotImportObject, row: LiveContactState) {
    const group = groups.get(key) ?? { key, object, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  const objects = [...groups.values()].map((group): HubSpotImportObjectReview => {
    const result: HubSpotImportObjectReview = { key: group.key, object: group.object,
      sourceRowIds: group.rows.map((row) => row.contactId), nativeId: null, status: 'review', reasons: [], fields: [] };
    const reasons = result.reasons;
    const skipped = group.rows.map(skippedReason).filter((reason): reason is string => Boolean(reason));
    if (skipped.length === group.rows.length) return { ...result, status: 'skipped', reasons: unique(skipped) };
    if (input.binding.portalId !== input.schema.portalId) reasons.push('The saved template belongs to a different HubSpot portal. Reconnect its field mappings.');
    const lookup = groupLookup(group, input.lookups);
    const record = lookup.status === 'matched' && lookup.records.length === 1 ? lookup.records[0] : null;
    result.nativeId = record?.id ?? null;
    if (lookup.status === 'unresolved' || lookup.status === 'ambiguous') reasons.push(lookup.reason || 'HubSpot identity is unresolved; this is not evidence of a new record.');
    if (lookup.status === 'absent' && group.rows.some((row) => declaredNativeId(row, group.object, input.binding))) {
      reasons.push(`The supplied HubSpot ${group.object} record ID was not found. Review the missing record; it must not become a new-record proposal.`);
    }
    if (group.object === 'contact') {
      if (group.rows.length > 1) reasons.push('More than one import row uses this source row ID. Assign unique row IDs before reviewing CRM identities.');
      for (const row of group.rows) {
        const email = row.normalizedEmail || row.rawEmail;
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email.trim())) reasons.push('A valid contact email is required to review this identity.');
        for (const flag of destinationHoldFlags(row)) reasons.push(`Existing import hold: ${flag.replaceAll('_', ' ')}.`);
      }
    } else if (group.rows.some((row) => !companyIdentity(row, input.binding))) {
      reasons.push('A company needs a supplied record ID or valid website hostname. A name alone cannot establish company identity.');
    }

    const row = group.rows[0];
    const importObject = row.importObject ?? 'contact';
    const labels = csvFieldLabelsForObject(importObject, input.customFields);
    const mappedFields = Object.entries(input.binding.fields).filter(([, target]) => target?.object === group.object);
    for (const [field, target] of mappedFields) {
      if (!target) continue;
      const property = input.schema.properties[group.object].find((entry) => entry.name === target.propertyName);
      const values = unique(group.rows.map((item) => hubspotImportValue(item, field)));
      const original = unique(group.rows.map((item) => hubspotImportValue(originals.get(item.contactId) ?? item, field))).join(' | ');
      const normalized = values.join(' | ');
      const current = property?.name === 'hs_object_id' ? record?.id ?? null : record?.properties[target.propertyName] ?? null;
      const review: HubSpotImportFieldReview = { field, propertyName: target.propertyName,
        label: property?.label ?? labels[field as CsvFieldKey] ?? target.propertyName,
        original, normalized, current, proposed: current, action: 'review', reason: '' };
      const invalid = (reason: string) => { review.reason = reason; reasons.push(`${review.label}: ${reason}`); };
      if (!Object.hasOwn(labels, field) || importFieldObject(field, importObject) !== group.object) invalid('This local field does not belong to the selected object.');
      else if ((field === 'rawEmail' || field === 'normalizedEmail') && target.propertyName !== 'email') invalid('The contact email must map to HubSpot email so it remains an identity field.');
      else if ((field === 'contactId' || field === 'associatedCompanyId') && target.propertyName !== 'hs_object_id') invalid('A record ID may only map to the HubSpot record ID for identity lookup.');
      else if (!property) invalid('This property no longer exists in the connected HubSpot schema.');
      else if (values.length !== 1) invalid('Rows grouped as one company supply conflicting values. Choose a value before importing; none was selected.');
      else if (record && property.name !== 'hs_object_id' && !Object.hasOwn(record.properties, property.name)) invalid('The current HubSpot value was not returned. It cannot be treated as empty.');
      else if (property.name === 'hs_object_id' || field === 'contactId' || field === 'associatedCompanyId') {
        review.action = 'preserve';
        review.reason = 'Record IDs identify lookup targets only; they are never assigned or overwritten.';
      } else if (record && (property.name === 'email' || field === 'rawEmail' || field === 'normalizedEmail')) {
        review.action = 'preserve';
        review.reason = 'The email identifies an existing contact; its primary email is preserved, including matches through an additional email.';
      } else if (!normalized.trim()) {
        review.action = current ? 'preserve' : 'unchanged';
        review.reason = 'Blank imported values never clear HubSpot data.';
      } else if (property.readOnly || property.calculated) invalid('This HubSpot property is read-only or calculated.');
      else if (property.hidden) invalid('This HubSpot property is hidden. Review the destination before importing.');
      else if (property.externalOptions) invalid('This property uses external options that are not available in the saved picklist. Review its allowed values separately.');
      else {
        const value = propertyValue(property, normalized);
        if (value.error) invalid(value.error);
        else if (record && sameValue(property, current ?? '', value.value!)) {
          review.action = 'unchanged';
          review.reason = value.reason || 'The normalized value already matches HubSpot.';
        } else if (record && current?.trim() && policy === 'fill-empty') {
          review.action = 'preserve';
          review.reason = 'Fill-empty policy preserves the existing HubSpot value.';
        } else {
          review.action = 'set';
          review.proposed = value.value!;
          review.reason = [record ? current?.trim() ? 'Overwrite policy proposes replacing the existing value.' : 'Fill the empty HubSpot property.' : 'Proposed value for a new record.', value.reason].filter(Boolean).join(' ');
        }
      }
      result.fields.push(review);
    }
    for (const [field, label] of Object.entries(labels)) {
      if (metadataFields.has(field) || importFieldObject(field, importObject) !== group.object || input.binding.fields[field as CsvFieldKey]) continue;
      if (field === 'fullName' && (importObject === 'company' || (input.binding.fields.firstName && input.binding.fields.lastName))) continue;
      const populated = group.rows.some((item) => {
        const value = hubspotImportValue(item, field).trim();
        return Boolean(value) && !(['region', 'segment'].includes(field) && value === 'Unassigned')
          && !(field === 'lifecycleStage' && value === 'lead');
      });
      if (populated) reasons.push(`${label}: populated import field has no HubSpot mapping and would be omitted.`);
    }
    if (!mappedFields.length) reasons.push(`No ${group.object} properties are mapped for this preview.`);
    if (group.object === 'company' && record) {
      const importedNames = unique(group.rows.map((item) => (item.importObject === 'company' ? item.company : item.associatedCompany?.name)?.trim()).filter((value): value is string => Boolean(value)));
      const existingName = record.properties.name;
      if (existingName && importedNames.some((name) => foldedName(name) !== foldedName(existingName))) reasons.push('The matched company has a different name. A shared hostname alone does not confirm the intended company; review its identity.');
    }
    result.reasons = unique(reasons);
    result.status = reasons.length ? 'review' : lookup.status === 'absent' ? 'create' : result.fields.some((field) => field.action === 'set') ? 'update' : 'unchanged';
    return result;
  });

  // Distinct inputs must not independently propose changes to one person or native company.
  const contactsById = new Map(input.contacts.map((row) => [row.contactId, row]));
  const targets = new Map<string, HubSpotImportObjectReview[]>();
  for (const object of objects.filter((item) => item.status !== 'skipped')) {
    const identities = object.nativeId ? [`${object.object}:native:${object.nativeId}`] : [];
    if (object.object === 'contact') for (const id of object.sourceRowIds) {
      const row = contactsById.get(id)!;
      const email = (row.normalizedEmail || row.rawEmail).trim().toLowerCase();
      if (email) identities.push(`contact:email:${email}`);
    }
    for (const identity of new Set(identities)) targets.set(identity, [...(targets.get(identity) ?? []), object]);
  }
  for (const [identity, matches] of targets) {
    if (matches.length < 2) continue;
    for (const object of matches) {
      object.status = 'review';
      object.reasons.push(identity.includes(':email:') ? 'More than one import row uses this contact email. Review duplicates before importing.' : 'Separate import proposals resolve to the same HubSpot record. Review them together before importing.');
    }
  }
  for (const object of objects) object.reasons = unique(object.reasons);
  const emptyCounts = () => ({ create: 0, update: 0, unchanged: 0, review: 0, skipped: 0 });
  const counts = { contact: emptyCounts(), company: emptyCounts() };
  for (const object of objects) counts[object.object][object.status] += 1;
  return { portalId: input.schema.portalId, checkedAt: (input.now ?? new Date()).toISOString(), workspaceId: input.workspaceId,
    workspaceRevision: input.workspaceRevision, fingerprint: input.fingerprint, schemaFetchedAt: input.schema.fetchedAt,
    normalizedChanges: input.normalizedChanges, policy, objects, counts, readOnly: true,
    warnings: unique([...input.schema.warnings, 'This dry run is advisory. It does not enable CRM writes or confirm import readiness.',
      ...(input.contacts.some((row) => row.importObject === 'contact_company') ? ['Contact–company associations are proposed for review only; no association operations are planned or executed.'] : [])]) };
}

function skippedReason(row: LiveContactState): string | null {
  if (isSuppressed(row)) return 'Suppressed rows are excluded from this import preview.';
  if (row.importExclusion) return `Excluded from import: ${row.importExclusion.reason}`;
  if (row.recordStatus === 'merged') return 'Merged rows are excluded from import.';
  return null;
}
function declaredNativeId(row: LiveContactState, object: HubSpotImportObject, binding: HubSpotImportBinding): string {
  if (object === 'company' && row.importObject === 'contact_company') return row.associatedCompany?.recordId?.trim() ?? '';
  return binding.fields.contactId?.object === object && binding.fields.contactId.propertyName === 'hs_object_id' ? row.contactId.trim() : '';
}
function companyIdentity(row: LiveContactState, binding: HubSpotImportBinding): string {
  const id = declaredNativeId(row, 'company', binding);
  const domain = companyHostname(row.importObject === 'contact_company' ? row.associatedCompany?.website ?? '' : row.website ?? '');
  return id ? `id:${id}` : domain ? `domain:${domain}` : '';
}
function groupLookup(group: Group, lookups: HubSpotImportLookups): HubSpotImportLookup {
  const values = group.rows.map((row) => (group.object === 'contact' ? lookups.contacts : lookups.companies)[row.contactId]);
  if (values.some((lookup) => !lookup || lookup.status === 'unresolved' || lookup.status === 'ambiguous')) return {
    status: 'unresolved', records: [], reason: unique(values.map((lookup) => lookup?.reason || (!lookup ? 'The HubSpot lookup is missing.' : lookup.status === 'ambiguous' ? 'Multiple HubSpot records match this identity.' : '')).filter(Boolean)).join(' ') || 'The HubSpot lookup could not establish identity.',
  };
  if (values.every((lookup) => lookup.status === 'absent' && lookup.records.length === 0)) return { status: 'absent', records: [] };
  const records = values.flatMap((lookup) => lookup.records);
  if (values.some((lookup) => lookup.status !== 'matched' || lookup.records.length !== 1) || new Set(records.map((record) => record.id)).size !== 1) return {
    status: 'unresolved', records: [], reason: 'Rows in this company proposal did not resolve to one consistent HubSpot identity.',
  };
  const first = records[0];
  if (records.some((record) => !sameProperties(first, record))) return { status: 'unresolved', records: [], reason: 'HubSpot returned inconsistent current values for the same record. Refresh the preview.' };
  return { status: 'matched', records: [first] };
}
function sameProperties(left: HubSpotImportRecord, right: HubSpotImportRecord): boolean {
  const keys = new Set([...Object.keys(left.properties), ...Object.keys(right.properties)]);
  return [...keys].every((key) => Object.hasOwn(left.properties, key) === Object.hasOwn(right.properties, key) && left.properties[key] === right.properties[key]);
}
function propertyValue(property: HubSpotImportProperty, value: string): { value?: string; reason?: string; error?: string } {
  if (property.type === 'enumeration') {
    const pieces = property.fieldType === 'checkbox' ? value.split(';').map((item) => item.trim()) : [value];
    if (pieces.some((piece) => !piece)) return { error: 'A multi-select value contains an empty choice. Review its semicolon-separated options.' };
    const result: string[] = [];
    for (const piece of pieces) {
      const exact = property.options.filter((option) => option.value === piece);
      if (exact.length) {
        if (exact.length !== 1 || exact[0].hidden) return { error: `“${piece}” is a hidden or ambiguous HubSpot option.` };
        result.push(exact[0].value);
        continue;
      }
      const matching = property.options.filter((option) => !option.hidden && option.label.trim().toLowerCase() === piece.trim().toLowerCase());
      if (matching.length !== 1) return { error: matching.length ? `“${piece}” matches more than one HubSpot option label.` : `“${piece}” is not an allowed HubSpot option.` };
      result.push(matching[0].value);
    }
    const normalized = unique(result).join(';');
    return { value: normalized, ...(normalized !== value ? { reason: 'Converted the displayed option label to its HubSpot internal value.' } : {}) };
  }
  if (property.type === 'string') return { value };
  if (property.type === 'number') return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value) && Number.isFinite(Number(value)) ? { value } : { error: 'Use a plain finite number without currency symbols, grouping separators or units.' };
  if (property.type === 'bool') return ['true', 'false'].includes(value) ? { value } : { error: 'This boolean property requires true or false.' };
  if (property.type === 'date') {
    const day = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
    const millis = /^\d{1,15}$/u.test(value) ? Number(value) : NaN;
    const validDay = day && Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
    return validDay || (Number.isSafeInteger(millis) && millis % 86_400_000 === 0 && Number.isFinite(new Date(millis).getTime())) ? { value } : { error: 'Use a valid YYYY-MM-DD date or a UTC-midnight timestamp in milliseconds.' };
  }
  if (property.type === 'datetime') {
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value);
    const stamp = /^\d{1,15}$/u.test(value) ? Number(value) : NaN;
    return (iso && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)) || (Number.isSafeInteger(stamp) && Number.isFinite(new Date(stamp).getTime()))
      ? { value } : { error: 'Use a valid UTC ISO timestamp or a timestamp in milliseconds.' };
  }
  return { error: `Property type “${property.type}” is not supported by this preview.` };
}
function sameValue(property: HubSpotImportProperty, left: string, right: string): boolean {
  if (property.type === 'enumeration' && property.fieldType === 'checkbox') return unique(left.split(';')).sort().join(';') === unique(right.split(';')).sort().join(';');
  return left === right;
}
function foldedName(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
