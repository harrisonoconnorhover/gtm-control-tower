# Morning Handoff

## Finished

- Added a ten-contact synthetic CRM lab with duplicates, plus-addressing, malformed email, Unicode, missing identity, ambiguous names, routing overload, and lifecycle regressions.
- Deployed receipt-verified n8n workers for logical duplicate merge, owner reroute, and lifecycle replay against mutable BigQuery contact state.
- Added same-origin seed, repair, and state APIs with strict contracts, bounded queries, and a deterministic workflow generator.
- Added a live contact-level dashboard showing raw/normalized values, quality flags, canonical targets, owners, stages, last actions, and repair receipts.
- Executed a cumulative proof: 2 rows merged, 5 rerouted, and 1 lifecycle state replayed.

## Try It

- Keep n8n running with `docker compose up -d`, then open `http://localhost:3001/`.
- Click **Run messy lead batch**, then **Execute merge worker**.
- Click **Test another failure** to execute reroute and lifecycle replay; watch the contact rows change after each receipt.

## Checks

- `npm run test`: 8/8 passed.
- `npm run lint`: passed with no warnings.
- `npm run build`: passed; page plus all three API routes built.
- Workflow sync ran twice with identical SHA-256 and valid JSON.
- Site API proof: seed `201`; merge/reroute/replay `202`; affected rows `2 / 5 / 1`; final warehouse state matched all receipts.

## Decisions

- Execute real mutations only on named synthetic BigQuery state until CRM-provider writes have separate authentication and review.
- Preserve merged source rows with canonical pointers for a clear audit trail.
- Keep public hosting disabled until mutation routes are authenticated.

## Remaining

- Add authenticated HubSpot/Salesforce provider-specific workers if a live-CRM mutation demo becomes valuable.
- Recover Salesforce access and validate its disabled parallel adapter.
- Add authentication and stable HTTPS n8n hosting before publishing repair controls.
- Optionally move aggregate dashboard measures from raw events to scheduled dbt marts.

## Review First

- `warehouse/bigquery/repair-worker.sql`
- `integrations/n8n/control-tower-ops-workflow.json`
- `components/control-tower-dashboard.tsx`
