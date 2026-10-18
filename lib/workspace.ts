import type { CsvColumnMapping, CsvContactCorrection } from './csv-control-tower';
import type { ConnectorId, ConnectorReceipt } from './connector-contract';
import type { ImportObject, LiveContactState, RepairRun } from './live-control-tower';
import { defaultCrmUpdatePolicy, isSafeContactUpdatePolicy, normalizeCrmUpdatePolicy, normalizeImportRecordMode, type CrmUpdatePolicy, type ImportRecordMode, type ImportRecipe } from './crm-workflow';
import { validImportMatchDecisions } from './import-match-decision';
import { validPomadeOrigins } from './pomade-handoff';
import { isImportExclusion } from './import-exclusions';
import { validateCrmCohortWorkspace, type CrmCohortWorkspace } from './crm-cohort-review';
import { validateCustomFields, type CustomFieldDefinition } from './import-fields';
import { validateNormalizationSettings, type NormalizationSettings } from './import-normalization';
import { validateHubSpotImportBinding, type HubSpotImportBinding } from './hubspot-import';

export const MAX_PERSISTED_CONTACTS = 5_000;
export const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024;

export type MappingPreset = {
  id: string;
  name: string;
  mapping: CsvColumnMapping;
  importObject?: ImportObject;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceState = {
  importObject?: ImportObject;
  customFields?: CustomFieldDefinition[];
  normalizationSettings?: NormalizationSettings;
  hubspotBinding?: HubSpotImportBinding;
  contacts: LiveContactState[];
  originalContacts: LiveContactState[];
  repairHistory: RepairRun[];
  correctionHistory: CsvContactCorrection[];
  receipts: ConnectorReceipt[];
  mapping: CsvColumnMapping;
  fileName: string | null;
  sourceType: ConnectorId;
  destinationType: ConnectorId;
  sourceLabel?: string;
  crmUpdatePolicy?: CrmUpdatePolicy;
  importRecordMode?: ImportRecordMode;
  importRecipe?: ImportRecipe;
  sourceFileHash?: string;
  crmCohort?: CrmCohortWorkspace;
};

export type SavedWorkspace = {
  id: string;
  name: string;
  revision: number;
  state: WorkspaceState;
  presets: MappingPreset[];
  createdAt: string;
  updatedAt: string;
};

export function emptyWorkspaceState(): WorkspaceState {
  return {
    importObject: 'contact',
    contacts: [],
    originalContacts: [],
    repairHistory: [],
    correctionHistory: [],
    receipts: [],
    mapping: {},
    fileName: null,
    sourceType: 'csv',
    destinationType: 'csv',
    crmUpdatePolicy: defaultCrmUpdatePolicy(),
    importRecordMode: 'create-and-update',
  };
}

export function validateWorkspaceState(value: unknown): WorkspaceState {
  if (!value || typeof value !== 'object') throw new Error('Workspace state is required.');
  const state = value as Partial<WorkspaceState>;
  const importObject = state.importObject ?? 'contact';
  if (!['contact', 'company', 'contact_company'].includes(importObject)) throw new Error('Unsupported import object. Choose contacts, companies, or contacts with associated companies.');
  const customFields = validateCustomFields(state.customFields ?? []);
  if (customFields.some((field) => importObject !== 'contact_company' && field.object !== importObject)) throw new Error('Custom fields must belong to the workspace import object.');
  const normalizationSettings = state.normalizationSettings === undefined ? undefined : validateNormalizationSettings(state.normalizationSettings);
  const hubspotBinding = validateHubSpotImportBinding(state.hubspotBinding, importObject, customFields);
  if (!Array.isArray(state.contacts) || !Array.isArray(state.originalContacts)) {
    throw new Error('Workspace contacts are invalid.');
  }
  if (state.contacts.length > MAX_PERSISTED_CONTACTS || state.originalContacts.length > MAX_PERSISTED_CONTACTS) {
    throw new Error(`A saved workspace can contain at most ${MAX_PERSISTED_CONTACTS.toLocaleString()} contacts.`);
  }
  for (const row of [...state.contacts, ...state.originalContacts]) {
    if (!row || typeof row !== 'object' || (row.importObject ?? 'contact') !== importObject) {
      throw new Error('Every row must use the workspace import object. Reload the source to change objects.');
    }
    validateOptionalImportFields(row, customFields.filter((field) => field.object === (importObject === 'company' ? 'company' : 'contact')));
    if (importObject === 'contact_company') {
      const company = row.associatedCompany;
      if (!company || typeof company !== 'object'
        || (company.recordId !== null && (typeof company.recordId !== 'string' || company.recordId.length > 300))
        || typeof company.name !== 'string' || company.name.length > 1_000
        || typeof company.website !== 'string' || company.website.length > 2_048
        || typeof company.phone !== 'string' || company.phone.length > 200
        || typeof company.state !== 'string' || company.state.length > 300) {
        throw new Error('Associated company fields are invalid or exceed their supported lengths.');
      }
      validateOptionalImportFields(company, customFields.filter((field) => field.object === 'company'));
    } else if (row.associatedCompany !== undefined) {
      throw new Error('Associated company fields require the contacts with associated companies import object.');
    }
    if (importObject === 'company' && (row.rawEmail !== '' || row.normalizedEmail !== null || row.firstName || row.lastName || row.jobTitle)) {
      throw new Error('Company rows cannot contain person names, email addresses or job titles.');
    }
    if (row && typeof row === 'object' && !validPomadeOrigins(row.sourceOrigins)) {
      throw new Error('Pomade source context is invalid or exceeds its bounded updates-only format.');
    }
    if (row && typeof row === 'object' && !validImportMatchDecisions(row.crmMatchDecisions)) {
      throw new Error('Confirmed CRM matches require a valid saved decision.');
    }
    if (row && typeof row === 'object' && 'importExclusion' in row && row.importExclusion !== undefined
      && (!isImportExclusion(row.importExclusion) || row.recordStatus !== 'active')) {
      throw new Error('Skipped import rows require an active row, a reason and a valid timestamp.');
    }
  }
  const sourceType = state.sourceType ?? 'csv';
  const destinationType = state.destinationType ?? 'csv';
  if (importObject !== 'contact' && (sourceType !== 'csv' || destinationType !== 'csv' || state.importRecipe !== undefined || state.crmCohort !== undefined)) {
    throw new Error('Company and associated-company imports support local CSV review and export only.');
  }
  const importRecordMode = normalizeImportRecordMode(state.importRecordMode);
  const crmUpdatePolicy = normalizeCrmUpdatePolicy(state.crmUpdatePolicy);
  if (state.importRecipe !== undefined && state.importRecipe !== 'safe-update-contacts') throw new Error('Unsupported import recipe.');
  if (state.importRecipe === 'safe-update-contacts'
    && (importRecordMode !== 'update-existing' || !isSafeContactUpdatePolicy(crmUpdatePolicy) || !['hubspot', 'salesforce'].includes(destinationType))) {
    throw new Error('Safe Import requires HubSpot or Salesforce, update-existing mode, and the protected fill-empty policy with no blank clearing.');
  }
  if (state.sourceFileHash !== undefined && (typeof state.sourceFileHash !== 'string' || !/^[a-f0-9]{64}$/u.test(state.sourceFileHash))) {
    throw new Error('Source file hash must be a SHA-256 digest.');
  }
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_WORKSPACE_BYTES) {
    throw new Error('This workspace is too large to save. Export the repaired CSV and start a smaller workspace.');
  }
  return {
    importObject,
    ...(state.customFields !== undefined ? { customFields } : {}),
    ...(normalizationSettings ? { normalizationSettings } : {}),
    ...(hubspotBinding ? { hubspotBinding } : {}),
    contacts: state.contacts.map((row) => withoutDerivedSuppressions({ ...row, importObject })),
    originalContacts: state.originalContacts.map((row) => withoutDerivedSuppressions({ ...row, importObject })),
    repairHistory: Array.isArray(state.repairHistory) ? state.repairHistory as RepairRun[] : [],
    correctionHistory: Array.isArray(state.correctionHistory) ? state.correctionHistory as CsvContactCorrection[] : [],
    receipts: Array.isArray(state.receipts) ? state.receipts as ConnectorReceipt[] : [],
    mapping: state.mapping && typeof state.mapping === 'object' ? state.mapping as CsvColumnMapping : {},
    fileName: typeof state.fileName === 'string' ? state.fileName : null,
    sourceType,
    destinationType,
    sourceLabel: typeof state.sourceLabel === 'string' ? state.sourceLabel : undefined,
    crmUpdatePolicy,
    importRecordMode,
    ...(state.importRecipe ? { importRecipe: state.importRecipe } : {}),
    ...(state.sourceFileHash ? { sourceFileHash: state.sourceFileHash } : {}),
    ...(state.crmCohort ? { crmCohort: validateCrmCohortWorkspace(state.crmCohort) } : {}),
  };
}

function validateOptionalImportFields(row: object, definitions: CustomFieldDefinition[]) {
  const fields = row as Record<string, unknown>;
  for (const key of ['country', 'address', 'city', 'postalCode', 'department', 'persona']) {
    const value = fields[key];
    if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 2_000)) throw new Error(`Import field ${key} must be text of at most 2,000 characters.`);
  }
  if (fields.customFields === undefined) return;
  if (!fields.customFields || typeof fields.customFields !== 'object' || Array.isArray(fields.customFields)) throw new Error('Custom field values must be an object.');
  const keys = new Set(definitions.map((field) => field.key));
  if (Object.entries(fields.customFields).some(([key, value]) => !keys.has(key) || typeof value !== 'string' || value.length > 10_000)) throw new Error('Custom field values require a matching definition and at most 10,000 characters.');
}

// Matches are derived from the current saved rules; client snapshots cannot override them.
function withoutDerivedSuppressions(row: LiveContactState): LiveContactState {
  const clean = { ...row };
  delete clean.suppressionMatches;
  return clean;
}
