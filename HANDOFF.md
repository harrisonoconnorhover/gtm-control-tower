# Morning Handoff

## Finished

- Fixed conflicting name columns clearing the wrong identity: create checks and eligible-row review now use the first and last names actually sent to the destination.
- Separated returned CRM outcomes from receipt-save failures. Completed rows stay completed even when local storage fails.
- Added a visible unsaved-receipt notice with the complete receipt/rollback download and a same-ID, storage-only retry.
- Preserved completed rollback results while their receipt awaits saving; reported workspace-summary save failures separately.
- Added repeatable browser failure checks for both providers using simulated CRM responses and real local storage.

## Try It

1. Run the configured self-hosted workspace and inspect an import containing both full-name and first/last-name columns. The match review explains which name is used.
2. For a disposable local app, set `CONTROL_TOWER_BROWSER_BASE_URL` and run `npm run test:receipt-recovery`. Use `CHROMIUM_PATH` if Chrome is not at the documented macOS default.
3. If receipt storage fails, use **Retry receipt save** or **Download receipt** before leaving the page. Retry does not repeat the CRM operation.

## Checks

- 238 tests across 25 suites passed, including both-provider conflicting-name regressions and run-save acknowledgment/error cases.
- Receipt-recovery browser checks passed for both providers: HTTP failure, network abort, preserved JSON download, storage-only retry, durable read-back, rollback recovery, and workspace-summary failure.
- Existing 105-row batch/progress and pending-operation browser checks passed for both providers, including the mobile overflow check.
- TypeScript, lint, both builds, script syntax and diff checks passed. Browser tests made zero live CRM requests.

## Decisions

- Preserve the effective destination name rather than silently compare a conflicting display name.
- Reuse existing idempotent run storage; no schema, automatic CRM retry, or browser-persistence layer was added.
- Keep native CRM outcomes distinct from local save outcomes and preserve earlier dated development evidence.

## Remaining

- Unsaved recovery is page-local: save or download before navigating or reloading.
- No new recovery claim for an operation whose CRM response never reaches the browser.
- Duplicate detection remains bounded by snapshot visibility, freshness and matching rules; scores are not identity probabilities.

## Review First

- `lib/import-create-review.ts` and `tests/import-create-review.test.ts`.
- `components/control-tower-dashboard.tsx`, `components/sync-runs.tsx`, and `components/unsaved-runs.tsx`.
- `scripts/check-receipt-recovery.mjs` and `docs/import-crm-comparison.md`.
