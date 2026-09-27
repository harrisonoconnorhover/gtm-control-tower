'use client';

import { portableCrmFieldNames, type CrmUpdatePolicy, type PortableCrmFieldName } from '@/lib/crm-workflow';

type Props = {
  value: CrmUpdatePolicy;
  onChange: (value: CrmUpdatePolicy) => void;
  disabled?: boolean;
};

const labels: Record<PortableCrmFieldName, string> = {
  firstName: 'first name', lastName: 'last name', company: 'company',
  phone: 'phone', jobTitle: 'job title', website: 'website',
};

export function CrmUpdatePolicyControls({ value, onChange, disabled = false }: Props) {
  return <fieldset disabled={disabled} className="space-y-3 rounded-xl border border-white/10 bg-white/[0.025] p-4 disabled:opacity-50">
    <legend className="px-1 text-sm font-semibold">Existing CRM records</legend>
    <label className="grid gap-2 text-sm">
      <span>Update existing CRM records</span>
      <select value={value.mode} onChange={(event) => {
        const mode = event.target.value as CrmUpdatePolicy['mode'];
        onChange({ ...value, mode, clearBlanks: mode === 'replace' && value.clearBlanks });
      }} className="rounded-lg border border-white/15 bg-[#111827] px-3 py-2 text-sm">
        <option value="fill-empty">Fill empty fields only</option>
        <option value="replace">Replace selected fields</option>
      </select>
    </label>
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      {portableCrmFieldNames.map((field) => <label key={field} className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={value.fields.includes(field)} onChange={(event) => {
          const selected = new Set(value.fields);
          if (event.target.checked) selected.add(field); else selected.delete(field);
          onChange({ ...value, fields: portableCrmFieldNames.filter((candidate) => selected.has(candidate)) });
        }} />
        <span>Update {labels[field]}</span>
      </label>)}
    </div>
    <label className="flex items-start gap-2 text-xs">
      <input type="checkbox" disabled={value.mode !== 'replace'} checked={value.mode === 'replace' && value.clearBlanks}
        onChange={(event) => onChange({ ...value, clearBlanks: event.target.checked })} />
      <span>Allow blank values to clear selected fields</span>
    </label>
    <p className="text-xs leading-5 text-white/55">
      {value.mode === 'fill-empty'
        ? 'Fill empty CRM fields from nonblank import values. Existing CRM values stay unchanged.'
        : value.clearBlanks
          ? 'Replace selected fields, including clearing CRM values when the import is blank. Review each change before executing.'
          : 'Replace selected fields using nonblank import values. Blank import values keep the current CRM value.'}
      {' '}Unselected fields stay unchanged. These choices apply to exact matches; new records use all mapped import fields.
    </p>
  </fieldset>;
}
