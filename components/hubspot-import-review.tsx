'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { csvFieldLabelsForObject, type CsvFieldKey } from '@/lib/csv-control-tower';
import type { CustomFieldDefinition } from '@/lib/import-fields';
import { normalizationFieldLabels, previewNormalization, type NormalizationSettings } from '@/lib/import-normalization';
import {
  hubspotImportValue, importFieldObject, suggestHubSpotBindings,
  type HubSpotImportBinding, type HubSpotImportDryRun, type HubSpotImportObjectReview,
  type HubSpotImportProperty, type HubSpotImportSchema,
} from '@/lib/hubspot-import';
import type { LiveContactState } from '@/lib/live-control-tower';

type Props = {
  workspaceId: string | null;
  workspaceRevision: number | null;
  contacts: LiveContactState[];
  originalContacts: LiveContactState[];
  customFields: CustomFieldDefinition[];
  normalizationSettings: NormalizationSettings;
  binding: HubSpotImportBinding | undefined;
  accessKey: string;
  disabled?: boolean;
  onBindingChange: (binding: HubSpotImportBinding | undefined) => void;
  onNormalizationChange: (settings: NormalizationSettings) => void;
  onSaveBinding: () => Promise<void>;
};
const buttonClass = 'rounded-full border border-white/20 px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40';
const inputClass = 'min-w-0 rounded-lg border border-white/15 bg-[#071710] px-3 py-2 text-xs text-[#dce9e2]';
const pageSize = 10;
const statusLabels = { create: 'Would create', update: 'Would update', unchanged: 'Unchanged', review: 'Needs review', skipped: 'Skipped' } as const;

export function HubSpotImportReview(props: Props) {
  return <Review key={`${props.workspaceId}:${props.accessKey}`} {...props} />;
}

function Review({ workspaceId, workspaceRevision, contacts, originalContacts, customFields, normalizationSettings, binding, accessKey,
  disabled = false, onBindingChange, onNormalizationChange, onSaveBinding }: Props) {
  const [schema, setSchema] = useState<HubSpotImportSchema | null>(null);
  const [review, setReview] = useState<HubSpotImportDryRun | null>(null);
  const [serverStale, setServerStale] = useState(false);
  const [reviewInputs, setReviewInputs] = useState<string | null>(null);
  const [busy, setBusy] = useState<'schema' | 'preview' | 'save' | null>(null);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [policy, setPolicy] = useState<'fill-empty' | 'overwrite'>('fill-empty');
  const [filter, setFilter] = useState<'all' | 'contact' | 'company'>('all');
  const [page, setPage] = useState(0);
  const importObject = contacts[0]?.importObject ?? 'contact';
  const normalization = useMemo(() => {
    try { return { result: previewNormalization(contacts, normalizationSettings, customFields), error: '' }; }
    catch (failure) { return { result: null, error: message(failure) }; }
  }, [contacts, normalizationSettings, customFields]);
  const normalized = normalization.result?.contacts ?? contacts;
  const inputSignature = useMemo(() => JSON.stringify({ workspaceId, workspaceRevision, contacts, originalContacts, customFields, normalizationSettings, binding }),
    [workspaceId, workspaceRevision, contacts, originalContacts, customFields, normalizationSettings, binding]);
  const latestInputs = useRef(inputSignature);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => { latestInputs.current = inputSignature; }, [inputSignature]);
  useEffect(() => () => activeRequest.current?.abort(), []);

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    const requestedInputs = latestInputs.current;
    async function load() {
      try {
        const response = await request<{ review: HubSpotImportDryRun | null; stale: boolean }>(
          `/api/control-tower/hubspot-import?workspaceId=${encodeURIComponent(workspaceId!)}`, accessKey, controller.signal);
        if (controller.signal.aborted) return;
        setReview(response.review);
        setServerStale(response.stale);
        setReviewInputs(requestedInputs);
        if (response.review) setPolicy(response.review.policy);
      } catch (failure) {
        if (!controller.signal.aborted) setError(message(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [workspaceId, accessKey]);

  const labels = Object.fromEntries(Object.entries(csvFieldLabelsForObject(importObject, customFields)).map(([field, label]) =>
    [field, field.startsWith('custom:') ? `${label} (${importFieldObject(field, importObject)})` : label])) as Partial<Record<CsvFieldKey, string>>;
  const normalizable = normalizationFieldLabels(importObject, customFields);
  const fields = Object.keys(labels).filter((field) =>
    (Object.hasOwn(normalizable, field) || ['rawEmail', 'lifecycleStage', 'ownerId', 'contactId', 'associatedCompanyId'].includes(field) || binding?.fields[field as CsvFieldKey])
    && (normalized.some((row) => hubspotImportValue(row, field).trim()) || binding?.fields[field as CsvFieldKey] || field.startsWith('custom:'))) as CsvFieldKey[];
  const portalMismatch = Boolean(schema && binding && schema.portalId !== binding.portalId);
  const stale = Boolean(review && (serverStale || review.workspaceRevision !== workspaceRevision
    || reviewInputs !== inputSignature || review.policy !== policy || portalMismatch || (binding && review.portalId !== binding.portalId)));
  const filtered = review?.objects.filter((row) => filter === 'all' || row.object === filter) ?? [];
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const blocked = disabled || Boolean(busy) || loading;

  async function loadSchema() {
    if (blocked) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const requestedInputs = inputSignature;
    setBusy('schema'); setError(''); setNotice('');
    try {
      const response = await request<{ schema: HubSpotImportSchema }>('/api/control-tower/hubspot-import?action=schema', accessKey, controller.signal);
      if (controller.signal.aborted) return;
      setSchema(response.schema);
      if (!binding && latestInputs.current === requestedInputs) {
        onBindingChange(suggestHubSpotBindings(response.schema, importObject, customFields, normalized));
        setNotice('Standard field mappings suggested from this HubSpot portal. Review them and save your mapping.');
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(message(failure));
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  function setField(field: CsvFieldKey, propertyName: string) {
    if (!schema || portalMismatch) return;
    const next = { ...(binding?.fields ?? {}) };
    if (propertyName) next[field] = { object: importFieldObject(field, importObject), propertyName };
    else delete next[field];
    onBindingChange({ portalId: schema.portalId, fields: next });
    setNotice('Mapping changed locally. Save the HubSpot mapping to include it in this workspace and future saved templates.');
  }

  async function saveBinding() {
    if (blocked) return;
    const requestedInputs = inputSignature;
    setBusy('save'); setError(''); setNotice('');
    try {
      await onSaveBinding();
      if (latestInputs.current === requestedInputs) setNotice('HubSpot mapping and value rules saved. Save a shared template to reuse them in future imports.');
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(null); }
  }

  async function dryRun() {
    if (blocked || !workspaceId || workspaceRevision === null || !binding || portalMismatch || normalization.error) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    const requestedInputs = inputSignature;
    setBusy('preview'); setError(''); setNotice('');
    try {
      const response = await request<{ review: HubSpotImportDryRun }>('/api/control-tower/hubspot-import', accessKey, controller.signal,
        { workspaceId, workspaceRevision, binding, normalizationSettings, policy });
      if (controller.signal.aborted) return;
      if (latestInputs.current !== requestedInputs) {
        setNotice('The import changed while HubSpot was being read. Run a new dry run for the current values.');
        return;
      }
      setReview(response.review); setReviewInputs(requestedInputs); setServerStale(false); setPage(0);
      setNotice('Dry run saved locally. HubSpot was read; no CRM records were changed.');
    } catch (failure) {
      if (!controller.signal.aborted) setError(message(failure));
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  return <section aria-label="HubSpot normalized import" className="mb-6 rounded-3xl border border-white/10 bg-[#0c1d17] p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-display text-xl">HubSpot fields and normalized import</h3>
        <p className="mt-2 text-sm text-[#bdcbc4]">Connect your local fields to this HubSpot portal’s properties and allowed picklist values, then compare the normalized import with existing records.</p></div>
      <span className="rounded-full bg-[#b8d8ff]/10 px-3 py-1 text-xs font-semibold text-[#b8d8ff]">Read-only CRM preview</span>
    </div>
    <p className="mt-3 text-xs leading-5 text-[#9db1a7]">Loading fields reads HubSpot’s property definitions. The dry run reads matching CRM records and saves a local review. It does not run paid checks, create properties, import records, or create associations.</p>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" className={buttonClass} disabled={blocked} onClick={() => void loadSchema()}>{busy === 'schema' ? 'Loading HubSpot fields…' : schema ? 'Refresh HubSpot fields' : 'Load HubSpot fields'}</button>
      {schema && <p className="text-xs text-[#9db1a7]">Verified portal {schema.portalId} · Fields fetched {formatTime(schema.fetchedAt)} · {schema.properties.contact.length} contact / {schema.properties.company.length} company properties</p>}
    </div>
    {binding && !schema && <p className="mt-3 text-xs text-[#9db1a7]">Saved field mapping: HubSpot portal {binding.portalId}. Load fields to verify its current properties and picklist values.</p>}
    {schema?.warnings.map((warning, index) => <p key={index} className="mt-2 text-xs text-[#e6bd68]">{warning}</p>)}
    {portalMismatch && <div role="alert" className="mt-4 rounded-xl border border-[#e6bd68]/30 p-3 text-sm text-[#e6bd68]">
      <p>This mapping belongs to HubSpot portal {binding?.portalId}; the connected portal is {schema?.portalId}. Review a new mapping before using this portal.</p>
      <button type="button" className={`${buttonClass} mt-3`} disabled={blocked} onClick={() => {
        onBindingChange(suggestHubSpotBindings(schema!, importObject, customFields, normalized));
        setNotice('A new mapping was suggested for the connected portal. Review every field and value rule before saving.');
      }}>Use connected HubSpot portal</button>
    </div>}
    {schema && !portalMismatch && <>
      <details open className="mt-4 rounded-2xl border border-white/10 p-4">
        <summary className="cursor-pointer text-sm font-semibold">HubSpot field mapping · {Object.keys(binding?.fields ?? {}).length} mapped fields</summary>
        <p className="mt-2 text-xs leading-5 text-[#9db1a7]">Contact and Company properties stay separate. Labels are shown with their internal property names. Missing custom properties stay unmapped; you can select another actual property.</p>
        <div className="mt-4 space-y-3">{fields.map((field) => {
          const scope = importFieldObject(field, importObject);
          const selected = binding?.fields[field]?.propertyName ?? '';
          const identityId = field === 'contactId' || field === 'associatedCompanyId';
          const identityEmail = field === 'rawEmail' || field === 'normalizedEmail';
          const properties = schema.properties[scope];
          const property = properties.find((candidate) => candidate.name === selected);
          const values = [...new Set(normalized.map((row) => hubspotImportValue(row, field)).filter((value) => value.trim()))];
          return <div key={field} className="rounded-xl border border-white/10 p-3" role="group" aria-label={`HubSpot mapping for ${labels[field]}`}>
            <div className="grid gap-3 md:grid-cols-[1fr_2fr]">
              <div><p className="text-xs font-semibold">{labels[field]} <span className="font-normal text-[#9db1a7]">({scope})</span></p>
                <p className="mt-1 break-words text-[11px] text-[#9db1a7]">Normalized sample: {values.slice(0, 3).join(' · ') || 'Empty'}{values.length > 3 ? ` · ${values.length} distinct values` : ''}</p></div>
              <label className="grid gap-1 text-xs text-[#9db1a7]">HubSpot {scope} property
                <select className={inputClass} aria-label={`HubSpot property for ${labels[field]}`} value={selected} disabled={blocked} onChange={(event) => setField(field, event.target.value)}>
                  <option value="">{identityId ? 'Not a verified HubSpot record ID — do not use for lookup' : 'Unmapped — keep for local review / export'}</option>
                  {selected && !property && <option value={selected}>{selected} — missing from this portal</option>}
                  {properties.map((candidate) => {
                    const inUse = Object.entries(binding?.fields ?? {}).some(([localField, target]) => localField !== field && target?.object === scope && target.propertyName === candidate.name);
                    const lookupOnly = identityId && candidate.name === 'hs_object_id';
                    const wrongIdentity = identityId ? candidate.name !== 'hs_object_id' : identityEmail ? candidate.name !== 'email' : ['hs_object_id', 'email'].includes(candidate.name);
                    return <option key={candidate.name} value={candidate.name} disabled={wrongIdentity || (candidate.readOnly && !lookupOnly) || candidate.calculated || candidate.hidden || candidate.externalOptions || inUse}>
                      {candidate.label} ({candidate.name}){lookupOnly ? ' — lookup only' : wrongIdentity ? ' — incompatible identity field' : candidate.readOnly ? ' — read-only' : candidate.calculated ? ' — calculated' : candidate.hidden ? ' — hidden' : candidate.externalOptions ? ' — external options' : inUse ? ' — already mapped' : ''}
                    </option>;
                  })}
                </select>
              </label>
            </div>
            {!selected && field.startsWith('custom:') && <p className="mt-2 text-xs text-[#e6bd68]">This custom field has no selected HubSpot property. No property will be created.</p>}
            {selected && !property && <p className="mt-2 text-xs text-[#e6bd68]">The saved property is unavailable. Select an existing property or leave this field unmapped.</p>}
            {identityId && <p className="mt-2 text-xs text-[#9db1a7]">Select Record ID only when the source contains real HubSpot {scope} record IDs. Local row numbers and generated IDs are not HubSpot IDs. IDs are used only to find records and are never proposed as updates.</p>}
            {property && !identityId && <PropertyValues property={property} field={field} label={labels[field] ?? field} values={values}
              rules={normalizationSettings.valueRules} canNormalize={Object.hasOwn(normalizable, field)} disabled={blocked}
              onAddRule={(from, to) => onNormalizationChange({ ...normalizationSettings, valueRules: [...normalizationSettings.valueRules.filter((rule) => !(rule.field === field && rule.from.trim().toLowerCase() === from.trim().toLowerCase())), { field, from, to }] })} />}
          </div>;
        })}</div>
        {!fields.length && <p className="mt-3 text-xs text-[#9db1a7]">Load an import to see fields that can be mapped.</p>}
        <button type="button" className={`${buttonClass} mt-4`} disabled={blocked || !binding || !workspaceId} onClick={() => void saveBinding()}>{busy === 'save' ? 'Saving mapping…' : 'Save HubSpot mapping'}</button>
        <p className="mt-2 text-[11px] text-[#9db1a7]">The shared template Save controls also retain this portal mapping and its value rules.</p>
      </details>
    </>}
    <div className="mt-5 flex flex-wrap items-end gap-3">
      <label className="grid gap-1.5 text-xs text-[#9db1a7]">Existing HubSpot values
        <select aria-label="HubSpot dry-run update policy" className={inputClass} value={policy} disabled={blocked} onChange={(event) => setPolicy(event.target.value as typeof policy)}>
          <option value="fill-empty">Fill empty fields; preserve existing values</option>
          <option value="overwrite">Preview overwriting mapped nonempty values</option>
        </select>
      </label>
      <button type="button" className={buttonClass} disabled={blocked || !binding || !workspaceId || workspaceRevision === null || portalMismatch || !contacts.length || contacts.length > 500 || Boolean(normalization.error)} onClick={() => void dryRun()}>
        {busy === 'preview' ? 'Reading HubSpot for dry run…' : 'Run normalized HubSpot dry run'}
      </button>
    </div>
    <p className="mt-2 text-xs text-[#9db1a7]">Preview up to 500 source rows. Normalization is simulated for this review; the source rows are preserved.</p>
    {contacts.length > 500 && <p className="mt-2 text-xs text-[#e6bd68]">This import has {contacts.length} rows. Use a workspace with up to 500 rows for the HubSpot dry run.</p>}
    {!workspaceId && <p className="mt-2 text-xs text-[#e6bd68]">Save the workspace before running a dry run.</p>}
    {disabled && <p className="mt-2 text-xs text-[#e6bd68]">Wait for the workspace to finish saving before reading HubSpot.</p>}
    {loading && <p role="status" className="mt-3 text-xs text-[#9db1a7]">Loading the saved local dry run…</p>}
    {(error || normalization.error) && <p role="alert" className="mt-3 text-sm text-[#ffb19a]">{error || normalization.error}</p>}
    {notice && <p role="status" className="mt-3 text-sm text-[#b8d8ff]">{notice}</p>}
    {review && <section className="mt-5 rounded-2xl border border-white/15 p-4" aria-label="HubSpot dry-run results">
      <h4 className="text-sm font-semibold">Normalized import dry run</h4>
      <p className="mt-2 text-xs text-[#9db1a7]">Portal {review.portalId} · Checked {formatTime(review.checkedAt)} · Fields fetched {formatTime(review.schemaFetchedAt)} · {review.normalizedChanges} normalized field changes</p>
      {stale && <p role="status" className="mt-3 rounded-xl border border-[#e6bd68]/30 p-3 text-sm text-[#e6bd68]">This dry run is stale. The workspace, mappings, normalization rules, or update policy changed. Run it again before relying on these proposals.</p>}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">{(['contact', 'company'] as const).map((object) => <div key={object} className="rounded-xl bg-white/[0.025] p-3">
        <p className="text-sm font-semibold">{object === 'contact' ? 'Contacts' : 'Companies'}</p>
        <p className="mt-2 text-xs leading-5 text-[#9db1a7]">{Object.entries(review.counts[object]).map(([status, count]) => `${count} ${statusLabels[status as keyof typeof statusLabels].toLowerCase()}`).join(' · ')}</p>
      </div>)}</div>
      {review.warnings.map((warning, index) => <p key={index} className="mt-2 text-xs text-[#e6bd68]">{warning}</p>)}
      <label className="mt-4 flex flex-wrap items-center gap-2 text-xs text-[#9db1a7]">Show objects
        <select aria-label="Filter HubSpot dry-run objects" className={inputClass} value={filter} onChange={(event) => { setFilter(event.target.value as typeof filter); setPage(0); }}>
          <option value="all">Contacts and companies</option><option value="contact">Contacts</option><option value="company">Companies</option>
        </select>
      </label>
      <div className="mt-3 space-y-3">{filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((row) => <ObjectReview key={row.key} row={row} />)}</div>
      {!filtered.length && <p className="mt-3 text-xs text-[#9db1a7]">No objects match this filter.</p>}
      {filtered.length > pageSize && <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[#9db1a7]">
        <span>{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, filtered.length)} of {filtered.length} objects</span>
        <button type="button" className={buttonClass} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous dry-run objects</button>
        <button type="button" className={buttonClass} disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next dry-run objects</button>
      </div>}
    </section>}
  </section>;
}

function PropertyValues({ property, field, label, values, rules, canNormalize, disabled, onAddRule }: {
  property: HubSpotImportProperty; field: string; label: string; values: string[];
  rules: NormalizationSettings['valueRules']; canNormalize: boolean; disabled: boolean;
  onAddRule: (from: string, to: string) => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const options = property.options.filter((option) => !option.hidden);
  const isEnum = property.type === 'enumeration' || property.fieldType === 'select' || property.fieldType === 'checkbox' || property.fieldType === 'radio';
  const unavailable = property.readOnly || property.calculated || property.hidden || property.externalOptions;
  if (!isEnum) return <p className="mt-2 text-[11px] text-[#9db1a7]">HubSpot type: {property.type} / {property.fieldType}. {unavailable ? 'This property cannot be used in this preview.' : 'No picklist values are defined for this property.'}</p>;
  return <div className="mt-3 text-xs text-[#9db1a7]">
    {unavailable && <p className="text-[#e6bd68]">{property.externalOptions ? 'Options are managed externally and cannot be verified from these property definitions.' : 'This property is read-only, calculated, or hidden.'} Its values need review.</p>}
    {!options.length && <p className="text-[#e6bd68]">HubSpot exposes no selectable values for this picklist. Values remain held for review; options are not invented.</p>}
    {options.length > 0 && <details>
      <summary className="cursor-pointer">Actual picklist values · {options.length}</summary>
      <ul className="mt-2 max-h-40 space-y-1 overflow-auto rounded-lg bg-black/10 p-2">{options.map((option) => <li key={option.value}>{option.label} <code className="text-[#dce9e2]">({option.value})</code></li>)}</ul>
    </details>}
    {rules.filter((rule) => rule.field === field).map((rule, index) => <p className="mt-2 break-words" key={index}>Saved value rule: {rule.from} → {rule.to}</p>)}
    {canNormalize && options.length > 0 && !unavailable && <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <label className="grid gap-1">Source value for {label}
        <input aria-label={`Source value for ${label}`} className={inputClass} value={from} maxLength={1000} list={`hubspot-values-${field}`} disabled={disabled} onChange={(event) => setFrom(event.target.value)} placeholder={values[0] || 'Value to replace'} />
        <datalist id={`hubspot-values-${field}`}>{values.slice(0, 100).map((value) => <option key={value} value={value} />)}</datalist>
      </label>
      <label className="grid gap-1">HubSpot picklist value
        <select aria-label={`HubSpot picklist value for ${label}`} className={inputClass} value={to} disabled={disabled} onChange={(event) => setTo(event.target.value)}>
          <option value="">Select an actual value</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.value})</option>)}
        </select>
      </label>
      <button type="button" className={`${buttonClass} self-end`} disabled={disabled || !from.trim() || !to || rules.length >= 200} onClick={() => { onAddRule(from.trim(), to); setFrom(''); setTo(''); }}>Add value mapping</button>
    </div>}
  </div>;
}

function ObjectReview({ row }: { row: HubSpotImportObjectReview }) {
  const name = row.fields.find((field) => ['email', 'name', 'firstname', 'company'].includes(field.propertyName))?.normalized;
  return <details className="rounded-xl border border-white/10 p-3">
    <summary className="cursor-pointer text-xs"><span className="font-semibold">{row.object === 'contact' ? 'Contact' : 'Company'}{name ? ` · ${name}` : ''}</span>
      <span className={`ml-3 ${row.status === 'review' ? 'text-[#e6bd68]' : 'text-[#b8d8ff]'}`}>{statusLabels[row.status]}</span>
      <span className="ml-3 text-[#9db1a7]">{row.nativeId ? `HubSpot ID ${row.nativeId}` : 'No confirmed HubSpot ID'}</span>
    </summary>
    <p className="mt-2 break-words text-[11px] text-[#9db1a7]">Source rows: {row.sourceRowIds.join(', ')}</p>
    {row.reasons.map((reason, index) => <p key={index} className="mt-2 text-xs text-[#e6bd68]">{reason}</p>)}
    <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[880px] text-left text-xs">
      <thead><tr className="border-b border-white/15 text-[#9db1a7]">{['HubSpot field', 'Original', 'Normalized', 'Current in HubSpot', 'Proposed', 'Action and reason'].map((label) => <th key={label} className="p-2">{label}</th>)}</tr></thead>
      <tbody>{row.fields.map((field) => <tr key={`${field.field}:${field.propertyName}`} className="border-b border-white/10 align-top">
        <td className="max-w-48 break-words p-2"><p>{field.label}</p><p className="mt-1 text-[#9db1a7]">{field.propertyName}</p></td>
        <td className="max-w-48 whitespace-pre-wrap break-words p-2">{displayValue(field.original)}</td>
        <td className="max-w-48 whitespace-pre-wrap break-words p-2">{displayValue(field.normalized)}</td>
        <td className="max-w-48 whitespace-pre-wrap break-words p-2">{displayValue(field.current)}</td>
        <td className="max-w-48 whitespace-pre-wrap break-words p-2">{displayValue(field.proposed)}</td>
        <td className="max-w-72 break-words p-2"><p className={field.action === 'review' ? 'text-[#e6bd68]' : 'text-[#b8d8ff]'}>{field.action}</p><p className="mt-1 text-[#9db1a7]">{field.reason}</p></td>
      </tr>)}</tbody>
    </table></div>
  </details>;
}

function displayValue(value: string | null) { return value === null ? 'Not available' : value || '(empty)'; }
function formatTime(value: string) { return new Date(value).toLocaleString(); }
function message(failure: unknown) { return failure instanceof Error ? failure.message : 'HubSpot import review could not be loaded. Please retry.'; }
async function request<T>(url: string, accessKey: string, signal?: AbortSignal, body?: object): Promise<T> {
  const headers = new Headers();
  if (accessKey) headers.set('x-control-tower-key', accessKey);
  if (body) headers.set('content-type', 'application/json');
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers, signal, cache: 'no-store', ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || 'HubSpot import review could not be loaded. Please retry.');
  return result;
}
