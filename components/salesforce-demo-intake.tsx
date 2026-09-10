'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { parseDemoSubmission, type DemoSubmission, type DemoIntakeReceipt } from '@/lib/demo-intake';

const endpoint = '/api/control-tower/demo-intake';
const pendingStorageKey = 'gtm-salesforce-demo-request-v1';
const inputStyle = 'mt-2 w-full rounded-xl border border-white/20 bg-[#07130f] px-3 py-3 text-base text-[#edf8f2] outline-none focus:border-[#d8ff67] disabled:opacity-60';
const buttonStyle = 'rounded-xl border border-white/20 px-4 py-2.5 text-sm font-semibold hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40';
const initialFields = { firstName: 'Elena', lastName: 'Foster', email: 'elena.foster@cedar-demo.example', phone: '+1 202-555-0148', company: 'Cedar Demo Studio', source: 'website', campaign: 'demo-request' };

export function SalesforceDemoIntake({ onBack, homeHref }: { onBack: () => void; homeHref: string }) {
  const [fields, setFields] = useState(initialFields);
  const [frozen, setFrozen] = useState<DemoSubmission | null>(null);
  const [receipt, setReceipt] = useState<DemoIntakeReceipt | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [needsKey, setNeedsKey] = useState(false);
  const [operatorKey, setOperatorKey] = useState('');
  const [message, setMessage] = useState('Checking the Salesforce connection…');
  const [error, setError] = useState('');

  async function checkConnection(key = '') {
    try {
      const response = await fetch(endpoint, { headers: key ? { 'x-control-tower-key': key } : {}, cache: 'no-store' });
      if (response.status === 401) { setNeedsKey(true); setReady(false); setMessage('Enter your operator access key to connect.'); return; }
      const result = await response.json() as { ready?: boolean; error?: string };
      setReady(response.ok && result.ready === true);
      setMessage(response.ok && result.ready ? 'Connected. Submissions create real activity in the configured Salesforce org.' : result.error ?? 'Salesforce is not configured on this server.');
    } catch { setReady(false); setMessage('The Salesforce connection could not be checked.'); }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = window.sessionStorage.getItem(pendingStorageKey);
        if (saved) {
          const submission = parseDemoSubmission(JSON.parse(saved));
          setFrozen(submission);
          setFields(submission);
        }
      } catch { setError('The saved request could not be restored.'); }
      void checkConnection();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    let submission: DemoSubmission;
    try {
      submission = frozen ?? parseDemoSubmission({ ...fields, requestId: crypto.randomUUID() });
      // Persist the original body before sending, so reloads can reconcile a lost response.
      window.sessionStorage.setItem(pendingStorageKey, JSON.stringify(submission));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The request could not be saved.'); return; }
    setFrozen(submission); setPending(true);
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(operatorKey ? { 'x-control-tower-key': operatorKey } : {}) },
        body: JSON.stringify(submission), signal: AbortSignal.timeout(35_000),
      });
      const result = await response.json() as DemoIntakeReceipt & { error?: string };
      if (!response.ok) {
        if (response.status === 401) setNeedsKey(true);
        throw new Error(result.error ?? 'No complete response arrived. Retry this same request.');
      }
      setReceipt(result as DemoIntakeReceipt);
      setMessage(result.reason);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The response was interrupted. Retry this same request.'); }
    finally { setPending(false); }
  }

  function newSubmission() {
    try { window.sessionStorage.removeItem(pendingStorageKey); }
    catch { setError('The previous request could not be cleared from this tab.'); return; }
    setFrozen(null); setReceipt(null); setError('');
    setMessage('Ready for a new submission. Keeping the same email creates fresh activity for the same person.');
  }

  return <main className="min-h-screen bg-[#06100d] px-4 pb-12 text-[#edf8f2] sm:px-8">
    <div className="mx-auto max-w-6xl">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/15 py-5">
        <a href={homeHref} className="font-semibold">GTM Control Tower / Inbound</a>
        <div className="flex flex-wrap gap-2"><button className={buttonStyle} onClick={() => void checkConnection(operatorKey)} disabled={pending}>Check connection</button><button className={buttonStyle} onClick={onBack} disabled={pending}>Back to practice</button></div>
      </header>
      <div className="py-7"><p className="text-sm text-[#83bcff]">CONNECTED SALESFORCE</p><h1 className="mt-2 text-3xl font-semibold">Demo request → owner follow-up</h1><p className="mt-3 max-w-3xl leading-7 text-[#adc3b5]">Existing people keep their record and owner. Each new request creates a follow-up task. Retrying the same request checks or completes that activity.</p></div>
      <p role="status" className="mb-5 rounded-xl border border-white/15 bg-[#0c1d15] p-4 text-sm leading-6">{message}</p>
      {needsKey && <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-white/15 p-4"><label className="min-w-64 flex-1 text-sm">Operator access key<input type="password" autoComplete="off" className={inputStyle} value={operatorKey} onChange={event => setOperatorKey(event.target.value)} /></label><button className={buttonStyle} onClick={() => void checkConnection(operatorKey)}>Connect</button></div>}
      {error && <p role="alert" className="mb-5 rounded-xl border border-[#ff8c7b]/30 p-4 text-sm text-[#ffad9f]">{error}</p>}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <section className="rounded-2xl border border-white/15 bg-[#0c1d15] p-6">
          <h2 className="text-xl font-semibold">Request a demo</h2>
          <p className="mt-2 text-sm leading-6 text-[#adc3b5]">Use fictional details for development. This form writes to Salesforce and requests a notification for the owner.</p>
          <form className="mt-5 grid grid-cols-2 gap-4" onSubmit={submit}>
            {([['firstName', 'First name', 'text', 40], ['lastName', 'Last name', 'text', 80], ['email', 'Business email', 'email', 80], ['phone', 'Phone (optional)', 'tel', 40], ['company', 'Company name', 'text', 255]] as const).map(([key, label, type, maxLength]) => <label key={key} className={`text-sm ${key === 'email' ? 'col-span-2' : ''}`}>{label}<input className={inputStyle} type={type} maxLength={maxLength} required={key !== 'phone'} disabled={Boolean(frozen) || pending} value={fields[key]} onChange={event => setFields({ ...fields, [key]: event.target.value })} /></label>)}
            <details className="col-span-2 rounded-xl border border-white/15 p-3"><summary className="cursor-pointer text-sm">Attribution</summary>{(['source', 'campaign'] as const).map(key => <label key={key} className="mt-3 block text-sm capitalize">{key}<input className={inputStyle} maxLength={128} disabled={Boolean(frozen)} value={fields[key]} onChange={event => setFields({ ...fields, [key]: event.target.value })} /></label>)}</details>
            <button disabled={!ready || pending} className="col-span-2 rounded-xl bg-[#83bcff] px-4 py-3.5 font-semibold text-[#06100d] disabled:opacity-40" type="submit">{pending ? 'Checking Salesforce…' : frozen ? 'Retry same request' : 'Submit to Salesforce'}</button>
            {frozen && <><button type="button" disabled={pending || !receipt} className={`${buttonStyle} col-span-2`} onClick={newSubmission}>Start a new submission</button><p className="col-span-2 break-all font-mono text-xs leading-5 text-[#adc3b5]">Request ID: {frozen.requestId}</p>{!receipt && <p className="col-span-2 text-sm leading-6 text-[#adc3b5]">Retry to resolve this saved request before starting another submission.</p>}</>}
          </form>
        </section>
        <section className="rounded-2xl border border-white/15 bg-[#0c1d15] p-6">
          <h2 className="text-xl font-semibold">Salesforce result</h2>
          {receipt ? <>
            <p className={`mt-4 font-semibold ${receipt.status === 'Routed' ? 'text-[#d8ff67]' : 'text-[#f5bc67]'}`}>{receipt.status}{receipt.reusedRequest && ' · existing request reconciled'}</p>
            <dl className="mt-5 space-y-4">
              <div><dt className="text-sm text-[#adc3b5]">Person</dt><dd className="mt-1">{receipt.personId ? `${receipt.createdPerson ? 'Created a new' : 'Matched existing'} ${receipt.personType}` : 'Identity held for review'}</dd></div>
              <div><dt className="text-sm text-[#adc3b5]">Follow-up owner</dt><dd className="mt-1">{receipt.ownerName ?? 'Awaiting review'}</dd></div>
              <div><dt className="text-sm text-[#adc3b5]">Task</dt><dd className="mt-1">{receipt.taskId ? 'Created · due today' : 'No task created'}</dd></div>
              <div><dt className="text-sm text-[#adc3b5]">Owner notification</dt><dd className="mt-1">{receipt.notificationStatus === 'Requested' ? 'Accepted by Salesforce' : receipt.notificationStatus}</dd></div>
            </dl>
            <div className="mt-6 flex flex-wrap gap-3">{([['Open person', receipt.links.person], ['Open task', receipt.links.task], ['Open request', receipt.links.submission]] as const).map(([label, url]) => url && <a key={label} href={url} target="_blank" rel="noreferrer" className={`${buttonStyle} text-[#83bcff]`}>{label} ↗</a>)}</div>
            <p className="mt-5 text-sm leading-6 text-[#adc3b5]">Salesforce has accepted the notification request. Delivery to the owner’s device is separate from this receipt.</p>
          </> : <p className="mt-4 leading-7 text-[#adc3b5]">Submit a request to see the matched person, owner, follow-up task, and notification outcome. If a response is interrupted, retry using the saved request.</p>}
          <details className="mt-6 border-t border-white/15 pt-4"><summary className="cursor-pointer text-sm font-semibold">Matching and ownership</summary><p className="mt-3 text-sm leading-6 text-[#adc3b5]">Salesforce searches Contacts and unconverted Leads by email. Multiple matches, queue ownership, or an inactive owner are held for review. New Leads go to the connected integration user as the initial intake owner. Existing names, company details, and ownership stay intact.</p></details>
        </section>
      </div>
    </div>
  </main>;
}
