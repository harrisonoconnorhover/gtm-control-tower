export const connectorIds = ['csv', 'google-sheets', 'hubspot', 'salesforce', 'bigquery'] as const;
export type ConnectorId = (typeof connectorIds)[number];
export type ConnectorDirection = 'source' | 'destination';
export type ConnectorPhase = 'preview' | 'validate' | 'execute' | 'receipt' | 'undo' | 'export';
export type ConnectorStatus = 'ready' | 'blocked' | 'executed' | 'partial' | 'failed' | 'undone';

export type ConnectorCapability = {
  id: ConnectorId;
  label: string;
  configured: boolean;
  directions: ConnectorDirection[];
  phases: ConnectorPhase[];
  setupHint?: string;
  mode?: 'built-in' | 'direct' | 'n8n' | 'hybrid';
  features?: Array<'preview' | 'write' | 'safe-writeback' | 'rollback' | 'account-scan'>;
};

export type ConnectorHealth = {
  connectorId: Extract<ConnectorId, 'hubspot' | 'salesforce'>;
  action: 'read' | 'write';
  status: 'ready' | 'needs_action' | 'failed';
  message: string;
  checkedAt: string;
  nativeReceiptId?: string;
};

export type ConnectorReceipt = {
  id: string;
  connectorId: ConnectorId;
  phase: ConnectorPhase;
  status: ConnectorStatus;
  summary: string;
  recordsRead?: number;
  recordsWritten?: number;
  recordsFailed?: number;
  createdAt: string;
  undoAvailable: boolean;
  nativeReceiptId?: string;
};

export type ConnectorCatalog = {
  persistenceEnabled: boolean;
  accessKeyRequired: boolean;
  connectors: ConnectorCapability[];
};

export const connectorPhases: ConnectorPhase[] = ['preview', 'validate', 'execute', 'receipt', 'undo', 'export'];
export const connectorStatuses: ConnectorStatus[] = ['ready', 'blocked', 'executed', 'partial', 'failed', 'undone'];

export function isConnectorReceipt(value: unknown): value is ConnectorReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<ConnectorReceipt>;
  return typeof receipt.id === 'string'
    && connectorIds.includes(receipt.connectorId as ConnectorId)
    && connectorPhases.includes(receipt.phase as ConnectorPhase)
    && connectorStatuses.includes(receipt.status as ConnectorStatus)
    && typeof receipt.summary === 'string'
    && typeof receipt.createdAt === 'string'
    && typeof receipt.undoAvailable === 'boolean';
}
