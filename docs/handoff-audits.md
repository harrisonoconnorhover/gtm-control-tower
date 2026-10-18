# Handoff audit

`/app/handoff-audits` accounts for an immutable cohort of HubSpot contacts expected
to reach Salesforce. Arrival and routing are separate results. The audit reads
imported evidence or the existing CRM Monitor cache; it never calls a CRM, retries
a transfer, changes routing, runs a monitor repair, or sends a notification.

## Review a cohort

1. Open **Handoff audit** from CRM Monitor or Incidents. Use the existing operator
   key when configured. The self-hosted SQLite runtime is required.
2. Load the clearly labeled synthetic example, or import a JSON evidence bundle
   containing `manifest` and optional `evidence`. The example is fictional and does
   not represent a connected account. Export it as a starting format for your own
   cohort. Never put customer evidence or credentials in version control.
3. Review source/destination accounts, eligibility and routing criteria, the sync
   deadline, routing deadline, and maximum evidence age. Save a new audit.
4. Review the source-row totals, arrival states, separate routing states, and
   individual evidence. Export the complete report as JSON or a spreadsheet-safe
   CSV. A filter changes the visible rows, not the cohort denominator.
5. Reconcile explicitly against a newer imported snapshot or the selected saved
   monitor account. Each report keeps its original cohort and policy. Changing the
   cohort or policy requires a new audit; merely refreshing a page does not refresh
   the age of its evidence.

## Meaning of the results

| Arrival | Meaning |
| --- | --- |
| Intentionally excluded | The saved source evidence establishes an exclusion or does not meet the configured eligibility criteria. |
| Awaiting sync | Eligible, with an established handoff clock still within its allowance. |
| Explicit failure | Supplied, timestamped failure evidence remains relevant and has not been superseded by a verified arrival. |
| Unexplained missing | Eligible and overdue, with sufficiently complete and fresh evidence that did not find the expected destination. This is not a claim of deletion or permanent data loss. |
| Present | A unique destination identity was found with usable evidence. Presence does not prove correct routing. |
| Unknown | Identity, eligibility, timing, coverage, or evidence freshness is insufficient or contradictory. |

Routing is independently **routed**, **awaiting routing**, **unrouted**,
**unknown**, or **not applicable**. Configure a meaningful owner/status criterion;
a default owner can be present before the intended routing has happened. An
unobserved field is different from an observed empty value. No rules means routing
is unknown. The first local observation is not the actual CRM arrival time.

## Evidence and identity

Each source row retains a row ID even when its native source ID is missing. The
cohort includes source observation/modification timestamps, the eligibility time,
the properties used by the criteria, explicit destination IDs when known, and any
supplied failure or exclusion evidence. Each output row remains accounted for.

Matching uses explicit Salesforce Lead/Contact IDs or a configured stable source-ID
property on destination records. It never joins by a person's name or email.
Missing or ambiguous mappings cannot choose an arbitrary target. Timestamped
failure evidence is not a substitute for checking a later observed arrival.

Imported snapshots are assertions supplied by the operator, not a verified live
connector. `completeThrough` declares the last time covered by a complete read;
it must not be set merely because an export or HTTP request finished. Partial
exports, incomplete pagination, unavailable fields and permissions must be
represented as incomplete coverage. Keep all evidence timestamps in ISO format.

Saved audits retain per-record clocks and verified arrival history across later
snapshots. Reconciliation rejects older or contradictory observations. If a
previously seen destination disappears from a newer snapshot, its current state
is unknown and its prior arrival remains visible; disappearance does not prove
the original handoff failed.

## Existing monitor integration and limits

Monitor mode reuses the saved account scope, cached observations, native timestamps,
completed scan watermark, coverage metadata, and links to existing incidents. It
does not start a scan. A successful individual scan page is not a completed scan;
an unfinished cursor/window or incomplete baseline cannot prove absence.

The current native monitor does not read all custom eligibility fields, source-ID
mapping properties, or native sync-error details. Supply these in the immutable
cohort or an imported snapshot when needed. Missing properties stay unknown.
Account coverage does not make an old individual record fresh. The cache can
retain records that were later deleted or converted, and native Salesforce polling
excludes converted Leads. Those limits remain visible in the report.

Audit creation and reconciliation save local evidence only. Existing incident
rows are linked as supporting context, not presented as a proven cause. The audit
does not create incident notifications or invoke the optional model investigator.
This feature inherits the application's operator-key access boundary; it does not
introduce separate tenant authorization.

## Local verification

Run the `tests/handoff-audit*.test.ts` tests for pure decisions, real SQLite report
persistence, authentication, account scoping, stale/incomplete coverage, and the
synthetic handoff flow. With a local development server, run
`npm run test:handoff-audit-ui` for the browser checks. These checks use fictional
evidence; no live CRM access is needed or qualified by them.
