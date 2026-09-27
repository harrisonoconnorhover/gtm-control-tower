# Morning Handoff

## Finished

- Added saved row skip/restore decisions with reasons, CSV round-trip, workspace undo, and server checks that reject stale previews.
- Added fill-empty and selected-field replacement policies, with separate blank-clearing permission. Updates and rollback include only approved changed fields.
- Added comparison and saved-results CSV downloads, joining receipts by row ID and keeping proposals, missing receipts, and actual outcomes distinct.
- Documented the controls with reviewed local screenshots and updated the public walkthrough while preserving dated native evidence.

## Try It

1. In the configured self-hosted `/app/lab`, import fictional contacts and open **Choose rows to import**. Skip a row, reload, and restore it.
2. Select a governed HubSpot or Salesforce destination. Choose the permitted update fields, read a fresh CRM snapshot, compare, and download the comparison CSV before approving a write.
3. Open `/runs` for saved results CSVs. See [operator controls](docs/import-operator-controls.md) for details and the disposable local browser check.

## Checks

- 310 tests across 27 suites passed, including both-provider route checks, real SQLite persistence, skip/restore, changed-field payloads, stale policy/row rejection, and CSV outcomes.
- Both-provider browser checks passed with real local workspace/run storage and simulated CRM responses: failed saves, reload, pending operations, downloads, and 390px layout. Zero native CRM requests.
- TypeScript, lint, both builds, script syntax, secret scan and diff checks passed.

## Decisions

- Preserve populated CRM values by default; require explicit replacement and separate permission to clear blanks.
- Keep skipped rows as source data and recheck saved selection and policy before governed execution.
- Export observed outcomes without treating previews or missing receipts as success. New controls have local automated evidence; prior native results retain their scope.

## Remaining

- Missing columns and blank cells both count as blank for explicit clearing; inspect the preview.
- Identity checks depend on the visible CRM snapshot and current saved import, and do not lock out concurrent writers.
- Legacy direct-sync/webhook routes do not enforce this saved-workspace contract.

## Review First

- `app/api/control-tower/crm-writeback/route.ts` and `lib/crm-workflow.ts`.
- `lib/import-exclusions.ts`, `lib/crm-review-export.ts`, and their tests.
- `scripts/check-import-controls.mjs` and `docs/import-operator-controls.md`.
