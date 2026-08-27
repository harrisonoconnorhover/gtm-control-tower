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

Scoring, segmentation, routing, and warehouse logging stay upstream of provider-specific writes. HubSpot and Salesforce have separate destination adapters but share the same governed contact state. This keeps provider rules out of the routing core without duplicating business logic.

## Demonstrate transformation, not only monitoring

The portfolio entry point is a guided messy-lead run rather than a static healthy dashboard. It exposes the raw record, each control, the governed output, contained defects, funnel impact, and recommended action so a reviewer can understand both the technical system and the business judgment in under two minutes.

## n8n as the credentialed operations boundary

The dashboard uses same-origin server routes as a narrow proxy while n8n owns BigQuery credentials and workflow execution. This keeps cloud secrets out of the browser and lets the UI validate stable state and receipt contracts. Production connector URLs intentionally have no default; public repair access requires authentication before it is enabled.

## Receipt before success

The interface never reports a repair from an optimistic click. It requires an allow-listed scenario, a successful n8n execution, a valid native receipt, and a subsequent warehouse refresh.

## Real mutations, synthetic boundary

The portfolio lab should prove operating behavior without risking destructive CRM changes. Merge, reroute, and replay therefore execute against named synthetic BigQuery or browser-local state. CRM writes are explicit, receipt-verified, standard-field-only syncs. Deletion, provider-side merge, owner mutation, and lifecycle mutation remain separate portal-aware boundaries.

## SQLite-first local workspace

CSV mode is the default product, not a temporary fallback. A local SQLite file
stores validated imports, visual mapping presets, repair history, receipts, and
twenty undo revisions. The static public site stores no workspace data. The
browser keeps only a random workspace capability key in the self-hosted app.
Identity matching defaults to exact normalized email; plus-addresses are flagged
rather than silently collapsed because that behavior is not universal.

## One connector lifecycle

CSV, Google Sheets, HubSpot, Salesforce, and BigQuery declare the same Preview,
Validate, Execute, Receipt, Undo, and Export phases. A phase can be unavailable
or non-reversible, but it cannot be silently skipped or reported complete
without a receipt. Unconfigured connectors are removed from operational choices.

## Google Sheets through n8n first

Google Sheets is the first non-CSV source because it is familiar and does not
require a warehouse. n8n owns Google OAuth and creates a separate `GTM Clean`
worksheet instead of overwriting source data. Direct Google OAuth in the web app
is deferred because it would duplicate n8n's credential boundary.

## Portable HubSpot authentication

Single-portal users can supply a scoped private-app token; teams already using n8n can bind their own HubSpot OAuth credential to the included workflow. The same server contract and receipt validator wrap both paths. Production writes require a separate Control Tower access key so publishing the UI does not publish an open CRM write endpoint.

## Query-first Salesforce identity

Standard Salesforce Lead email is not a portable external ID, while `Company` and `LastName` are required. The Salesforce adapter therefore queries active Leads by normalized email before writing: create on zero matches, update on exactly one, and hold on multiple matches. It writes only portable standard fields and never requires a Harrison-specific custom field. A server-side access token authenticates the local connector; production should use a refreshable connected-app OAuth flow.

## Self-hosted open-source release

The first public release is a self-hosted toolkit, not a multi-tenant SaaS. CSV-only mode needs no account, while optional setup renders BigQuery and n8n assets from portable project and dataset tokens. A public demo carries no CRM credentials; each operator owns their deployment, secrets, connector permissions, and resulting data.

## Separate experiences, one codebase

The public Cloudflare Pages build contains only the fast, credential-free root
demonstration. The same repository retains `/app` as the operational workspace
and `/setup` as its local installation guide for Docker self-hosters. Reusing
the public demo component avoids a second product codebase without publishing
uploads, persistence, credentials, or connector routes.

## Destination-ready means unresolved rows stay out

Generic destinations accept only active contacts without duplicate identity,
invalid email, missing company, missing owner, or lifecycle regression. This is
stricter than merely checking `recordStatus`. Spreadsheet output prefixes
formula-trigger characters before sync so source strings cannot become formulas
accidentally.

## Google Sheets identity is normalized email

Destination-ready contacts have a valid, deduplicated normalized email, so the
portable n8n workflow uses that column for append-or-update. Reruns therefore
update the existing `GTM Clean` row instead of multiplying it. A changed email
is treated as a new identity rather than guessed to be the same person. The
bundled n8n service serializes all production webhooks with
`N8N_CONCURRENCY_PRODUCTION_LIMIT=1`; this sacrifices parallel connector
throughput so concurrent Sheets calls cannot both decide to append the same new
identity.

## Public companies, synthetic people

The adversarial CSV fixture uses a dated snapshot of the SEC's public company,
ticker, exchange, and CIK associations. Names, emails, phone numbers, titles,
owners, and websites are generated locally with reserved example domains. This
keeps the input recognizable and traceable without turning public personal data
into test CRM records.

Internationalized email domains remain visibly flagged in the imported record,
but the normalized identity uses the domain's ASCII IDNA form. This preserves
the diagnostic evidence while producing the provider-compatible email form used
for deduplication and governed CRM writes.

## Fresh installs own their runtime

Compose does not hard-code container names, and its host ports and bind-mounted
runtime directories are configurable. The acceptance test therefore launches a
fully isolated stack with random ports and empty temporary storage, verifies
restart persistence and undo, then removes only the state it created.

## Read before write, and roll back updates only

CRM change approval is meaningful only when it describes current provider
state. Direct HubSpot and Salesforce writes therefore begin with a provider
read, persist the exact standard-field diff, expire after fifteen minutes, and
re-read before execution. Updated portable fields keep their previous values so
they can be restored exactly, including nulls. Rollback re-reads the fields it
would restore and holds on a mismatch instead of overwriting newer CRM edits.
Created records are never
auto-deleted: deletion may cascade through provider automation and is too broad
for a generic rollback control.

## Durable runs are evidence, not another mutable dashboard

Connector runs live in their own append-oriented SQLite records rather than
only inside the latest workspace snapshot. Each run keeps its source and repair
counts, reviewed plan, native receipt, failures, and eligible rollback. The UI
can filter and export this evidence, while a completed rollback disables that
plan's repeated rollback control.
