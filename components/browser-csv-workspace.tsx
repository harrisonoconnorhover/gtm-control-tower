'use client';

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  applyBrowserCleanup, BROWSER_CSV_MAX_BYTES, browserCsvColumnLabel, browserCsvIssues, browserCsvReview, browserCsvSample,
  cleanupProposals, exportBrowserCsv, parseBrowserCsv, toggleBrowserRow,
  type BrowserCsv, type BrowserCsvRow,
} from '@/lib/browser-csv';
import { BrowserCsvRelatedRows } from '@/components/browser-csv-related-rows';

const primary = 'rounded-xl bg-[#d8ff67] px-5 py-3 text-sm font-semibold text-[#102019] transition hover:bg-[#e5ff9e] disabled:cursor-not-allowed disabled:opacity-40';
const secondary = 'rounded-xl border border-white/15 bg-white/[0.035] px-4 py-2.5 text-sm text-[#d6e4dc] transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40';
const inputClass = 'w-full rounded-lg border border-white/20 bg-[#091914] px-3 py-2.5 text-sm text-[#edf8f2] focus:border-[#d8ff67] focus:outline-none focus:ring-1 focus:ring-[#d8ff67]';
type RowFilter = 'all' | 'review' | 'changed' | 'excluded';
const changed = (row: BrowserCsvRow) => row.values.some((value, column) => value !== row.original[column]);

export function BrowserCsvWorkspace({ active = true }: { active?: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const readVersion = useRef(0);
  const rowButtons = useRef(new Map<number, HTMLButtonElement>());
  const rowsHeading = useRef<HTMLHeadingElement>(null);
  const [document, setDocument] = useState<BrowserCsv | null>(null);
  const [filename, setFilename] = useState('');
  const [history, setHistory] = useState<BrowserCsv[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draftValues, setDraftValues] = useState<string[] | null>(null);
  const [filter, setFilter] = useState<RowFilter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [proposalPage, setProposalPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (active) window.scrollTo({ top: 0 });
  }, [active]);

  useEffect(() => {
    if (!document) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [document]);

  const { issues, groups } = useMemo(() => document ? browserCsvReview(document) : { issues: new Map<number, string[]>(), groups: [] }, [document]);
  const proposals = useMemo(() => document ? cleanupProposals(document) : [], [document]);
  const currentProposalPage = Math.min(proposalPage, Math.max(0, Math.ceil(proposals.length / 5) - 1));
  const download = useMemo(() => document ? exportBrowserCsv(document) : null, [document]);
  const rows = useMemo(() => document?.rows.filter((row) => {
    if (filter === 'review' && !issues.has(row.id)) return false;
    if (filter === 'changed' && !changed(row)) return false;
    if (filter === 'excluded' && !row.excluded) return false;
    return !search || row.values.some((value) => value.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  }) ?? [], [document, filter, issues, search]);
  const selected = document?.rows.find((row) => row.id === selectedId);
  const draftDirty = Boolean(selected && draftValues?.some((value, column) => value !== selected.values[column]));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  const visibleRows = rows.slice(currentPage * 20, currentPage * 20 + 20);
  const previewColumns = document ? Array.from(new Set([
    ...document.headers.slice(0, 2).map((_, index) => index),
    document.emailColumn ?? (document.headers.length > 2 ? 2 : 0),
  ])) : [];

  function commit(next: BrowserCsv, message: string) {
    if (document) setHistory((previous) => [...previous.slice(-9), document]);
    setDocument(next);
    setDraftValues(null);
    setProposalPage(0);
    setNotice(message);
    setError('');
  }

  // A pending row edit is part of the user's working file, including when an
  // action is clicked without pressing Save row first. Keep the draft in this
  // component so hiding the editor or switching a view cannot destroy it.
  function withRowEdits(current: BrowserCsv): BrowserCsv {
    if (!draftDirty || !draftValues || selectedId === null) return current;
    return { ...current, rows: current.rows.map((row) => row.id === selectedId ? { ...row, values: [...draftValues] } : row) };
  }

  function saveRow() {
    if (document && draftDirty) commit(withRowEdits(document), `Saved row ${(selectedId ?? 0) + 1}. Review notes have been updated.`);
  }

  function selectRow(id: number | null) {
    saveRow();
    setDraftValues(null);
    setSelectedId(id);
  }

  function closeRow() {
    const closingId = selectedId;
    selectRow(null);
    // Saving may remove the row from the current filter. Return to its action
    // when it is still visible, otherwise keep focus at the rows being reviewed.
    window.requestAnimationFrame(() => {
      (closingId === null ? rowsHeading.current : rowButtons.current.get(closingId) ?? rowsHeading.current)?.focus();
    });
  }

  function changePage(next: number) {
    setPage(next);
    window.requestAnimationFrame(() => {
      rowsHeading.current?.focus({ preventScroll: true });
      rowsHeading.current?.scrollIntoView({ block: 'start' });
    });
  }

  function undo() {
    if (draftDirty) {
      setDraftValues(null);
      setNotice('Undid the current row edits.');
      return;
    }
    const previous = history.at(-1);
    if (previous) {
      setDocument(previous);
      setDraftValues(null);
      setHistory(history.slice(0, -1));
      setNotice('Undid the last change.');
    }
  }

  function mayReplace() {
    return !document || window.confirm('Replace this file? Download your current work first if you want to keep it.');
  }

  function load(text: string, name: string) {
    const next = parseBrowserCsv(text);
    setDocument(next);
    setFilename(name);
    setHistory([]);
    setSelectedId(null);
    setDraftValues(null);
    setFilter('all');
    setSearch('');
    setPage(0);
    setRulesOpen(next.trimColumns.length === 0 && next.emailColumn === null);
    setError('');
    setNotice(`${next.rows.length.toLocaleString()} rows opened locally. Review the suggested changes below.`);
  }

  async function readFile(file: File) {
    if (!mayReplace()) return;
    const version = ++readVersion.current;
    setBusy(true);
    setError('');
    try {
      if (file.size > BROWSER_CSV_MAX_BYTES) throw new Error('Choose a CSV no larger than 10 MB. Your file has not been uploaded.');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw new Error('This file could not be read as UTF-8. Export it as CSV UTF-8 (comma delimited) from your spreadsheet, then try again.');
      }
      if (version !== readVersion.current) return;
      load(text, file.name);
    } catch (failure) {
      if (version === readVersion.current) setError(failure instanceof Error ? failure.message : 'This file could not be read. Try a UTF-8, comma-separated CSV.');
    } finally {
      if (version === readVersion.current) setBusy(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void readFile(file);
  }

  function saveDownload() {
    if (!document) return;
    const current = withRowEdits(document);
    const result = current === document ? download : exportBrowserCsv(current);
    if (!result || result.rowCount === 0) return;
    if (current !== document) commit(current, 'Saved row edits.');
    const pendingReview = browserCsvIssues(current).size;
    const blob = new Blob(['\uFEFF', result.csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = `${filename.replace(/\.csv$/iu, '') || 'contacts'}-cleaned.csv`;
    window.document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(`Download prepared: ${result.rowCount.toLocaleString()} ${result.rowCount === 1 ? 'row' : 'rows'}, all ${current.headers.length} original columns. ${pendingReview ? `${pendingReview} ${pendingReview === 1 ? 'row still has' : 'rows still have'} review notes.` : ''}`);
  }

  return (
    <main id="clean-csv" className="min-h-screen bg-[#07130f] text-[#edf8f2] selection:bg-[#d8ff67] selection:text-[#102019]">
      <div className="mx-auto max-w-[1440px] px-4 sm:px-8 lg:px-10">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 py-5">
          <a href="#top" onClick={saveRow} className="flex items-center gap-3 rounded focus-visible:outline-2 focus-visible:outline-[#d8ff67]">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#d8ff67] text-xs font-black text-[#102019]">GT</span>
            <span className="text-sm font-semibold">GTM Control Tower <span className="mt-0.5 block text-xs font-normal text-[#9eb3a7]">← Back to overview</span></span>
          </a>
          <span className="rounded-full border border-[#d8ff67]/20 bg-[#d8ff67]/5 px-3 py-2 text-xs text-[#d8ff67]">On your device · no account needed</span>
        </header>

        <div className="flex flex-wrap items-end justify-between gap-6 py-8 sm:py-10">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#83bcff]">The browser CSV workspace</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">A cleaner CSV. Zero setup.</h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-[#a2b8ab]">Open your file, review the changes, and take it with you. Your data stays in this tab. No uploads, installations, or CRM connections.</p>
          </div>
          <ol className="flex flex-wrap gap-4 text-xs text-[#a2b8ab]" aria-label="Workflow">
            {['Open CSV', 'Review & clean', 'Download'].map((label, index) => <li key={label} className="flex items-center gap-2"><span className={`grid h-6 w-6 place-items-center rounded-full border ${document || index === 0 ? 'border-[#d8ff67]/40 text-[#d8ff67]' : 'border-white/15'}`}>{index + 1}</span>{label}</li>)}
          </ol>
        </div>

        <input ref={fileInput} type="file" accept=".csv,text/csv" aria-label="Choose a CSV file" className="sr-only" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void readFile(file); event.currentTarget.value = ''; }} />
        {error && <p role="alert" className="mb-5 rounded-xl border border-[#ffac8b]/30 bg-[#ffac8b]/10 p-4 text-sm text-[#ffd0ba]">{error}</p>}
        <p role="status" aria-live="polite" className={notice ? 'mb-4 text-sm text-[#c4d7cb]' : 'sr-only'}>{notice}</p>

        {!document ? (
          <div className="mb-12 grid overflow-hidden rounded-3xl border border-white/15 bg-[#0b1c16] lg:grid-cols-[1.25fr_0.75fr]">
            <div onDragOver={(event) => event.preventDefault()} onDragEnter={() => setDragging(true)} onDragLeave={() => setDragging(false)} onDrop={handleDrop} data-testid="csv-dropzone" className={`m-5 flex min-h-[360px] flex-col items-center justify-center rounded-2xl border border-dashed p-6 text-center sm:m-8 ${dragging ? 'border-[#d8ff67] bg-[#d8ff67]/10' : 'border-[#83bcff]/35 bg-[#83bcff]/[0.025]'}`}>
              <span aria-hidden="true" className="grid h-16 w-16 place-items-center rounded-2xl border border-[#83bcff]/30 bg-[#83bcff]/10 text-3xl text-[#83bcff]">↥</span>
              <h2 className="mt-6 text-2xl font-semibold tracking-tight">Drop your CSV here</h2>
              <p className="mt-3 max-w-sm text-sm leading-6 text-[#a2b8ab]">Contacts, companies, deals, or any other table. No email or name column required. Keep every column and review every row.</p>
              <button disabled={busy} onClick={() => fileInput.current?.click()} className={`${primary} mt-6`}>{busy ? 'Reading on your device…' : 'Choose CSV file'}</button>
              <p className="mt-4 text-xs text-[#91a89b]">UTF-8 CSV · up to 10 MB and 10,000 rows</p>
            </div>
            <div className="flex flex-col justify-center border-t border-white/10 p-7 sm:p-10 lg:border-l lg:border-t-0">
              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[#d8ff67]">Take a quick look first</span>
              <h2 className="mt-4 text-2xl font-semibold tracking-tight">Try a small, messy file.</h2>
              <p className="mt-3 text-sm leading-6 text-[#a2b8ab]">Six fictional contacts, extra spaces, a repeated email, and a couple of things only a person can fix.</p>
              <div className="my-6 space-y-3 rounded-xl border border-white/10 bg-black/15 p-4 text-xs">
                <p className="flex justify-between gap-3"><span className="text-[#a2b8ab]">Extra spaces</span><span className="text-[#d8ff67]">Preview a fix</span></p>
                <p className="flex justify-between gap-3"><span className="text-[#a2b8ab]">Repeated email</span><span className="text-[#f6c985]">Review together</span></p>
                <p className="flex justify-between gap-3"><span className="text-[#a2b8ab]">Custom columns</span><span className="text-[#83bcff]">Keep them all</span></p>
              </div>
              <button disabled={busy} className={`${secondary} self-start`} onClick={() => { ++readVersion.current; load(browserCsvSample, 'practice-contacts.csv'); }}>Try sample CSV →</button>
            </div>
          </div>
        ) : (
          <>
            <section aria-label="File overview" className="rounded-2xl border border-white/15 bg-[#0b1c16] p-5 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0"><h2 className="break-all text-lg font-semibold">{filename}</h2><p className="mt-1 text-xs text-[#a2b8ab]">{document.headers.length} original columns · changes stay here until you download</p></div>
                <div className="flex flex-wrap gap-2">
                  <button className={secondary} disabled={!history.length && !draftDirty} onClick={undo}>Undo</button>
                  <button className={secondary} disabled={busy} onClick={() => fileInput.current?.click()}>Open another CSV</button>
                  <button className={primary} disabled={!download?.rowCount} onClick={saveDownload}>Download CSV</button>
                </div>
              </div>
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="Source rows" value={document.rows.length} />
                <Metric label="Rows changed" value={document.rows.filter(changed).length} />
                <Metric label="Need your review" value={issues.size} warning />
                <Metric label="Excluded from download" value={document.rows.filter((row) => row.excluded).length} />
              </div>
              <p className="mt-4 text-xs leading-5 text-[#a2b8ab]" aria-label="Review coverage">{document.emailColumn === null
                ? 'Checking empty rows and exact repeated rows. No email column is selected, so email checks are off. All rows remain available to edit, format, and download.'
                : 'Checking empty rows, exact repeated rows, and email formatting. Review notes are suggestions; rows are never removed automatically.'}</p>
            </section>

            <section aria-label="Suggested cleanup" className="my-5 overflow-hidden rounded-2xl border border-[#83bcff]/25 bg-[#83bcff]/[0.04]">
              <div className="flex flex-wrap items-center justify-between gap-4 p-5">
                <div><h2 className="text-lg font-semibold">{proposals.length ? `${proposals.length.toLocaleString()} formatting changes to review` : document.trimColumns.length === 0 && document.emailColumn === null ? 'Choose which columns to clean' : 'No formatting changes to apply'}</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-[#a2b8ab]">Trim selected text columns and standardize email domains. Names, owners, stages, and duplicate decisions stay yours.</p></div>
                <button disabled={!proposals.length} className={secondary} onClick={() => { const current = withRowEdits(document); const count = cleanupProposals(current).length; commit(applyBrowserCleanup(current), `Applied ${count.toLocaleString()} formatting changes. Review notes have been updated.`); }}>Apply formatting changes</button>
              </div>
              {proposals.length > 0 && <details className="border-t border-white/10 p-5" open>
                <summary className="cursor-pointer text-sm font-medium text-[#b9d8ff]">Preview before applying</summary>
                <div className="mt-3 space-y-2">
                  {proposals.slice(currentProposalPage * 5, currentProposalPage * 5 + 5).map((proposal) => <div key={`${proposal.rowId}-${proposal.column}`} className="grid gap-1 rounded-lg bg-black/15 p-3 text-xs sm:grid-cols-[150px_1fr_auto_1fr] sm:items-center">
                    <span className="text-[#a2b8ab]">Row {proposal.rowId + 1} · {browserCsvColumnLabel(document.headers, proposal.column)}</span>
                    <code className="whitespace-pre-wrap break-all text-[#ffc7ae]">{JSON.stringify(proposal.before)}</code><span aria-hidden="true" className="text-[#a2b8ab]">→</span><code className="whitespace-pre-wrap break-all text-[#d8ff67]">{JSON.stringify(proposal.after)}</code>
                  </div>)}
                  {proposals.length > 5 && <div className="flex flex-wrap items-center justify-between gap-3 pt-2 text-xs text-[#a2b8ab]"><span>Changes {currentProposalPage * 5 + 1}–{Math.min(currentProposalPage * 5 + 5, proposals.length)} of {proposals.length.toLocaleString()}</span><div className="flex gap-2"><button className={secondary} disabled={currentProposalPage === 0} onClick={() => setProposalPage(currentProposalPage - 1)}>Earlier changes</button><button className={secondary} disabled={(currentProposalPage + 1) * 5 >= proposals.length} onClick={() => setProposalPage(currentProposalPage + 1)}>More changes</button></div></div>}
                </div>
              </details>}
              <details open={rulesOpen} onToggle={(event) => setRulesOpen(event.currentTarget.open)} className="border-t border-white/10 p-5">
                <summary className="cursor-pointer text-sm text-[#b9d8ff]">Choose columns & formatting rules</summary>
                <div className="mt-4 grid gap-5 sm:grid-cols-[minmax(180px,0.7fr)_1.3fr]">
                  <label className="text-xs text-[#c4d7cb]">Email column
                    <select aria-label="Email column" className={`${inputClass} mt-2`} value={document.emailColumn ?? ''} onChange={(event) => commit({ ...withRowEdits(document), emailColumn: event.target.value === '' ? null : Number(event.target.value) }, 'Email checks updated.')}>
                      <option value="">No email checks</option>{document.headers.map((_, column) => <option key={column} value={column}>{browserCsvColumnLabel(document.headers, column)}</option>)}
                    </select>
                    <span className="mt-2 block leading-5 text-[#a2b8ab]">Checks formatting and repeated addresses, not whether a mailbox exists. Email domains are standardized; the part before @ stays unchanged.</span>
                  </label>
                  <fieldset><legend className="text-xs text-[#c4d7cb]">Trim outer spaces in these columns</legend><div className="mt-3 grid max-h-48 gap-3 overflow-auto sm:grid-cols-2">{document.headers.map((_, column) => <label key={column} className="flex items-start gap-2 text-xs text-[#a2b8ab]"><input type="checkbox" className="mt-0.5 accent-[#d8ff67]" checked={document.trimColumns.includes(column)} onChange={(event) => commit({ ...withRowEdits(document), trimColumns: event.target.checked ? [...document.trimColumns, column] : document.trimColumns.filter((item) => item !== column) }, 'Formatting preview updated.')} /><span className="break-all">{browserCsvColumnLabel(document.headers, column)}</span></label>)}</div></fieldset>
                </div>
              </details>
            </section>

            <section aria-label="Review rows" className={`grid items-start gap-5 ${selected ? 'xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]' : ''}`}>
              <div className="min-w-0 overflow-hidden rounded-2xl border border-white/15 bg-[#0b1c16]">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 p-5"><div><h2 ref={rowsHeading} tabIndex={-1} className="rounded text-lg font-semibold focus-visible:outline-2 focus-visible:outline-[#83bcff]">Your rows</h2><p className="mt-1 text-xs text-[#a2b8ab]">Review any row to edit all its columns.</p></div><input aria-label="Search rows" placeholder="Search this file…" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} className={`${inputClass} max-w-[230px]`} /></div>
                <div className="flex flex-wrap gap-2 p-4" aria-label="Filter rows">{(['all', 'review', 'changed', 'excluded'] as const).map((value) => <button key={value} onClick={() => { setFilter(value); setPage(0); }} aria-pressed={filter === value} className={`rounded-lg px-3 py-2 text-xs ${filter === value ? 'bg-[#d8ff67] font-semibold text-[#102019]' : 'bg-white/5 text-[#bdcfc3]'}`}>{({ all: 'All rows', review: 'Needs review', changed: 'Changed', excluded: 'Excluded' })[value]}</button>)}</div>
                <p className="px-4 pb-3 text-xs text-[#a2b8ab] sm:hidden">Swipe across the table to see more columns. Review opens every field.</p>
                <div className="relative overflow-x-auto"><table className="w-full text-left text-xs"><caption className="sr-only">CSV preview. Open a row to inspect every column.</caption><thead className="border-y border-white/10 bg-black/15 text-[#a2b8ab]"><tr><th className="sticky left-0 z-10 min-w-[100px] bg-[#0b1c16] px-4 py-3 font-medium">Row / action</th>{previewColumns.map((column) => <th key={column} className="min-w-[140px] px-3 py-3 font-medium">{browserCsvColumnLabel(document.headers, column)}</th>)}<th className="min-w-[160px] px-3 py-3 font-medium">Review notes</th></tr></thead>
                  <tbody className="divide-y divide-white/10">{visibleRows.map((row) => <tr key={row.id} className={row.id === selectedId ? 'bg-[#83bcff]/10' : row.excluded ? 'bg-black/20 text-[#91a89b]' : 'hover:bg-white/[0.02]'}><th scope="row" className="sticky left-0 z-10 bg-[#0b1c16] px-3 py-3 font-normal text-[#a2b8ab]"><span className="mb-2 block">{row.id + 1}</span><button ref={(node) => { if (node) rowButtons.current.set(row.id, node); else rowButtons.current.delete(row.id); }} aria-label={`Review row ${row.id + 1}`} className="rounded-lg border border-white/20 px-3 py-2 text-[#d6e4dc] hover:border-[#83bcff]" onClick={() => selectRow(row.id)}>Review</button></th>{previewColumns.map((column) => <td key={column} className="max-w-[220px] px-3 py-4"><span className="line-clamp-2 break-all" title={row.values[column]}>{row.values[column] || <span className="text-[#91a89b]">Empty</span>}</span></td>)}<td className="px-3 py-4"><span className={row.excluded ? 'text-[#a2b8ab]' : issues.has(row.id) ? 'text-[#f6c985]' : 'text-[#b7d4c1]'}>{row.excluded ? 'Excluded' : issues.get(row.id)?.join(' · ') || (document.emailColumn === null ? 'No empty or repeated-row issues' : 'No issues in selected checks')}</span>{changed(row) && <span className="mt-1 block text-[#83bcff]">Edited</span>}</td></tr>)}</tbody>
                </table></div>
                {!rows.length && <p className="p-8 text-center text-sm text-[#a2b8ab]">No rows match this view.</p>}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-4 py-3 text-xs text-[#a2b8ab]"><span>{rows.length ? `${currentPage * 20 + 1}–${Math.min((currentPage + 1) * 20, rows.length)} of ${rows.length.toLocaleString()}` : '0 rows'}</span><div className="flex gap-2"><button className={secondary} disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}>Previous</button><button className={secondary} disabled={(currentPage + 1) * 20 >= rows.length} onClick={() => changePage(currentPage + 1)}>Next</button></div></div>
              </div>
              {selected && <RowEditor row={selected} draft={draftValues ?? selected.values} onDraftChange={setDraftValues} headers={document.headers} issues={issues.get(selected.id) ?? []} onClose={closeRow} onToggle={() => commit(toggleBrowserRow(withRowEdits(document), selected.id), selected.excluded ? `Row ${selected.id + 1} restored to the download.` : `Row ${selected.id + 1} excluded. You can restore it anytime.`)} onSave={saveRow} onDiscard={() => { setDraftValues(null); setNotice('Discarded the current row edits.'); }}>
                {draftDirty ? <p className="mt-4 text-xs leading-5 text-[#b9d8ff]">Save row to refresh review notes and related-row comparisons.</p> : <div className="mt-4"><BrowserCsvRelatedRows key={selected.id} document={document} selectedRowId={selected.id} groups={groups} onSelectRow={selectRow} onExcludeRow={(id) => commit(toggleBrowserRow(withRowEdits(document), id), `Row ${id + 1} excluded. Use Undo or the Excluded view to restore it.`)} /></div>}
              </RowEditor>}
            </section>

            <section aria-label="Download details" className="mb-10 mt-5 flex flex-wrap items-center justify-between gap-5 rounded-2xl border border-[#d8ff67]/25 bg-[#d8ff67]/[0.045] p-5 sm:p-6">
              <div className="max-w-3xl"><h2 className="text-lg font-semibold">Take your file with you</h2><p className="mt-2 text-sm leading-6 text-[#bdd0c2]">{download?.rowCount.toLocaleString()} rows and all {document.headers.length} original columns will be downloaded. {issues.size > 0 ? `${issues.size} ${issues.size === 1 ? 'row still needs' : 'rows still need'} review and ${issues.size === 1 ? 'is' : 'are'} included unless you exclude ${issues.size === 1 ? 'it' : 'them'}.` : 'Only rows you explicitly exclude are left out.'}</p>{proposals.length > 0 && <p className="mt-2 text-xs text-[#f6c985]">{proposals.length} suggested formatting changes have not been applied. The download uses your current values.</p>}<p className="mt-2 text-xs leading-5 text-[#a2b8ab]">{download?.escapedCells ? `${download.escapedCells} formula-like ${download.escapedCells === 1 ? 'cell will' : 'cells will'} receive a leading apostrophe so spreadsheets treat them as text. ` : ''}CSV files cannot control spreadsheet formatting. Import ID and phone columns as text to preserve leading zeros. Download before closing or refreshing this tab.</p></div>
              <button className={primary} disabled={!download?.rowCount} onClick={saveDownload}>Download CSV</button>
            </section>
          </>
        )}
        <footer className="border-t border-white/10 py-6 text-xs leading-6 text-[#91a89b]">Your file stays in this tab&apos;s memory. No data is sent to a server or saved in browser storage. The original file is never overwritten.</footer>
      </div>
    </main>
  );
}

function Metric({ label, value, warning = false }: { label: string; value: number; warning?: boolean }) {
  return <div className="rounded-xl border border-white/10 bg-black/10 p-4"><p className={`text-2xl font-semibold ${warning && value ? 'text-[#f6c985]' : 'text-[#edf8f2]'}`}>{value.toLocaleString()}</p><p className="mt-1 text-xs text-[#a2b8ab]">{label}</p></div>;
}

function RowEditor({ row, draft, onDraftChange, headers, issues, onSave, onDiscard, onToggle, onClose, children }: { children?: ReactNode; row: BrowserCsvRow; draft: string[]; onDraftChange: (values: string[]) => void; headers: string[]; issues: string[]; onSave: () => void; onDiscard: () => void; onToggle: () => void; onClose: () => void }) {
  const dirty = draft.some((value, column) => value !== row.values[column]);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: window.matchMedia('(max-width: 1279px)').matches ? 'start' : 'nearest' }); }, [row.id]);
  return <aside aria-label={`Edit row ${row.id + 1}`} className="rounded-2xl border border-[#83bcff]/30 bg-[#0d211a] p-5">
    <div className="flex items-start justify-between gap-4"><div><h2 ref={heading} tabIndex={-1} className="rounded text-lg font-semibold focus-visible:outline-2 focus-visible:outline-[#83bcff]">Review row {row.id + 1}</h2><p className="mt-1 text-xs text-[#a2b8ab]">{row.excluded ? 'Excluded from download' : 'Included in download'}</p></div><button onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-[#b9cfc0]">Close</button></div>
    {issues.length > 0 && <div className="mt-4 rounded-xl border border-[#f6c985]/25 bg-[#f6c985]/5 p-3 text-xs leading-5 text-[#f6c985]">{issues.map((issue) => <p key={issue}>{issue}</p>)}{issues.some((issue) => issue.startsWith('Repeated email')) && <p className="mt-2 text-[#c7cdb5]">Repeated email does not prove these are the same person. Inspect both rows before excluding one.</p>}</div>}
    {children}
    <form onSubmit={(event) => { event.preventDefault(); onSave(); }} className="mt-5">
      <div className="max-h-[480px] space-y-4 overflow-y-auto px-0.5 pb-1">{headers.map((_, column) => <label key={column} className="block text-xs text-[#c4d7cb]">{browserCsvColumnLabel(headers, column)}<textarea aria-label={`${browserCsvColumnLabel(headers, column)} — row ${row.id + 1}`} rows={draft[column].includes('\n') ? 3 : 1} className={`${inputClass} mt-1.5 min-h-11 resize-y`} value={draft[column]} onChange={(event) => onDraftChange(draft.map((value, index) => index === column ? event.target.value : value))} />{draft[column] !== row.original[column] && <span className="mt-1 block break-all text-[11px] text-[#91a89b]">Original: {JSON.stringify(row.original[column])}</span>}</label>)}</div>
      <div className="mt-5 flex flex-wrap gap-2"><button type="submit" disabled={!dirty} className={primary}>Save row</button>{dirty && <button type="button" className={secondary} onClick={onDiscard}>Discard edits</button>}<button type="button" className={secondary} onClick={onToggle}>{row.excluded ? 'Restore row' : 'Exclude row'}</button></div>
      <p className="mt-3 text-xs leading-5 text-[#91a89b]">Row edits are kept when you switch rows or download. Use Undo to reverse a change. Excluded rows can always be restored.</p>
    </form>
  </aside>;
}
