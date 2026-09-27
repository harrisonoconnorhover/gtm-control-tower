import type { CsvColumnMapping, CsvContactCorrection } from './csv-control-tower';
import type { ConnectorId, ConnectorReceipt } from './connector-contract';
import type { LiveContactState, RepairRun } from './live-control-tower';
import { defaultCrmUpdatePolicy, normalizeCrmUpdatePolicy, type CrmUpdatePolicy } from './crm-workflow';
import { isImportExclusion } from './import-exclusions';

export const MAX_PERSISTED_CONTACTS = 5_000;
export const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024;

export type MappingPreset = {
  id: string;
  name: string;
  mapping: CsvColumnMapping;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceState = {
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
  };
}

export function validateWorkspaceState(value: unknown): WorkspaceState {
  if (!value || typeof value !== 'object') throw new Error('Workspace state is required.');
  const state = value as Partial<WorkspaceState>;
  if (!Array.isArray(state.contacts) || !Array.isArray(state.originalContacts)) {
    throw new Error('Workspace contacts are invalid.');
  }
  if (state.contacts.length > MAX_PERSISTED_CONTACTS || state.originalContacts.length > MAX_PERSISTED_CONTACTS) {
    throw new Error(`A saved workspace can contain at most ${MAX_PERSISTED_CONTACTS.toLocaleString()} contacts.`);
  }
  for (const row of [...state.contacts, ...state.originalContacts]) {
    if (row && typeof row === 'object' && 'importExclusion' in row && row.importExclusion !== undefined
      && (!isImportExclusion(row.importExclusion) || row.recordStatus !== 'active')) {
      throw new Error('Skipped import rows require an active row, a reason and a valid timestamp.');
    }
  }
  const sourceType = state.sourceType ?? 'csv';
  const destinationType = state.destinationType ?? 'csv';
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_WORKSPACE_BYTES) {
    throw new Error('This workspace is too large to save. Export the repaired CSV and start a smaller workspace.');
  }
  return {
    contacts: state.contacts as LiveContactState[],
    originalContacts: state.originalContacts as LiveContactState[],
    repairHistory: Array.isArray(state.repairHistory) ? state.repairHistory as RepairRun[] : [],
    correctionHistory: Array.isArray(state.correctionHistory) ? state.correctionHistory as CsvContactCorrection[] : [],
    receipts: Array.isArray(state.receipts) ? state.receipts as ConnectorReceipt[] : [],
    mapping: state.mapping && typeof state.mapping === 'object' ? state.mapping as CsvColumnMapping : {},
    fileName: typeof state.fileName === 'string' ? state.fileName : null,
    sourceType,
    destinationType,
    sourceLabel: typeof state.sourceLabel === 'string' ? state.sourceLabel : undefined,
    crmUpdatePolicy: normalizeCrmUpdatePolicy(state.crmUpdatePolicy),
  };
}
