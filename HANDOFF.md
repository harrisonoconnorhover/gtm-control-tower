# Morning Handoff

## Finished

- Built `/#clean-csv` with upload/drop, a fictional sample, formatting previews, manual cell edits, review filters, row exclusions/restores, Undo, and CSV downloads. Existing `/#audit` links open the new workflow.
- Preserved source column names/order, custom values, leading-zero strings, Unicode and quoted multiline fields. Repeated emails remain review warnings; rows are never merged or removed automatically.
- Kept source data and edits in tab memory with no processing network requests or browser storage. Downloads explain unresolved warnings and counted formula protection.
- Made browser cleanup the README and public-site entry point. Clarified that Docker must be running for the separate operator workspace; n8n is optional.

## Try It

1. Open the running production preview at `http://127.0.0.1:4176/#clean-csv`, or run `npm ci` then `npm run preview:public -- --port 4175` and open that port.
2. Choose **Try sample CSV**, inspect and apply formatting changes, review a row, then **Download CSV**. Download before leaving or refreshing; work is not persisted.
3. Read [the browser guide](docs/browser-csv.md). Files are limited to UTF-8 CSV, 10 MiB and 10,000 rows.

## Checks

- 52 focused tests passed across browser CSV, existing CSV transformations and CRM audit tests.
- TypeScript, full repository lint, static production build, focused browser-script lint and `git diff --check` passed.
- Production browser QA passed on desktop and at 390px: uploads, exact download contents, edits, exclusions, Undo, custom mapping, malformed/invalid UTF-8 recovery, refresh reset and no page overflow.
- Browser checks observed no script errors, processing HTTP requests, API/external requests or local/session storage. Desktop/mobile screenshots inspected under ignored `outputs/browser-csv/`.

## Decisions

- Keep conservative real-file cleanup separate from the synthetic demo's owner, lifecycle and merge rules.
- Preserve email local-part case, dots and plus tags; normalize only domains. Include unresolved rows unless explicitly excluded.
- Escape formula-like CSV cells with an apostrophe and disclose the count. Spreadsheet type inference remains outside CSV control.

## Remaining

- Local implementation is ready; public publishing and GitHub push await user approval.
- Cloudflare read-only project listing confirmed `gtm-control-tower` / `gtm-control-tower.pages.dev` exists with no Git integration. Nothing was deployed.

## Review First

1. [Browser workspace](components/browser-csv-workspace.tsx) and the local preview.
2. [CSV helpers](lib/browser-csv.ts) and [focused tests](tests/browser-csv.test.ts).
3. [Browser acceptance script](scripts/check-browser-csv.mjs) and [usage guide](docs/browser-csv.md).
