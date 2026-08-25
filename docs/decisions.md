# Decisions

## BigQuery rather than Snowflake

BigQuery keeps this first portfolio slice small: one SQL setup file, event-oriented storage, and straightforward dbt models. The contracts and marts are portable if a Snowflake version becomes useful later.

## Synthetic first, live connectors second

The public-facing demo must be reliable and safe without exposing credentials or personal/customer data. A deterministic local dataset proves the model; the n8n workflow and warehouse/dbt assets show the real integration boundary.

## Human-approved repairs

Automatic detection is valuable, but destructive merges and lifecycle rewrites should be reviewed. The dashboard therefore separates detection and recommendation from the repair action.

## Append-only event history

CRM state can arrive late or out of order. Keeping immutable source events permits deduplication, reconstruction, and controlled replay without treating the current Salesforce row as complete history.

## CRM-agnostic routing core

Scoring, segmentation, routing, and warehouse logging stay upstream of provider-specific writes. HubSpot is the first live CRM because an authorized account is available now; Salesforce remains a disabled parallel adapter until its access is restored. This proves portability without duplicating the decision logic or pretending the blocked Salesforce path is live.

## Demonstrate transformation, not only monitoring

The portfolio entry point is a guided messy-lead run rather than a static healthy dashboard. It exposes the raw record, each control, the governed output, contained defects, funnel impact, and recommended action so a reviewer can understand both the technical system and the business judgment in under two minutes.

## n8n as the credentialed operations boundary

The dashboard uses same-origin server routes as a narrow proxy while n8n owns BigQuery credentials and workflow execution. This keeps cloud secrets out of the browser and lets the UI validate stable state and receipt contracts. Production connector URLs intentionally have no default; public repair access requires authentication before it is enabled.

## Receipt before success

The interface never reports a repair from an optimistic click. It requires an allow-listed scenario, a successful n8n execution, a valid native receipt, and a subsequent warehouse refresh.

## Real mutations, synthetic boundary

The portfolio lab should prove operating behavior without risking a real CRM. Its merge, reroute, and replay workers therefore execute against named synthetic BigQuery contact state. Logical merges retain source rows and canonical pointers for an obvious before/after audit trail. Provider-specific HubSpot and Salesforce mutations remain a later, separately authenticated boundary.

## Browser-local CSV fallback

CSV mode exists for teams without BigQuery and requires no alternate backend. Imported rows, inferred flags, repairs, and receipts stay in React memory; the user explicitly exports the result. Identity matching defaults to exact normalized email. Plus-addresses are flagged rather than silently collapsed because that alias behavior is not universal across corporate mail systems.
