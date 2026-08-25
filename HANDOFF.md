# Morning Handoff

## Finished

- Added a browser-local CSV operating mode that needs no BigQuery, n8n, account, or upload.
- Mapped common CRM headers and inferred duplicate, missing-field, plus-address, Unicode-domain, and lifecycle-regression flags.
- Reused the contact table and incident controls for local logical merge, Northeast enterprise reroute, and lifecycle replay.
- Added local execution receipts, original-file reset, repaired CSV export, and a downloadable four-contact template.
- Preserved the existing receipt-verified n8n/BigQuery mode and explicit execution-boundary labels.

## Try It

- Open `http://localhost:3001/` and click **Import your CSV** in the contact lab.
- Use **CSV template** for a ready-made funky file, then execute merge, reroute, and replay in sequence.
- Click **Export repaired CSV** or **Use BigQuery demo** at any time.

## Checks

- `npm test`: 12/12 passed across parser, import/export, repairs, contracts, and scenarios.
- `npm run lint`: passed with no warnings.
- `npm run build`: passed; page plus all three API routes built.
- Local page and CSV template returned HTTP 200.
- Existing warehouse state remained valid: BigQuery source with 10 contact rows.

## Decisions

- Keep imported CSV bytes and repair state only in browser memory; export is the explicit persistence step.
- Match duplicates only on exact normalized email; never infer identity from fuzzy name/company similarity.
- Flag plus-addresses without collapsing them unless `normalized_email` is supplied deliberately.

## Remaining

- Add a column-mapping screen only if real user files reveal unsupported headers.
- Add authenticated HubSpot/Salesforce provider-specific workers if live-CRM mutation becomes valuable.
- Recover Salesforce access and validate its disabled parallel adapter.
- Add authentication and stable HTTPS n8n hosting before publishing warehouse repair controls.

## Review First

- `lib/csv-control-tower.ts`
- `components/control-tower-dashboard.tsx`
- `tests/csv-control-tower.test.ts`
