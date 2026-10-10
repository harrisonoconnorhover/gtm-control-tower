# Operations Inbox

Open `/app/work` in the persistent SQLite self-host. Enter the existing operator
key, choose HubSpot or Salesforce, and submit a CSV with an Email column. Uploads
are limited to 4 MB and 5,000 rows; the existing workspace size limit also applies.
For unusual column names, use the CSV lab's mapping controls instead.

Receiving a file saves an import task and Safe Import workspace atomically. It
does not read or write CRM records. Identical file contents sent to the same CRM
return the same task, including concurrent retries; different destinations remain
separate. Source text is data, never authority to expand the recipe.

Use **Open saved workspace** to prepare the review, inspect exact field decisions,
resolve identities, and approve the concrete saved proposal. Subsequent Inbox links
target that workspace and saved review directly. Assignees and notes persist on
the task; they do not send notifications. See [Safe Import](safe-import.md).

The queue combines the latest 50 Inbox uploads with up to 100 saved Watchdog
findings for each connected provider. Existing CSV-lab workspaces are not backfilled
into this upload queue. Findings reuse Watchdog's durable account/object/rule
identity and triage screens; no parallel finding or approval system is created.
Each provider's connection error is shown independently. The page refreshes every
30 seconds; refreshing reads saved findings and verifies account identity, not a
new scan. See [Watchdog](watchdog.md) for the separate polling runner.

Counts and states come from saved reviews and executions. Expired or changed
reviews need refresh; held, unmatched and unread identities remain follow-up work.
A completed execution is only displayed as completed if its proposed updates
were accepted and verified and there are no unresolved rows. Lost responses or
unavailable readback show **Verify outcome**, with no retry action in the Inbox.
Import approval stays per review. Watchdog's narrowly defined repairs use the
separate saved per-account opt-in.

This version uses the existing shared operator key. It adds no model, Slack
integration, automatic import approval, role-based team access or D1 deployment.
The existing whole-file Safe Import hosted-execution limit remains open.

Run `npx vitest run tests/operations-inbox.test.ts`. Against an isolated local app,
run `CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3197 node scripts/check-operations-inbox.mjs`
for mocked desktop/mobile upload, assignment, status filters and review-link checks.
