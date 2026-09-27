# Morning Handoff

## Finished

- Added read-only import-to-CRM suggestions with selectable name, email, phone, state and company fields, proposed from usable import values.
- Ranked up to three native CRM records per imported person, showing score, supporting values, conflicts and missing fields. Existing exact-email write protections remain separate.
- Reused durable paged CRM snapshots with visible dates and coverage. HubSpot reads additional emails and state; Salesforce reads Lead State and Contact MailingState.
- Added a fictional walkthrough and inspected screenshot. No CRM records were read or written in live accounts during qualification.
- Published source `01dae32`, the guide and screenshot, and portfolio-site update `ef46539`. Published artifacts and canonical site HTML match reviewed bytes.

## Try It

1. Start the self-hosted app using the README, configure a direct CRM connection, and open `/app/lab`.
2. Import the CSV in `docs/approximate-import-matches.md`, select the CRM destination, and inspect **Find possible CRM matches**.
3. Select fields, read a CRM snapshot, find suggestions, and download the review JSON. The public static demo has no CRM connection.

## Checks

- All 210 tests across 23 suites passed. TypeScript, full lint, secret scan, diff check, operator build and public build passed. The development mirror passed 103 focused tests and TypeScript, preserving its inbound-routing link.
- Browser checks passed against a disposable local D1 database: real import/API/scoring, field changes, stale-response rejection, 101-row paging, partial coverage and matching JSON export. Synthetic scan-control responses verified pause/resume and cursor-cycle handling.
- Desktop and 390px app and live-site checks passed with no page errors or overflow. Fixture scores were 72/100, 38/100 and no suggestion. Both published guide links returned HTTP 200; the site Pages deployment passed.
- [Published runtime CI for `01dae32`](https://github.com/harrisonoconnorhover/gtm-control-tower/actions/runs/36343392025) passed tests, lint, secret/dependency checks, both builds and isolated fresh-install smoke.

## Decisions

- Scores rank evidence; they are not calibrated probabilities. Missing values never count as matches, and broad search limits remain visible.
- Suggestions do not link, merge, update or change write eligibility. Investigate possible duplicates before using the separate exact-email write preview.
- Reuse storage and normalizers, with no schema or dependency changes. State is separate from sales territory.

## Remaining

- Development mirror `ab48dd8` remains local; no private deployment occurred.
- Qualify against live development accounts before relying on provider-specific visibility, permissions or duplicate rules. Snapshot age, caps and concurrent CRM changes limit coverage; no suggestion does not establish absence.

## Review First

- `lib/import-match.ts` and `tests/import-match.test.ts` for scoring and limits.
- `components/import-match-review.tsx` and `app/api/control-tower/import-matches/route.ts` for the review flow.
- `docs/approximate-import-matches.md` for the fictional walkthrough and boundaries.
