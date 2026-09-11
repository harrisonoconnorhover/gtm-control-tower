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

## Inbound practice shares the showroom, with simulated destinations

The inbound lab uses a generic five-field demo request with WPForms-style payload
keys and separate fictional enrichment. Product copy and documentation stay
company-neutral. In practice mode, CRM behavior, ownership rules, and notifications
are explicitly simulated. The same client component serves `/#inbound-lab` in the static
showroom and `/app/inbound` in the self-hosted app. Browser storage keeps the
practice session useful without credentials or new infrastructure.

Normalized email provides person identity. Assignment consumes capacity once per
person; tasks and notifications complete once per genuine submission. Technical
retries reuse the original request. Existing owners take precedence over pool
capacity. The lab retains attempt payload/context snapshots, including after
correction. This is a synchronous practice model, not proof of provider semantics
or a concurrent production queue. See `docs/inbound-routing-lab.md` for the
schema, policies, limits, and walkthrough.

## Salesforce owns demo activity and identity matching

Connected intake sends one immutable request ID and form payload from the server
to a Salesforce Apex REST service. The service creates a Demo Request record,
searches both Contacts and unconverted Leads, preserves existing ownership, and
creates a Task and owner notification. Each genuine submission gets fresh
activity. Technical retries reuse the same request and task; changed payloads
cannot reuse an old key.

Apex is used here instead of a chain of Flow steps because the person lookup,
creation, and task write need a transaction and an email-specific row lock.
A unique identity row serializes requests with different IDs for the same email.
A first-insert collision rolls back and returns a retryable response. This
prevents competing submissions through this intake from both creating a Lead;
Salesforce duplicate rules still govern writes from other integrations.

Existing queue or inactive ownership is held for review. New Leads initially
belong to the connected integration user; this pilot does not silently apply the
practice rep pools to Salesforce. Production operator access uses the existing
Control Tower key boundary. Salesforce credentials remain server-side. Public
static hosting continues to provide practice mode only.

## Hollis adds a public Account-and-Contact intake

Hollis Consulting is a distinct public Worker on the owner's Cloudflare account.
It shares Control Tower's submission contract and Salesforce transaction, rather
than exposing the operator app. The existing operator defaults and receipt hashes
stay compatible; a server-selected `createContact` mode adds Account/Contact
creation and native Lead conversion for Hollis.

Existing contact identity wins; new company matching requires agreement between
company name and business email domain. Conflicts are held. New Account websites,
company sizes, regions, and tiers are left unset because the form supplies no
verified evidence for them. New Accounts belong to the integration user; existing
owners are preserved. A domain lock prevents two simultaneous people from
creating two company records through this intake.

Long-lived authorization stays in Cloudflare secrets with automatic access-token
renewal. Only public assets and a bounded anonymous submission endpoint are
published. The 5-per-minute IP limit and same-origin checks address this form's
spam and cross-site submission exposure without adding a new database or operator
login to the marketing site. Details are in `docs/hollis-consulting.md`.

## Hollis design uses specific copy and restrained decoration

The September 10 revision replaces the generated staircase metaphor with real
workflow-planning photography. Headlines now name the service and practical
work. We removed the floating image caption, promotional eyebrows, repeated
slogans, decorative arrows, exaggerated corner radii, and the duplicate service
strip. Process steps use an ordered list, secondary text is larger, and section
spacing is tighter. The charcoal/cyan palette and familiar demo form remain.

This is a limited application of recurring comments in
[r/web_design](https://www.reddit.com/r/web_design/comments/1uzascg/every_vibecoded_websites_looks_the_same/)
and [r/UX_Design](https://www.reddit.com/r/UX_Design/comments/1v3tghy/what_gives_away_a_website_as_fully_vibecoded/),
not a rule that any one color, font, or layout proves AI authorship. Neither
Salesforce behavior nor the public submission contract changes in this revision.

## Public demo follow-up uses the current Account owner

For public Account/Contact intake, an exact existing Contact keeps its identity,
ownership, and first-touch fields while the current Account owner receives the
new follow-up task. This resolves partial territory handoffs without rewriting
CRM history. A queue-owned marketing Lead may convert into an unambiguously
matched Account using its active owner. An unknown company with no active Lead
owner waits for trusted CRM enrichment, then reuses the held request and task.
Private Lead-only intake retains its previous ownership behavior.

A single exact normalized company-name and domain match can distinguish business
units sharing a corporate domain. Partial evidence, multiple exact matches, and
truncated searches remain held. Each request stores a readable routing decision.
The form contract stays unchanged; existing CRM ownership supplies context.

The public Worker retries network failures and 502/503/504 once using the same
payload and request ID. It does not retry conflicts or throttling, and does not
claim durable delivery during a long outage. Repeatable fictional fixtures and
the boundaries of the marketing/enrichment simulation are documented in
`docs/hollis-routing-scenarios.md`.

## Recover saved inquiries where operators already work

A native Salesforce Screen Flow and request-page action retry one saved inquiry
after a trusted CRM correction. The action uses the existing permission and
transactional intake service; it reconstructs the original mode from its payload
fingerprint so historical Lead-only requests remain compatible. Original form
fields and attribution stay unchanged. A Needs attention view and task hyperlink
make unresolved work accessible without adding a private console to the public site.

Response-body failures belong inside the Worker's recovery attempt because a
successful HTTP header does not prove a complete receipt. One shared 40-second
deadline bounds authentication and delivery within the unchanged form timeout.
The local interruption drill uses real Salesforce writes with stable IDs and
explicitly labels its simulated transport/authentication boundary.
