import type { LiveContactState } from '@/lib/live-control-tower';
import { POMADE_CONTACT_FIELDS, type PomadeContactField, type PomadeOrigin } from '@/lib/pomade-handoff';

type CurrentContact = Pick<LiveContactState, 'fullName' | 'firstName' | 'lastName' | 'rawEmail' | 'company' | 'phone' | 'jobTitle' | 'website'>;

/** Imported research remains a source claim, including when its value still matches. */
export function PomadeSourceContext({ origins, contact }: { origins?: PomadeOrigin[]; contact?: CurrentContact }) {
  if (!origins?.length) return null;
  const currentValue = (field: PomadeContactField) => (contact?.[field === 'email' ? 'rawEmail' : field] ?? '').trim();
  return <details className="mt-3 rounded-xl border border-[#83bcff]/15 bg-[#83bcff]/[0.025] p-3 text-[11px] text-[#a8bbb1]">
    <summary className="cursor-pointer font-semibold text-[#b8d8ff]">Pomade source context · {origins.length} {origins.length === 1 ? 'row' : 'rows'} · updates only</summary>
    <p className="mt-2 leading-5">Research evidence is historical source context, not proof of current values or CRM approval. “Ready” does not authorize a write. Research context does not establish a CRM identity.</p>
    {origins.map((origin, index) => {
      const changed = contact && POMADE_CONTACT_FIELDS.some((field) => origin.proposedFields[field] !== null && origin.proposedFields[field]!.trim() !== currentValue(field));
      return <div key={`${origin.sourceInstanceId ?? origin.legacyImportId}:${origin.workspaceId}:${origin.rowId}:${index}`} className="mt-3 border-t border-white/10 pt-3">
        <p className="break-words font-semibold">{origin.workspaceName ?? 'Unknown table name'} · source row {origin.rowId}</p>
        <p className="mt-1 break-all font-mono text-[9px]">Table {origin.workspaceId} · source installation {origin.sourceInstanceId ?? 'unknown (legacy file)'}</p>
        <p className="mt-1">Source status: {origin.sourceStatus ?? 'unknown'}{origin.reviewReason ? ` · ${origin.reviewReason}` : ''}</p>
        <p className="mt-1">Exported {origin.exportedAt ? new Date(origin.exportedAt).toLocaleString() : 'at an unknown time'} · revision {origin.sourceRevision ?? 'unknown'}</p>
        {changed && <p className="mt-2 text-[#e6bd68]">Current values differ from this proposal. Its evidence is historical context, not proof of the edited values.</p>}
        <div className="mt-2 overflow-x-auto"><table className="w-full text-left"><caption className="pb-2 text-left font-semibold">Original proposed values</caption><tbody>{POMADE_CONTACT_FIELDS.map((field) => <tr key={field} className="border-t border-white/[0.04]"><th className="py-1.5 pr-3 align-top font-normal text-[#71877c]">{field}</th><td className="break-words py-1.5">{origin.proposedFields[field] ?? 'Not supplied'}</td></tr>)}</tbody></table></div>
        {origin.fieldMappings.length > 0 && <p className="mt-2 break-words text-[#71877c]">Source columns: {origin.fieldMappings.map((mapping) => `${mapping.sourceColumnTitle} → ${mapping.contactField}`).join(' · ')}</p>}
        {origin.evidence.length ? <div className="mt-3 space-y-2">{origin.evidence.map((evidence, evidenceIndex) => {
          const historical = contact && currentValue(evidence.field) !== evidence.value.trim();
          const sourceUrl = safeSourceUrl(evidence.sourceUrl);
          return <div key={evidenceIndex} className="rounded-lg border border-white/[0.06] p-2 leading-5"><p className="font-semibold">Supplied source claim · {evidence.field}{historical ? ' · historical value' : ''}</p><p className="break-words">Observed value: {evidence.value}</p>{evidence.quote && <p className="mt-1 break-words">Quoted context: “{evidence.quote}”</p>}{sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer" className="mt-1 block break-all text-[#83bcff] underline">Source reference</a>}<p className="mt-1 text-[#71877c]">{evidence.observedAt ? new Date(evidence.observedAt).toLocaleString() : 'Observation time unknown'}{evidence.reference ? ` · ${evidence.reference}` : ''}</p></div>;
        })}</div> : <p className="mt-2 text-[#71877c]">No research evidence supplied. Missing citations alone do not approve or reject a row.</p>}
      </div>;
    })}
  </details>;
}

function safeSourceUrl(value: string | null): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
