'use client';

import { useMemo, useState } from 'react';
import type { CustomFieldDefinition } from '@/lib/import-fields';
import type { ImportObject, LiveContactState } from '@/lib/live-control-tower';
import {
  normalizationFieldLabels,
  previewNormalization,
  type NormalizationPreview,
  type NormalizationSettings,
} from '@/lib/import-normalization';

const inputClass = 'min-w-0 rounded-lg border border-white/15 bg-[#0c1d17] px-3 py-2 text-xs text-[#dce9e2]';
const secondaryButton = 'rounded-full border border-white/15 px-3 py-2 text-xs text-[#a9bbb2] disabled:opacity-40';

type EditorProps = {
  settings: NormalizationSettings;
  onChange: (settings: NormalizationSettings) => void;
  customFields?: CustomFieldDefinition[];
  importObject?: ImportObject;
  disabled?: boolean;
};

export function NormalizationSettingsEditor({ settings, onChange, customFields = [], importObject = 'contact', disabled }: EditorProps) {
  const fields = normalizationFieldLabels(importObject, customFields);
  const update = (patch: Partial<NormalizationSettings>) => onChange({ ...settings, ...patch });
  const switches = [
    ['trimWhitespace', 'Clean extra whitespace'],
    ...(importObject !== 'company' ? [['splitFullName', 'Split simple full names into First / Last name']] : []),
    ['normalizeCountries', 'Standardize countries'], ['normalizeStates', 'Standardize US states / Canadian provinces'],
    ['normalizePhones', 'Format phone numbers internationally'], ['normalizeAddresses', 'Clean address spacing'],
    ...(importObject !== 'company' ? [['normalizeJobTitles', 'Map job titles to department / persona']] : []),
  ] as Array<[keyof NormalizationSettings, string]>;
  return <fieldset disabled={disabled} className="space-y-4 disabled:opacity-50">
    <div className="grid gap-3 sm:grid-cols-2">
      {switches.map(([key, label]) => <label key={key} className="flex items-start gap-2 text-xs leading-5 text-[#bdcbc4]">
        <input type="checkbox" checked={Boolean(settings[key])} onChange={(event) => update({ [key]: event.target.checked })} className="mt-1 accent-[#cdfc54]" />{label}
      </label>)}
    </div>
    <div className="grid gap-3 md:grid-cols-3">
      <label className="grid gap-1.5 text-xs text-[#a9bbb2]">Country / state standard
        <select aria-label="Country and state standard" value={settings.countryFormat} onChange={(event) => update({ countryFormat: event.target.value as NormalizationSettings['countryFormat'] })} className={inputClass}>
          <option value="name">Full names (United States, California)</option><option value="code">Codes (US, CA)</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-xs text-[#a9bbb2]">Default country for missing country values
        <input value={settings.defaultCountry} onChange={(event) => update({ defaultCountry: event.target.value })} placeholder="Optional: United States or US" className={inputClass} />
      </label>
      {importObject !== 'company' && <label className="grid gap-1.5 text-xs text-[#a9bbb2]">Name casing
        <select aria-label="Name casing" value={settings.nameCase} onChange={(event) => update({ nameCase: event.target.value as NormalizationSettings['nameCase'] })} className={inputClass}>
          <option value="preserve">Preserve spelling and capitalization</option><option value="title">Title case (review before applying)</option>
        </select>
      </label>}
    </div>
    <p className="text-[11px] leading-5 text-[#8fa99d]">Country context is required for national phone numbers and states. Simple two-part names can be split; ambiguous names stay for review. Address cleanup changes spacing only. Phone formatting does not verify reachability.</p>
    {importObject !== 'company' && <details className="rounded-xl border border-white/10 p-3">
      <summary className="cursor-pointer text-xs font-semibold text-[#bdcbc4]">Job title rules · {settings.titleRules.length}</summary>
      <p className="mt-3 text-[11px] leading-5 text-[#8fa99d]">Keywords match complete words or phrases, ignoring case. Matching rules fill empty categories only. Conflicting rules produce a warning.</p>
      <div className="mt-3 space-y-3">
        {settings.titleRules.map((rule, index) => <div key={index} role="group" aria-label={`Job title rule ${index + 1}`} className="grid gap-2 rounded-lg bg-white/[0.025] p-3 md:grid-cols-[2fr_1fr_1fr_auto]">
          <label className="grid gap-1 text-[11px] text-[#a9bbb2]">Title keywords, separated by commas
            <input value={rule.keywords.join(',')} onChange={(event) => update({ titleRules: settings.titleRules.map((item, i) => i === index ? { ...item, keywords: event.target.value.split(',') } : item) })} className={inputClass} placeholder="revops, revenue operations" />
          </label>
          <label className="grid gap-1 text-[11px] text-[#a9bbb2]">Department
            <input value={rule.department} onChange={(event) => update({ titleRules: settings.titleRules.map((item, i) => i === index ? { ...item, department: event.target.value } : item) })} className={inputClass} />
          </label>
          <label className="grid gap-1 text-[11px] text-[#a9bbb2]">Persona
            <input value={rule.persona} onChange={(event) => update({ titleRules: settings.titleRules.map((item, i) => i === index ? { ...item, persona: event.target.value } : item) })} className={inputClass} />
          </label>
          <button type="button" onClick={() => update({ titleRules: settings.titleRules.filter((_, i) => i !== index) })} aria-label={`Remove job title rule ${index + 1}`} className={`${secondaryButton} self-end`}>Remove</button>
        </div>)}
      </div>
      <button type="button" onClick={() => update({ titleRules: [...settings.titleRules, { keywords: [], department: '', persona: '' }] })} disabled={settings.titleRules.length >= 100} className={`${secondaryButton} mt-3`}>Add job title rule</button>
    </details>}
    <details className="rounded-xl border border-white/10 p-3">
      <summary className="cursor-pointer text-xs font-semibold text-[#bdcbc4]">Exact value rules · {settings.valueRules.length}</summary>
      <p className="mt-3 text-[11px] leading-5 text-[#8fa99d]">Map variations to your picklist values, including custom fields. Matches ignore case and extra spaces. Blank values are not filled by these rules.</p>
      <div className="mt-3 space-y-3">
        {settings.valueRules.map((rule, index) => <div key={index} role="group" aria-label={`Value rule ${index + 1}`} className="grid gap-2 rounded-lg bg-white/[0.025] p-3 md:grid-cols-[1.5fr_1fr_1fr_auto]">
          <label className="grid gap-1 text-[11px] text-[#a9bbb2]">Field
            <select value={rule.field} onChange={(event) => update({ valueRules: settings.valueRules.map((item, i) => i === index ? { ...item, field: event.target.value } : item) })} className={inputClass}>
              {!Object.hasOwn(fields, rule.field) && <option value={rule.field}>Unavailable field · {rule.field}</option>}
              {Object.entries(fields).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-[#a9bbb2]">Source value
            <input value={rule.from} onChange={(event) => update({ valueRules: settings.valueRules.map((item, i) => i === index ? { ...item, from: event.target.value } : item) })} className={inputClass} placeholder="Chocolate icecream" />
          </label>
          <label className="grid gap-1 text-[11px] text-[#a9bbb2]">Standard value
            <input value={rule.to} onChange={(event) => update({ valueRules: settings.valueRules.map((item, i) => i === index ? { ...item, to: event.target.value } : item) })} className={inputClass} placeholder="Chocolate" />
          </label>
          <button type="button" onClick={() => update({ valueRules: settings.valueRules.filter((_, i) => i !== index) })} aria-label={`Remove value rule ${index + 1}`} className={`${secondaryButton} self-end`}>Remove</button>
        </div>)}
      </div>
      <button type="button" onClick={() => update({ valueRules: [...settings.valueRules, { field: Object.keys(fields).find((key) => key.startsWith('custom:')) ?? 'country', from: '', to: '' }] })} disabled={settings.valueRules.length >= 200} className={`${secondaryButton} mt-3`}>Add value rule</button>
    </details>
  </fieldset>;
}

type Props = {
  contacts: LiveContactState[];
  customFields: CustomFieldDefinition[];
  settings: NormalizationSettings;
  onSettingsChange: (settings: NormalizationSettings) => void;
  onApply: (preview: NormalizationPreview) => Promise<void>;
  disabled?: boolean;
};

export function ImportNormalizationPanel({ contacts, customFields, settings, onSettingsChange, onApply, disabled }: Props) {
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState('');
  const [changesPage, setChangesPage] = useState(0);
  const [warningsPage, setWarningsPage] = useState(0);
  const importObject = contacts[0]?.importObject ?? 'contact';
  const labels = normalizationFieldLabels(importObject, customFields);
  const result = useMemo(() => {
    try { return { preview: previewNormalization(contacts, settings, customFields), error: '' }; }
    catch (error) { return { preview: null, error: error instanceof Error ? error.message : 'Check the normalization rules.' }; }
  }, [contacts, settings, customFields]);
  const preview = result.preview;
  const changePages = Math.max(1, Math.ceil((preview?.changes.length ?? 0) / 100));
  const warningPages = Math.max(1, Math.ceil((preview?.warnings.length ?? 0) / 50));
  const currentChangesPage = Math.min(changesPage, changePages - 1);
  const currentWarningsPage = Math.min(warningsPage, warningPages - 1);
  async function apply() {
    if (!preview || !preview.changes.length) return;
    setApplying(true);
    setMessage('');
    try {
      await onApply(preview);
      setMessage(`Applied ${preview.changes.length.toLocaleString()} field changes across ${preview.changedRows.toLocaleString()} rows. Original imported values are retained for reset and undo.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The normalization changes could not be saved.'); }
    finally { setApplying(false); }
  }
  return <section aria-label="Import normalization" className="rounded-3xl border border-white/10 bg-[#0c1d17]/70 p-5 md:p-6">
    <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#83bcff]">Import preparation</p>
    <h2 className="mt-2 text-xl font-semibold text-[#e5f1eb]">Normalize values</h2>
    <p className="mb-5 mt-2 text-sm leading-6 text-[#a9bbb2]">Review the proposed changes, then apply them to this local import. Skipped, merged, and suppressed rows are left unchanged. No paid checks or CRM writes run here.</p>
    <NormalizationSettingsEditor settings={settings} onChange={(next) => { setMessage(''); setChangesPage(0); setWarningsPage(0); onSettingsChange(next); }} customFields={customFields} importObject={importObject} disabled={disabled || applying} />
    {result.error && <p role="alert" className="mt-4 text-sm text-[#f0a59c]">{result.error}</p>}
    {preview && <div className="mt-5 border-t border-white/10 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-sm text-[#bdcbc4]">{preview.changes.length.toLocaleString()} proposed changes · {preview.changedRows.toLocaleString()} rows · {preview.warnings.length.toLocaleString()} review warnings</p>
        <button type="button" onClick={() => void apply()} disabled={disabled || applying || !preview.changes.length} className="rounded-full bg-[#cdfc54] px-4 py-2.5 text-xs font-bold text-[#07130f] disabled:opacity-40">{applying ? 'Saving normalization…' : 'Apply local normalization'}</button>
      </div>
      {preview.changes.length > 0 && <div className="mt-4 max-h-[420px] overflow-auto rounded-xl border border-white/10">
        <table className="w-full min-w-[680px] text-left text-xs" aria-label="Normalization before and after">
          <thead className="sticky top-0 bg-[#11251c] text-[#a9bbb2]"><tr>{['Row', 'Field', 'Before', 'After', 'Reason'].map((heading) => <th key={heading} className="px-3 py-2 font-medium">{heading}</th>)}</tr></thead>
          <tbody>{preview.changes.slice(currentChangesPage * 100, (currentChangesPage + 1) * 100).map((change) => <tr key={`${change.contactId}:${change.field}`} className="border-t border-white/5 text-[#bdcbc4]">
            <td className="px-3 py-2 font-mono">{change.contactId}</td><td className="px-3 py-2">{labels[change.field] ?? change.field}</td>
            <td className="max-w-56 break-words px-3 py-2 whitespace-pre-wrap">{change.before || '(empty)'}</td><td className="max-w-56 break-words px-3 py-2 whitespace-pre-wrap text-[#cdfc54]">{change.after || '(empty)'}</td><td className="max-w-72 px-3 py-2 leading-5">{change.reason}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {changePages > 1 && <div aria-label="Normalization changes pages" className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" disabled={currentChangesPage === 0} onClick={() => setChangesPage(currentChangesPage - 1)} className={secondaryButton}>Previous changes</button>
        <p className="text-[11px] text-[#8fa99d]">Changes page {currentChangesPage + 1} of {changePages}. Apply includes all {preview.changes.length.toLocaleString()} changes.</p>
        <button type="button" disabled={currentChangesPage >= changePages - 1} onClick={() => setChangesPage(currentChangesPage + 1)} className={secondaryButton}>Next changes</button>
      </div>}
      {preview.warnings.length > 0 && <details className="mt-4 rounded-xl border border-[#e6bd68]/25 p-3">
        <summary className="cursor-pointer text-xs font-semibold text-[#e6bd68]">Review warnings · {preview.warnings.length.toLocaleString()}</summary>
        <ul className="mt-3 space-y-2 text-xs leading-5 text-[#bdcbc4]">{preview.warnings.slice(currentWarningsPage * 50, (currentWarningsPage + 1) * 50).map((warning, index) => <li key={index}><strong>{warning.contactId} · {labels[warning.field] ?? warning.field}:</strong> {warning.reason}</li>)}</ul>
        {warningPages > 1 && <div aria-label="Normalization warning pages" className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" disabled={currentWarningsPage === 0} onClick={() => setWarningsPage(currentWarningsPage - 1)} className={secondaryButton}>Previous warnings</button>
          <p className="text-[11px] text-[#8fa99d]">Warnings page {currentWarningsPage + 1} of {warningPages}</p>
          <button type="button" disabled={currentWarningsPage >= warningPages - 1} onClick={() => setWarningsPage(currentWarningsPage + 1)} className={secondaryButton}>Next warnings</button>
        </div>}
      </details>}
    </div>}
    {message && <p role="status" className="mt-4 text-sm text-[#bdcbc4]">{message}</p>}
  </section>;
}
