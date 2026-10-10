const form = document.querySelector('#demo-form');
if (form) {
  const status = document.querySelector('#form-status');
  const button = form.querySelector('button[type="submit"]');
  let pending;
  const setStatus = (message, state) => { status.textContent = message; status.dataset.state = state; };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    const fields = Object.fromEntries(new FormData(form));
    const fingerprint = JSON.stringify(fields);
    // Keep the same ID after an uncertain response; edited details represent a new request.
    if (!pending || pending.fingerprint !== fingerprint) pending = { fingerprint, requestId: crypto.randomUUID() };
    button.disabled = true;
    setStatus('Sending your request…', 'sending');
    try {
      const response = await fetch('/api/demo-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fields, requestId: pending.requestId }), signal: AbortSignal.timeout(45000),
      });
      const receipt = await response.json();
      if (!response.ok || receipt.accepted !== true || receipt.requestId !== pending.requestId) {
        throw new Error(receipt.error || 'We could not confirm your request. Please try again.');
      }
      setStatus(`Thank you — your request is with Hollis Consulting. We'll follow up using the details you provided. Reference: ${receipt.requestId}`, 'success');
      form.reset();
      pending = undefined;
    } catch (error) {
      setStatus(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'Confirmation took longer than expected. Please submit again; your request will not be duplicated.' : error instanceof TypeError ? 'We could not connect. Check your connection and try again.' : error.message, 'error');
    } finally { button.disabled = false; }
  });
}
