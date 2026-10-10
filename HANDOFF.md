# Morning Handoff

## Finished

- Extended Safe Import to existing Salesforce Leads and Contacts, with verified organization identity, ambiguous-match holds, protected Contact Account fields, reviewed updates, and native readback.
- Extended Watchdog to Salesforce: bounded baseline/change polling, persistent findings, assignments, reports, and optional Lead Company/Title or Contact Title whitespace repairs. HubSpot behavior and saved records remain compatible.
- Added `/app/work`: CSV intake for either CRM, atomic upload/task persistence, duplicate-upload reuse, source-derived review/execution states, assignments, and links to exact reviews or findings.
- Added provider-aware browser controls and background runner configuration. Refreshed the ignored local Salesforce session through the existing CLI connection. No CRM records were changed.

## Try It

1. Start the persistent self-host following [README](README.md); configure direct CRM credentials and `CONTROL_TOWER_SYNC_KEY`. Open `/app/work` and submit a CSV with an Email column.
2. Open its saved workspace, prepare the review, inspect changes and held identities, then approve the saved proposal when appropriate.
3. Open `/app/watchdog`, select each CRM, and enable monitoring. Run `npm run watchdog`; for Docker set `CONTROL_TOWER_WATCHDOG_PROVIDERS=hubspot,salesforce` and use the Watchdog Compose profile. Automatic repairs require their own saved opt-in.

## Checks

- Full suite: 626 tests across 48 files passed. TypeScript, build, changed-file ESLint, script syntax, Compose configuration, diff checks and secret scan (2,069 Git objects) passed. Full lint completed with zero errors and ten unused-variable warnings in ignored generated qualification outputs.
- Four browser probes passed: HubSpot Safe Import, Salesforce Safe Import, both-provider Watchdog, and Operations Inbox. Desktop/mobile layouts checked; fictional API fixtures, zero external requests.
- Native read-only: Salesforce Watchdog scanned 139 records with four findings; HubSpot scanned 31 with two. Salesforce Safe Import saved a complete two-row Lead/Contact review. All native checks made zero writes.
- Private summaries: `outputs/salesforce-watchdog-native-6V4x8J/summary.json`, `outputs/watchdog-native-E9bO42/summary.json`, `outputs/salesforce-safe-import-native-gaNiqT/summary.json`.

## Decisions

- Reuse existing review/execution and finding storage. Inbox status comes from saved evidence; unresolved or unverified work is not completed.
- Salesforce rules respect object differences. No inferred Lead status order or Contact Account edits; PATCH suppresses Lead assignment rules.
- Keep this operator slice on SQLite with existing authentication. See [decisions](docs/decisions.md).

## Remaining

- Native Salesforce automatic writes are unqualified; write behavior passed fictional-provider tests. External writers and downstream automation can still race or alter records.
- Existing Safe Import whole-file D1 execution remains blocked; no hosted deployment or public publication performed.
- Polling can miss intermediate changes. Converted/deleted records leave scanning coverage; existing findings may need human resolution.
- Tokens can expire; automatic OAuth refresh, Slack notifications and team roles are not included. Old CSV-lab workspaces are not backfilled into the Inbox.

## Review First

- [Operations Inbox](docs/operations-inbox.md) and `/app/work`.
- [Salesforce/HubSpot Safe Import](docs/safe-import.md) and `lib/safe-import-execution.ts`.
- [Watchdog](docs/watchdog.md) and `lib/watchdog-salesforce.ts`.
