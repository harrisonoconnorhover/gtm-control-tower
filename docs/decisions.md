# Decisions

## September 27, 2026: make connector setup reproducible

Docker setup documents Compose's default `.env` loading and the explicit
`--env-file .env.local` alternative. The app uses the `n8n` service hostname
inside Compose; a Node development server uses localhost. Changed environment
values require `docker compose up -d app`, not a plain restart. An isolated
configuration check with synthetic values confirmed both loading paths without
starting containers or contacting providers.

The Sheets guide retains the August 26 receipt's 44 ready and 12 held records
as historical evidence. The revised local fixture produces 46 ready and 11 held
after seven merges; no new connected Sheets run is implied.

## September 27, 2026: demonstrate the same rules that import real files

The synthetic fixture supplies raw identities rather than precomputed normalized
answers. Case variants still demonstrate exact duplicates; the corporate plus
address remains distinct, and the internationalized domain uses IDNA. The new
result is seven merges, 57 canonical contacts, 46 ready, and 11 held. These are
measured sample outcomes, not targets for the rules to satisfy.

Preview and import reject nonblank rows whose column count differs from the
header. Silently dropping an extra cell can shift a company fragment into the
owner field while reporting readiness. An actionable CSV row error is safer
than guessing how to realign the input; correctly quoted commas and line breaks
remain valid.

Public record decisions are derived from the same before/after states and
destination gate as the cleanup. They distinguish an action taken from final
readiness, preserve every remaining hold reason, and download the same evidence
locally. This adds visibility to the existing workflow without creating another
repair engine or connecting the public site to a CRM.

An applied routing rule clears `missing_owner` when it supplies an owner, while
retaining independent blockers such as an invalid email. Repair completion and
record readiness must describe the resulting state rather than stale flags.

The CSV audit reports lifecycle comparison coverage separately from readiness.
Only active rows with recognized, supplied current and expected stages count as
compared. Missing columns, blank values, and unknown stages leave visible gaps;
the fallback used by the existing repair model is not evidence of CRM history.
Mapped source headers are inspectable in the browser and Markdown report.

The dependency refresh removes the reported high and critical advisories while
preserving the existing high-severity CI gate. Four moderate notices remain in
Drizzle's legacy development-tool chain; npm's suggested breaking downgrade is
not applied blindly. The public static build now runs in CI alongside the
operator build and isolated Docker smoke test.

The account-free setup starts at `/app/lab`. The whole-account scanner at `/app`
requires configured CRM access and remains a separate optional step. Historical
connector results are labeled as dated observations rather than current health.

Fresh operator sessions start in CSV mode. Connector configuration labels and
imported-row metrics describe the current installation. Static warehouse stage
counters, dbt examples and replay traces are hidden from CSV mode and explicitly
illustrative when shown; they are not current native execution evidence. Local
repair counts and returned receipts continue to come from the existing engine.

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
CSV cleanup still defaults to exact normalized email; plus-addresses are flagged
rather than silently collapsed because that behavior is not universal. The
separate account audit uses a versioned multi-signal resolver and persists
provider pages, cursors, candidate groups, and review decisions in dedicated
SQLite/D1 tables.

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

Single-portal users can supply a scoped account service key; teams already using
n8n can bind their own HubSpot OAuth credential to the included workflows. The
service key enables the direct whole-account scanner, while n8n mode remains a
bounded source preview and delegated write path. Production private CRM
operations require a separate Control Tower access key so publishing the UI
does not publish an open account read or write endpoint.

## Query-first Salesforce identity

Standard Salesforce Lead email is not a portable external ID, while `Company` and `LastName` are required. The Salesforce adapter therefore queries active Leads by normalized email before writing: create on zero matches, update on exactly one, and hold on multiple matches. It writes only portable standard fields and never requires a Harrison-specific custom field. A server-side access token authenticates the local connector; production should use a refreshable connected-app OAuth flow.

## Read-only Agentforce triage as the first agent action

The first Agentforce action previews a Salesforce Lead's deterministic data
readiness through an autolaunched Flow and bulk-safe invocable Apex. It performs
no DML. This keeps the agent aligned with the Control Tower's human-approval
boundary while demonstrating a real Agentforce → Flow → Apex execution path.
Mutation remains in the existing governed connector workflow, where plans,
fresh reads, receipts, and rollback evidence already exist.

## Separate human-approved Salesforce execution plane

Agentforce remains a read-only recommendation surface. Native Salesforce Lead
ownership changes use a separate Screen Flow approval, an idempotent invocable
Apex planner, and one Queueable executor. Routing thresholds and queues live in
Custom Metadata; the worker locks records, refuses stale snapshots, uses
partial-success user-mode DML, and persists a parent run plus per-Lead receipts.
A Transaction Finalizer records unhandled async failures after the worker
transaction rolls back. This makes the write boundary obvious,
admin-configurable, and auditable without giving the agent mutation authority.

## Self-hosted open-source release

The first public release is a self-hosted toolkit, not a multi-tenant SaaS. CSV-only mode needs no account, while optional setup renders BigQuery and n8n assets from portable project and dataset tokens. A public demo carries no CRM credentials; each operator owns their deployment, secrets, connector permissions, and resulting data.

## Separate experiences, one codebase

The public Cloudflare Pages build contains only the fast, credential-free root
demonstration. The same repository retains `/app` as the whole-account duplicate
audit, `/app/lab` as the CSV and guided repair workspace, and `/setup` as the
local installation guide for Docker self-hosters. Reusing the public demo
component avoids a second product codebase without publishing uploads,
persistence, credentials, or connector routes.

## Deterministic review before provider merge

Duplicate confidence is an explainable rule result, not an AI probability and
not an execution threshold. Exact and alias email, low-frequency phone, name,
company, and domain evidence are visible beside conflicts. Unanchored context is
capped below the review threshold, broad buckets are bounded, and Salesforce
Lead-to-Contact candidates carry a cross-object blocker. A phone shared by more
than three records is context-only. Competing overlapping candidates must be
dismissed before the remaining cleanup plan can be approved, and a Salesforce
Contact is the fixed survivor for a Lead/Contact group.

The first whole-account release persists the proposed field recovery with the
scan. A review saves only **not a duplicate** or **confirmed duplicate** and the
chosen primary record. It does not call provider merge APIs, convert Leads,
delete records, or apply the field plan. This creates a useful, auditable queue
without presenting an irreversible CRM operation as rollback-safe.

## Durable provider pagination with an explicit ceiling

Whole-account scans are browser-driven but server-persisted one page at a time.
The provider record upsert and cursor transition are committed together, so a
pause or interrupted tab resumes without multiplying records. A 25,000-record
local SQLite ceiling and 10,000-record D1 ceiling bound work; reaching either
before provider completion is a partial audit with an explicit warning and
partial run receipt. The UI claims a
clean account only when provider pagination is complete, and a retried completed
step reconciles the same scan-ID receipt instead of creating a second run.
If the resolver version changes while a scan is paused, resume is refused and
the operator must start over so one audit never mixes rule versions.

## Public audit is local-only

The public showroom may accept a CSV only through browser-local file reading.
It uses the same deterministic import and destination-gate rules as the
self-hosted workspace, returns aggregate issue counts, and downloads a
contact-free Markdown report. It never sends a filename, row, or audit result
to a server, and it cannot execute connector writes. This gives a visitor an
immediate personal proof without weakening the static hosting boundary.

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

## September 27, 2026 — Reject ambiguous CSV identities and invalidate failed previews

Each imported source record must have a unique final contact ID, including IDs generated for blank inputs. Repairs index records by ID; silently accepting repeats could merge an unrelated person. Reject the batch with both CSV row numbers instead of renaming or dropping records. Preview and direct import share the existing normalized-header collision check.

Starting a replacement preview discards the previous draft and mapping. An unreadable, oversized or invalid file cannot leave an old Validate + load action available. Already imported contacts remain intact until a new file validates successfully. These changes correct the existing CSV workflow without changing the bundled sample or adding providers.

## September 27, 2026 — Initialize the documented local D1 development store

The Vite development server binds a local D1 database, while the standalone Docker path initializes SQLite automatically. A fresh Node checkout therefore needs the existing Drizzle migrations before it can save workspaces. The explicit `db:migrate:local` command pins Wrangler to a checked-in local configuration and `.wrangler/state`; it uses the same binding, database name and placeholder ID as Vite. It adds no schema or remote migration path. Reapplying completed migrations preserves saved workspaces.

## September 27, 2026 — Resolve held records within the imported workspace

Allow corrections to email, company, owner and current lifecycle stage on active
held rows, with a required reason and before/after values. IDs, expected stages
and merged rows stay fixed. An explicit email recheck can replace an invalid
supplied normalized identity; editing other fields preserves it. Email changes
recompute duplicate holds across active rows. Unresolved and unrelated flags
remain, and an unknown lifecycle value cannot clear an existing stage hold.

Store correction history in the existing workspace snapshot, with no migration
or separate audit system. Old snapshots load with an empty history. Undo restores
rows and history together; replacement imports and resets clear the current
history. Existing revision and size limits still apply. When persistence is
configured, a failed save leaves the correction unapplied and retains the draft
for retry; session-only mode labels changes as browser-local.

Workspace changes invalidate current CRM previews and sync results so the next
write uses the existing eligibility and review flow. Historical connector
receipts remain in their existing store. The first version belongs to the
self-hosted operator workspace, not the static public demonstration, and performs
no provider writes by itself.

## September 27, 2026 — Compare imported identities with current CRM records

Use shared exact-email readers in both the reviewed write path and legacy direct
sync routes. HubSpot includes primary and additional emails and individually
confirms missing batch results before proposing a create. Salesforce checks
Leads, including converted Leads, and Contacts; only a sole unconverted Lead is
an update target. Contact, converted, ambiguous and shared-native input matches
are held with visible native IDs. Incomplete reads stop the comparison.
Contact lookup reads only ID and email because held Contacts are never update
targets; Account access and unrelated Contact fields are not required.

Keep the existing fifteen-minute plan and execution reread. Include matched
identities in its fingerprint. HubSpot creates use create-only requests so a
conflict cannot silently become an unreviewed update; Salesforce writes retain
configured duplicate rules. Neither separate read/write sequence is atomic
against external writers. Different unlinked emails and records outside the
connected user's visibility remain outside the guarantee. Add no fuzzy matching,
native merge, schema, dependency or n8n behavior change.
