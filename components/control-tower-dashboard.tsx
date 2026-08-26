'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  demoRunSummary,
  demoStages,
  funnelForScenario,
  healthHeadline,
  nextScenario,
  scenarioMetrics,
  scenarios,
  type ScenarioKey,
} from '@/lib/control-tower';
import {
  countCsvRepairCandidates,
  executeCsvRepair,
  exportContactsCsv,
  importContactsCsv,
  type CsvColumnMapping,
} from '@/lib/csv-control-tower';
import { SelfHostConsole } from '@/components/self-host-console';
import type { ConnectorCatalog, ConnectorId, ConnectorReceipt } from '@/lib/connector-contract';
import {
  combineHubSpotSyncReceipts,
  isHubSpotEligible,
  isHubSpotSyncReceipt,
  toHubSpotSyncContact,
  type HubSpotSyncReceipt,
} from '@/lib/hubspot-sync';
import {
  combineSalesforceSyncReceipts,
  isSalesforceEligible,
  isSalesforceSyncReceipt,
  toSalesforceSyncLead,
  type SalesforceSyncReceipt,
} from '@/lib/salesforce-sync';
import {
  isLiveControlTowerState,
  isRepairReceipt,
  isSeedReceipt,
  type LiveControlTowerState,
  type LiveContactState,
  type RepairReceipt,
  type RepairRun,
  type SeedReceipt,
} from '@/lib/live-control-tower';
import type { MappingPreset, SavedWorkspace, WorkspaceState } from '@/lib/workspace';

const dbtTests = [
  ['unique_account_domain', '2 duplicates contained'],
  ['valid_lifecycle_progression', '1 regression rejected'],
  ['opportunity_has_owner', 'complete'],
  ['route_time_under_sla', '96.4% within SLA'],
  ['closed_won_has_amount', 'complete'],
];

const activity = [
  ['00:05.8', 'Control Tower', 'Duplicate cluster isolated; repair plan ready'],
  ['00:04.7', 'dbt', 'Trusted funnel rebuilt from accepted events'],
  ['00:03.5', 'BigQuery', 'Immutable raw and quality events appended'],
  ['00:02.2', 'n8n', 'Six qualified records scored and routed'],
  ['00:00.7', 'BigQuery', 'Ten-contact synthetic CRM state reset'],
];

const baselineIncidents = [
  { id: 'missing-company', title: 'Missing company identity', detail: 'One personal-email lead is held for review instead of contaminating account metrics.', severity: 'warning' },
  { id: 'lifecycle', title: 'Lifecycle regression blocked', detail: 'A Customer → MQL write was quarantined before it changed source-of-truth state.', severity: 'resolved' },
];

function metricsFromLiveState(state: LiveControlTowerState): ReturnType<typeof scenarioMetrics> {
  const leads = state.funnel.find((stage) => stage.label === 'Leads')?.count ?? 0;
  const won = state.funnel.find((stage) => stage.label === 'Won')?.count ?? 0;
  const wonRate = leads > 0 ? (won / leads) * 100 : 0;
  const routeWarning = state.metrics.medianRouteSeconds > 120;
  const qualityWarning = state.metrics.qualityRate < 95;
  return [
    {
      label: 'Warehouse events',
      value: state.metrics.totalEvents.toLocaleString(),
      detail: 'accepted in the last 30 days',
      direction: 'good',
    },
    {
      label: 'Median route time',
      value: formatRouteTime(state.metrics.medianRouteSeconds),
      detail: routeWarning ? '2m SLA breached' : 'under 2m SLA',
      direction: routeWarning ? 'warning' : 'good',
    },
    {
      label: 'Data quality',
      value: `${state.metrics.qualityRate.toFixed(1)}%`,
      detail: `${state.metrics.duplicateEvents} duplicates detected`,
      direction: qualityWarning ? 'warning' : 'good',
    },
    {
      label: 'Lead → won',
      value: `${wonRate.toFixed(1)}%`,
      detail: `${won.toLocaleString()} won of ${leads.toLocaleString()} leads`,
      direction: 'good',
    },
  ];
}

function funnelFromLiveState(state: LiveControlTowerState): ReturnType<typeof funnelForScenario> {
  const leads = state.funnel.find((stage) => stage.label === 'Leads')?.count ?? 0;
  return state.funnel.map((stage) => ({
    label: stage.label,
    count: stage.count,
    conversion: leads > 0 ? (stage.count / leads) * 100 : 0,
  }));
}

function metricsFromCsvContacts(contacts: LiveContactState[]): ReturnType<typeof scenarioMetrics> {
  const active = contacts.filter((contact) => contact.recordStatus === 'active');
  const clean = active.filter((contact) => contact.qualityFlags.length === 0).length;
  const assigned = active.filter((contact) => Boolean(contact.ownerId)).length;
  const qualityRate = active.length ? (clean / active.length) * 100 : 0;
  return [
    { label: 'Workspace rows', value: contacts.length.toLocaleString(), detail: 'saved locally when SQLite is enabled', direction: 'good' },
    { label: 'Active identities', value: active.length.toLocaleString(), detail: `${contacts.length - active.length} logically merged`, direction: 'good' },
    { label: 'Data quality', value: `${qualityRate.toFixed(1)}%`, detail: `${active.length - clean} active rows need attention`, direction: qualityRate < 95 ? 'warning' : 'good' },
    { label: 'Assigned owners', value: assigned.toLocaleString(), detail: `${active.length - assigned} unassigned`, direction: assigned < active.length ? 'warning' : 'good' },
  ];
}

function funnelFromCsvContacts(contacts: LiveContactState[]): ReturnType<typeof funnelForScenario> {
  const active = contacts.filter((contact) => contact.recordStatus === 'active');
  const ranks: Record<string, number> = { lead: 1, mql: 2, sql: 3, opportunity: 4, customer: 5, closed_won: 5 };
  const counts = [
    active.length,
    active.filter((contact) => (ranks[contact.lifecycleStage] ?? 1) >= 2).length,
    active.filter((contact) => (ranks[contact.lifecycleStage] ?? 1) >= 3).length,
    active.filter((contact) => (ranks[contact.lifecycleStage] ?? 1) >= 4).length,
    active.filter((contact) => (ranks[contact.lifecycleStage] ?? 1) >= 5).length,
  ];
  const labels = ['Leads', 'MQL', 'SQL', 'Open opp', 'Won'] as const;
  return labels.map((label, index) => ({
    label,
    count: counts[index],
    conversion: counts[0] ? (counts[index] / counts[0]) * 100 : 0,
  }));
}

function formatRouteTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = String(Math.round(seconds % 60)).padStart(2, '0');
  return `${String(minutes).padStart(2, '0')}:${remainder}`;
}

export function ControlTowerDashboard() {
  const [activeScenario, setActiveScenario] = useState<ScenarioKey | null>(null);
  const [repaired, setRepaired] = useState(false);
  const [demoStage, setDemoStage] = useState(-1);
  const [demoRunning, setDemoRunning] = useState(false);
  const [liveState, setLiveState] = useState<LiveControlTowerState | null>(null);
  const [liveStatus, setLiveStatus] = useState<'loading' | 'live' | 'offline'>('loading');
  const [repairStatus, setRepairStatus] = useState<'idle' | 'sending' | 'executed' | 'error'>('idle');
  const [repairReceipt, setRepairReceipt] = useState<RepairReceipt | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [seedStatus, setSeedStatus] = useState<'idle' | 'sending' | 'seeded' | 'error'>('idle');
  const [seedReceipt, setSeedReceipt] = useState<SeedReceipt | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [dataMode, setDataMode] = useState<'warehouse' | 'csv'>('warehouse');
  const [csvContacts, setCsvContacts] = useState<LiveContactState[]>([]);
  const [originalCsvContacts, setOriginalCsvContacts] = useState<LiveContactState[]>([]);
  const [csvRepairHistory, setCsvRepairHistory] = useState<RepairRun[]>([]);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [, setCsvStatus] = useState<'idle' | 'reading' | 'ready' | 'error'>('idle');
  const [csvError, setCsvError] = useState<string | null>(null);
  const [hubSpotSyncStatus, setHubSpotSyncStatus] = useState<'idle' | 'sending' | 'complete' | 'partial' | 'error'>('idle');
  const [hubSpotSyncReceipt, setHubSpotSyncReceipt] = useState<HubSpotSyncReceipt | null>(null);
  const [hubSpotSyncError, setHubSpotSyncError] = useState<string | null>(null);
  const [hubSpotSyncKey, setHubSpotSyncKey] = useState('');
  const [salesforceSyncStatus, setSalesforceSyncStatus] = useState<'idle' | 'sending' | 'complete' | 'partial' | 'error'>('idle');
  const [salesforceSyncReceipt, setSalesforceSyncReceipt] = useState<SalesforceSyncReceipt | null>(null);
  const [salesforceSyncError, setSalesforceSyncError] = useState<string | null>(null);
  const [salesforceSyncKey, setSalesforceSyncKey] = useState('');
  const [connectorCatalog, setConnectorCatalog] = useState<ConnectorCatalog | null>(null);
  const [sourceType, setSourceType] = useState<ConnectorId>('csv');
  const [destinationType, setDestinationType] = useState<ConnectorId>('csv');
  const [csvMapping, setCsvMapping] = useState<CsvColumnMapping>({});
  const [connectorReceipts, setConnectorReceipts] = useState<ConnectorReceipt[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceRevision, setWorkspaceRevision] = useState<number | null>(null);
  const [mappingPresets, setMappingPresets] = useState<MappingPreset[]>([]);
  const [persistenceStatus, setPersistenceStatus] = useState<'loading' | 'saved' | 'saving' | 'disabled' | 'error'>('loading');
  const hubSpotEligibleContacts = useMemo(() => csvContacts.filter(isHubSpotEligible), [csvContacts]);
  const syncedHubSpotContactIds = useMemo(
    () => new Set(hubSpotSyncReceipt?.records.filter((record) => record.status === 'synced').map((record) => record.contactId) ?? []),
    [hubSpotSyncReceipt],
  );
  const pendingHubSpotContacts = useMemo(
    () => hubSpotEligibleContacts.filter((contact) => !syncedHubSpotContactIds.has(contact.contactId)),
    [hubSpotEligibleContacts, syncedHubSpotContactIds],
  );
  const salesforceEligibleContacts = useMemo(() => csvContacts.filter(isSalesforceEligible), [csvContacts]);
  const syncedSalesforceContactIds = useMemo(
    () => new Set(salesforceSyncReceipt?.records.filter((record) => record.status !== 'failed').map((record) => record.contactId) ?? []),
    [salesforceSyncReceipt],
  );
  const pendingSalesforceContacts = useMemo(
    () => salesforceEligibleContacts.filter((contact) => !syncedSalesforceContactIds.has(contact.contactId)),
    [salesforceEligibleContacts, syncedSalesforceContactIds],
  );
  const bigQueryConfigured = connectorCatalog?.connectors.some((connector) => connector.id === 'bigquery' && connector.configured) ?? false;
  const hubSpotConfigured = connectorCatalog?.connectors.some((connector) => connector.id === 'hubspot' && connector.configured) ?? false;
  const salesforceConfigured = connectorCatalog?.connectors.some((connector) => connector.id === 'salesforce' && connector.configured) ?? false;
  const googleSheetsConfigured = connectorCatalog?.connectors.some((connector) => connector.id === 'google-sheets' && connector.configured) ?? false;
  const visibleIntegrations = useMemo(() => [
    { name: 'CSV', role: 'free source + export', status: 'always ready', tone: 'live' },
    ...(googleSheetsConfigured ? [{ name: 'Google Sheets', role: 'worksheet source + destination', status: 'configured', tone: 'live' }] : []),
    ...(googleSheetsConfigured || bigQueryConfigured ? [{ name: 'n8n', role: 'credentialed orchestration', status: 'configured', tone: 'live' }] : []),
    ...(bigQueryConfigured ? [
      { name: 'BigQuery', role: 'event warehouse', status: 'configured', tone: 'live' },
      { name: 'dbt', role: 'semantic layer', status: 'available', tone: 'live' },
    ] : []),
    ...(hubSpotConfigured ? [{ name: 'HubSpot', role: 'CRM destination', status: 'configured', tone: 'live' }] : []),
    ...(salesforceConfigured ? [{ name: 'Salesforce', role: 'CRM destination', status: 'configured', tone: 'live' }] : []),
    { name: 'Control Tower', role: 'decision layer', status: 'active', tone: 'demo' },
  ], [bigQueryConfigured, googleSheetsConfigured, hubSpotConfigured, salesforceConfigured]);
  const visibleScenario = repaired ? null : activeScenario;
  const metrics = useMemo(
    () => dataMode === 'csv'
      ? metricsFromCsvContacts(csvContacts)
      : !visibleScenario && liveState ? metricsFromLiveState(liveState) : scenarioMetrics(visibleScenario),
    [csvContacts, dataMode, liveState, visibleScenario],
  );
  const funnel = useMemo(
    () => dataMode === 'csv'
      ? funnelFromCsvContacts(csvContacts)
      : !visibleScenario && liveState ? funnelFromLiveState(liveState) : funnelForScenario(visibleScenario),
    [csvContacts, dataMode, liveState, visibleScenario],
  );
  const runSummary = useMemo(() => demoRunSummary(demoStage), [demoStage]);

  const refreshLiveState = useCallback(async () => {
    setLiveStatus((status) => status === 'live' ? 'live' : 'loading');
    try {
      const response = await fetch('/api/control-tower/state', { cache: 'no-store' });
      const state: unknown = await response.json();
      if (!response.ok || !isLiveControlTowerState(state)) throw new Error('Live state unavailable');
      setLiveState(state);
      setLiveStatus('live');
    } catch {
      setLiveStatus('offline');
    }
  }, []);

  useEffect(() => {
    const initialRefreshTimer = window.setTimeout(() => void refreshLiveState(), 0);
    const refreshTimer = window.setInterval(() => void refreshLiveState(), 30_000);
    return () => {
      window.clearTimeout(initialRefreshTimer);
      window.clearInterval(refreshTimer);
    };
  }, [refreshLiveState]);

  useEffect(() => {
    let cancelled = false;
    async function initializeSelfHostWorkspace() {
      try {
        const response = await fetch('/api/control-tower/connectors', { cache: 'no-store' });
        const catalog = await response.json() as ConnectorCatalog;
        if (cancelled) return;
        setConnectorCatalog(catalog);
        const availableSources = catalog.connectors.filter((connector) => connector.configured && connector.directions.includes('source'));
        const availableDestinations = catalog.connectors.filter((connector) => connector.configured && connector.directions.includes('destination'));
        if (!availableSources.some((connector) => connector.id === sourceType)) setSourceType(availableSources[0]?.id ?? 'csv');
        if (!availableDestinations.some((connector) => connector.id === destinationType)) setDestinationType(availableDestinations[0]?.id ?? 'csv');
        if (!catalog.persistenceEnabled) {
          setPersistenceStatus('disabled');
          return;
        }
        const storedId = window.localStorage.getItem('gtm-control-tower-workspace-id');
        if (storedId) {
          const savedResponse = await fetch(`/api/control-tower/workspace?id=${encodeURIComponent(storedId)}`, { cache: 'no-store' });
          if (savedResponse.ok) {
            const saved = await savedResponse.json() as { workspace: SavedWorkspace };
            if (!cancelled) applySavedWorkspace(saved.workspace);
            return;
          }
        }
        const createdResponse = await fetch('/api/control-tower/workspace', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create' }),
        });
        if (!createdResponse.ok) throw new Error('Persistent workspace unavailable.');
        const created = await createdResponse.json() as { workspace: SavedWorkspace };
        if (!cancelled) applySavedWorkspace(created.workspace);
      } catch {
        if (!cancelled) setPersistenceStatus('error');
      }
    }
    void initializeSelfHostWorkspace();
    return () => { cancelled = true; };
    // Connector availability and the saved workspace are loaded once per page session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applySavedWorkspace(workspace: SavedWorkspace) {
    setWorkspaceId(workspace.id);
    setWorkspaceRevision(workspace.revision);
    setMappingPresets(workspace.presets);
    setSourceType(workspace.state.sourceType);
    setDestinationType(workspace.state.destinationType);
    setCsvMapping(workspace.state.mapping);
    setConnectorReceipts(workspace.state.receipts);
    setCsvContacts(workspace.state.contacts);
    setOriginalCsvContacts(workspace.state.originalContacts);
    setCsvRepairHistory(workspace.state.repairHistory);
    setCsvFileName(workspace.state.fileName);
    if (workspace.state.contacts.length) {
      setDataMode('csv');
      setCsvStatus('ready');
      setDemoStage(demoStages.length - 1);
    }
    window.localStorage.setItem('gtm-control-tower-workspace-id', workspace.id);
    setPersistenceStatus('saved');
  }

  async function ensureWorkspace(): Promise<string | null> {
    if (persistenceStatus === 'disabled') return null;
    if (workspaceId) return workspaceId;
    const response = await fetch('/api/control-tower/workspace', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create' }),
    });
    if (!response.ok) return null;
    const created = await response.json() as { workspace: SavedWorkspace };
    setWorkspaceId(created.workspace.id);
    setWorkspaceRevision(created.workspace.revision);
    setMappingPresets(created.workspace.presets);
    window.localStorage.setItem('gtm-control-tower-workspace-id', created.workspace.id);
    return created.workspace.id;
  }

  async function persistWorkspace(reason: string, overrides: Partial<WorkspaceState> = {}) {
    if (persistenceStatus === 'disabled') return;
    setPersistenceStatus('saving');
    try {
      const id = await ensureWorkspace();
      if (!id) throw new Error('Workspace persistence is unavailable.');
      const state: WorkspaceState = {
        contacts: overrides.contacts ?? csvContacts,
        originalContacts: overrides.originalContacts ?? originalCsvContacts,
        repairHistory: overrides.repairHistory ?? csvRepairHistory,
        receipts: overrides.receipts ?? connectorReceipts,
        mapping: overrides.mapping ?? csvMapping,
        fileName: overrides.fileName === undefined ? csvFileName : overrides.fileName,
        sourceType: overrides.sourceType ?? sourceType,
        destinationType: overrides.destinationType ?? destinationType,
        sourceLabel: overrides.sourceLabel,
      };
      const response = await fetch('/api/control-tower/workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'save', id, state, reason }),
      });
      if (!response.ok) throw new Error('Workspace save failed.');
      const saved = await response.json() as { workspace: SavedWorkspace };
      setWorkspaceRevision(saved.workspace.revision);
      setMappingPresets(saved.workspace.presets);
      setPersistenceStatus('saved');
    } catch {
      setPersistenceStatus('error');
    }
  }

  async function loadCsvWorkspace(
    source: string,
    fileName: string,
    mapping: CsvColumnMapping = {},
    importedSource: ConnectorId = 'csv',
    startWalkthrough = false,
  ) {
    const imported = importContactsCsv(source, mapping);
    const snapshot = imported.contacts.map((contact) => ({ ...contact, qualityFlags: [...contact.qualityFlags] }));
    const receipt: ConnectorReceipt = {
      id: globalThis.crypto.randomUUID(), connectorId: importedSource, phase: 'validate', status: 'executed',
      summary: `Validated ${snapshot.length} mapped contacts.`, recordsRead: snapshot.length,
      createdAt: new Date().toISOString(), undoAvailable: false,
    };
    const receipts = [receipt, ...connectorReceipts].slice(0, 30);
    setCsvContacts(snapshot);
    setOriginalCsvContacts(snapshot.map((contact) => ({ ...contact, qualityFlags: [...contact.qualityFlags] })));
    setCsvRepairHistory([]);
    setCsvFileName(fileName);
    setCsvMapping(mapping);
    setConnectorReceipts(receipts);
    setSourceType(importedSource);
    setCsvStatus('ready');
    setCsvError(null);
    setHubSpotSyncStatus('idle');
    setHubSpotSyncReceipt(null);
    setHubSpotSyncError(null);
    setSalesforceSyncStatus('idle');
    setSalesforceSyncReceipt(null);
    setSalesforceSyncError(null);
    setDataMode('csv');
    setActiveScenario('duplicate-surge');
    setRepaired(false);
    setRepairStatus('idle');
    setRepairReceipt(null);
    setRepairError(null);
    setDemoStage(startWalkthrough ? 0 : demoStages.length - 1);
    setDemoRunning(startWalkthrough);
    await persistWorkspace('import_validated', {
      contacts: snapshot,
      originalContacts: snapshot.map((contact) => ({ ...contact, qualityFlags: [...contact.qualityFlags] })),
      repairHistory: [], receipts, mapping, fileName, sourceType: importedSource,
    });
  }

  useEffect(() => {
    if (!demoRunning) return;
    if (demoStage >= demoStages.length - 1) {
      const completionTimer = window.setTimeout(() => setDemoRunning(false), 550);
      return () => window.clearTimeout(completionTimer);
    }
    const stageTimer = window.setTimeout(() => setDemoStage((stage) => stage + 1), 780);
    return () => window.clearTimeout(stageTimer);
  }, [demoRunning, demoStage]);

  async function resetFunkyBatch(startWalkthrough = false) {
    if (seedStatus === 'sending') return;
    setSeedStatus('sending');
    setSeedError(null);
    try {
      const response = await fetch('/api/control-tower/funky', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const receipt: unknown = await response.json();
      if (!response.ok || !isSeedReceipt(receipt)) throw new Error('The workflow did not return a seed receipt.');
      setSeedReceipt(receipt);
      setSeedStatus('seeded');
      setDataMode('warehouse');
      setRepairStatus('idle');
      setRepairReceipt(null);
      setRepairError(null);
      setRepaired(false);
      if (startWalkthrough) {
        setDemoStage(0);
        setDemoRunning(true);
        setActiveScenario('duplicate-surge');
      }
      await refreshLiveState();
    } catch (error) {
      if (startWalkthrough) {
        try {
          const localDemo = await fetch('/control-tower-csv-template.csv', { cache: 'no-store' });
          if (!localDemo.ok) throw new Error('The bundled CSV demo is unavailable.');
          await loadCsvWorkspace(await localDemo.text(), 'synthetic-funky-crm.csv', {}, 'csv', true);
          setSeedStatus('error');
          setSeedError('Warehouse connectors are not configured, so this run is using the browser-local synthetic batch.');
          return;
        } catch {
          // Keep the native connector error below if the local demo also fails.
        }
      }
      setSeedStatus('error');
      setSeedError(error instanceof Error ? error.message : 'The synthetic CRM batch could not be reset.');
    }
  }

  async function runMessyBatch() {
    await resetFunkyBatch(true);
  }

  async function resetCsvWorkspace() {
    const contacts = originalCsvContacts.map((contact) => ({ ...contact, qualityFlags: [...contact.qualityFlags] }));
    setCsvContacts(contacts);
    setCsvRepairHistory([]);
    setHubSpotSyncStatus('idle');
    setHubSpotSyncReceipt(null);
    setHubSpotSyncError(null);
    setSalesforceSyncStatus('idle');
    setSalesforceSyncReceipt(null);
    setSalesforceSyncError(null);
    setActiveScenario('duplicate-surge');
    setRepaired(false);
    setRepairStatus('idle');
    setRepairReceipt(null);
    setRepairError(null);
    await persistWorkspace('import_reset', { contacts, repairHistory: [] });
  }

  function exportCsvWorkspace() {
    const blob = new Blob([exportContactsCsv(csvContacts)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${csvFileName?.replace(/\.csv$/i, '') || 'control-tower'}-repaired.csv`;
    link.click();
    URL.revokeObjectURL(url);
    const receipt: ConnectorReceipt = {
      id: globalThis.crypto.randomUUID(), connectorId: 'csv', phase: 'export', status: 'executed',
      summary: `Exported ${csvContacts.length} contacts as CSV.`, recordsWritten: csvContacts.length,
      createdAt: new Date().toISOString(), undoAvailable: false,
    };
    void recordConnectorReceipt(receipt);
  }

  async function recordConnectorReceipt(receipt: ConnectorReceipt) {
    const receipts = [receipt, ...connectorReceipts].slice(0, 30);
    setConnectorReceipts(receipts);
    await persistWorkspace('connector_receipt', { receipts });
  }

  async function undoSavedWorkspace() {
    if (!workspaceId || !workspaceRevision) return;
    setPersistenceStatus('saving');
    try {
      const response = await fetch('/api/control-tower/workspace', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'undo', id: workspaceId }),
      });
      if (!response.ok) throw new Error('Undo failed.');
      const restored = await response.json() as { workspace: SavedWorkspace };
      applySavedWorkspace(restored.workspace);
    } catch {
      setPersistenceStatus('error');
    }
  }

  async function saveMappingPreset(name: string, mapping: CsvColumnMapping) {
    const id = await ensureWorkspace();
    if (!id) throw new Error('Persistent workspaces are disabled.');
    const response = await fetch('/api/control-tower/workspace', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save-preset', id, name, mapping }),
    });
    if (!response.ok) throw new Error('Mapping preset could not be saved.');
    const result = await response.json() as { presets: MappingPreset[] };
    setMappingPresets(result.presets);
  }

  function changeSourceType(next: ConnectorId) {
    setSourceType(next);
    if (next === 'bigquery') activateWarehouseMode();
    void persistWorkspace('source_changed', { sourceType: next });
  }

  function changeDestinationType(next: ConnectorId) {
    setDestinationType(next);
    void persistWorkspace('destination_changed', { destinationType: next });
  }

  function activateWarehouseMode() {
    setDataMode('warehouse');
    setRepaired(false);
    setRepairStatus('idle');
    setRepairReceipt(null);
    setRepairError(null);
    void refreshLiveState();
  }

  async function syncNextCsvBatchToHubSpot() {
    if (hubSpotSyncStatus === 'sending' || !pendingHubSpotContacts.length) return;
    const batch = pendingHubSpotContacts.slice(0, 100).map(toHubSpotSyncContact);
    const parentSyncId = hubSpotSyncReceipt?.syncId ?? globalThis.crypto.randomUUID();
    setHubSpotSyncStatus('sending');
    setHubSpotSyncError(null);
    try {
      const response = await fetch('/api/control-tower/hubspot-sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(hubSpotSyncKey ? { 'x-control-tower-key': hubSpotSyncKey } : {}),
        },
        body: JSON.stringify({
          syncId: `${parentSyncId}-${Date.now()}`,
          sourceFile: csvFileName ?? 'imported-contacts.csv',
          contacts: batch,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !isHubSpotSyncReceipt(payload)) {
        const message = typeof payload === 'object' && payload !== null && 'error' in payload
          ? String(payload.error)
          : 'HubSpot did not return a per-record receipt.';
        throw new Error(message);
      }
      const combined = combineHubSpotSyncReceipts(
        hubSpotSyncReceipt ? [hubSpotSyncReceipt, payload] : [payload],
        parentSyncId,
      );
      setHubSpotSyncReceipt(combined);
      setHubSpotSyncStatus(combined.status);
      await recordConnectorReceipt({
        id: globalThis.crypto.randomUUID(), connectorId: 'hubspot', phase: 'receipt',
        status: combined.failed ? 'partial' : 'executed',
        summary: `${combined.synced} HubSpot contacts synced; ${combined.failed} failed.`,
        recordsWritten: combined.synced, recordsFailed: combined.failed,
        createdAt: combined.completedAt, undoAvailable: false, nativeReceiptId: combined.syncId,
      });
    } catch (error) {
      setHubSpotSyncStatus('error');
      setHubSpotSyncError(error instanceof Error ? error.message : 'The HubSpot sync failed before a valid receipt returned.');
    }
  }

  async function syncNextCsvBatchToSalesforce() {
    if (salesforceSyncStatus === 'sending' || !pendingSalesforceContacts.length) return;
    const batch = pendingSalesforceContacts.slice(0, 100).map(toSalesforceSyncLead);
    const parentSyncId = salesforceSyncReceipt?.syncId ?? globalThis.crypto.randomUUID();
    setSalesforceSyncStatus('sending');
    setSalesforceSyncError(null);
    try {
      const response = await fetch('/api/control-tower/salesforce-sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(salesforceSyncKey ? { 'x-control-tower-key': salesforceSyncKey } : {}),
        },
        body: JSON.stringify({
          syncId: `${parentSyncId}-${Date.now()}`,
          sourceFile: csvFileName ?? 'imported-contacts.csv',
          leads: batch,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !isSalesforceSyncReceipt(payload)) {
        const message = typeof payload === 'object' && payload !== null && 'error' in payload
          ? String(payload.error)
          : 'Salesforce did not return a per-record receipt.';
        throw new Error(message);
      }
      const combined = combineSalesforceSyncReceipts(
        salesforceSyncReceipt ? [salesforceSyncReceipt, payload] : [payload],
        parentSyncId,
      );
      setSalesforceSyncReceipt(combined);
      setSalesforceSyncStatus(combined.status);
      await recordConnectorReceipt({
        id: globalThis.crypto.randomUUID(), connectorId: 'salesforce', phase: 'receipt',
        status: combined.failed ? 'partial' : 'executed',
        summary: `${combined.created} Salesforce Leads created, ${combined.updated} updated; ${combined.failed} failed.`,
        recordsWritten: combined.created + combined.updated, recordsFailed: combined.failed,
        createdAt: combined.completedAt, undoAvailable: false, nativeReceiptId: combined.syncId,
      });
    } catch (error) {
      setSalesforceSyncStatus('error');
      setSalesforceSyncError(error instanceof Error ? error.message : 'The Salesforce sync failed before a valid receipt returned.');
    }
  }

  function triggerChaos() {
    setActiveScenario(nextScenario(activeScenario));
    setRepaired(false);
    setDemoRunning(false);
    setDemoStage(demoStages.length - 1);
    setRepairStatus('idle');
    setRepairReceipt(null);
    setRepairError(null);
  }

  async function approveRepair() {
    if (!activeScenario || repairStatus === 'sending') return;
    setRepairStatus('sending');
    setRepairError(null);
    if (dataMode === 'csv') {
      const result = executeCsvRepair(csvContacts, activeScenario);
      const history = [result.run, ...csvRepairHistory].slice(0, 6);
      const connectorReceipt: ConnectorReceipt = {
        id: globalThis.crypto.randomUUID(), connectorId: sourceType, phase: 'execute', status: 'executed',
        summary: `${result.receipt.action} changed ${result.receipt.affectedRecords} records.`,
        recordsWritten: result.receipt.affectedRecords, createdAt: result.receipt.approvedAt,
        undoAvailable: true, nativeReceiptId: result.receipt.requestId,
      };
      const receipts = [connectorReceipt, ...connectorReceipts].slice(0, 30);
      setCsvContacts(result.contacts);
      setCsvRepairHistory(history);
      setConnectorReceipts(receipts);
      setRepairReceipt(result.receipt);
      setRepairStatus('executed');
      setRepaired(true);
      await persistWorkspace('repair_executed', { contacts: result.contacts, repairHistory: history, receipts });
      return;
    }
    try {
      const response = await fetch('/api/control-tower/repair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario: activeScenario }),
      });
      const receipt: unknown = await response.json();
      if (!response.ok || !isRepairReceipt(receipt)) throw new Error('The workflow did not return a receipt.');
      setRepairReceipt(receipt);
      setRepairStatus('executed');
      setRepaired(true);
      await refreshLiveState();
    } catch (error) {
      setRepairStatus('error');
      setRepairError(error instanceof Error ? error.message : 'The repair workflow is unavailable.');
    }
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#07130f] text-[#edf8f2] selection:bg-[#cdfc54] selection:text-[#07130f]">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[520px] bg-[radial-gradient(circle_at_76%_8%,rgba(205,252,84,0.11),transparent_33%),radial-gradient(circle_at_12%_0%,rgba(64,170,127,0.16),transparent_31%)]" />
      <div className="relative mx-auto max-w-[1540px] px-5 py-5 sm:px-8 lg:px-12">
        <header className="flex flex-wrap items-center justify-between gap-5 border-b border-white/10 pb-5">
          <div className="flex items-center gap-4">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#cdfc54] font-mono text-sm font-black text-[#07130f] shadow-[0_0_45px_rgba(205,252,84,0.18)]">GT</span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#8fa99d]">Revenue systems portfolio lab</p>
              <h1 className="text-xl font-semibold tracking-tight">GTM Control Tower</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Link href="/" className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#9db1a7] transition hover:border-white/25 hover:text-white">Demo</Link>
            <Link href="/setup" className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#9db1a7] transition hover:border-white/25 hover:text-white">Setup</Link>
            <a
              href="https://github.com/harrisonoconnorhover/gtm-control-tower"
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-[#cdfc54]/20 bg-[#cdfc54]/[0.07] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#cdfc54] transition hover:border-[#cdfc54]/45 hover:bg-[#cdfc54]/[0.12] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#cdfc54]"
            >
              Open source · GitHub ↗
            </a>
            <span className="rounded-full border border-[#cdfc54]/20 bg-[#cdfc54]/[0.07] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#cdfc54]">Self-hosted · MIT</span>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#9db1a7]">Synthetic demo data</span>
          </div>
        </header>

        <section className="grid items-end gap-8 py-10 lg:grid-cols-[1.2fr_0.8fr] lg:py-14">
          <div>
            <div className="mb-4 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-[#cdfc54]">
              <span className={`h-2 w-2 rounded-full ${demoRunning ? 'animate-pulse bg-[#cdfc54]' : 'bg-[#4fa782]'}`} />
              {demoRunning ? `Processing · ${demoStages[Math.max(demoStage, 0)].label}` : 'Guided system walkthrough'}
            </div>
            <h2 className="max-w-[980px] text-4xl font-semibold leading-[0.98] tracking-[-0.05em] sm:text-6xl lg:text-[72px]">
              Watch messy CRM data become a trusted revenue decision.
            </h2>
            <p className="mt-6 max-w-2xl text-base leading-7 text-[#9cb0a7] sm:text-lg">
              Ten flawed contacts enter. The system enriches and routes the usable records, contains bad writes, rebuilds the funnel, and explains what is costing the team revenue.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <button
                data-testid="run-demo"
                onClick={() => void runMessyBatch()}
                disabled={demoRunning || seedStatus === 'sending'}
                className="rounded-full bg-[#cdfc54] px-6 py-3 text-sm font-bold text-[#07130f] shadow-[0_12px_40px_rgba(205,252,84,0.16)] transition hover:-translate-y-0.5 hover:bg-[#dcff83] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#cdfc54] disabled:cursor-wait disabled:opacity-65"
              >
                {seedStatus === 'sending' ? 'Loading funky CRM data…' : demoRunning ? 'Batch running…' : demoStage >= 0 ? 'Reset + replay messy batch' : 'Run messy lead batch'}
              </button>
              <button
                data-testid="chaos-trigger"
                onClick={triggerChaos}
                className="rounded-full border border-white/15 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-[#c9d8d0] transition hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9d8d0]"
              >
                Test another failure
              </button>
            </div>
          </div>
          <article className="rounded-[30px] border border-white/10 bg-[#0c1d17]/90 p-5 shadow-[0_30px_90px_rgba(0,0,0,0.28)] backdrop-blur sm:p-6">
            <div className="flex items-start justify-between gap-5">
              <div>
                <p className="text-sm text-[#8fa99d]">What is real?</p>
                <h3 className="mt-1 text-xl font-semibold">Honest integration boundary</h3>
              </div>
              <span className="rounded-full bg-[#cdfc54]/10 px-3 py-1 font-mono text-[10px] text-[#cdfc54]">PORTFOLIO-SAFE</span>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <ProofPoint label="Live path" value="HubSpot · Salesforce · n8n · BigQuery" />
              <ProofPoint label="Analytics" value="dbt · 15 checks passed" />
              <ProofPoint label="Demo layer" value="Deterministic synthetic batch" />
              <ProofPoint label="Salesforce" value="Create + update · same Lead ID" />
            </div>
          </article>
        </section>

        <SelfHostConsole
          catalog={connectorCatalog}
          contacts={csvContacts}
          sourceType={sourceType}
          destinationType={destinationType}
          mapping={csvMapping}
          presets={mappingPresets}
          workspaceRevision={workspaceRevision}
          persistenceStatus={persistenceStatus}
          lastReceipt={connectorReceipts[0] ?? null}
          onMappedImport={(csv, fileName, mapping, source) => loadCsvWorkspace(csv, fileName, mapping, source)}
          onSourceChange={changeSourceType}
          onDestinationChange={changeDestinationType}
          onSavePreset={saveMappingPreset}
          onUndo={undoSavedWorkspace}
          onExport={exportCsvWorkspace}
          onReceipt={recordConnectorReceipt}
        />

        {bigQueryConfigured && <LiveWarehouseCard state={liveState} status={liveStatus} onRefresh={refreshLiveState} />}

        <FunkyCrmLab
          mode={dataMode}
          contacts={dataMode === 'csv' ? csvContacts : liveState?.contacts ?? []}
          repairHistory={dataMode === 'csv' ? csvRepairHistory : liveState?.repairHistory ?? []}
          csvFileName={csvFileName}
          csvError={csvError}
          bigQueryConfigured={bigQueryConfigured}
          hubSpotEligibleCount={hubSpotEligibleContacts.length}
          hubSpotPendingCount={pendingHubSpotContacts.length}
          hubSpotSyncStatus={hubSpotSyncStatus}
          hubSpotSyncReceipt={hubSpotSyncReceipt}
          hubSpotSyncError={hubSpotSyncError}
          hubSpotSyncKey={hubSpotSyncKey}
          hubSpotConfigured={hubSpotConfigured && destinationType === 'hubspot'}
          salesforceEligibleCount={salesforceEligibleContacts.length}
          salesforcePendingCount={pendingSalesforceContacts.length}
          salesforceSyncStatus={salesforceSyncStatus}
          salesforceSyncReceipt={salesforceSyncReceipt}
          salesforceSyncError={salesforceSyncError}
          salesforceSyncKey={salesforceSyncKey}
          salesforceConfigured={salesforceConfigured && destinationType === 'salesforce'}
          seedStatus={seedStatus}
          seedReceipt={seedReceipt}
          seedError={seedError}
          onExport={exportCsvWorkspace}
          onUseWarehouse={activateWarehouseMode}
          onHubSpotSync={syncNextCsvBatchToHubSpot}
          onHubSpotSyncKeyChange={setHubSpotSyncKey}
          onSalesforceSync={syncNextCsvBatchToSalesforce}
          onSalesforceSyncKeyChange={setSalesforceSyncKey}
          onReset={() => dataMode === 'csv' ? Promise.resolve(resetCsvWorkspace()) : resetFunkyBatch(false)}
        />

        <section className="rounded-[34px] border border-white/10 bg-[#091a14]/92 p-4 shadow-[0_30px_100px_rgba(0,0,0,0.22)] sm:p-6" aria-label="Messy lead processing walkthrough">
          <div className="flex flex-wrap items-end justify-between gap-4 px-1 pb-5">
            <div>
              <p className="text-sm text-[#8fa99d]">One batch, six controls</p>
              <h3 className="mt-1 text-2xl font-semibold tracking-tight">From raw signal to governed action</h3>
            </div>
            <p aria-live="polite" className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#8fa99d]">
              {demoStage < 0 ? 'Ready for input' : demoRunning ? `Step ${demoStage + 1} of ${demoStages.length}` : 'Run complete · diagnosis ready'}
            </p>
          </div>
          <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-6">
            {demoStages.map((stage, index) => {
              const complete = demoStage > index || (!demoRunning && demoStage === index);
              const active = demoRunning && demoStage === index;
              return (
                <article
                  key={stage.id}
                  className={`relative min-h-[176px] rounded-2xl border p-4 transition-all duration-500 ${active ? 'translate-y-[-3px] border-[#cdfc54]/60 bg-[#cdfc54]/10 shadow-[0_18px_50px_rgba(205,252,84,0.08)]' : complete ? 'border-[#4fa782]/30 bg-[#11251d]' : 'border-white/[0.08] bg-white/[0.025]'}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className={`grid h-7 w-7 place-items-center rounded-full font-mono text-[10px] ${active ? 'bg-[#cdfc54] text-[#07130f]' : complete ? 'bg-[#4fa782]/20 text-[#7fddb6]' : 'bg-white/[0.06] text-[#70857b]'}`}>
                      {complete ? '✓' : String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="font-mono text-[9px] uppercase tracking-wider text-[#70857b]">{stage.system}</span>
                  </div>
                  <h4 className="mt-5 font-semibold">{stage.label}</h4>
                  <p className="mt-2 text-xs leading-5 text-[#81978d]">{stage.detail}</p>
                  <p className={`mt-4 font-mono text-[10px] ${active || complete ? 'text-[#cdfc54]' : 'text-[#566b61]'}`}>{complete ? stage.result : active ? 'working…' : 'queued'}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="mt-6 grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
          <TransformationCard demoStage={demoStage} />
          <RunOutcomeCard summary={runSummary} demoStage={demoStage} />
        </section>

        <div className="mt-7 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-[#8fa99d]">{dataMode === 'csv' ? 'Imported CSV metrics' : visibleScenario ? 'Scenario impact model' : liveState ? 'Live warehouse metrics' : 'Demo baseline'}</p>
            <h3 className="mt-1 text-xl font-semibold">{dataMode === 'csv' ? 'What this browser-local file says now' : visibleScenario ? 'How this failure changes the business' : 'What BigQuery says now'}</h3>
          </div>
          <span className={`rounded-full px-3 py-1 font-mono text-[9px] uppercase tracking-wider ${dataMode === 'csv' ? 'bg-[#83bcff]/10 text-[#83bcff]' : visibleScenario ? 'bg-[#ff7b55]/10 text-[#ff9d7f]' : liveState ? 'bg-[#cdfc54]/10 text-[#cdfc54]' : 'bg-white/[0.05] text-[#8fa99d]'}`}>
            {dataMode === 'csv' ? 'Local CSV' : visibleScenario ? 'Simulated overlay' : liveState ? 'Live' : 'Fallback'}
          </span>
        </div>
        <section className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Pipeline health metrics">
          {metrics.map((metric) => (
            <article key={metric.label} className={`rounded-3xl border p-5 transition-colors ${metric.direction === 'warning' ? 'border-[#ff7b55]/45 bg-[#2b1712]' : 'border-white/10 bg-[#0c1d17]'}`}>
              <p className="text-sm text-[#8fa99d]">{metric.label}</p>
              <p className="mt-3 text-3xl font-semibold tracking-tight">{metric.value}</p>
              <p className={`mt-2 font-mono text-[11px] ${metric.direction === 'warning' ? 'text-[#ff9d7f]' : 'text-[#cdfc54]'}`}>{metric.detail}</p>
            </article>
          ))}
        </section>

        <section className="mt-6 grid gap-5 xl:grid-cols-[1.18fr_0.82fr]">
          <FunnelCard funnel={funnel} source={dataMode === 'csv' ? 'csv' : !visibleScenario && liveState ? 'warehouse' : 'simulation'} />
          <IncidentCard
            activeScenario={visibleScenario}
            repaired={repaired}
            repairStatus={repairStatus}
            repairReceipt={repairReceipt}
            repairError={repairError}
            executionMode={dataMode}
            candidateCount={dataMode === 'csv' && visibleScenario ? countCsvRepairCandidates(csvContacts, visibleScenario) : null}
            onApproveRepair={approveRepair}
          />
        </section>

        <section className="mt-6 overflow-hidden rounded-[28px] border border-white/10 bg-[#0c1d17]">
          <div className="border-b border-white/10 px-5 py-4 sm:px-6">
            <p className="text-sm text-[#8fa99d]">System lineage</p>
            <h3 className="mt-1 text-lg font-semibold">One auditable path, with every boundary labeled</h3>
          </div>
          <div className="grid divide-y divide-white/10 sm:grid-cols-3 sm:divide-x sm:divide-y-0 xl:grid-cols-6">
            {visibleIntegrations.map((integration) => (
              <div key={integration.name} className="p-5">
                <p className="font-semibold">{integration.name}</p>
                <p className="mt-1 text-xs text-[#81978d]">{integration.role}</p>
                <p className={`mt-4 font-mono text-[10px] uppercase tracking-wider ${integration.tone === 'live' ? 'text-[#cdfc54]' : integration.tone === 'staged' ? 'text-[#e6bd68]' : 'text-[#83bcff]'}`}>{integration.status}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-6 grid gap-5 lg:grid-cols-2">
          <article className="rounded-[28px] border border-white/10 bg-[#0c1d17] p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-[#8fa99d]">dbt quality suite</p>
                <h3 className="mt-1 text-lg font-semibold">Business rules that fail loudly</h3>
              </div>
              <span className="rounded-full bg-[#cdfc54]/10 px-3 py-1 font-mono text-[10px] text-[#cdfc54]">15 / 15 PASS</span>
            </div>
            <div className="mt-5 space-y-2">
              {dbtTests.map(([name, result]) => (
                <div key={name} className="flex items-center justify-between gap-4 rounded-xl bg-white/[0.035] px-4 py-3">
                  <code className="min-w-0 truncate text-xs text-[#b5c6bd]">{name}</code>
                  <span className="shrink-0 font-mono text-[9px] uppercase text-[#cdfc54]">{result}</span>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-[28px] border border-white/10 bg-[#f0f5e8] p-5 text-[#10221a] sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-[#65736b]">Automation trace</p>
                <h3 className="mt-1 text-lg font-semibold">Every decision is explainable</h3>
              </div>
              <span className="font-mono text-[10px] text-[#65736b]">DEMO REPLAY</span>
            </div>
            <div className="mt-5 divide-y divide-[#10221a]/10">
              {activity.map(([time, source, message]) => (
                <div key={`${time}-${source}`} className="grid grid-cols-[54px_86px_1fr] gap-2 py-3 text-xs">
                  <code className="text-[#77847d]">{time}</code>
                  <span className="font-semibold">{source}</span>
                  <span className="leading-5 text-[#55645c]">{message}</span>
                </div>
              ))}
            </div>
          </article>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-3 py-8 text-xs text-[#71877c]">
          <p>Portfolio simulation · no employer or customer data</p>
          <p className="font-mono">HUBSPOT / SALESFORCE → N8N → BIGQUERY → DBT → DECISION</p>
        </footer>
      </div>
    </main>
  );
}

function LiveWarehouseCard({
  state,
  status,
  onRefresh,
}: {
  state: LiveControlTowerState | null;
  status: 'loading' | 'live' | 'offline';
  onRefresh: () => Promise<void>;
}) {
  const latestEvent = state?.latestEventAt
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(state.latestEventAt))
    : 'No event yet';
  return (
    <section className="mb-6 overflow-hidden rounded-[28px] border border-white/10 bg-[#0c1d17]" aria-label="Live warehouse status">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span className={`h-2.5 w-2.5 rounded-full ${status === 'live' ? 'bg-[#cdfc54] shadow-[0_0_18px_rgba(205,252,84,0.55)]' : status === 'loading' ? 'animate-pulse bg-[#e6bd68]' : 'bg-[#ff7b55]'}`} />
          <div>
            <p className="text-sm font-semibold">Live warehouse truth</p>
            <p className="mt-0.5 text-xs text-[#71877c]">n8n queries BigQuery through a server-side connector</p>
          </div>
        </div>
        <button
          onClick={() => void onRefresh()}
          disabled={status === 'loading'}
          className="rounded-full border border-white/10 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-[#a9bbb2] transition hover:bg-white/[0.05] disabled:cursor-wait disabled:opacity-60"
        >
          {status === 'loading' ? 'Refreshing…' : 'Refresh warehouse'}
        </button>
      </div>
      {state ? (
        <div className="grid divide-y divide-white/10 sm:grid-cols-3 sm:divide-x sm:divide-y-0 xl:grid-cols-6">
          <LiveStat label="30-day events" value={state.metrics.totalEvents.toLocaleString()} />
          <LiveStat label="Routed leads" value={state.metrics.routedLeads.toLocaleString()} />
          <LiveStat label="Median routing" value={formatRouteTime(state.metrics.medianRouteSeconds)} />
          <LiveStat label="Quality rate" value={`${state.metrics.qualityRate.toFixed(1)}%`} />
          <LiveStat label="Duplicates seen" value={state.metrics.duplicateEvents.toLocaleString()} warning={state.metrics.duplicateEvents > 0} />
          <LiveStat label="Latest event" value={latestEvent} compact />
        </div>
      ) : (
        <div className="px-5 py-5 text-sm text-[#8fa99d] sm:px-6">
          {status === 'offline' ? 'The live connector is offline; the deterministic walkthrough remains available.' : 'Loading the current BigQuery snapshot…'}
        </div>
      )}
    </section>
  );
}

function LiveStat({ label, value, warning = false, compact = false }: { label: string; value: string; warning?: boolean; compact?: boolean }) {
  return (
    <div className="p-4 sm:p-5">
      <p className="font-mono text-[9px] uppercase tracking-wider text-[#71877c]">{label}</p>
      <p className={`mt-2 font-semibold ${compact ? 'text-sm' : 'text-xl'} ${warning ? 'text-[#ff9d7f]' : 'text-[#e5f1eb]'}`}>{value}</p>
    </div>
  );
}

function FunkyCrmLab({
  mode,
  contacts,
  repairHistory,
  csvFileName,
  csvError,
  bigQueryConfigured,
  hubSpotEligibleCount,
  hubSpotPendingCount,
  hubSpotSyncStatus,
  hubSpotSyncReceipt,
  hubSpotSyncError,
  hubSpotSyncKey,
  hubSpotConfigured,
  salesforceEligibleCount,
  salesforcePendingCount,
  salesforceSyncStatus,
  salesforceSyncReceipt,
  salesforceSyncError,
  salesforceSyncKey,
  salesforceConfigured,
  seedStatus,
  seedReceipt,
  seedError,
  onExport,
  onUseWarehouse,
  onHubSpotSync,
  onHubSpotSyncKeyChange,
  onSalesforceSync,
  onSalesforceSyncKeyChange,
  onReset,
}: {
  mode: 'warehouse' | 'csv';
  contacts: LiveContactState[];
  repairHistory: RepairRun[];
  csvFileName: string | null;
  csvError: string | null;
  bigQueryConfigured: boolean;
  hubSpotEligibleCount: number;
  hubSpotPendingCount: number;
  hubSpotSyncStatus: 'idle' | 'sending' | 'complete' | 'partial' | 'error';
  hubSpotSyncReceipt: HubSpotSyncReceipt | null;
  hubSpotSyncError: string | null;
  hubSpotSyncKey: string;
  hubSpotConfigured: boolean;
  salesforceEligibleCount: number;
  salesforcePendingCount: number;
  salesforceSyncStatus: 'idle' | 'sending' | 'complete' | 'partial' | 'error';
  salesforceSyncReceipt: SalesforceSyncReceipt | null;
  salesforceSyncError: string | null;
  salesforceSyncKey: string;
  salesforceConfigured: boolean;
  seedStatus: 'idle' | 'sending' | 'seeded' | 'error';
  seedReceipt: SeedReceipt | null;
  seedError: string | null;
  onExport: () => void;
  onUseWarehouse: () => void;
  onHubSpotSync: () => Promise<void>;
  onHubSpotSyncKeyChange: (value: string) => void;
  onSalesforceSync: () => Promise<void>;
  onSalesforceSyncKeyChange: (value: string) => void;
  onReset: () => Promise<void>;
}) {
  const active = contacts.filter((contact) => contact.recordStatus === 'active').length;
  const merged = contacts.filter((contact) => contact.recordStatus === 'merged').length;
  const hubSpotResultByContact = new Map(hubSpotSyncReceipt?.records.map((record) => [record.contactId, record]) ?? []);
  const salesforceResultByContact = new Map(salesforceSyncReceipt?.records.map((record) => [record.contactId, record]) ?? []);
  return (
    <section className="mb-6 overflow-hidden rounded-[30px] border border-white/10 bg-[#0c1d17]" aria-label="Funky CRM contact lab">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 px-5 py-5 sm:px-6">
        <div>
          <p className="text-sm text-[#8fa99d]">{mode === 'csv' ? 'Saved contact workspace' : 'Executed-repair lab'}</p>
          <h3 className="mt-1 text-xl font-semibold">{mode === 'csv' ? `${contacts.length} imported contacts · no warehouse required` : 'Ten genuinely funky contacts in mutable BigQuery state'}</h3>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[#71877c]">{mode === 'csv' ? 'Mapped imports, quality flags, repairs, receipts, and undo snapshots persist in the self-hosted SQLite workspace. Explicit destination actions still control every external write.' : 'Duplicates, plus-addressing, malformed email, Unicode, conflicting companies, routing overload, and impossible lifecycle changes. The workers below change these rows and return native execution receipts.'}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <a href="/control-tower-csv-template.csv" download className="rounded-full border border-white/10 px-4 py-2 text-xs font-semibold text-[#a9bbb2] transition hover:bg-white/[0.05]">CSV template</a>
          {mode === 'csv' && <button onClick={onExport} className="rounded-full border border-[#cdfc54]/25 bg-[#cdfc54]/[0.07] px-4 py-2 text-xs font-semibold text-[#cdfc54] transition hover:bg-[#cdfc54]/[0.12]">Export repaired CSV</button>}
          <button
            onClick={() => void onReset()}
            disabled={mode === 'warehouse' && seedStatus === 'sending'}
            className="rounded-full border border-white/10 px-4 py-2 text-xs font-semibold text-[#a9bbb2] transition hover:bg-white/[0.05] disabled:cursor-wait disabled:opacity-60"
          >
            {mode === 'csv' ? 'Reset imported file' : seedStatus === 'sending' ? 'Resetting in BigQuery…' : 'Reset funky batch'}
          </button>
          {mode === 'csv' && bigQueryConfigured && <button onClick={onUseWarehouse} className="rounded-full border border-white/10 px-4 py-2 text-xs font-semibold text-[#a9bbb2] transition hover:bg-white/[0.05]">Use BigQuery demo</button>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-b border-white/10 px-5 py-3 font-mono text-[9px] uppercase tracking-wider text-[#8fa99d] sm:px-6">
        <span className="rounded-full bg-white/[0.05] px-3 py-1">{active} active</span>
        <span className="rounded-full bg-white/[0.05] px-3 py-1">{merged} merged</span>
        <span className="rounded-full bg-white/[0.05] px-3 py-1">{repairHistory.length} executed repairs</span>
        {mode === 'csv' && csvFileName && <span className="rounded-full bg-[#83bcff]/10 px-3 py-1 text-[#83bcff]">{csvFileName}</span>}
        {mode === 'warehouse' && seedReceipt && <span className="rounded-full bg-[#cdfc54]/10 px-3 py-1 text-[#cdfc54]">Receipt: {seedReceipt.contacts} seeded / {seedReceipt.dirtyRecords} dirty</span>}
        {mode === 'warehouse' && seedError && <span className="rounded-full bg-[#ff7b55]/10 px-3 py-1 text-[#ff9d7f]">{seedError}</span>}
        {csvError && <span className="rounded-full bg-[#ff7b55]/10 px-3 py-1 text-[#ff9d7f]">{csvError}</span>}
      </div>
      {mode === 'csv' && (hubSpotConfigured || salesforceConfigured) && (
        <div className={`grid border-b border-white/10 ${hubSpotConfigured && salesforceConfigured ? 'xl:grid-cols-2 xl:divide-x xl:divide-white/10' : ''}`}>
          {hubSpotConfigured && <HubSpotSyncPanel
            eligibleCount={hubSpotEligibleCount}
            heldCount={contacts.length - hubSpotEligibleCount}
            pendingCount={hubSpotPendingCount}
            status={hubSpotSyncStatus}
            receipt={hubSpotSyncReceipt}
            error={hubSpotSyncError}
            accessKey={hubSpotSyncKey}
            onAccessKeyChange={onHubSpotSyncKeyChange}
            onSync={onHubSpotSync}
          />}
          {salesforceConfigured && <SalesforceSyncPanel
            eligibleCount={salesforceEligibleCount}
            heldCount={contacts.length - salesforceEligibleCount}
            pendingCount={salesforcePendingCount}
            status={salesforceSyncStatus}
            receipt={salesforceSyncReceipt}
            error={salesforceSyncError}
            accessKey={salesforceSyncKey}
            onAccessKeyChange={onSalesforceSyncKeyChange}
            onSync={onSalesforceSync}
          />}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] border-collapse text-left text-xs">
          <thead className="bg-white/[0.025] font-mono text-[9px] uppercase tracking-wider text-[#71877c]">
            <tr>
              <th className="px-5 py-3 font-medium">Contact</th>
              <th className="px-4 py-3 font-medium">Raw → normalized email</th>
              <th className="px-4 py-3 font-medium">Company</th>
              <th className="px-4 py-3 font-medium">Lifecycle</th>
              <th className="px-4 py-3 font-medium">Owner</th>
              <th className="px-4 py-3 font-medium">Current result</th>
              <th className="px-5 py-3 font-medium">Quality flags</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {contacts.map((contact) => (
              <tr key={contact.contactId} className={contact.recordStatus === 'merged' ? 'bg-[#83bcff]/[0.04] text-[#92a69c]' : 'text-[#dce9e2]'}>
                <td className="px-5 py-3.5 align-top">
                  <p className="font-semibold">{contact.fullName}</p>
                  <p className="mt-1 font-mono text-[9px] text-[#71877c]">{contact.contactId}</p>
                </td>
                <td className="px-4 py-3.5 align-top">
                  <p className="max-w-[240px] break-all">{contact.rawEmail}</p>
                  <p className="mt-1 break-all font-mono text-[9px] text-[#7fddb6]">→ {contact.normalizedEmail ?? 'invalid / held'}</p>
                </td>
                <td className="max-w-[170px] px-4 py-3.5 align-top">
                  <p>{contact.company ?? '— missing —'}</p>
                  {contact.jobTitle && <p className="mt-1 text-[10px] text-[#71877c]">{contact.jobTitle}</p>}
                  {contact.phone && <p className="mt-1 font-mono text-[9px] text-[#71877c]">{contact.phone}</p>}
                </td>
                <td className="px-4 py-3.5 align-top">
                  <p className={contact.lifecycleStage !== contact.expectedLifecycleStage ? 'text-[#ff9d7f]' : ''}>{contact.lifecycleStage}</p>
                  {contact.lifecycleStage !== contact.expectedLifecycleStage && <p className="mt-1 font-mono text-[9px] text-[#cdfc54]">expected {contact.expectedLifecycleStage}</p>}
                </td>
                <td className="px-4 py-3.5 align-top font-mono text-[10px]">{contact.ownerId ?? 'UNASSIGNED'}</td>
                <td className="px-4 py-3.5 align-top">
                  <p className={contact.recordStatus === 'merged' ? 'text-[#83bcff]' : 'text-[#cdfc54]'}>{contact.recordStatus}</p>
                  <p className="mt-1 font-mono text-[9px] text-[#71877c]">{contact.lastAction.replaceAll('_', ' ')}</p>
                  {contact.canonicalContactId && <p className="mt-1 font-mono text-[9px] text-[#83bcff]">→ {contact.canonicalContactId}</p>}
                  {hubSpotResultByContact.get(contact.contactId) && (
                    <p className={`mt-2 font-mono text-[9px] ${hubSpotResultByContact.get(contact.contactId)?.status === 'synced' ? 'text-[#cdfc54]' : 'text-[#ff9d7f]'}`}>
                      HubSpot {hubSpotResultByContact.get(contact.contactId)?.status}{hubSpotResultByContact.get(contact.contactId)?.hubSpotId ? ` · ${hubSpotResultByContact.get(contact.contactId)?.hubSpotId}` : ''}
                    </p>
                  )}
                  {salesforceResultByContact.get(contact.contactId) && (
                    <p className={`mt-1 font-mono text-[9px] ${salesforceResultByContact.get(contact.contactId)?.status !== 'failed' ? 'text-[#83bcff]' : 'text-[#ff9d7f]'}`}>
                      Salesforce {salesforceResultByContact.get(contact.contactId)?.status}{salesforceResultByContact.get(contact.contactId)?.salesforceId ? ` · ${salesforceResultByContact.get(contact.contactId)?.salesforceId}` : ''}
                    </p>
                  )}
                </td>
                <td className="px-5 py-3.5 align-top">
                  <div className="flex max-w-[230px] flex-wrap gap-1">
                    {contact.qualityFlags.length ? contact.qualityFlags.map((flag) => (
                      <span key={flag} className="rounded bg-[#ff7b55]/10 px-2 py-1 font-mono text-[8px] text-[#ff9d7f]">{flag.replaceAll('_', ' ')}</span>
                    )) : <span className="font-mono text-[9px] text-[#7fddb6]">clean</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!contacts.length && <p className="px-5 py-5 text-sm text-[#8fa99d] sm:px-6">Import a CSV or reset the synthetic batch to load contact state.</p>}
      {repairHistory.length ? (
        <div className="flex flex-wrap gap-2 border-t border-white/10 px-5 py-4 sm:px-6">
          {repairHistory.slice(0, 3).map((run) => (
            <span key={run.runId} className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-2 font-mono text-[9px] text-[#a9bbb2]">
              {run.scenario} · {run.affectedRecords} rows · executed
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function HubSpotSyncPanel({
  eligibleCount,
  heldCount,
  pendingCount,
  status,
  receipt,
  error,
  accessKey,
  onAccessKeyChange,
  onSync,
}: {
  eligibleCount: number;
  heldCount: number;
  pendingCount: number;
  status: 'idle' | 'sending' | 'complete' | 'partial' | 'error';
  receipt: HubSpotSyncReceipt | null;
  error: string | null;
  accessKey: string;
  onAccessKeyChange: (value: string) => void;
  onSync: () => Promise<void>;
}) {
  const failedRecords = receipt?.records.filter((record) => record.status === 'failed') ?? [];
  const batchCount = Math.min(100, pendingCount);
  return (
    <div className="border-b border-white/10 bg-[#07130f]/55 px-5 py-5 sm:px-6">
      <div className="grid gap-5 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">Governed HubSpot destination</p>
            <span className="rounded-full bg-[#cdfc54]/10 px-3 py-1 font-mono text-[9px] uppercase text-[#cdfc54]">Upsert by email</span>
          </div>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[#71877c]">{eligibleCount} clean active contacts qualify; {heldCount} merged or unresolved rows stay out. Each click writes at most 100 contacts and returns a result for every email. Portable fields: name, company, phone, job title, and website.</p>
          <p className="mt-1 text-[10px] leading-5 text-[#566b61]">Lifecycle and symbolic owner routes remain local because safely changing those fields requires reading each portal’s current stages and owner IDs first.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2 lg:justify-end">
          <label className="grid gap-1 font-mono text-[8px] uppercase tracking-wider text-[#71877c]">
            Access key · if configured
            <input
              type="password"
              value={accessKey}
              onChange={(event) => onAccessKeyChange(event.target.value)}
              autoComplete="off"
              className="w-44 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-xs normal-case tracking-normal text-[#dce9e2] outline-none focus:border-[#83bcff]/50"
            />
          </label>
          <button
            onClick={() => void onSync()}
            disabled={status === 'sending' || pendingCount === 0}
            className="rounded-full bg-[#cdfc54] px-5 py-3 text-xs font-bold text-[#07130f] transition hover:bg-[#dcff83] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === 'sending' ? 'Writing to HubSpot…' : pendingCount ? `Sync ${batchCount}${pendingCount > 100 ? ` of ${pendingCount}` : ''} to HubSpot` : eligibleCount ? 'All clean contacts synced' : 'Fix held records first'}
          </button>
        </div>
      </div>
      <div aria-live="polite" className="mt-4">
        {receipt && (
          <div className={`rounded-2xl border px-4 py-3 text-xs ${receipt.failed ? 'border-[#e6bd68]/25 bg-[#e6bd68]/[0.06] text-[#e6cf95]' : 'border-[#cdfc54]/20 bg-[#cdfc54]/[0.06] text-[#bfe57d]'}`}>
            <span className="font-semibold">HubSpot receipt:</span> {receipt.synced} synced · {receipt.failed} failed · {pendingCount} still pending
            <span className="ml-2 font-mono text-[9px] text-[#71877c]">{receipt.syncId}</span>
          </div>
        )}
        {error && <div className="rounded-2xl border border-[#ff7b55]/25 bg-[#ff7b55]/[0.06] px-4 py-3 text-xs text-[#ff9d7f]">{error} No unreceipted batch is shown as complete.</div>}
        {failedRecords.length > 0 && (
          <div className="mt-2 space-y-1 font-mono text-[9px] text-[#ff9d7f]">
            {failedRecords.slice(0, 3).map((record) => <p key={record.contactId}>{record.email}: {record.error}</p>)}
          </div>
        )}
      </div>
    </div>
  );
}

function SalesforceSyncPanel({
  eligibleCount,
  heldCount,
  pendingCount,
  status,
  receipt,
  error,
  accessKey,
  onAccessKeyChange,
  onSync,
}: {
  eligibleCount: number;
  heldCount: number;
  pendingCount: number;
  status: 'idle' | 'sending' | 'complete' | 'partial' | 'error';
  receipt: SalesforceSyncReceipt | null;
  error: string | null;
  accessKey: string;
  onAccessKeyChange: (value: string) => void;
  onSync: () => Promise<void>;
}) {
  const failedRecords = receipt?.records.filter((record) => record.status === 'failed') ?? [];
  const batchCount = Math.min(100, pendingCount);
  return (
    <div className="bg-[#07130f]/55 px-5 py-5 sm:px-6">
      <div className="grid gap-5 lg:grid-cols-[1fr_auto] lg:items-end xl:grid-cols-1">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">Governed Salesforce destination</p>
            <span className="rounded-full bg-[#83bcff]/10 px-3 py-1 font-mono text-[9px] uppercase text-[#83bcff]">Lead · match by email</span>
          </div>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[#71877c]">{eligibleCount} clean active contacts qualify; {heldCount} rows stay out. Company and last name are required. One email match is updated, no match is created, and duplicate Lead matches are held for review.</p>
          <p className="mt-1 text-[10px] leading-5 text-[#566b61]">Portable standard fields only: email, name, company, phone, title, and website. Owner, status, score, and custom fields remain untouched.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2 lg:justify-end xl:justify-start">
          <label className="grid gap-1 font-mono text-[8px] uppercase tracking-wider text-[#71877c]">
            Access key · if configured
            <input
              type="password"
              value={accessKey}
              onChange={(event) => onAccessKeyChange(event.target.value)}
              autoComplete="off"
              className="w-44 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2.5 text-xs normal-case tracking-normal text-[#dce9e2] outline-none focus:border-[#83bcff]/50"
            />
          </label>
          <button
            onClick={() => void onSync()}
            disabled={status === 'sending' || pendingCount === 0}
            className="rounded-full bg-[#83bcff] px-5 py-3 text-xs font-bold text-[#07130f] transition hover:bg-[#a7d0ff] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === 'sending' ? 'Writing to Salesforce…' : pendingCount ? `Sync ${batchCount}${pendingCount > 100 ? ` of ${pendingCount}` : ''} to Salesforce` : eligibleCount ? 'All clean Leads synced' : 'Fix held records first'}
          </button>
        </div>
      </div>
      <div aria-live="polite" className="mt-4">
        {receipt && (
          <div className={`rounded-2xl border px-4 py-3 text-xs ${receipt.failed ? 'border-[#e6bd68]/25 bg-[#e6bd68]/[0.06] text-[#e6cf95]' : 'border-[#83bcff]/20 bg-[#83bcff]/[0.06] text-[#a7d0ff]'}`}>
            <span className="font-semibold">Salesforce receipt:</span> {receipt.created} created · {receipt.updated} updated · {receipt.failed} failed · {pendingCount} pending
            <span className="ml-2 font-mono text-[9px] text-[#71877c]">{receipt.syncId}</span>
          </div>
        )}
        {error && <div className="rounded-2xl border border-[#ff7b55]/25 bg-[#ff7b55]/[0.06] px-4 py-3 text-xs text-[#ff9d7f]">{error} No unreceipted batch is shown as complete.</div>}
        {failedRecords.length > 0 && (
          <div className="mt-2 space-y-1 font-mono text-[9px] text-[#ff9d7f]">
            {failedRecords.slice(0, 3).map((record) => <p key={record.contactId}>{record.email}: {record.error}</p>)}
          </div>
        )}
      </div>
    </div>
  );
}

function ProofPoint({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
      <p className="font-mono text-[9px] uppercase tracking-wider text-[#70857b]">{label}</p>
      <p className={`mt-2 text-sm font-medium ${muted ? 'text-[#d8bd78]' : 'text-[#dceae3]'}`}>{value}</p>
    </div>
  );
}

function TransformationCard({ demoStage }: { demoStage: number }) {
  const enriched = demoStage >= 1;
  const routed = demoStage >= 2;
  return (
    <article className="rounded-[30px] border border-white/10 bg-[#f0f5e8] p-5 text-[#10221a] sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-[#637169]">Record transformation</p>
          <h3 className="mt-1 text-xl font-semibold">Messy in. Account-ready out.</h3>
        </div>
        <span className="rounded-full bg-[#10221a]/[0.06] px-3 py-1 font-mono text-[10px] text-[#637169]">CONTACT 04 / 10</span>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_32px_1fr] sm:items-stretch">
        <RecordPanel title="Raw CRM record" tone="bad" rows={[
          ['company', ' North Star Robotics, INC. '],
          ['domain', 'HTTPS://WWW.NORTHSTAR.AI/'],
          ['annual_revenue', '$42M'],
          ['owner', '(blank)'],
        ]} />
        <div className="grid place-items-center text-xl text-[#758179]" aria-hidden="true">→</div>
        <RecordPanel title="Governed record" tone="good" rows={[
          ['account', enriched ? 'Northstar Robotics' : '—'],
          ['domain', enriched ? 'northstar.ai' : '—'],
          ['segment / score', enriched ? 'Enterprise · 92' : '—'],
          ['route', routed ? 'Enterprise East' : '—'],
        ]} />
      </div>
    </article>
  );
}

function RecordPanel({ title, rows, tone }: { title: string; rows: string[][]; tone: 'bad' | 'good' }) {
  return (
    <div className={`rounded-2xl border p-4 ${tone === 'bad' ? 'border-[#d97757]/20 bg-[#fff6ef]' : 'border-[#2f956c]/20 bg-[#e9f5ed]'}`}>
      <p className={`font-mono text-[9px] uppercase tracking-wider ${tone === 'bad' ? 'text-[#b05a40]' : 'text-[#2f7659]'}`}>{title}</p>
      <dl className="mt-3 space-y-2.5">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[112px_1fr] gap-2 text-[11px] sm:grid-cols-[96px_1fr]">
            <dt className="font-mono text-[#7b8780]">{label}</dt>
            <dd className="min-w-0 break-words font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RunOutcomeCard({ summary, demoStage }: { summary: ReturnType<typeof demoRunSummary>; demoStage: number }) {
  const checks = [
    ['Duplicate root domain', demoStage >= 3 ? 'contained' : 'waiting', 'northstar.ai appears twice'],
    ['Lifecycle regression', demoStage >= 3 ? 'blocked' : 'waiting', 'Customer → MQL rejected'],
    ['Missing identity', demoStage >= 3 ? 'review' : 'waiting', 'personal email, no company'],
  ];
  return (
    <article className="rounded-[30px] border border-white/10 bg-[#0c1d17] p-5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-[#8fa99d]">Control outcomes</p>
          <h3 className="mt-1 text-xl font-semibold">Bad data becomes visible—not viral</h3>
        </div>
        <span className={`rounded-full px-3 py-1 font-mono text-[10px] ${summary.diagnosisReady ? 'bg-[#cdfc54]/10 text-[#cdfc54]' : 'bg-white/[0.05] text-[#8fa99d]'}`}>{summary.diagnosisReady ? 'DIAGNOSIS READY' : 'AWAITING RUN'}</span>
      </div>
      <div className="mt-5 grid grid-cols-4 gap-2">
        <OutcomeStat value={summary.received} label="received" />
        <OutcomeStat value={summary.enriched} label="enriched" />
        <OutcomeStat value={summary.routed} label="routed" />
        <OutcomeStat value={summary.quarantined} label="held" warning />
      </div>
      <div className="mt-5 space-y-2">
        {checks.map(([label, status, detail]) => (
          <div key={label} className="grid gap-1 rounded-xl border border-white/[0.06] bg-white/[0.025] px-4 py-3 sm:grid-cols-[1fr_auto] sm:gap-4">
            <div>
              <p className="text-xs font-semibold text-[#cbdad2]">{label}</p>
              <p className="mt-1 text-[11px] text-[#71877c]">{detail}</p>
            </div>
            <span className={`self-center font-mono text-[9px] uppercase ${status === 'waiting' ? 'text-[#566b61]' : status === 'review' ? 'text-[#e6bd68]' : 'text-[#cdfc54]'}`}>{status}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function OutcomeStat({ value, label, warning = false }: { value: number; label: string; warning?: boolean }) {
  return (
    <div className="rounded-xl bg-white/[0.035] p-3 text-center">
      <p className={`text-xl font-semibold ${warning && value > 0 ? 'text-[#ff9d7f]' : 'text-white'}`}>{value}</p>
      <p className="mt-1 font-mono text-[8px] uppercase tracking-wider text-[#71877c]">{label}</p>
    </div>
  );
}

function FunnelCard({ funnel, source }: { funnel: ReturnType<typeof funnelForScenario>; source: 'csv' | 'warehouse' | 'simulation' }) {
  const title = source === 'csv' ? 'Imported-contact funnel' : source === 'warehouse' ? 'Live trusted funnel' : 'Scenario funnel model';
  const badge = source === 'csv' ? 'LOCAL CSV' : source === 'warehouse' ? 'BIGQUERY · 30 DAYS' : 'SIMULATED OVERLAY';
  return (
    <article className="rounded-[30px] border border-white/10 bg-[#0c1d17] p-5 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-[#8fa99d]">{title}</p>
          <h3 className="mt-1 text-xl font-semibold">Accepted events only</h3>
        </div>
        <span className={`font-mono text-[10px] ${source === 'warehouse' ? 'text-[#cdfc54]' : source === 'csv' ? 'text-[#83bcff]' : 'text-[#8fa99d]'}`}>{badge}</span>
      </div>
      <div className="mt-8 grid grid-cols-5 items-end gap-2 sm:gap-4">
        {funnel.map((stage) => (
          <div key={stage.label} className="flex min-w-0 flex-col justify-end gap-3">
            <div className="rounded-xl bg-gradient-to-t from-[#1f4939] to-[#cdfc54] transition-all" style={{ height: `${Math.max(38, stage.conversion * 1.75)}px` }} />
            <div>
              <p className="truncate font-mono text-[9px] uppercase tracking-wide text-[#8fa99d] sm:text-[11px]">{stage.label}</p>
              <p className="mt-1 text-sm font-semibold sm:text-lg">{stage.count.toLocaleString()}</p>
              <p className="mt-1 hidden font-mono text-[9px] text-[#71877c] sm:block">{stage.conversion.toFixed(1)}%</p>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function IncidentCard({
  activeScenario,
  repaired,
  repairStatus,
  repairReceipt,
  repairError,
  executionMode,
  candidateCount,
  onApproveRepair,
}: {
  activeScenario: ScenarioKey | null;
  repaired: boolean;
  repairStatus: 'idle' | 'sending' | 'executed' | 'error';
  repairReceipt: RepairReceipt | null;
  repairError: string | null;
  executionMode: 'warehouse' | 'csv';
  candidateCount: number | null;
  onApproveRepair: () => Promise<void>;
}) {
  const baseActive = activeScenario ? scenarios[activeScenario] : null;
  const active = baseActive && executionMode === 'csv' && candidateCount !== null
    ? { ...baseActive, detail: csvIncidentDetail(activeScenario, candidateCount) }
    : baseActive;
  const incidentRows = active ? [active, ...baselineIncidents] : baselineIncidents;
  return (
    <article className="rounded-[30px] border border-white/10 bg-[#f0f5e8] p-5 text-[#10221a] sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-[#637169]">What is broken?</p>
          <h3 className="mt-1 text-xl font-semibold">Revenue impact, then repair</h3>
        </div>
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full font-semibold text-white ${active ? 'bg-[#ff7b55]' : 'bg-[#2f956c]'}`}>{active ? incidentRows.length : repaired ? '✓' : incidentRows.length}</span>
      </div>
      {active && (
        <div className="mt-5 rounded-2xl border border-[#d97757]/20 bg-[#fff1e9] p-4">
          <p className="font-mono text-[9px] uppercase tracking-wider text-[#b05a40]">Revenue consequence</p>
          <p data-testid="health-headline" className="mt-2 text-sm font-semibold leading-5">{healthHeadline(active.scenario)}</p>
        </div>
      )}
      {repaired && repairReceipt && (
        <div data-testid="repair-success" className="mt-5 rounded-2xl border border-[#2f956c]/25 bg-[#dff2e8] p-4 text-sm text-[#236b50]">
          <p className="font-semibold">{executionMode === 'csv' ? 'The local worker executed in this browser tab.' : 'n8n executed the repair against BigQuery.'}</p>
          <p className="mt-1 text-xs leading-5">{repairReceipt.affectedRecords} records changed · {repairReceipt.action.replaceAll('_', ' ')} · Receipt {repairReceipt.eventId}</p>
        </div>
      )}
      {repairStatus === 'error' && repairError && (
        <div className="mt-5 rounded-2xl border border-[#d97757]/25 bg-[#fff1e9] p-4 text-sm text-[#9a452f]">
          {repairError} No repair was reported as complete.
        </div>
      )}
      <div className="mt-4 space-y-3">
        {incidentRows.map((incident) => (
          <div key={incident.id} className="rounded-2xl border border-[#10221a]/10 bg-white/70 p-4">
            <div className="flex items-start gap-3">
              <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${incident.severity === 'critical' ? 'bg-[#ff5f45]' : incident.severity === 'warning' ? 'bg-[#e6a62c]' : 'bg-[#2f956c]'}`} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{incident.title}</p>
                <p className="mt-1 text-xs leading-5 text-[#637169]">{incident.detail}</p>
                {'recommendation' in incident && active && incident.id === active.id && (
                  <div className="mt-3 border-t border-[#10221a]/10 pt-3">
                    <p className="text-xs leading-5 text-[#43534a]">{typeof incident.recommendation === 'string' ? incident.recommendation : ''}</p>
                    <button
                      data-testid="approve-repair"
                      onClick={() => void onApproveRepair()}
                      disabled={repairStatus === 'sending'}
                      className="mt-3 rounded-full bg-[#10221a] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#234234] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#10221a] disabled:cursor-wait disabled:opacity-65"
                    >
                      {repairStatus === 'sending' ? 'Executing in n8n…' : repairButtonLabel(activeScenario)}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function repairButtonLabel(scenario: ScenarioKey | null): string {
  if (scenario === 'duplicate-surge') return 'Execute merge worker';
  if (scenario === 'routing-overload') return 'Execute reroute worker';
  if (scenario === 'stage-regression') return 'Execute lifecycle replay';
  return 'Execute repair worker';
}

function csvIncidentDetail(scenario: ScenarioKey | null, count: number): string {
  const rows = `${count} imported ${count === 1 ? 'row' : 'rows'}`;
  if (scenario === 'duplicate-surge') return `${rows} will be logically merged into canonical identities.`;
  if (scenario === 'routing-overload') return `${rows} match the Northeast enterprise overflow rule.`;
  if (scenario === 'stage-regression') return `${rows} will be restored to their expected lifecycle stage.`;
  return `${rows} match this repair.`;
}
