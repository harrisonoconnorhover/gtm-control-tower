import type { ConnectorId, ConnectorReceipt, ConnectorStatus } from './connector-contract';
import type { CrmRollbackPlan, CrmWritePlan, CrmWritebackReceipt } from './crm-workflow';

export type ConnectorRunDetails = {
  sourceLabel?: string;
  inputCount?: number;
  activeCount?: number;
  heldCount?: number;
  repairCounts?: { merged: number; rerouted: number; replayed: number };
  plan?: CrmWritePlan;
  writeback?: CrmWritebackReceipt;
};

export type ConnectorRun = {
  id: string;
  workspaceId: string;
  connectorId: ConnectorId;
  phase: ConnectorReceipt['phase'];
  status: ConnectorStatus;
  receipt: ConnectorReceipt;
  details: ConnectorRunDetails | null;
  undo: CrmRollbackPlan | null;
  createdAt: string;
};

export type ConnectorRunInput = {
  receipt: ConnectorReceipt;
  details?: ConnectorRunDetails | null;
  undo?: CrmRollbackPlan | null;
};

export function isConnectorRunInput(value: unknown): value is ConnectorRunInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Partial<ConnectorRunInput>;
  return Boolean(input.receipt && typeof input.receipt.id === 'string');
}
