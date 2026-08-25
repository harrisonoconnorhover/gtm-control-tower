import type { CsvColumnMapping } from './csv-control-tower';
import type { ConnectorId, ConnectorReceipt } from './connector-contract';
import type { LiveContactState, RepairRun } from './live-control-tower';

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
  receipts: ConnectorReceipt[];
  mapping: CsvColumnMapping;
  fileName: string | null;
  sourceType: ConnectorId;
  destinationType: ConnectorId;
  sourceLabel?: string;
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
    receipts: [],
    mapping: {},
    fileName: null,
    sourceType: 'csv',
    destinationType: 'csv',
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
    receipts: Array.isArray(state.receipts) ? state.receipts as ConnectorReceipt[] : [],
    mapping: state.mapping && typeof state.mapping === 'object' ? state.mapping as CsvColumnMapping : {},
    fileName: typeof state.fileName === 'string' ? state.fileName : null,
    sourceType,
    destinationType,
    sourceLabel: typeof state.sourceLabel === 'string' ? state.sourceLabel : undefined,
  };
}
