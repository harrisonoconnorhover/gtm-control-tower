'use client';

import { useMemo, useState } from 'react';
import { browserCsvColumnLabel, type BrowserCsv, type BrowserCsvReviewGroup } from '@/lib/browser-csv';

type BrowserCsvRelatedRowsProps = {
  document: BrowserCsv;
  selectedRowId: number;
  groups: BrowserCsvReviewGroup[];
  onSelectRow: (id: number) => void;
  onExcludeRow: (id: number) => void;
};

const buttonClass = 'rounded-lg border border-white/20 px-3 py-2 text-xs text-[#d6e4dc] hover:border-[#83bcff] focus-visible:outline-2 focus-visible:outline-[#83bcff]';

/** Compare actual source columns without deciding which record a person should keep. */
export function BrowserCsvRelatedRows({ document, selectedRowId, groups, onSelectRow, onExcludeRow }: BrowserCsvRelatedRowsProps) {
  const [chosenPeerId, setChosenPeerId] = useState<number | null>(null);
  const [showAllColumns, setShowAllColumns] = useState(false);
  const rowsById = useMemo(() => new Map(document.rows.map((row) => [row.id, row])), [document.rows]);
  const relatedGroups = groups.filter((group) => group.rowIds.includes(selectedRowId));
  const peerIds = [...new Set(relatedGroups.flatMap((group) => group.rowIds))]
    .filter((id) => id !== selectedRowId && rowsById.has(id) && !rowsById.get(id)?.excluded)
    .sort((left, right) => left - right);
  const selected = rowsById.get(selectedRowId);
  const peerId = chosenPeerId !== null && peerIds.includes(chosenPeerId) ? chosenPeerId : peerIds[0];
  const peer = rowsById.get(peerId);

  if (!selected || selected.excluded || !peer) return null;

  const sharedKinds = new Set(relatedGroups.filter((group) => group.rowIds.includes(peer.id)).map((group) => group.kind));
  const columns = document.headers.map((_, column) => column);
  const differentColumns = columns.filter((column) => selected.values[column] !== peer.values[column]);
  const visibleColumns = showAllColumns ? columns : differentColumns;
  const selectedNumber = selected.id + 1;
  const peerNumber = peer.id + 1;


  return <section aria-label={`Compare related rows for row ${selectedNumber}`} className="min-w-0 rounded-xl border border-[#f6c985]/25 bg-[#f6c985]/[0.035] p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h3 className="text-sm font-semibold text-[#f4dfb4]">Compare related rows</h3>
      <span className="text-xs text-[#b8c6b7]">{peerIds.length.toLocaleString()} {peerIds.length === 1 ? 'other row' : 'other rows'}</span>
    </div>
    {peerIds.length > 1 ? <label className="mt-3 block text-xs text-[#c4d7cb]">
      Compare row {selectedNumber} with
      <select aria-label={`Compare row ${selectedNumber} with`} value={peer.id} onChange={(event) => setChosenPeerId(Number(event.target.value))} className="mt-1.5 block min-h-11 w-full min-w-0 rounded-lg border border-white/20 bg-[#081710] px-3 py-2 text-sm text-[#edf8f2] focus-visible:outline-2 focus-visible:outline-[#83bcff]">
        {peerIds.map((id) => <option key={id} value={id}>Row {id + 1}</option>)}
      </select>
    </label> : <p className="mt-3 text-xs text-[#c4d7cb]">Row {selectedNumber} compared with row {peerNumber}</p>}

    <p className="mt-3 text-xs leading-5 text-[#c7cdb5]">{sharedKinds.has('repeated-row')
      ? `All ${document.headers.length.toLocaleString()} column values match exactly.${sharedKinds.has('repeated-email') ? ' Their email also matches.' : ''}`
      : 'These rows share an email after formatting checks. A shared address does not prove they are the same person.'} Both rows stay in the download unless you choose to exclude one.</p>
    {sharedKinds.has('repeated-email') && document.emailColumn !== null && <p className="mt-2 break-words text-xs leading-5 text-[#b8c6b7]">Email in row {selectedNumber}: <code className="whitespace-pre-wrap text-[#d6e4dc]">{JSON.stringify(selected.values[document.emailColumn])}</code></p>}

    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
      <p className="text-xs text-[#c4d7cb]">{differentColumns.length.toLocaleString()} {differentColumns.length === 1 ? 'column differs' : 'columns differ'}</p>
      <button type="button" aria-pressed={showAllColumns} onClick={() => setShowAllColumns((value) => !value)} className="rounded px-1 py-2 text-xs text-[#b9d8ff] underline decoration-[#b9d8ff]/40 underline-offset-4 focus-visible:outline-2 focus-visible:outline-[#83bcff]">{showAllColumns ? 'Show differences only' : `Show all ${columns.length.toLocaleString()} columns`}</button>
    </div>
    {!visibleColumns.length && <p className="mt-2 text-xs leading-5 text-[#a2b8ab]">There are no differing values. Show all columns to inspect the matching values.</p>}
    {visibleColumns.length > 0 && <div role="region" tabIndex={0} className="mt-2 max-h-[420px] space-y-3 overflow-y-auto rounded-lg pr-1 focus-visible:outline-2 focus-visible:outline-[#83bcff]" aria-label={`Values for rows ${selectedNumber} and ${peerNumber}`}>
      {visibleColumns.map((column) => <div key={column} className="min-w-0 rounded-lg border border-white/10 bg-black/15 p-3">
        <h4 className="whitespace-pre-wrap break-words text-xs font-semibold text-[#d6e4dc]">{browserCsvColumnLabel(document.headers, column)}</h4>
        <dl className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2">
          {[selected, peer].map((row) => <div key={row.id} className="min-w-0">
            <dt className="mb-1 text-[11px] text-[#a2b8ab]">Row {row.id + 1}{row.id === selected.id ? ' · currently open' : ''}</dt>
            <dd className="min-w-0"><code className="block whitespace-pre-wrap break-words text-xs leading-5 text-[#edf8f2]">{JSON.stringify(row.values[column])}</code></dd>
          </div>)}
        </dl>
      </div>)}
    </div>}
    <p className="mt-3 text-[11px] leading-5 text-[#91a89b]">{visibleColumns.length > 2 && 'Scroll within the comparison to inspect every shown column. '}Values are quoted to show outer spaces. <code>\n</code> marks a line break; <code>\t</code> marks a tab.</p>

    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className={buttonClass} onClick={() => onSelectRow(peer.id)}>Open row {peerNumber} to edit</button>
      <button type="button" className={buttonClass} onClick={() => onExcludeRow(peer.id)}>Exclude row {peerNumber}</button>
    </div>
    <p className="mt-2 text-[11px] leading-5 text-[#91a89b]">Exclusion only omits that row from the download. Restore it from the Excluded view or use Undo.</p>
  </section>;
}
