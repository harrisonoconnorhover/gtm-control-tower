'use client';

import { useState } from 'react';
import {
  destinationHoldFlags,
  isDestinationReadyContact,
  type CsvContactCorrection,
  type CsvContactCorrectionInput,
} from '@/lib/csv-control-tower';
import type { LiveContactState } from '@/lib/live-control-tower';

type Props = {
  contacts: LiveContactState[];
  history: CsvContactCorrection[];
  disabled: boolean;
  onCorrect: (contactId: string, input: CsvContactCorrectionInput, reason: string) => Promise<string>;
};

const fields = [
  ['rawEmail', 'Email'],
  ['company', 'Company'],
  ['ownerId', 'Owner'],
  ['lifecycleStage', 'Lifecycle stage'],
] as const;

const historyFields = [
  ...fields,
  ['normalizedEmail', 'Normalized email'],
  ['qualityFlags', 'Quality flags'],
] as const;

function displayValue(value: string | string[] | null) {
  return Array.isArray(value) ? value.join(', ') || 'None' : value || 'Empty';
}

export function HeldContactReview({ contacts, history, disabled, onCorrect }: Props) {
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('');
  const held = contacts.filter((contact) => contact.recordStatus === 'active' && !contact.importExclusion && destinationHoldFlags(contact).length > 0);
  const ready = contacts.filter(isDestinationReadyContact).length;
  const selected = held.find((contact) => contact.contactId === selectedId) ?? held[0];

  return (
    <section aria-label="Resolve held records" className="mb-6 rounded-[28px] border border-white/10 bg-[#0c1d17] p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold">Resolve held records</h3>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-[#9db1a7]">Correct imported values using a verified source. Each correction rechecks the remaining holds and keeps the original values and your reason. Changes stay in this workspace until you explicitly export or sync.</p>
        </div>
        <p className="text-sm text-[#cdfc54]">{ready} destination ready · {held.length} held</p>
      </div>
      <p className="mt-2 text-xs text-[#9db1a7]">These counts use the generic destination rules. HubSpot and Salesforce have their own eligibility checks.</p>
      {message && <p role="status" className="mt-4 rounded-xl bg-[#83bcff]/10 p-3 text-sm text-[#b6d7ff]">{message}</p>}
      {selected ? (
        <div className="mt-5">
          <label className="block max-w-xl text-sm">
            Held record
            <select value={selected.contactId} disabled={disabled} onChange={(event) => { setSelectedId(event.target.value); setMessage(''); }} className="mt-2 w-full rounded-xl border border-white/20 bg-[#07130f] p-3">
              {held.map((contact) => <option key={contact.contactId} value={contact.contactId}>{contact.fullName} · {contact.contactId}</option>)}
            </select>
          </label>
          <CorrectionForm key={JSON.stringify(selected)} contact={selected} disabled={disabled} onCorrect={async (input, reason) => {
            const result = await onCorrect(selected.contactId, input, reason);
            setMessage(result);
          }} />
        </div>
      ) : <p className="mt-4 text-sm text-[#9db1a7]">{contacts.length ? 'No active records are held by the generic destination rules.' : 'Import a CSV to review held records.'}</p>}
      {history.length > 0 && (
        <div className="mt-6 border-t border-white/10 pt-5">
          <h4 className="font-semibold">Correction history</h4>
          <p className="mt-1 text-xs text-[#9db1a7]">Before and after each correction. Workspace undo restores the previous saved state.</p>
          <div className="mt-3 space-y-2">
            {history.map((correction) => (
              <details key={correction.id} className="rounded-xl border border-white/10 p-3">
                <summary className="cursor-pointer text-sm">{correction.before.fullName} · {correction.contactId} · {new Date(correction.reviewedAt).toLocaleString()}</summary>
                <p className="mt-3 break-words text-sm text-[#b5c6bd]">Reason: {correction.reason}</p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead><tr><th className="p-2">Field</th><th className="p-2">Before</th><th className="p-2">After</th></tr></thead>
                    <tbody>{historyFields.filter(([field]) => JSON.stringify(correction.before[field]) !== JSON.stringify(correction.after[field])).map(([field, label]) => (
                      <tr key={field} className="border-t border-white/10"><th className="p-2 font-normal">{label}</th><td className="max-w-xs break-words p-2 text-[#9db1a7]">{displayValue(correction.before[field])}</td><td className="max-w-xs break-words p-2 text-[#dce9e2]">{displayValue(correction.after[field])}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
                <p className="mt-3 text-xs text-[#9db1a7]">Remaining holds at this correction: {destinationHoldFlags(correction.after).join(', ') || 'None'}. Email changes also recheck duplicate flags on other active records.</p>
              </details>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function CorrectionForm({ contact, disabled, onCorrect }: {
  contact: LiveContactState;
  disabled: boolean;
  onCorrect: (input: CsvContactCorrectionInput, reason: string) => Promise<void>;
}) {
  const [values, setValues] = useState<CsvContactCorrectionInput>({ rawEmail: contact.rawEmail, company: contact.company ?? '', ownerId: contact.ownerId ?? '', lifecycleStage: contact.lifecycleStage });
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return (
    <form className="mt-4" onSubmit={async (event) => {
      event.preventDefault();
      setError('');
      setSaving(true);
      try { await onCorrect(values, reason); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Correction failed.'); }
      finally { setSaving(false); }
    }}>
      <p className="text-sm text-[#ffb19a]">Held for: {destinationHoldFlags(contact).map((flag) => flag.replaceAll('_', ' ')).join(', ')}</p>
      <p className="mt-2 text-xs text-[#9db1a7]">Current normalized email: {contact.normalizedEmail ?? 'Invalid'}. Expected lifecycle stage: {contact.expectedLifecycleStage}.</p>
      <fieldset disabled={disabled || saving} className="mt-4 space-y-4 disabled:opacity-60">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {fields.map(([field, label]) => (
            <label key={field} className="text-sm">{label}
              <input value={values[field]} onChange={(event) => setValues({ ...values, [field]: event.target.value })} className="mt-2 w-full rounded-xl border border-white/20 bg-[#07130f] p-3 text-sm" />
            </label>
          ))}
        </div>
        <label className="flex items-start gap-2 text-xs leading-5 text-[#b5c6bd]">
          <input type="checkbox" checked={values.recheckEmail ?? false} onChange={(event) => setValues({ ...values, recheckEmail: event.target.checked })} className="mt-1" />
          Recheck identity from the entered email. Use this when a supplied normalized email is wrong. Changing the email also rechecks identity automatically.
        </label>
        <label className="block text-sm">Correction reason
          <textarea required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="What did you verify, and where?" rows={2} className="mt-2 w-full rounded-xl border border-white/20 bg-[#07130f] p-3 text-sm" />
        </label>
        <p className="text-xs leading-5 text-[#9db1a7]">Leave unknown values unresolved. Saving a correction does not override a hold or verify that an email address exists. Changing an email may create or resolve duplicate holds elsewhere in this batch.</p>
        <button type="submit" disabled={!reason.trim()} className="rounded-full bg-[#cdfc54] px-5 py-3 text-sm font-semibold text-[#10221a] disabled:opacity-50">{saving ? 'Saving correction…' : 'Save correction and revalidate'}</button>
      </fieldset>
      {error && <p role="alert" className="mt-3 text-sm text-[#ffb19a]">{error}</p>}
    </form>
  );
}
