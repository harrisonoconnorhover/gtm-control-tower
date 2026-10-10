# Morning Handoff

## Finished

- Added a connected HubSpot Watchdog at `/app/watchdog`: baseline and incremental contact scans, five deterministic checks, saved findings, assignments, review notes, and CSV/JSON reports.
- Added optional company/job-title whitespace repairs with fresh-read checks, durable attempts, native readback, five-repair batches, and no automatic replay of uncertain outcomes.
- Added a browser-independent runner and optional Docker Compose service. Monitoring and repairs both start disabled; settings are bound to the verified HubSpot account.
- Completed a read-only native check: all 31 connected contacts scanned, two missing-email findings, contact change search accepted, zero native writes. Private evidence: `outputs/watchdog-native-IDGJGk/summary.json`.

## Try It

1. Follow [Watchdog setup](docs/watchdog.md), configure the self-host's HubSpot token and operator key, and open `/app/watchdog`.
2. Enable monitoring and save settings; run a manual check. To continue with the browser closed, run `npm run watchdog` or `docker compose --profile watchdog up --build app watchdog`.
3. Review findings, assign work, and export a report. Automatic repair is a separate explicit opt-in.

## Checks

- 34 tests across six focused Watchdog/self-hosting suites passed, including paging, deduplication, repair batches, concurrent workers, stale holds, interrupted claims, unknown outcomes, and account/auth boundaries.
- TypeScript, focused ESLint, application build, script syntax, Compose configuration, Git diff, and secret scan (2,030 Git objects) passed.
- Desktop/mobile browser fixture passed settings, triage, downloads, reload/poll behavior, empty/error states, and layout checks; zero external requests. Screenshots: `.runtime/watchdog-ui/`.
- Native qualification exercised actual account identity, contact list, rule detection, and change search only. Automatic repairs were tested against fictional provider records.

## Decisions

- Use explicit rules and human triage; five-minute default polling with one-minute/hourly choices. Scope is Contacts and self-hosted SQLite.
- Keep repairs narrow and optional. A native read-then-PATCH race remains; no atomic external-writer guarantee is claimed.
- Preserve existing Safe Import behavior and the static public showcase. No Slack messages or public deployment were added.

## Remaining

- Native automatic-write qualification and hosted/D1 support are unqualified; this feature rejects D1 explicitly.
- Polling cannot capture every intermediate change, and archived/deleted contacts are outside coverage. Daily baseline reconciliation reduces indexing gaps.
- Intentional lifecycle regressions can reopen on observation; operators must interpret the finding. Queue assignments do not notify people externally.
- Earlier Safe Import whole-file D1 execution limits remain; see `docs/safe-import-native-check.md`. This change does not resolve that separate release blocker.

## Review First

- `docs/watchdog.md` for setup, behavior, and limits.
- `lib/watchdog.ts`, `lib/watchdog-store.ts`, and focused tests for scan/repair behavior.
- `/app/watchdog` for the operator experience and reports.
