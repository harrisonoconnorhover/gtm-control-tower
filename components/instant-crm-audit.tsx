'use client';

import { useRef, useState, type DragEvent } from 'react';
import { auditContactsCsv, renderCrmAuditMarkdown, type CrmAuditReport } from '@/lib/crm-audit';
import { messyLeadDemoCsv } from '@/lib/messy-lead-demo';

const MAX_FILE_SIZE = 10 * 1024 * 1024;

export function InstantCrmAudit() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<CrmAuditReport | null>(null);
  const [status, setStatus] = useState<'idle' | 'reading' | 'ready' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  async function readFile(file: File) {
    setStatus('reading');
    setMessage(null);
    if (file.size > MAX_FILE_SIZE) {
      setStatus('error');
      setMessage('Choose a CSV smaller than 10 MB. Nothing was uploaded.');
      return;
    }
    try {
      runAudit(await file.text(), file.name);
    } catch (error) {
      setReport(null);
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'That file could not be audited.');
    }
  }

  function runAudit(csv: string, fileName: string) {
    try {
      setReport(auditContactsCsv(csv, fileName));
      setStatus('ready');
      setMessage(null);
    } catch (error) {
      setReport(null);
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'That file could not be audited.');
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void readFile(file);
  }

  function downloadReport() {
    if (!report) return;
    const blob = new Blob([renderCrmAuditMarkdown(report)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${report.fileName.replace(/\.csv$/iu, '') || 'crm'}-readiness-audit.md`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function reset() {
    setReport(null);
    setStatus('idle');
    setMessage(null);
  }

  return (
    <section id="audit" className="scroll-mt-6 py-8" aria-labelledby="audit-heading">
      <div className="overflow-hidden rounded-[36px] border border-[#83bcff]/25 bg-[linear-gradient(145deg,#0a201a_0%,#0a1714_48%,#07110e_100%)] shadow-[0_35px_110px_rgba(0,0,0,0.28)]">
        <div className="grid lg:grid-cols-[0.88fr_1.12fr]">
          <div className="border-b border-white/10 p-6 sm:p-8 lg:border-b-0 lg:border-r lg:p-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#83bcff]/25 bg-[#83bcff]/[0.07] px-3 py-2 font-mono text-[9px] uppercase tracking-[0.18em] text-[#83bcff]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#83bcff]" />
              Private browser-only audit
            </div>
            <h2 id="audit-heading" className="mt-5 text-4xl font-semibold leading-[0.98] tracking-[-0.055em] sm:text-5xl">Know what will break before the CRM does.</h2>
            <p className="mt-5 max-w-xl text-sm leading-6 text-[#91a69b]">Drop a common CRM contact export. Control Tower reads it in this tab, maps familiar headers, and returns a board-ready readiness audit. The file is never uploaded or stored.</p>
            <div className="mt-6 grid grid-cols-2 gap-3 text-xs">
              <AuditPromise value="Seconds" label="to first diagnosis" />
              <AuditPromise value="0 rows" label="sent to a server" />
              <AuditPromise value="7" label="control families" />
              <AuditPromise value=".md" label="portable audit report" />
            </div>
            <div className="mt-6 rounded-2xl border border-white/10 bg-black/15 p-4">
              <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-[#6f887c]">Works best with exports containing</p>
              <p className="mt-2 text-xs leading-5 text-[#a7b8af]">Email · name · company · owner · lifecycle stage · expected stage · region · segment</p>
            </div>
          </div>

          <div className="p-5 sm:p-7 lg:p-10">
            {!report ? (
              <div>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  aria-label="Choose a CRM CSV to audit"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) void readFile(file);
                    event.currentTarget.value = '';
                  }}
                />
                <div
                  onDragEnter={() => setDragging(true)}
                  onDragLeave={() => setDragging(false)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={handleDrop}
                  className={`grid min-h-[320px] place-items-center rounded-[28px] border border-dashed p-6 text-center transition ${dragging ? 'border-[#d8ff67] bg-[#d8ff67]/10' : 'border-[#83bcff]/35 bg-[#83bcff]/[0.045]'}`}
                  data-testid="crm-audit-dropzone"
                >
                  <div className="max-w-md">
                    <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-[#83bcff]/20 bg-[#83bcff]/10 text-2xl text-[#83bcff]">↥</span>
                    <h3 className="mt-5 text-xl font-semibold">Drop a CSV here</h3>
                    <p className="mt-2 text-xs leading-5 text-[#789084]">Your data stays in this browser tab. We receive no rows, filenames, or audit results.</p>
                    <button onClick={() => fileInput.current?.click()} disabled={status === 'reading'} className="mt-5 rounded-full bg-[#83bcff] px-5 py-3 text-sm font-black text-[#07130f] transition hover:-translate-y-0.5 hover:bg-[#acd5ff] disabled:opacity-60">
                      {status === 'reading' ? 'Reading locally…' : 'Choose my CRM export'}
                    </button>
                    <button onClick={() => runAudit(messyLeadDemoCsv(), 'gtm-control-tower-practice-batch.csv')} className="ml-2 mt-3 rounded-full border border-white/12 px-5 py-3 text-sm font-semibold text-[#b8c9c0] transition hover:border-white/25 hover:bg-white/[0.04]">Try the safe sample</button>
                  </div>
                </div>
                {message && <p role="alert" className="mt-3 rounded-xl border border-[#ff7755]/25 bg-[#ff7755]/[0.07] px-4 py-3 text-xs leading-5 text-[#ffad97]">{message}</p>}
              </div>
            ) : (
              <AuditResult report={report} onDownload={downloadReport} onReset={reset} />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function AuditResult({ report, onDownload, onReset }: { report: CrmAuditReport; onDownload: () => void; onReset: () => void }) {
  return (
    <div data-testid="crm-audit-result">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-[#83bcff]">Instant CRM audit · complete</p>
          <h3 className="mt-2 break-all text-2xl font-semibold">{report.fileName}</h3>
          <p className="mt-1 text-xs text-[#71877c]">{report.sourceRows.toLocaleString()} rows · {report.mappedFields} familiar fields mapped locally</p>
        </div>
        <div className="relative grid h-28 w-28 place-items-center rounded-full" style={{ background: `conic-gradient(#d8ff67 ${report.readinessScore * 3.6}deg, rgba(255,255,255,0.08) 0deg)` }}>
          <div className="grid h-[92px] w-[92px] place-items-center rounded-full bg-[#081713] text-center">
            <div><p className="text-3xl font-semibold text-[#d8ff67]">{report.readinessScore}%</p><p className="font-mono text-[8px] uppercase text-[#71877c]">ready</p></div>
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <AuditMetric label="Ready now" value={report.readyRows} tone="good" />
        <AuditMetric label="Held safely" value={report.heldRows} tone="warning" />
        <AuditMetric label="Duplicate extras" value={report.duplicateRecords} tone="warning" />
        <AuditMetric label="Automatable" value={report.automatableCandidates} tone="good" />
      </div>

      <div className="mt-5 overflow-hidden rounded-2xl border border-white/10">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[0.025] px-4 py-3">
          <p className="text-xs font-semibold">Priority controls</p>
          <span className={`rounded-full px-3 py-1 font-mono text-[8px] uppercase ${report.readinessScore >= 90 ? 'bg-[#d8ff67]/10 text-[#d8ff67]' : 'bg-[#ff7755]/10 text-[#ff9c82]'}`}>{report.readinessLabel}</span>
        </div>
        <div className="divide-y divide-white/[0.06]">
          {report.priorities.length ? report.priorities.slice(0, 5).map((priority) => (
            <div key={priority.key} className="grid grid-cols-[auto_1fr] gap-3 px-4 py-3 sm:grid-cols-[auto_150px_1fr] sm:items-center">
              <span className={`grid h-8 min-w-8 place-items-center rounded-lg px-2 font-mono text-[10px] ${priority.severity === 'blocker' ? 'bg-[#ff7755]/10 text-[#ff9c82]' : 'bg-[#e6bd68]/10 text-[#e6bd68]'}`}>{priority.count}</span>
              <p className="text-xs font-semibold">{priority.label}</p>
              <p className="col-start-2 text-[10px] leading-4 text-[#71877c] sm:col-start-auto">{priority.recommendation}</p>
            </div>
          )) : <p className="px-4 py-5 text-xs text-[#9fb2a8]">No destination-blocking controls fired. Keep monitoring new imports.</p>}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button onClick={onDownload} data-testid="download-crm-audit" className="rounded-full bg-[#d8ff67] px-5 py-3 text-sm font-black text-[#07130f] transition hover:-translate-y-0.5">Download the audit</button>
        <a href="https://github.com/harrisonoconnorhover/gtm-control-tower#quick-start-one-command-no-accounts-required" className="rounded-full border border-[#83bcff]/25 px-5 py-3 text-sm font-semibold text-[#83bcff] transition hover:bg-[#83bcff]/10">Repair it in the workspace ↗</a>
        <button onClick={onReset} className="rounded-full border border-white/10 px-5 py-3 text-sm text-[#9fb2a8]">Audit another file</button>
      </div>
      <p className="mt-4 font-mono text-[8px] uppercase tracking-[0.13em] text-[#566b61]">Aggregate report only · no source rows leave this tab · no CRM writes</p>
    </div>
  );
}

function AuditPromise({ value, label }: { value: string; label: string }) {
  return <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"><p className="text-xl font-semibold text-[#83bcff]">{value}</p><p className="mt-1 text-[10px] text-[#71877c]">{label}</p></div>;
}

function AuditMetric({ label, value, tone }: { label: string; value: number; tone: 'good' | 'warning' }) {
  return <div className="rounded-2xl border border-white/10 bg-black/15 p-4"><p className="text-[10px] text-[#71877c]">{label}</p><p className={`mt-2 text-2xl font-semibold ${tone === 'good' ? 'text-[#d8ff67]' : 'text-[#ff9c82]'}`}>{value.toLocaleString()}</p></div>;
}
