# Morning Handoff

## Finished

- Built `/#clean-csv` with upload/drop, a fictional sample, formatting previews, manual cell edits, review filters, row exclusions/restores, Undo, and CSV downloads. Existing `/#audit` links open the new workflow.
- Preserved source column names/order, custom values, leading-zero strings, Unicode and quoted multiline fields. Repeated emails remain review warnings; rows are never merged or removed automatically.
- Kept source data and edits in tab memory with no processing network requests or browser storage. Downloads explain unresolved warnings and counted formula protection.
- Made browser cleanup the README and public-site entry point. Clarified Docker prerequisites and optional n8n.
- Published feature commit `73a6aea` to GitHub main and Cloudflare Pages production on October 10, 2026; deployment `29780a86` is live.

## Try It

1. Open [the public CSV cleaner](https://gtm-control-tower.pages.dev/#clean-csv). For local development, run `npm ci`, then `npm run preview:public -- --port 4175`.
2. Choose **Try sample CSV**, inspect and apply formatting changes, review a row, then **Download CSV**. Download before leaving or refreshing; work is not persisted.
3. Read [the browser guide](docs/browser-csv.md). Files are limited to UTF-8 CSV, 10 MiB and 10,000 rows.

## Checks

- 52 focused tests passed across browser CSV, existing CSV transformations and CRM audit tests.
- TypeScript, full repository lint, static production build, focused browser-script lint and `git diff --check` passed.
- Production browser QA passed on desktop and at 390px: uploads, exact download contents, edits, exclusions, Undo, custom mapping, malformed/invalid UTF-8 recovery, refresh reset and no page overflow.
- The same full desktop/mobile suite passed on the public URL after deployment, including exact downloaded CSV contents. No script errors, processing HTTP requests, API/external requests or local/session storage were observed. Screenshots are under ignored `outputs/browser-csv/` and `outputs/browser-csv-live/`.

## Decisions

- Keep conservative real-file cleanup separate from the synthetic demo's owner, lifecycle and merge rules.
- Preserve email local-part case, dots and plus tags; normalize only domains. Include unresolved rows unless explicitly excluded.
- Escape formula-like CSV cells with an apostrophe and disclose the count. Spreadsheet type inference remains outside CSV control.

## Remaining

- No browser-workflow blockers remain. [Broader GitHub CI](https://github.com/harrisonoconnorhover/gtm-control-tower/actions/runs/38077627592) was still running at handoff; focused local and live checks passed.
- Edits are intentionally temporary; download before closing the tab.

## Review First

1. [Browser workspace](components/browser-csv-workspace.tsx) and the live workflow.
2. [CSV helpers](lib/browser-csv.ts) and [focused tests](tests/browser-csv.test.ts).
3. [Browser acceptance script](scripts/check-browser-csv.mjs) and [usage guide](docs/browser-csv.md).
