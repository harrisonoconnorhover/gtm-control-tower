'use client';

import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import {
  csvFieldLabels,
  csvFieldLabelsForObject,
  destinationHoldFlags,
  isDestinationReadyContact,
  previewContactsCsv,
  type CsvColumnMapping,
  type CsvFieldKey,
  type CsvPreview,
} from '@/lib/csv-control-tower';
import type { ConnectorCatalog, ConnectorId, ConnectorReceipt } from '@/lib/connector-contract';
import type { CrmSourcePreview } from '@/lib/crm-source';
import { tabularRowsToCsv, type GoogleSheetsPreview } from '@/lib/google-sheets';
import type { ImportObject, LiveContactState } from '@/lib/live-control-tower';
import { messyLeadDemoCsv } from '@/lib/messy-lead-demo';
import type { MappingPreset } from '@/lib/workspace';
import { importPomadeHandoff, MAX_POMADE_HANDOFF_BYTES, type PomadeHandoffImport } from '@/lib/pomade-handoff';
import { PomadeSourceContext } from '@/components/pomade-source-context';
import { customFieldKey, validateCustomFields, type CustomFieldDefinition } from '@/lib/import-fields';
import { resolveImportTemplates, type ImportTemplate } from '@/lib/import-template';
import type { NormalizationSettings } from '@/lib/import-normalization';
import type { HubSpotImportBinding } from '@/lib/hubspot-import';

const mappingFields = Object.keys(csvFieldLabels) as CsvFieldKey[];

// Empty strings survive saved presets and override automatic suggestions on import.
function mappingForHeaders(mapping: CsvColumnMapping, headers: string[], fields = mappingFields): CsvColumnMapping {
  const sources = Object.values(mapping).filter(Boolean);
  return Object.fromEntries(fields.map((field) => {
    const source = mapping[field];
    return [field, source && headers.includes(source) && sources.filter((value) => value === source).length === 1 ? source : ''];
  }));
}

type Props = {
  catalog: ConnectorCatalog | null;
  contacts: LiveContactState[];
  sourceType: ConnectorId;
  importObject: ImportObject;
  destinationType: ConnectorId;
  mapping: CsvColumnMapping;
  presets: MappingPreset[];
  templates: ImportTemplate[];
  customFields: CustomFieldDefinition[];
  normalizationSettings: NormalizationSettings;
  hubspotBinding?: HubSpotImportBinding;
  workspaceRevision: number | null;
  persistenceStatus: 'loading' | 'saved' | 'saving' | 'disabled' | 'error';
  lastReceipt: ConnectorReceipt | null;
  operatorKey: string;
  onOperatorKeyChange: (value: string) => void;
  onMappedImport: (csv: string, fileName: string, mapping: CsvColumnMapping, source: ConnectorId, importObject: ImportObject, customFields?: CustomFieldDefinition[], normalization?: NormalizationSettings, hubspotBinding?: HubSpotImportBinding) => Promise<void>;
  onPomadeImport: (handoff: PomadeHandoffImport, fileName: string) => Promise<void>;
  onSourceChange: (source: ConnectorId) => void;
  onDestinationChange: (destination: ConnectorId) => void;
  onSavePreset: (name: string, mapping: CsvColumnMapping, importObject: ImportObject) => Promise<void>;
  onSaveTemplate: (name: string, mapping: CsvColumnMapping, importObject: ImportObject, customFields: CustomFieldDefinition[], normalization: NormalizationSettings, templateId?: string, hubspotBinding?: HubSpotImportBinding) => Promise<void>;
  onDeleteTemplate: (id: string) => Promise<void>;
  onUndo: () => Promise<void>;
  onExport: () => void;
  onReceipt: (receipt: ConnectorReceipt) => Promise<void>;
};

export function SelfHostConsole({
  catalog,
  contacts,
  sourceType,
  importObject,
  destinationType,
  mapping,
  presets,
  templates,
  customFields,
  normalizationSettings,
  hubspotBinding,
  workspaceRevision,
  persistenceStatus,
  lastReceipt,
  operatorKey,
  onOperatorKeyChange,
  onMappedImport,
  onPomadeImport,
  onSourceChange,
  onDestinationChange,
  onSavePreset,
  onSaveTemplate,
  onDeleteTemplate,
  onUndo,
  onExport,
  onReceipt,
}: Props) {
  const [draftImportObject, setDraftImportObject] = useState<ImportObject>(importObject);
  const [draftCustomFields, setDraftCustomFields] = useState<CustomFieldDefinition[]>(customFields);
  const [draftNormalization, setDraftNormalization] = useState<NormalizationSettings | null>(null);
  const [normalizationBaseline, setNormalizationBaseline] = useState(normalizationSettings);
  const [draftHubSpotBinding, setDraftHubSpotBinding] = useState(hubspotBinding);
  const [hubspotBindingBaseline, setHubSpotBindingBaseline] = useState(hubspotBinding);
  const [mappingProvenance, setMappingProvenance] = useState<Record<string, { templateId: string; templateName: string }>>({});
  const [manuallyMappedHeaders, setManuallyMappedHeaders] = useState<string[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateName, setTemplateName] = useState('My team import');
  const [customFieldLabel, setCustomFieldLabel] = useState('');
  const [customFieldProperty, setCustomFieldProperty] = useState('');
  const [customFieldObject, setCustomFieldObject] = useState<'contact' | 'company'>(importObject === 'company' ? 'company' : 'contact');
  const fieldLabels = csvFieldLabelsForObject(draftImportObject, draftCustomFields);
  const objectFields = Object.keys(fieldLabels) as CsvFieldKey[];
  const companyDraft = draftImportObject === 'company';
  const combinedDraft = draftImportObject === 'contact_company';
  const localDraft = draftImportObject !== 'contact';
  const previewSource = localDraft ? 'csv' : sourceType;
  const objectLabel = draftImportObject === 'company' ? 'company' : combinedDraft ? 'contact and associated company' : 'contact';
  const associatedFields = objectFields.filter((field) => field.startsWith('associatedCompany') || field.startsWith('custom:company:'));
  const contactFields = objectFields.filter((field) => !associatedFields.includes(field));
  const applicablePresets = presets.filter((preset) => (preset.importObject ?? 'contact') === draftImportObject);
  const fileInput = useRef<HTMLInputElement>(null);
  const pomadeInput = useRef<HTMLInputElement>(null);
  const [pomadePreview, setPomadePreview] = useState<PomadeHandoffImport | null>(null);
  const [pomadeFileName, setPomadeFileName] = useState('pomade-handoff.json');
  const [rawCsv, setRawCsv] = useState<string | null>(null);
  const [rawName, setRawName] = useState('imported-contacts.csv');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [draftMapping, setDraftMapping] = useState<CsvColumnMapping>(mapping);
  const [mappingNotice, setMappingNotice] = useState('');
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
  const mappedColumns = preview?.headers.filter((header) => Object.values(draftMapping).includes(header)).length ?? 0;
  const currentNormalization = normalizationBaseline === normalizationSettings ? draftNormalization ?? normalizationSettings : normalizationSettings;
  const currentHubSpotBinding = hubspotBindingBaseline === hubspotBinding ? draftHubSpotBinding : hubspotBinding;
  const templateObject = preview ? draftImportObject : importObject;
  const applicableTemplates = templates.filter((template) => template.importObject === templateObject);
  const selectedTemplate = applicableTemplates.find((template) => template.id === selectedTemplateId);

  function clearPreview() {
    setRawCsv(null);
    setPreview(null);
    setDraftMapping({});
    setMappingProvenance({});
    setManuallyMappedHeaders([]);
    setDraftNormalization(null);
    setDraftHubSpotBinding(undefined);
    setSelectedTemplateId('');
    setMappingNotice('');
    setPomadePreview(null);
  }

  async function readPomadeHandoff(file: File) {
    clearPreview();
    setStatus('working');
    setMessage(null);
    try {
      if (file.size > MAX_POMADE_HANDOFF_BYTES) throw new Error('Use a Pomade handoff smaller than 2 MB.');
      const imported = await importPomadeHandoff(await file.text());
      setDraftImportObject('contact');
      setPomadePreview(imported);
      setPomadeFileName(file.name);
      setStatus('ready');
      setMessage(`${imported.contacts.length} Pomade proposals previewed. Your current workspace has not changed.`);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'That Pomade handoff could not be read.');
    }
  }

  async function loadPomadeHandoff() {
    if (!pomadePreview) return;
    setStatus('working');
    try {
      await onPomadeImport(pomadePreview, pomadeFileName);
      setMessage(`${pomadePreview.contacts.length} proposals loaded in a new saved workspace for review. No CRM writes were made.`);
      setPomadePreview(null);
      setStatus('ready');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'The Pomade import could not be saved.');
    }
  }

  async function prepareCsv(csv: string, fileName: string, object: ImportObject = draftImportObject) {
    clearPreview();
    try {
      const currentDefinitions = draftCustomFields.filter((field) => object === 'contact_company' || field.object === object);
      const headers = previewContactsCsv(csv, object, currentDefinitions).headers;
      const resolved = resolveImportTemplates(headers, object, templates, currentDefinitions);
      const nextPreview = previewContactsCsv(csv, object, resolved.customFields);
      setDraftImportObject(object);
      setCustomFieldObject(object === 'company' ? 'company' : 'contact');
      setRawCsv(csv);
      setRawName(fileName);
      setPreview(nextPreview);
      setDraftCustomFields(resolved.customFields);
      setDraftMapping(resolved.mapping);
      setMappingProvenance(resolved.provenance);
      setDraftNormalization(resolved.template?.normalization ?? null);
      setDraftHubSpotBinding(resolved.template?.hubspotBinding);
      setHubSpotBindingBaseline(hubspotBinding);
      setNormalizationBaseline(normalizationSettings);
      setSelectedTemplateId(resolved.template?.id ?? '');
      if (resolved.template) setTemplateName(resolved.template.name);
      setMappingNotice(resolved.conflicts.join(' '));
      setStatus('ready');
      setMessage(`${nextPreview.sourceRows.toLocaleString()} rows ready to map.`);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'That table could not be previewed.');
    }
  }

  function mapColumn(header: string, field: CsvFieldKey | '') {
    const previousSource = field ? draftMapping[field] : '';
    setDraftMapping((current) => ({
      ...Object.fromEntries(objectFields.map((key) => [key, current[key] === header ? '' : current[key] ?? ''])),
      ...(field ? { [field]: header } : {}),
    }));
    setMappingProvenance((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== field && draftMapping[key as CsvFieldKey] !== header)));
    setManuallyMappedHeaders((current) => [...new Set([...current, header])]);
    setMappingNotice(field
      ? `${header} → ${fieldLabels[field]}.${previousSource && previousSource !== header ? ` ${previousSource} is now unmapped.` : ''}`
      : `${header} will not be imported into this ${objectLabel} workspace.`);
  }

  function applyTemplate(template: ImportTemplate) {
    if (!preview || !rawCsv) return;
    const resolved = resolveImportTemplates(preview.headers, draftImportObject, [template]);
    setDraftCustomFields(resolved.customFields);
    setDraftMapping(resolved.mapping);
    setMappingProvenance(resolved.provenance);
    setManuallyMappedHeaders([]);
    setDraftNormalization(template.normalization);
    setDraftHubSpotBinding(template.hubspotBinding);
    setHubSpotBindingBaseline(hubspotBinding);
    setNormalizationBaseline(normalizationSettings);
    setSelectedTemplateId(template.id);
    setTemplateName(template.name);
    setPreview(previewContactsCsv(rawCsv, draftImportObject, resolved.customFields));
    setMappingNotice(resolved.conflicts.length ? resolved.conflicts.join(' ') : `${template.name} applied. Review the matches before loading. Its normalization rules will be available for preview after loading.`);
  }

  function autoMapHeaders() {
    if (!preview || !rawCsv) return;
    const resolved = resolveImportTemplates(preview.headers, draftImportObject, templates, draftCustomFields);
    setDraftCustomFields(resolved.customFields);
    setDraftMapping(resolved.mapping);
    setMappingProvenance(resolved.provenance);
    setManuallyMappedHeaders([]);
    setDraftNormalization(resolved.template?.normalization ?? null);
    setDraftHubSpotBinding(resolved.template?.hubspotBinding);
    setHubSpotBindingBaseline(hubspotBinding);
    setNormalizationBaseline(normalizationSettings);
    setSelectedTemplateId(resolved.template?.id ?? '');
    if (resolved.template) setTemplateName(resolved.template.name);
    setPreview(previewContactsCsv(rawCsv, draftImportObject, resolved.customFields));
    setMappingNotice(resolved.conflicts.length ? resolved.conflicts.join(' ') : 'Saved template and automatic header matches restored. Review them before loading.');
  }

  function addCustomField() {
    const label = customFieldLabel.trim();
    const key = customFieldProperty.trim();
    const object = companyDraft ? 'company' : combinedDraft ? customFieldObject : 'contact';
    try {
      setDraftCustomFields(validateCustomFields([...draftCustomFields, { key, label, object }]));
    } catch (error) {
      setMappingNotice(error instanceof Error ? error.message : 'That custom field could not be added.');
      return;
    }
    setCustomFieldLabel('');
    setCustomFieldProperty('');
    setMappingNotice(`${label} added to ${object === 'company' && combinedDraft ? 'Associated Company' : object === 'company' ? 'Company' : 'Contact'} fields. Choose it for the matching source column, then save a shared template to remember the mapping.`);
  }

  function removeCustomField(definition: CustomFieldDefinition) {
    const field = customFieldKey(definition);
    setDraftCustomFields((current) => current.filter((candidate) => candidate.object !== definition.object || candidate.key !== definition.key));
    setDraftMapping((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== field)));
    setMappingProvenance((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== field)));
    setMappingNotice(`${definition.label} removed from this draft. Saved templates and loaded rows have not changed.`);
  }

  async function saveSharedTemplate(update = false) {
    setStatus('working');
    try {
      await onSaveTemplate(templateName, preview ? draftMapping : mapping, templateObject, preview ? draftCustomFields : customFields, preview ? currentNormalization : normalizationSettings, update ? selectedTemplate?.id : undefined, preview ? currentHubSpotBinding : hubspotBinding);
      setStatus('ready');
      setMappingNotice(`${templateName.trim()} ${update ? 'updated' : 'saved'} for future imports on this installation.`);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'The import template could not be saved.');
    }
  }

  async function deleteSharedTemplate(id: string) {
    setStatus('working');
    try {
      await onDeleteTemplate(id);
      if (selectedTemplateId === id) setSelectedTemplateId('');
      setMappingProvenance((current) => Object.fromEntries(Object.entries(current).filter(([, source]) => source.templateId !== id)));
      setStatus('ready');
      setMappingNotice('Shared template deleted. Your current mapping and loaded rows are unchanged.');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'The import template could not be deleted.');
    }
  }

  function sharedTemplateControls() {
    const unavailable = persistenceStatus !== 'saved' || status === 'working';
    return <section aria-label="Shared import templates" className="mt-4 rounded-xl border border-[#83bcff]/20 bg-[#83bcff]/[0.035] p-3">
      <h4 className="text-sm font-semibold text-[#c5dbef]">Shared import templates</h4>
      <p className="mt-1 text-xs leading-5 text-[#9cb0a7]">Remember source headers, field mappings, custom fields, and normalization rules for everyone using this installation. Future matching columns get an auto-mapped flag.</p>
      {(preview ? currentHubSpotBinding : hubspotBinding) && <p className="mt-2 text-xs text-[#83bcff]">Includes HubSpot field mappings for portal {(preview ? currentHubSpotBinding : hubspotBinding)?.portalId}. Actual fields and options are checked again during the dry run.</p>}
      {!preview && <p className="mt-2 text-xs leading-5 text-[#9cb0a7]">Save this workspace’s mapping and current normalization rules. Selecting an existing template below lets you update it with these settings.</p>}
      {preview && selectedTemplate && <p className="mt-2 text-xs leading-5 text-[#83bcff]">{selectedTemplate.name} selected. Its normalization rules can be previewed and applied after loading; mapping does not change values.</p>}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="grid min-w-[160px] flex-1 gap-1 text-[10px] font-semibold text-[#9cb0a7]">Shared template name
          <input aria-label="Shared template name" value={templateName} maxLength={120} onChange={(event) => setTemplateName(event.target.value)} className="rounded-lg border border-white/10 bg-[#0c1d17] px-3 py-2 text-xs text-[#dce9e2]" />
        </label>
        <button type="button" onClick={() => void saveSharedTemplate()} disabled={unavailable || !templateName.trim()} className="rounded-full border border-[#83bcff]/30 px-3 py-2 text-xs font-semibold text-[#83bcff] disabled:opacity-40">Save shared template</button>
        {selectedTemplate && <button type="button" onClick={() => void saveSharedTemplate(true)} disabled={unavailable || !templateName.trim()} className="rounded-full border border-white/15 px-3 py-2 text-xs text-[#a9bbb2] disabled:opacity-40">Update selected template</button>}
      </div>
      {applicableTemplates.length > 0 && <div className="mt-3 space-y-2">{applicableTemplates.map((template) => <div key={template.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 px-2 py-2">
        <button type="button" onClick={() => { if (preview) applyTemplate(template); else { setSelectedTemplateId(template.id); setTemplateName(template.name); setMappingNotice(`${template.name} selected for updating with this workspace’s mapping and normalization rules.`); } }} disabled={status === 'working'} className="min-w-0 flex-1 break-words px-1 text-left text-xs font-semibold text-[#a9bbb2] disabled:opacity-40">{preview ? 'Apply' : 'Select'} {template.name}{selectedTemplateId === template.id ? ' · selected' : ''}</button>
        <button type="button" aria-label={`Delete ${template.name} template`} onClick={() => void deleteSharedTemplate(template.id)} disabled={unavailable} className="rounded-full px-2 py-1 text-[10px] text-[#a9bbb2] hover:text-[#ff9d7f] disabled:opacity-40">Delete</button>
      </div>)}</div>}
    </section>;
  }

  async function readCsv(file: File) {
    clearPreview();
    setStatus('working');
    setMessage(null);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Use a CSV smaller than 10 MB.');
      await prepareCsv(await file.text(), file.name);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'That file could not be read.');
    }
  }

  async function previewGoogleSheet() {
    clearPreview();
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
    clearPreview();
    setStatus('working');
    setMessage(null);
    try {
      const response = await fetch('/api/control-tower/crm-source', {
        method: 'POST', headers: { 'content-type': 'application/json', ...(operatorKey ? { 'x-control-tower-key': operatorKey } : {}) },
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
      await onMappedImport(rawCsv, rawName, draftMapping, previewSource, draftImportObject, draftCustomFields, currentNormalization, currentHubSpotBinding);
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
      {importObject === 'contact' && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4 sm:px-6"><p className="text-xs text-[#9cb0a7]">Prepare existing CRM contacts with evidence already in HubSpot.</p><Link href="/app/cohort" className="rounded-full border border-[#cdfc54]/25 px-4 py-2 text-xs font-semibold text-[#cdfc54]">Prepare CRM cohort</Link></div>}
      {importObject === 'contact' && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4 sm:px-6"><p className="text-xs text-[#9cb0a7]">Keep an eye on connected CRM records between imports.</p><Link href={destinationType === 'salesforce' ? '/app/monitor?provider=salesforce' : '/app/monitor'} className="rounded-full border border-[#cdfc54]/25 px-4 py-2 text-xs font-semibold text-[#cdfc54]">Open CRM Monitor</Link></div>}
      {catalog?.accessKeyRequired && <div className="border-b border-white/10 px-5 py-4 sm:px-6"><label className="grid max-w-lg gap-2 text-xs font-semibold text-[#9cb0a7]">Operator access key<input type="password" value={operatorKey} onChange={(event) => onOperatorKeyChange(event.target.value)} className="rounded-xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm text-[#e5f1eb] outline-none focus:border-[#83bcff]/50" /></label><p className="mt-2 text-[10px] text-[#71877c]">Kept only in this browser tab and required for private CRM reads and writes.</p></div>}
      <div className="border-b border-white/10 px-5 py-5 sm:px-6">
        <label className="grid max-w-lg gap-2 text-sm font-semibold">What does each row represent?
          <select aria-label="Import object" value={draftImportObject} disabled={status === 'working'} onChange={(event) => { clearPreview(); setDraftImportObject(event.target.value as ImportObject); setMessage('Choose a file for this object. Your saved rows have not changed.'); }} className="rounded-xl border border-white/15 bg-[#07130f] px-4 py-3 text-sm text-[#e5f1eb]">
            <option value="contact">Contacts — one person per row</option>
            <option value="company">Companies — one company per row</option>
            <option value="contact_company">Contacts + associated companies — one contact and company per row</option>
          </select>
        </label>
        <p className="mt-2 max-w-3xl text-xs leading-5 text-[#9cb0a7]">{combinedDraft ? 'Map Contact fields and associated Company fields separately. Pomade uses the associated Company name and website for identity and ICP checks, and the Contact email for verification. Review and export locally; CRM contact/company imports and association writes are not available in this mode.' : companyDraft ? 'Map company names and websites. Company review/export only; CRM Company/Account import is not available.' : 'Map person names and emails. Company name and website describe that contact’s company; they do not create or link a separate Company/Account record.'}</p>
        {contacts.length > 0 && <p className="mt-2 text-xs text-[#83bcff]">Current saved workspace: {importObject === 'company' ? 'Companies' : importObject === 'contact_company' ? 'Contacts + associated companies' : 'Contacts'}. This choice applies when you validate and load the next file.</p>}
      </div>
      <div className="grid gap-6 border-b border-white/10 px-5 py-5 lg:grid-cols-[1fr_1fr_auto] lg:items-end sm:px-6">
        <label className="grid gap-2 text-xs font-semibold text-[#9cb0a7]">
          Where is your data?
          <select value={previewSource} disabled={localDraft || importObject !== 'contact'} onChange={(event) => onSourceChange(event.target.value as ConnectorId)} className="rounded-2xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm text-[#e5f1eb] outline-none focus:border-[#83bcff]/50">
            {sources.filter((connector) => !localDraft || connector.id === 'csv').map((connector) => <option key={connector.id} value={connector.id}>{connector.label}</option>)}
          </select>
        </label>
        <label className="grid gap-2 text-xs font-semibold text-[#9cb0a7]">
          Where should clean records go?
          <select value={localDraft || importObject !== 'contact' ? 'csv' : destinationType} disabled={localDraft || importObject !== 'contact'} onChange={(event) => onDestinationChange(event.target.value as ConnectorId)} className="rounded-2xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm text-[#e5f1eb] outline-none focus:border-[#83bcff]/50">
            {destinations.filter((connector) => (!localDraft && importObject === 'contact') || connector.id === 'csv').map((connector) => <option key={connector.id} value={connector.id}>{connector.label}</option>)}
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
              <h3 className="mt-1 text-lg font-semibold">{previewSource === 'google-sheets' ? 'Preview a worksheet' : previewSource === 'csv' ? 'Choose a CSV' : `Preview ${sourceType === 'hubspot' ? 'contacts' : 'active Leads'}`}</h3>
            </div>
            <span className={`rounded-full px-3 py-1 font-mono text-[9px] uppercase ${persistenceStatus === 'saved' ? 'bg-[#cdfc54]/10 text-[#cdfc54]' : persistenceStatus === 'disabled' ? 'bg-white/[0.06] text-[#71877c]' : 'bg-[#e6bd68]/10 text-[#e6bd68]'}`}>
              {persistenceStatus === 'disabled' ? 'Session only' : workspaceRevision === null ? persistenceStatus : `SQLite r${workspaceRevision} · ${persistenceStatus}`}
            </span>
          </div>

          {previewSource === 'csv' && (
            <div className="mt-4">
              <input ref={fileInput} type="file" accept=".csv,text/csv" aria-label="CSV file" className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void readCsv(file); event.currentTarget.value = ''; }} />
              <button onClick={() => fileInput.current?.click()} disabled={status === 'working'} className="w-full rounded-2xl border border-dashed border-[#83bcff]/30 bg-[#83bcff]/[0.05] px-5 py-6 text-sm font-semibold text-[#83bcff] hover:bg-[#83bcff]/10 disabled:opacity-40">Choose CSV to preview</button>
              <button onClick={() => void prepareCsv(messyLeadDemoCsv(), 'gtm-control-tower-messy-leads-64.csv', 'contact')} disabled={status === 'working'} className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.035] px-5 py-3 text-xs font-semibold text-[#a9bbb2] hover:bg-white/[0.06] disabled:opacity-40">Or load the bundled 64-row contact practice batch</button>
              <input ref={pomadeInput} type="file" accept=".json,application/json" aria-label="Pomade handoff file" className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void readPomadeHandoff(file); event.currentTarget.value = ''; }} />
              <button onClick={() => pomadeInput.current?.click()} disabled={status === 'working'} className="mt-2 w-full rounded-2xl border border-white/10 px-5 py-3 text-xs font-semibold text-[#a9bbb2] hover:bg-white/[0.06] disabled:opacity-40">Import Pomade handoff</button>
              <p className="mt-2 text-[10px] leading-4 text-[#71877c]">Optional JSON file · no Pomade account or connection needed · existing-record updates only.</p>
            </div>
          )}

          {previewSource === 'google-sheets' && (
            <div className="mt-4 grid gap-3">
              <input value={sourceSpreadsheet} onChange={(event) => setSourceSpreadsheet(event.target.value)} placeholder="Google Sheet URL or spreadsheet ID" className="rounded-2xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm outline-none focus:border-[#83bcff]/50" />
              <input value={sourceSheet} onChange={(event) => setSourceSheet(event.target.value)} placeholder="Source worksheet, e.g. Leads" className="rounded-2xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm outline-none focus:border-[#83bcff]/50" />
              <button onClick={() => void previewGoogleSheet()} disabled={status === 'working'} className="rounded-2xl bg-[#83bcff] px-5 py-3 text-sm font-bold text-[#07130f] disabled:opacity-50">Read through n8n</button>
            </div>
          )}

          {!localDraft && (sourceType === 'hubspot' || sourceType === 'salesforce') && (
            <div className="mt-4 grid gap-3">
              <label className="grid gap-1 font-mono text-[8px] uppercase tracking-wider text-[#71877c]">
                Maximum records · 1–500
                <input type="number" min={1} max={500} value={crmImportLimit} onChange={(event) => setCrmImportLimit(Math.max(1, Math.min(500, Number(event.target.value) || 1)))} className="rounded-2xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm normal-case tracking-normal outline-none focus:border-[#83bcff]/50" />
              </label>
              <button onClick={() => void previewCrm()} disabled={status === 'working'} className="rounded-2xl bg-[#83bcff] px-5 py-3 text-sm font-bold text-[#07130f] disabled:opacity-50">{status === 'working' ? 'Reading CRM…' : `Read from ${sourceType === 'hubspot' ? 'HubSpot' : 'Salesforce'}`}</button>
              <p className="text-[10px] leading-5 text-[#566b61]">Read-only source access creates a local preview. It does not modify the CRM.</p>
            </div>
          )}

          {importObject === 'contact' && destinationType === 'google-sheets' && contacts.length > 0 && (
            <div className="mt-5 border-t border-white/10 pt-5">
              <p className="text-xs font-semibold">Google Sheets destination</p>
              <p className="mt-1 text-[11px] leading-5 text-[#71877c]">n8n queues Sheets writes one at a time and upserts up to 1,000 destination-ready records to the separate <strong className="text-[#a9bbb2]">GTM Clean</strong> worksheet. Matching normalized emails update in place. {heldRows} unresolved active row{heldRows === 1 ? '' : 's'} stay out.</p>
              <input value={destinationSpreadsheet} onChange={(event) => setDestinationSpreadsheet(event.target.value)} placeholder="Destination Sheet URL or ID" className="mt-3 w-full rounded-2xl border border-white/10 bg-[#07130f] px-4 py-3 text-sm outline-none focus:border-[#83bcff]/50" />
              <button onClick={() => void writeGoogleSheet()} disabled={status === 'working' || !readyRows.length} className="mt-3 w-full rounded-2xl bg-[#cdfc54] px-5 py-3 text-sm font-bold text-[#07130f] disabled:opacity-50">Sync {Math.min(readyRows.length, 1_000)} ready rows to GTM Clean</button>
            </div>
          )}

          {message && <p aria-live="polite" className={`mt-3 text-xs leading-5 ${status === 'error' ? 'text-[#ff9d7f]' : 'text-[#8fa99d]'}`}>{message}</p>}
        </div>

        <div className="min-w-0 rounded-[24px] border border-white/10 bg-[#07130f]/65 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-wider text-[#cdfc54]">{pomadePreview ? 'Optional source handoff' : 'Visual mapping'}</p>
              <h3 className="mt-1 text-lg font-semibold">{pomadePreview ? 'Review the imported proposals' : 'Map your CSV columns'}</h3>
              <p className="mt-1 text-xs leading-5 text-[#9cb0a7]">{pomadePreview ? 'The complete file was validated locally. No CRM or research calls were made.' : 'Your CSV headers are on the left. Choose the Control Tower field on the right. Common headers are matched automatically.'}</p>
            </div>
            {preview && <span className="rounded-full bg-white/[0.05] px-3 py-1 font-mono text-[9px] text-[#a9bbb2]">{preview.headers.length} columns · {preview.sourceRows} rows</span>}
          </div>
          {pomadePreview ? <div aria-label="Pomade handoff preview" className="mt-4 space-y-3">
            <p className="text-sm font-semibold text-[#c5dbef]">{pomadePreview.workspaceName ?? pomadeFileName} · {pomadePreview.contacts.length} proposals</p>
            <p className="text-xs leading-5 text-[#a9bbb2]">{pomadePreview.destination.provider === 'hubspot' ? 'HubSpot Contacts' : 'Salesforce Leads'} · updates only. Source status is context, not approval. Control Tower still checks identity, missing fields, and permitted changes.</p>
            <div className="flex flex-wrap gap-2 text-[11px] text-[#e6bd68]"><span>{pomadePreview.contacts.filter((contact) => contact.importExclusion).length} source-review rows skipped</span><span>· {pomadePreview.contacts.filter((contact) => destinationHoldFlags(contact).length > 0).length} rows need field review</span></div>
            {pomadePreview.warnings.map((warning) => <p key={warning} className="text-xs leading-5 text-[#e6bd68]">{warning}</p>)}
            <div className="max-h-[420px] space-y-3 overflow-y-auto">{pomadePreview.contacts.map((contact) => <div key={contact.contactId} className="rounded-xl border border-white/10 p-3"><p className="break-words text-xs font-semibold text-[#dce9e2]">{contact.fullName || 'Missing contact name'} · {contact.rawEmail || 'Missing email'}</p>{contact.qualityFlags.length > 0 && <p className="mt-1 text-[11px] text-[#e6bd68]">{contact.qualityFlags.join(' · ')}</p>}{contact.importExclusion && <p className="mt-1 text-xs text-[#e6bd68]">Skipped: {contact.importExclusion.reason}</p>}<PomadeSourceContext origins={contact.sourceOrigins} contact={contact} /></div>)}</div>
            <button onClick={() => void loadPomadeHandoff()} disabled={status === 'working' || persistenceStatus !== 'saved'} className="rounded-full bg-[#cdfc54] px-5 py-2.5 text-xs font-bold text-[#07130f] disabled:opacity-40">Load in new saved workspace</button>
            <p className="text-[10px] leading-4 text-[#71877c]">Your previous workspace stays saved. Loading does not query a CRM or approve any proposal.{persistenceStatus !== 'saved' ? ' Saved workspace storage must be ready before loading.' : ''}</p>
          </div> : preview ? (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-[#a9bbb2]">{mappedColumns} of {preview.headers.length} columns matched · {preview.headers.length - mappedColumns} not imported</p>
                <button type="button" onClick={autoMapHeaders} className="rounded-full border border-[#83bcff]/30 px-3 py-2 text-xs font-semibold text-[#83bcff]">Auto-map headers</button>
              </div>
              <section aria-label="CSV column mapping" className="mt-3 max-h-[480px] space-y-2 overflow-y-auto pr-1">
                {preview.headers.map((header, index) => {
                  const field = objectFields.find((key) => draftMapping[key] === header);
                  const sample = preview.sampleRows.map((row) => row[header]).find((value) => value?.trim());
                  const provenance = field ? mappingProvenance[field] : undefined;
                  return <div key={header} role="group" aria-label={`CSV column ${header}`} className="grid min-w-0 gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-[#83bcff]">Your CSV column · {index + 1}</p>
                      <p className="mt-1 break-words text-sm font-semibold text-[#e5f1eb]">{header}</p>
                      <p className="mt-1 break-all text-[11px] leading-5 text-[#9cb0a7]" title={sample}>Example: {sample ? (sample.length > 100 ? `${sample.slice(0, 100)}…` : sample) : 'No non-empty sample'}</p>
                    </div>
                    <span aria-hidden="true" className="hidden text-lg text-[#83bcff] sm:block">→</span>
                    <div className="min-w-0">
                      <label className="grid gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#cdfc54]">Control Tower field
                        <select aria-label={`Control Tower field for ${header}`} value={field ?? ''} onChange={(event) => mapColumn(header, event.target.value as CsvFieldKey | '')} className="min-w-0 w-full rounded-lg border border-white/15 bg-[#0c1d17] px-2 py-2.5 text-xs font-normal normal-case tracking-normal text-[#dce9e2]">
                          <option value="">Do not import this column</option>
                          {combinedDraft ? <><optgroup label="Contact fields">{contactFields.map((key) => <option key={key} value={key}>{fieldLabels[key]}</option>)}</optgroup><optgroup label="Associated Company fields">{associatedFields.map((key) => <option key={key} value={key}>{fieldLabels[key]}</option>)}</optgroup></> : objectFields.map((key) => <option key={key} value={key}>{fieldLabels[key]}</option>)}
                        </select>
                      </label>
                      <p className={`mt-1.5 text-[10px] ${provenance ? 'text-[#83bcff]' : field ? 'text-[#a9bbb2]' : 'text-[#e6bd68]'}`}>{!field ? 'Not mapped' : `${combinedDraft ? associatedFields.includes(field) ? 'Company object · ' : 'Contact object · ' : ''}${provenance ? `Auto-mapped · ${provenance.templateName}` : !manuallyMappedHeaders.includes(header) && preview.suggestedMapping[field] === header ? 'Auto-matched from header' : 'Manual match'}`}</p>
                      {field?.startsWith('custom:') && <p className="mt-1 break-words text-[10px] leading-4 text-[#71877c]">Custom field · {draftCustomFields.find((definition) => customFieldKey(definition) === field)?.key} · sample: {sample || 'empty'}</p>}
                    </div>
                  </div>;
                })}
              </section>
              {mappingNotice && <p role="status" className="mt-3 text-xs leading-5 text-[#a9bbb2]">{mappingNotice}</p>}
              <p className="mt-3 text-[11px] leading-5 text-[#9cb0a7]">Unmapped columns are not loaded into this {objectLabel} workspace. Loading saves the mapped records here; it does not write to your CRM.</p>
              {combinedDraft && <p className="mt-2 text-xs text-[#83bcff]">Map a contact name or email and an associated company name, website, or record ID. Company fields stay separate from Contact fields.</p>}
              <details className="mt-4 rounded-xl border border-white/10 p-3">
                <summary className="cursor-pointer text-xs font-semibold text-[#c5dbef]">Add custom destination fields{draftCustomFields.length > 0 ? ` · ${draftCustomFields.length}` : ''}</summary>
                <p className="mt-2 text-xs leading-5 text-[#9cb0a7]">Use your CRM field label and property key, then choose it in the mapping above. For example, map “Favorite icecream” to “Fav. Ice Cream.” Custom values stay in local review and CSV export; adding a field does not enable CRM writes.</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <label className="grid gap-1 text-[10px] font-semibold text-[#9cb0a7]">CRM field label<input aria-label="Custom field label" placeholder="Fav. Ice Cream" value={customFieldLabel} maxLength={120} onChange={(event) => setCustomFieldLabel(event.target.value)} className="rounded-lg border border-white/10 bg-[#0c1d17] px-3 py-2 text-xs text-[#dce9e2]" /></label>
                  <label className="grid gap-1 text-[10px] font-semibold text-[#9cb0a7]">CRM property key<input aria-label="Custom field property key" placeholder="fav_ice_cream" value={customFieldProperty} maxLength={80} onChange={(event) => setCustomFieldProperty(event.target.value)} className="rounded-lg border border-white/10 bg-[#0c1d17] px-3 py-2 text-xs text-[#dce9e2]" /></label>
                  {combinedDraft && <label className="grid gap-1 text-[10px] font-semibold text-[#9cb0a7]">Object<select aria-label="Custom field object" value={customFieldObject} onChange={(event) => setCustomFieldObject(event.target.value as 'contact' | 'company')} className="rounded-lg border border-white/10 bg-[#0c1d17] px-3 py-2 text-xs text-[#dce9e2]"><option value="contact">Contact</option><option value="company">Associated Company</option></select></label>}
                  <button type="button" onClick={addCustomField} disabled={status === 'working' || !customFieldLabel.trim() || !customFieldProperty.trim()} className="self-end rounded-full border border-[#83bcff]/30 px-3 py-2 text-xs font-semibold text-[#83bcff] disabled:opacity-40">Add custom field</button>
                </div>
                {draftCustomFields.length > 0 && <div className="mt-3 space-y-2">{draftCustomFields.map((definition) => <div key={`${definition.object}:${definition.key}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 px-2 py-2 text-[11px]"><span className="min-w-0 break-words text-[#a9bbb2]">{definition.label} · {definition.object === 'company' && combinedDraft ? 'Associated Company' : definition.object === 'company' ? 'Company' : 'Contact'} · {definition.key}</span><button type="button" aria-label={`Remove custom field ${definition.label}`} onClick={() => removeCustomField(definition)} className="text-[#71877c] hover:text-[#ff9d7f]">Remove</button></div>)}</div>}
              </details>
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <label className="grid flex-1 gap-1 font-mono text-[8px] uppercase tracking-wider text-[#71877c]">
                  Mapping preset name
                  <input value={presetName} onChange={(event) => setPresetName(event.target.value)} className="rounded-full border border-white/10 bg-[#0c1d17] px-4 py-2.5 text-xs normal-case tracking-normal text-[#dce9e2]" />
                </label>
                <button onClick={() => void onSavePreset(presetName, draftMapping, draftImportObject)} disabled={persistenceStatus === 'disabled' || persistenceStatus === 'error' || draftCustomFields.length > 0} className="rounded-full border border-white/10 px-4 py-2.5 text-xs text-[#a9bbb2] disabled:opacity-40">Save mapping</button>
                <button onClick={() => void importMappedData()} disabled={status === 'working' || (companyDraft ? !draftMapping.company && !draftMapping.website : (!draftMapping.rawEmail && !draftMapping.fullName && !draftMapping.firstName && !draftMapping.lastName) || (combinedDraft && !draftMapping.associatedCompanyId && !draftMapping.associatedCompanyName && !draftMapping.associatedCompanyWebsite))} className="rounded-full bg-[#cdfc54] px-5 py-2.5 text-xs font-bold text-[#07130f] disabled:opacity-40">Validate + load</button>
              </div>
              <p className="mt-2 text-[10px] leading-4 text-[#71877c]">{draftCustomFields.length > 0 ? 'Use a shared template to retain custom fields and normalization rules.' : '“Save mapping” keeps a preset in this workspace. Use a shared import template below to remember mappings across future workspaces.'}</p>
              {applicablePresets.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {applicablePresets.map((preset) => <button key={preset.id} onClick={() => { setDraftMapping(mappingForHeaders(preset.mapping, preview.headers, objectFields)); setMappingProvenance({}); setManuallyMappedHeaders(preview.headers); setSelectedTemplateId(''); setDraftNormalization(null); setMappingNotice('Preset applied to matching headers. Missing or conflicting matches remain unmapped; review those columns.'); }} className="rounded-full bg-white/[0.05] px-3 py-1.5 font-mono text-[9px] text-[#8fa99d]">Use {preset.name}</button>)}
                </div>
              )}
            </>
          ) : <p className="mt-5 rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-xs text-[#71877c]">Choose the row object, then preview a source file to map its columns.</p>}
          {!pomadePreview && (preview || contacts.length > 0) && sharedTemplateControls()}
          {!preview && mappingNotice && <p role="status" className="mt-3 text-xs leading-5 text-[#a9bbb2]">{mappingNotice}</p>}
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
