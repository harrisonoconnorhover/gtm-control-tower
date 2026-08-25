# Morning Handoff

## Finished

- Turned CSV mode into a governed HubSpot pipeline: local import and repair, clean-record gate, explicit write, and per-email receipts.
- Added standard-property mapping for email, name, company, phone, job title, and website; unsafe rows remain held.
- Added a server-validated 100-contact batch API with direct private-app-token and n8n OAuth connector paths.
- Added production access-key enforcement, retryable batch progress, native error display, and HubSpot IDs on synced rows.
- Completed a live HubSpot proof: synthetic contact `540806575835` was created; an invalid email returned its exact validation failure.

## Try It

- Open `http://localhost:3001/`, import the CSV template, and execute merge then lifecycle replay.
- Review **Governed HubSpot destination**; eligible and held counts update after each repair.
- Click **Sync to HubSpot**. Batches are capped at 100 and additional clicks continue remaining contacts.

## Checks

- `npm test`: 16/16 passed across CSV, repair, HubSpot eligibility, contracts, receipt aggregation, and template import.
- `npm run lint`: passed with no warnings.
- `npm run build`: passed; the HubSpot sync API route built with the existing site.
- Page/template/invalid-sync HTTP checks: `200 / 200 / 400`.
- n8n executions 94 and 95 succeeded; live receipts proved native failure and successful create paths.

## Decisions

- Send only governed standard contact fields; never upload the original CSV.
- Do not write lifecycle or owner values until portal-aware preflight reads exist.
- Require `CONTROL_TOWER_SYNC_KEY` for production writes; keep tokens server-side and out of Git.

## Remaining

- Optionally archive the clearly labeled synthetic proof contact after review.
- Add lifecycle/owner preflight only if those provider-side writes become valuable.
- Recover Salesforce access and validate its disabled parallel adapter.
- Add stable HTTPS hosting before publishing any CRM mutation controls.

## Review First

- `app/api/control-tower/hubspot-sync/route.ts`
- `integrations/n8n/csv-hubspot-sync-workflow.json`
- `docs/hubspot-csv-setup.md`
