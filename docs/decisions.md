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

The portfolio lab should prove operating behavior without risking destructive CRM changes. Merge, reroute, and replay therefore execute against named synthetic BigQuery or browser-local state. The only live CSV destination is an explicit, receipt-verified HubSpot upsert of governed standard contact properties. Deletion, provider-side merge, owner mutation, lifecycle mutation, and Salesforce writes remain separate portal-aware boundaries.

## Browser-local CSV fallback

CSV mode exists for teams without BigQuery and requires no persistent database. Imported rows, inferred flags, and repairs stay in React memory; the user explicitly exports the result or sends governed fields to HubSpot. Identity matching defaults to exact normalized email. Plus-addresses are flagged rather than silently collapsed because that alias behavior is not universal across corporate mail systems.

## Portable HubSpot authentication

Single-portal users can supply a scoped private-app token; teams already using n8n can bind their own HubSpot OAuth credential to the included workflow. The same server contract and receipt validator wrap both paths. Production writes require a separate Control Tower access key so publishing the UI does not publish an open CRM write endpoint.
