# Morning Handoff

## Finished

- Closed a HubSpot alternate-email gap: rows using different known addresses for the same Contact now conflict across batches, including human-confirmed matches.
- Included the canonical alias set in confirmation freshness. Changed aliases require review again; reordered/case-only aliases and older confirmations without aliases remain valid.
- Changing or clearing a saved match returns only that row to its connector's pending comparison. Other completed rows and saved receipts remain intact.
- Pre-write backup JSON now distinguishes the imported email from the actual CRM email beside the native ID.
- Updated the walkthrough and operator documentation while preserving the scope of the earlier native evidence.

## Try It

1. Read the [confirmed-match workflow](https://gtm-control-tower.pages.dev/enterprise-import-walkthrough#confirm).
2. In a configured `/app/lab`, process a confirmed row, then clear or change its match: that row becomes pending again and requires a new preview.
3. Download **Download pre-write backup** and inspect `importedEmail`, `crmEmail`, the native ID and before-values. See [workflow details](docs/confirmed-import-matches.md).

## Checks

- Four cross-batch regressions reproduced the old defect by accepting execution instead of returning HTTP 409, then passed after the fix with no writes.
- 146 focused alias/confirmation/workflow tests passed, along with TypeScript, focused ESLint and diff checks.
- All 413 tests across 29 suites passed. TypeScript, full ESLint, application/public builds, secret scan and diff checks passed.
- Both-provider browser regression passed with real local workspace/run storage and simulated CRM responses: affected-row re-review, failed-save retention, unchanged historical receipts, backup emails, reload and mobile checks. No live CRM requests were made. Temporary runtime removed.
- Walkthrough anchors/local targets and built HTML match verified.

## Decisions

- Reuse native identities already returned by CRM reads; add no account-wide lookup or new write path.
- A saved identity decision changes only the affected row's current progress, never historical receipts or CRM data by itself.
- The additional-email and recovery checks use simulated CRM responses. Earlier native Priya/Jordan evidence remains dated and unchanged; no new native alias qualification is claimed.

## Remaining

- Changes between the last read and the actual CRM write are not atomic; other workspaces and external writers remain outside these controls.
- Alias checks cover addresses visible to the connected CRM account. They cannot infer unknown alternate addresses.
- Salesforce Contacts remain review-only; there is no native merge, conversion or email replacement.

## Review First

- `app/api/control-tower/crm-writeback/route.ts` and `tests/crm-confirmed-match.test.ts`.
- `lib/import-match-decision.ts` and `tests/import-match-decision.test.ts`.
- `components/control-tower-dashboard.tsx` and `scripts/check-import-match-decision.mjs`.
