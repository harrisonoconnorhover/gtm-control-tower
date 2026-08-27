'use client';

import { useMemo, useRef, useState } from 'react';
import {
  csvFieldLabels,
  isDestinationReadyContact,
  previewContactsCsv,
  type CsvColumnMapping,
  type CsvFieldKey,
  type CsvPreview,
} from '@/lib/csv-control-tower';
import type { ConnectorCatalog, ConnectorId, ConnectorReceipt } from '@/lib/connector-contract';
import type { CrmSourcePreview } from '@/lib/crm-source';
import { tabularRowsToCsv, type GoogleSheetsPreview } from '@/lib/google-sheets';
import type { LiveContactState } from '@/lib/live-control-tower';
import { messyLeadDemoCsv } from '@/lib/messy-lead-demo';
import type { MappingPreset } from '@/lib/workspace';

const mappingOrder: CsvFieldKey[] = [
  'rawEmail', 'fullName', 'firstName', 'lastName', 'company', 'phone', 'jobTitle', 'website',
  'region', 'segment', 'lifecycleStage', 'expectedLifecycleStage', 'ownerId', 'contactId',
  'normalizedEmail', 'canonicalContactId', 'recordStatus', 'lastAction', 'qualityFlags',
];

type Props = {
  catalog: ConnectorCatalog | null;
  contacts: LiveContactState[];
  sourceType: ConnectorId;
  destinationType: ConnectorId;
  mapping: CsvColumnMapping;
  presets: MappingPreset[];
  workspaceRevision: number | null;
  persistenceStatus: 'loading' | 'saved' | 'saving' | 'disabled' | 'error';
  lastReceipt: ConnectorReceipt | null;
  onMappedImport: (csv: string, fileName: string, mapping: CsvColumnMapping, source: ConnectorId) => Promise<void>;
  onSourceChange: (source: ConnectorId) => void;
  onDestinationChange: (destination: ConnectorId) => void;
  onSavePreset: (name: string, mapping: CsvColumnMapping) => Promise<void>;
  onUndo: () => Promise<void>;
  onExport: () => void;
  onReceipt: (receipt: ConnectorReceipt) => Promise<void>;
};

export function SelfHostConsole({
  catalog,
  contacts,
  sourceType,
  destinationType,
  mapping,
  presets,
  workspaceRevision,
  persistenceStatus,
  lastReceipt,
  onMappedImport,
  onSourceChange,
  onDestinationChange,
  onSavePreset,
  onUndo,
  onExport,
  onReceipt,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [rawCsv, setRawCsv] = useState<string | null>(null);
  const [rawName, setRawName] = useState('imported-contacts.csv');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [draftMapping, setDraftMapping] = useState<CsvColumnMapping>(mapping);
  const [presetName, setPresetName] = useState('My CRM export');
  const [sourceSpreadsheet, setSourceSpreadsheet] = useState('');
  const [sourceSheet, setSourceSheet] = useState('Sheet1');
  const [destinationSpreadsheet, setDestinationSpreadsheet] = useState('');
  const [crmImportLimit, setCrmImportLimit] = useState(100);
  const [status, setStatus] = useState<'idle' | 'working' | 'ready' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const configured = catalog?.connectors.filter((connector) => connector.configured) ?? [];
  const sources = configured.filter((connector) => connector.directions.includes('source'));
  const destinations = configured.filter((connector) => connector.directions.includes('destination'));
  const hiddenCount = (catalog?.connectors.length ?? 1) - configured.length;
  const activeRows = useMemo(() => contacts.filter((contact) => contact.recordStatus === 'active'), [contacts]);
  const readyRows = useMemo(() => contacts.filter(isDestinationReadyContact), [contacts]);
  const heldRows = activeRows.length - readyRows.length;
  const currentPhase = lastReceipt?.phase ?? (contacts.length ? 'validate' : preview ? 'preview' : null);

  async function prepareCsv(csv: string, fileName: string) {
    try {
      const nextPreview = previewContactsCsv(csv);
      setRawCsv(csv);
      setRawName(fileName);
      setPreview(nextPreview);
      setDraftMapping(nextPreview.suggestedMapping);
      setStatus('ready');
      setMessage(`${nextPreview.sourceRows.toLocaleString()} rows ready to map.`);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'That table could not be previewed.');
    }
  }

  async function readCsv(file: File) {
    setStatus('working');
    setMessage(null);
    if (file.size > 10 * 1024 * 1024) {
      setStatus('error');
      setMessage('Use a CSV smaller than 10 MB.');
      return;
    }
    await prepareCsv(await file.text(), file.name);
  }

  async function previewGoogleSheet() {
    setStatus('working');
    setMessage(null);
    try {
      const response = await fetch('/api/control-tower/google-sheets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'preview',
          spreadsheetId: extractSpreadsheetId(sourceSpreadsheet),
          sourceSheet,
        }),
      });
      const result = await response.json() as GoogleSheetsPreview | { error?: string };
      if (!response.ok || !('rows' in result)) throw new Error('error' in result ? result.error : 'Google Sheets preview failed.');
      const csv = tabularRowsToCsv(result.headers, result.rows);
      await onReceipt(result.receipt);
      await prepareCsv(csv, `${sourceSheet}.google-sheet.csv`);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Google Sheets preview failed.');
    }
  }

  async function previewCrm() {
    if (sourceType !== 'hubspot' && sourceType !== 'salesforce') return;
    setStatus('working');
    setMessage(null);
    try {
      const response = await fetch('/api/control-tower/crm-source', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectorId: sourceType, limit: crmImportLimit }),
      });
      const result = await response.json() as CrmSourcePreview | { error?: string };
      if (!response.ok || !('csv' in result)) throw new Error('error' in result ? result.error : 'CRM preview failed.');
      await prepareCsv(result.csv, `${sourceType}-contacts-${result.readAt.slice(0, 10)}.csv`);
      setMessage(`${result.contacts.length} ${result.sourceLabel} read into a local preview${result.truncated ? ' (sample cap reached)' : ''}. Validate the mapping before anything can write.`);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'CRM preview failed.');
    }
  }

  async function importMappedData() {
    if (!rawCsv || !preview) return;
    setStatus('working');
    try {
      await onMappedImport(rawCsv, rawName, draftMapping, sourceType);
      setStatus('ready');
      setMessage(`${preview.sourceRows.toLocaleString()} mapped rows validated and loaded.`);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'The mapped data could not be imported.');
    }
  }

  async function writeGoogleSheet() {
    setStatus('working');
    setMessage(null);
    try {
      const response = await fetch('/api/control-tower/google-sheets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'execute',
          spreadsheetId: extractSpreadsheetId(destinationSpreadsheet),
          destinationSheet: 'GTM Clean',
          contacts: readyRows.slice(0, 1_000),
        }),
      });
      const result = await response.json() as { receipt?: ConnectorReceipt; error?: string };
      if (!response.ok || !result.receipt) throw new Error(result.error ?? 'Google Sheets write failed.');
      await onReceipt(result.receipt);
      setStatus('ready');
      setMessage(result.receipt.summary);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Google Sheets write failed.');
    }
  }

  return (
    <section className="mb-6 overflow-hidden rounded-[30px] border border-[#83bcff]/20 bg-[#0b1b19]" aria-label="Self-hosted workspace setup">
      <div className="grid gap-6 border-b border-white/10 px-5 py-5 lg:grid-cols-[1fr_1fr_auto] lg:items-end sm:px-6">
        <label className="grid gap-2 text-xs font-semibold text-[#9cb0a7]">
          Where is your data?
          <select value={sourceType} onChange={(event) => onSourceChange(event.target.value as ConnectorId)} className="rounded-2xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm text-[#e5f1eb] outline-none focus:border-[#83bcff]/50">
            {sources.map((connector) => <option key={connector.id} value={connector.id}>{connector.label}</option>)}
          </select>
        </label>
        <label className="grid gap-2 text-xs font-semibold text-[#9cb0a7]">
          Where should clean records go?
          <select value={destinationType} onChange={(event) => onDestinationChange(event.target.value as ConnectorId)} className="rounded-2xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm text-[#e5f1eb] outline-none focus:border-[#83bcff]/50">
            {destinations.map((connector) => <option key={connector.id} value={connector.id}>{connector.label}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          <button onClick={() => void onUndo()} disabled={!workspaceRevision || persistenceStatus === 'disabled'} className="rounded-full border border-white/10 px-4 py-2 text-xs text-[#a9bbb2] disabled:opacity-40">Undo saved change</button>
          {contacts.length > 0 && <button onClick={onExport} className="rounded-full border border-[#cdfc54]/25 px-4 py-2 text-xs font-semibold text-[#cdfc54]">Export CSV</button>}
        </div>
      </div>

      <div className="grid gap-5 px-5 py-5 lg:grid-cols-[0.8fr_1.2fr] sm:px-6">
        <div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-wider text-[#83bcff]">Source</p>
              <h3 className="mt-1 text-lg font-semibold">{sourceType === 'google-sheets' ? 'Preview a worksheet' : sourceType === 'csv' ? 'Choose a CSV' : `Preview ${sourceType === 'hubspot' ? 'contacts' : 'active Leads'}`}</h3>
            </div>
            <span className={`rounded-full px-3 py-1 font-mono text-[9px] uppercase ${persistenceStatus === 'saved' ? 'bg-[#cdfc54]/10 text-[#cdfc54]' : persistenceStatus === 'disabled' ? 'bg-white/[0.06] text-[#71877c]' : 'bg-[#e6bd68]/10 text-[#e6bd68]'}`}>
              {persistenceStatus === 'disabled' ? 'Session only' : workspaceRevision === null ? persistenceStatus : `SQLite r${workspaceRevision} · ${persistenceStatus}`}
            </span>
          </div>

          {sourceType === 'csv' && (
            <div className="mt-4">
              <input ref={fileInput} type="file" accept=".csv,text/csv" className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void readCsv(file); event.currentTarget.value = ''; }} />
              <button onClick={() => fileInput.current?.click()} className="w-full rounded-2xl border border-dashed border-[#83bcff]/30 bg-[#83bcff]/[0.05] px-5 py-6 text-sm font-semibold text-[#83bcff] hover:bg-[#83bcff]/10">Choose CSV to preview</button>
              <button onClick={() => void prepareCsv(messyLeadDemoCsv(), 'gtm-control-tower-messy-leads-64.csv')} className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.035] px-5 py-3 text-xs font-semibold text-[#a9bbb2] hover:bg-white/[0.06]">Or load the bundled 64-row practice batch</button>
            </div>
          )}

          {sourceType === 'google-sheets' && (
            <div className="mt-4 grid gap-3">
              <input value={sourceSpreadsheet} onChange={(event) => setSourceSpreadsheet(event.target.value)} placeholder="Google Sheet URL or spreadsheet ID" className="rounded-2xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm outline-none focus:border-[#83bcff]/50" />
              <input value={sourceSheet} onChange={(event) => setSourceSheet(event.target.value)} placeholder="Source worksheet, e.g. Leads" className="rounded-2xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm outline-none focus:border-[#83bcff]/50" />
              <button onClick={() => void previewGoogleSheet()} disabled={status === 'working'} className="rounded-2xl bg-[#83bcff] px-5 py-3 text-sm font-bold text-[#07130f] disabled:opacity-50">Read through n8n</button>
            </div>
          )}

          {(sourceType === 'hubspot' || sourceType === 'salesforce') && (
            <div className="mt-4 grid gap-3">
              <label className="grid gap-1 font-mono text-[8px] uppercase tracking-wider text-[#71877c]">
                Maximum records · 1–500
                <input type="number" min={1} max={500} value={crmImportLimit} onChange={(event) => setCrmImportLimit(Math.max(1, Math.min(500, Number(event.target.value) || 1)))} className="rounded-2xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm normal-case tracking-normal outline-none focus:border-[#83bcff]/50" />
              </label>
              <button onClick={() => void previewCrm()} disabled={status === 'working'} className="rounded-2xl bg-[#83bcff] px-5 py-3 text-sm font-bold text-[#07130f] disabled:opacity-50">{status === 'working' ? 'Reading CRM…' : `Read from ${sourceType === 'hubspot' ? 'HubSpot' : 'Salesforce'}`}</button>
              <p className="text-[10px] leading-5 text-[#566b61]">Read-only source access creates a local preview. It does not modify the CRM.</p>
            </div>
          )}

          {destinationType === 'google-sheets' && contacts.length > 0 && (
            <div className="mt-5 border-t border-white/10 pt-5">
              <p className="text-xs font-semibold">Google Sheets destination</p>
              <p className="mt-1 text-[11px] leading-5 text-[#71877c]">n8n queues Sheets writes one at a time and upserts up to 1,000 destination-ready records to the separate <strong className="text-[#a9bbb2]">GTM Clean</strong> worksheet. Matching normalized emails update in place. {heldRows} unresolved active row{heldRows === 1 ? '' : 's'} stay out.</p>
              <input value={destinationSpreadsheet} onChange={(event) => setDestinationSpreadsheet(event.target.value)} placeholder="Destination Sheet URL or ID" className="mt-3 w-full rounded-2xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm outline-none focus:border-[#83bcff]/50" />
              <button onClick={() => void writeGoogleSheet()} disabled={status === 'working' || !readyRows.length} className="mt-3 w-full rounded-2xl bg-[#cdfc54] px-5 py-3 text-sm font-bold text-[#07130f] disabled:opacity-50">Sync {Math.min(readyRows.length, 1_000)} ready rows to GTM Clean</button>
            </div>
          )}

          {message && <p aria-live="polite" className={`mt-3 text-xs leading-5 ${status === 'error' ? 'text-[#ff9d7f]' : 'text-[#8fa99d]'}`}>{message}</p>}
        </div>

        <div className="rounded-[24px] border border-white/10 bg-[#07130f]/65 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-wider text-[#cdfc54]">Visual mapping</p>
              <h3 className="mt-1 text-lg font-semibold">Match any headers to the clean model</h3>
              <p className="mt-1 text-xs text-[#71877c]">Nothing writes until preview and validation succeed.</p>
            </div>
            {preview && <span className="rounded-full bg-white/[0.05] px-3 py-1 font-mono text-[9px] text-[#a9bbb2]">{preview.headers.length} columns · {preview.sourceRows} rows</span>}
          </div>
          {preview ? (
            <>
              <div className="mt-4 grid max-h-[360px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                {mappingOrder.map((field) => (
                  <label key={field} className="grid gap-1 rounded-xl border border-white/[0.06] bg-white/[0.025] p-3 font-mono text-[8px] uppercase tracking-wider text-[#71877c]">
                    {csvFieldLabels[field]}{field === 'rawEmail' || field === 'fullName' ? ' · identity' : ''}
                    <select value={draftMapping[field] ?? ''} onChange={(event) => setDraftMapping((current) => ({ ...current, [field]: event.target.value || undefined }))} className="mt-1 rounded-lg border border-white/10 bg-[#0c1d17] px-2 py-2 text-xs normal-case tracking-normal text-[#dce9e2]">
                      <option value="">Ignore</option>
                      {preview.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <label className="grid flex-1 gap-1 font-mono text-[8px] uppercase tracking-wider text-[#71877c]">
                  Mapping preset name
                  <input value={presetName} onChange={(event) => setPresetName(event.target.value)} className="rounded-full border border-white/10 bg-[#0c1d17] px-4 py-2.5 text-xs normal-case tracking-normal text-[#dce9e2]" />
                </label>
                <button onClick={() => void onSavePreset(presetName, draftMapping)} disabled={persistenceStatus === 'disabled' || persistenceStatus === 'error'} className="rounded-full border border-white/10 px-4 py-2.5 text-xs text-[#a9bbb2] disabled:opacity-40">Save mapping</button>
                <button onClick={() => void importMappedData()} disabled={!draftMapping.rawEmail && !draftMapping.fullName && !draftMapping.firstName && !draftMapping.lastName} className="rounded-full bg-[#cdfc54] px-5 py-2.5 text-xs font-bold text-[#07130f] disabled:opacity-40">Validate + load</button>
              </div>
              {presets.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {presets.map((preset) => <button key={preset.id} onClick={() => setDraftMapping(preset.mapping)} className="rounded-full bg-white/[0.05] px-3 py-1.5 font-mono text-[9px] text-[#8fa99d]">Use {preset.name}</button>)}
                </div>
              )}
            </>
          ) : <p className="mt-5 rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-xs text-[#71877c]">Choose a CSV or preview a Google worksheet to map its columns.</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-5 py-4 sm:px-6">
        <div className="flex flex-wrap gap-1.5 font-mono text-[8px] uppercase tracking-wider">
          {(['preview', 'validate', 'execute', 'receipt', 'undo', 'export'] as const).map((phase) => (
            <span key={phase} className={`rounded-full px-3 py-1.5 ${currentPhase === phase ? 'bg-[#cdfc54] text-[#07130f]' : 'bg-white/[0.05] text-[#71877c]'}`}>{phase}</span>
          ))}
        </div>
        <p className="text-[10px] text-[#566b61]">{hiddenCount > 0 ? `${hiddenCount} unconfigured connector${hiddenCount === 1 ? '' : 's'} hidden` : 'All declared connectors configured'} · connector secrets stay server-side</p>
      </div>
    </section>
  );
}

function extractSpreadsheetId(value: string): string {
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/u);
  return (match?.[1] ?? value).trim();
}
