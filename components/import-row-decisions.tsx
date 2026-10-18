'use client';

import { useMemo, useRef, useState } from 'react';
import { IMPORT_EXCLUSION_REASON_MAX_LENGTH } from '@/lib/import-exclusions';
import type { LiveContactState } from '@/lib/live-control-tower';

type Props = {
  contacts: LiveContactState[];
  busy: boolean;
  onExclude: (contactId: string, reason: string) => Promise<void>;
  onRestore: (contactId: string) => Promise<void>;
};

const pageSize = 20;
const buttonClass = 'rounded-full border border-white/20 px-4 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40';

export function ImportRowDecisions({ contacts, busy, onExclude, onRestore }: Props) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [reasons, setReasons] = useState<Map<string, string>>(() => new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const active = useMemo(() => contacts.filter((contact) => contact.recordStatus === 'active'), [contacts]);
  const skipped = active.filter((contact) => contact.importExclusion).length;
  const suppressed = active.filter((contact) => contact.suppressionMatches?.length).length;
  const included = active.filter((contact) => !contact.importExclusion && !contact.suppressionMatches?.length).length;
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return active.filter((contact) => [contact.contactId, contact.fullName, contact.rawEmail, contact.company, contact.associatedCompany?.name, contact.associatedCompany?.website,
      contact.importExclusion?.reason, ...(contact.suppressionMatches ?? []).flatMap((match) => [match.reason, match.listName, match.value])].some((value) => value?.toLowerCase().includes(search)));
  }, [active, query]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const rows = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const disabled = busy || saving;

  async function decide(contact: LiveContactState) {
    if (busy || savingRef.current) return;
    const reason = (reasons.get(contact.contactId) ?? '').trim();
    if (!contact.importExclusion && !reason) {
      setError(`Enter a reason for skipping ${contact.contactId}.`);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      if (contact.importExclusion) await onRestore(contact.contactId);
      else await onExclude(contact.contactId, reason);
      setReasons((previous) => { const next = new Map(previous); next.delete(contact.contactId); return next; });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The row decision could not be saved. Try again.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <section aria-label="Import row decisions" className="mt-6 rounded-2xl border border-white/10 bg-black/15 p-4 sm:p-5">
      <h3 className="font-display text-xl">Choose which rows to import</h3>
      <p className="mt-2 text-sm text-[#bdcbc4]">{included} included · {skipped} manually skipped · {suppressed} suppressed. Skipping keeps the source row and your reason, leaves it out of writes and duplicate suggestions, and can be reversed here. Suppressions come from the saved lists above.</p>
      <label className="mt-4 block text-xs font-semibold">
        Find import row
        <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }}
          placeholder="ID, name, email, company, or exclusion reason"
          className="mt-2 block w-full rounded-xl border border-white/20 bg-[#10271d] px-3 py-2 text-sm font-normal" />
      </label>
      {error ? <p role="alert" className="mt-3 text-sm text-[#ffbdab]">{error}</p> : null}
      <div className="mt-4 space-y-3">
        {rows.map((contact) => (
          <div key={contact.contactId} className="rounded-xl border border-white/10 p-3">
            <p className="break-words text-sm font-semibold">{contact.importObject === 'company' ? contact.company || 'Missing company name' : contact.fullName} <span className="font-mono text-xs font-normal text-[#a8bdb0]">{contact.contactId}</span></p>
            <p className="mt-1 break-words text-xs text-[#a8bdb0]">{contact.importObject === 'company' ? contact.website || 'No website' : `${contact.rawEmail || 'No email'} · ${contact.associatedCompany?.name || contact.company || 'No company'}`}</p>
            {!!contact.suppressionMatches?.length && <div className="mt-2 text-sm text-[#f2d28b]">
              <p className="font-semibold">Suppressed</p>
              <ul className="mt-1 space-y-1">{contact.suppressionMatches.map((match) => <li key={match.ruleId} className="break-words">{match.reason} · {match.listName} · {match.type}: {match.value}</li>)}</ul>
              <p className="mt-1 text-xs text-[#a8bdb0]">Change the matching suppression rule to include this row. Restoring a manual skip does not override suppression.</p>
            </div>}
            {contact.importExclusion ? (
              <>
                <p className="mt-2 break-words text-sm text-[#f2d28b]">Skipped: {contact.importExclusion.reason}</p>
                <p className="mt-1 text-xs text-[#a8bdb0]">Saved {new Date(contact.importExclusion.excludedAt).toLocaleString()}</p>
              </>
            ) : (
              <label className="mt-3 block text-xs text-[#bdcbc4]">
                Reason for skipping {contact.contactId}
                <input value={reasons.get(contact.contactId) ?? ''} required maxLength={IMPORT_EXCLUSION_REASON_MAX_LENGTH}
                  disabled={disabled} onChange={(event) => setReasons((previous) => new Map(previous).set(contact.contactId, event.target.value))}
                  className="mt-1 block w-full rounded-lg border border-white/20 bg-[#10271d] px-3 py-2 text-sm" />
              </label>
            )}
            <button type="button" disabled={disabled} onClick={() => void decide(contact)} className={`${buttonClass} mt-3`}>
              {contact.importExclusion ? contact.suppressionMatches?.length ? 'Restore manual skip for' : 'Restore' : 'Skip'} row {contact.contactId}
            </button>
          </div>
        ))}
        {!rows.length ? <p className="text-sm text-[#a8bdb0]">No active import rows match this search.</p> : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[#a8bdb0]">
        <span>{filtered.length ? `${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, filtered.length)} of ${filtered.length} rows` : '0 rows'}</span>
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className={buttonClass}>Previous import rows</button>
        <button type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)} className={buttonClass}>Next import rows</button>
      </div>
    </section>
  );
}
