# HubSpot Watchdog

The self-hosted `/app/watchdog` watches connected HubSpot Contacts, saves findings,
and gives a person a queue to work through. It reads actual provider records; no
sample data is substituted when a connection fails. A separate runner keeps
checks going with the browser closed. This feature currently requires local
SQLite; the hosted D1 runtime and static public showroom cannot run it.

## Start monitoring

1. Configure `HUBSPOT_ACCESS_TOKEN` on the self-hosted server, with contact read
   access and access to account details. Set `CONTROL_TOWER_SYNC_KEY` for the
   operator interface; it is required in production. Start the app normally.
2. Open `/app/watchdog`, enter the operator key if configured, verify the account,
   choose an interval and default assignee, and enable monitoring. Automatic
   repairs are off by default. **Run check now** processes one bounded page.
3. In a second terminal, run `npm run watchdog`. The runner reads `.env` and
   `.env.local`; `CONTROL_TOWER_WATCHDOG_URL` defaults to `http://127.0.0.1:3000`.
   Alternatively, use `docker compose --profile watchdog up --build app watchdog`.
   The optional Compose service restarts with the application. Stop a terminal
   runner with Ctrl+C; pause checks in the UI without discarding history.

`npm run watchdog -- --once` requests a single due check, suitable for an existing
scheduler. A configured interval alone does not start a process. The page shows
last check time, rather than claiming that a background runner is healthy.

## What is checked

| Check | Action |
| --- | --- |
| Missing email | Human identity review |
| Email fails a basic format check | Human identity review; no inferred replacement |
| SQL, opportunity, or customer contact without an owner | Human routing review |
| Known lifecycle stage moves backward after being observed | Human review of whether the change was intentional |
| Surrounding whitespace in company or job title | Optional automatic trim; otherwise human review |

These are explicit rules, not statistical anomaly detection. They do not inspect
workflows, deals, companies, associations, duplicate identities, or deleted
contacts. Unknown/custom lifecycle values do not receive an inferred order.
The existing duplicate-audit workspace remains available separately.

Automatic repairs require the saved opt-in and contact write access. Only
`company` and `jobtitle` are eligible, trimming cannot clear a field, and contacts
with missing or malformed email remain in review. The
service saves an attempt before sending it, re-reads the contact to reject stale
proposals, and verifies returned values afterward. It never guesses email,
ownership, or lifecycle; never creates or deletes contacts; and never merges
records. Read-then-write is not an atomic lock against another HubSpot writer.
An uncertain write stays visible for human review and is not automatically resent.

## Findings and reports

Findings are scoped to the verified HubSpot account. Repeated observations update
the same contact/rule issue. The queue retains first/last observation, assignee,
status, notes, and before/after evidence. People can mark work in progress or
resolved, and open the native contact. A defect observed again can reopen.
An assignment is saved in Control Tower; it does not send a message or create a
HubSpot task. There is no Slack integration in this first version.

The page exports the displayed findings and recent run reports. Aggregate counts
cover stored findings; the displayed/exported history is bounded, not a complete
account export. Runner logs contain counts and run IDs, not contact values.
Findings and snapshots in the local SQLite database contain CRM information.

## Coverage and timing

The initial baseline follows native contact pagination. Subsequent checks use
the contact `lastmodifieddate` property, a delayed upper bound, and an overlapping
window. Each tick processes at most 50 contacts and attempts at most five repairs.
Continuation pages drain separately from the configured interval; the default
interval between completed scans is five minutes. One hour is also available.
Saved eligible repairs also drain in bounded batches, including when the operator
enables repairs after a read-only scan. A daily full reconciliation revisits older
contacts and helps recover delayed search results.

This is polling, not an immediate change event or a historical audit log. A change
can be missed if it is reversed between observations. Search indexing can lag;
the overlap reduces that risk without guaranteeing capture of arbitrarily late
results. The saved watermark advances only after the complete window succeeds.
Search pages continue after the last native contact ID, avoiding offset shifts
when a repair changes a contact's modification time. HubSpot caps a search query
at 10,000 records; an oversized window produces an explicit failed report and
switches to full native-list reconciliation, retaining the previous watermark
until that completes. See HubSpot's
[CRM Search documentation](https://developers.hubspot.com/docs/api-reference/latest/crm/search-the-crm).

## Verify locally

```bash
npx vitest run tests/watchdog*.test.ts
node --check scripts/watchdog.mjs
docker compose --profile watchdog config --quiet
```

With an isolated app listening on `http://127.0.0.1:3087`, run
`npm run test:watchdog-ui` for the desktop/mobile browser check. It intercepts
every API request with fictional findings and exercises settings, review,
downloads, refresh, and connection errors without contacting HubSpot.

`node --env-file=.env.local scripts/check-watchdog-native.mjs --run` is an
optional **read-only** native check. It uses a disposable local database, disables
repairs, and blocks every native mutation. Its private results stay under ignored
`outputs/watchdog-native-*`. Passing that probe verifies reads and detection;
automatic repairs are separately tested with a fictional provider and must not
be described as live-write qualification.
