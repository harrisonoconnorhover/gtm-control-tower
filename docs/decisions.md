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

## Sister projects expose concrete work and current availability

On September 24, 2026, the public page gained Hot Potato and Pomade cards after
Salesforce proof, with matching footer links. They link to the actual public
application repositories. Hot Potato's marketing claims need correction before
that site becomes the primary destination; Pomade's hosted access remains private.
The cards imply neither shared accounts nor a runtime integration.

The narrow Pages release was built from previously deployed `d7e63a6` plus
`797ec39`, and that patch was also applied to the current development checkout as
`62b4028`. This avoids publishing unrelated inbound-routing work with a portfolio
link change. The evidence and next improvements are in
`docs/portfolio-credibility-review.md`.

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

## September 27, 2026 — Rank possible import matches for review

Compare each imported person independently with records in a saved CRM scan.
Suggest selectable name, email, phone, state and company fields from usable import
values. Keep state separate from sales territory. Reuse normalizers and scan
storage; retain the existing account-clustering rules and exact-email write path.

Use a deterministic score out of 100, not a percentage probability: no labeled
match dataset or calibration supports a certainty claim. Fixed weights prevent
missing or deselected fields from inflating a score. Shared phones, weak context
and conflicting values remain visible. Limit broad candidate searches and show
their limits alongside snapshot dates, permissions and partial coverage.

Suggestions are read-only and never link, merge or approve writes. Show native
IDs and compared values so an operator can investigate in the CRM before the
separate write preview. Reuse paged CRM reads, reject malformed pagination rather
than reporting false completion, and review imports in batches of 100. Add no
schema or dependencies; live development-account qualification remains pending.

## September 27, 2026 — Distinguish native reads from write qualification

A read-only run against the configured HubSpot account and Salesforce Developer
Edition verified fresh scans, stored approximate suggestions and exact-email
preview proposals using existing labeled fixtures. Record the dated results in
`docs/import-matching-native-check.md`; keep screenshots from earlier simulated
browser checks labeled separately. Do not turn successful reads into a claim
about write execution, native duplicate rules or measured matching accuracy.
No runtime code or CRM records changed during this qualification pass.

## September 27, 2026 — Share the current operator key across the workspace

The setup console and destination panels must use the same current operator key.
Separate React state initialized once from session storage left matching and
preview unauthorized after a valid key was entered at the top. Make the setup
console a controlled consumer of the dashboard's existing key and change handler.
Keep tab-only storage and server authorization unchanged; add no new context,
authentication mechanism or persistence field.

## September 27, 2026 — Reject redirects in both supported runtimes

The native browser check exposed a local Cloudflare runtime incompatibility:
`fetch` rejected `redirect: 'error'` before sending a CRM request, although the
earlier Node handler check passed. Use `redirect: 'manual'` in the scan readers
and exact Salesforce reader, then reject non-success status codes. This retains
the no-follow behavior using the documented
[manual redirect mode](https://developers.cloudflare.com/workers/runtime-apis/request/#properties).
Check Salesforce response status before parsing JSON so an empty redirect body
produces the intended status error. No new redirect helper or fallback is needed.

## September 27, 2026 — Retain direct CRM outcomes across batches

Direct execution replaced the previous batch's display receipt, which caused
completed rows to return to the pending list after a second batch. Converting
that receipt to legacy sync statuses also mislabeled unchanged Salesforce rows
as updates and held rows as failures. Keep a separate in-session progress summary
of original direct receipt records, with the latest result per contact ID. Only
created, updated and unchanged rows count as completed. Preserve native run IDs
and rollback data on individual saved runs rather than inventing one combined
execution receipt. Reuse existing import/correction/repair/undo/reset invalidation;
add no storage migration or connector/API behavior change.

## September 27, 2026 — Keep pending CRM requests attached to their input

The dashboard allowed importing, resetting, undoing and refreshing comparisons
while CRM requests were pending. A late response could reinstate an old plan or
apply an old receipt to replacement rows with reused contact IDs. Extend the
existing fieldset's busy state through CRM comparison/sync and receipt saving;
wait for existing workspace saves, corrections and repairs before starting CRM
work. One synchronous in-flight ref rejects duplicate starts before React updates
the screen. Release it in finally, not in review invalidation. Keep provider APIs,
matching rules and saved receipt formats unchanged; add no cancellation framework
or new approval step.

## September 27, 2026 — Demonstrate a realistic fictional CRM import

Use recognizable company names and public websites with invented people, roles,
555-01xx phones, and company subdomains of IANA-reserved example.com. HubSpot
rejected the reserved .example suffix; example.com subdomains passed native
validation. Keep native IDs, account details, browser state, and full receipts
in ignored private output. Retain screenshots with IDs masked and a small
public result summary.

Use a prepared approved CSV to make the operator's exclusion of two approximate
matches explicit; suggestions do not enforce holds. Preserve Salesforce's native
duplicate-rule behavior on application writes. A single acknowledged rule alert
was necessary to seed the second fictional Jordan Lee; the seeder's opt-in applies
only to that named fixture and does not change the account rules. Native testing
also exposed a vague Salesforce failure message, so receipts retain its error code
alongside its text. No matching policy or new product feature is introduced.

## September 27, 2026 — Hold possible duplicates before creating CRM records

The native sparse-Jordan probe showed that a CRM can accept an unresolved match.
Connect the existing matcher to the governed direct write path: check would-be
creates against a complete snapshot started within 15 minutes, using all five
identity fields from the saved import. Any returned candidate holds creation,
including low-scoring ambiguous coworkers. Missing or incomplete coverage holds
creates too. Recompute at execution; exploratory field selection cannot weaken
the check. Exact-email updates and existing holds retain their current behavior.

Reuse plan holds and receipts without a new review table or override feature.
Show candidate evidence, never infer an identity link or merge. Accept additional
human review as the tradeoff: a held row may be a different person, and no
candidate is not proof of absence. Snapshot age, search bounds, and concurrent
CRM changes remain limitations; this is not universal duplicate prevention.

## September 27, 2026 — Compare the name sent to the destination

An import can contain both full_name and first_name/last_name with conflicting
values. The provider mappers prefer first/last, so create review must compare
those effective values after saved-input parity succeeds. Use the same precedence
in exploratory review for eligible rows; preserve raw review for ineligible rows
and exclude synthetic contact-ID placeholders. Do not let an unrelated display
name clear the identity that will actually be written.

## September 27, 2026 — Separate CRM outcomes from receipt-save outcomes

Once a valid provider receipt returns, retain the completed outcome immediately.
Failure to save it locally must not put successful records back into the write
queue or offer the original execution as a recovery action. Require an explicit
successful run-save acknowledgment, keep the full pending payload on the page,
and offer download or a storage-only retry using the same receipt ID. Reuse the
existing idempotent run store for both writes and rollback; add no schema or
automatic CRM retry. Warn that unsaved recovery data is lost on navigation or
reload unless it is saved or downloaded. Workspace-summary failures remain a
separate status from detailed history persistence.

## September 27, 2026 — Check possible duplicates within the saved import

Two rows for a new person can use different emails and both pass a CRM-only
lookup. Reuse the existing deterministic matcher to compare each proposed create
against the other active rows in the full saved workspace, including later
batches. Exclude the current row before scoring, phone frequency and search
limits; exclude locally merged rows. Hold any candidate or incomplete search
without choosing a winning row. Keep source-row evidence separate from native
CRM matches, and include it in the preview fingerprint rechecked at execution.
This is a current-import check, not a cross-workspace lock or a guarantee that
sparse identities will be detected. Preserve exact-email update behavior and
the dated native evidence; qualify this correction with simulated providers.

## September 27, 2026 — Save row selection separately from identity repair

Operators need to exclude a reviewed row without editing and re-uploading a CSV
or falsely marking it merged. Store a reason and timestamp on the source row,
with explicit restore and existing workspace undo. Recompute duplicate flags
among included rows, retain skipped source values, and round-trip the decision
in the full CSV. Save before applying selection changes; keep completed session
outcomes. Require the saved workspace for every governed CRM comparison, including
updates, so missing context cannot bypass a skip. Recheck current row identity
at execution as well as exclusion state. No native delete or merge is introduced.

## September 27, 2026 — Make update intent explicit

An operator may want to fill missing data without replacing known CRM values.
Default to fill-empty and allow selected-field replacement with separate blank
clearing permission. Save one portable policy per workspace for both connectors;
include it in the preview fingerprint and compare against saved policy before
execution. The effective after-values preserve unselected fields, and forward
updates send only the fields in the approved diff. Rollback uses that same diff.
Creates retain their mapped fields. Because missing columns and empty cells are
already both null, disclose that explicit blank clearing applies to both.

## September 27, 2026 — Separate spreadsheet proposals from observed outcomes

Existing JSON exports and repaired source CSVs do not provide a per-row business
review of a CRM batch. Add comparison/results CSV reports from existing plans and
receipts, joining by contact ID and retaining receipt-only or missing-result rows.
A comparison is not a receipt; blank outcomes and no_receipt must not imply a
successful write. Keep import IDs, native IDs, candidate counts, evidence and
update policy inspectable. Neutralize formula-like report cells without changing
stored source data. Reuse saved runs rather than adding a reporting datastore.

## September 27, 2026 — Qualify operator controls on retained development records

Reuse the existing fictional case instead of deleting or resetting records to
recreate a first import. Add a separate native update-only check: saved skips,
selected replacement and clearing, a real fill-empty write, receipt CSVs, and
restoration through the existing rollback path. Verify account and fixture
ownership before writes and compare the nine records' observed fields afterward.
Publish dated results with identifiers redacted; preserve earlier evidence and
keep native coverage separate from simulated failure and mobile checks.

## September 28, 2026 — Confirm an existing person without replacing their email

Resolve a held import row only through an explicit candidate choice and saved
reason. Support HubSpot Contacts and unconverted Salesforce Leads; preserve the
CRM email and reuse existing field policy, native-ID updates, receipts and rollback.
Require a fresh complete snapshot when confirming. Re-read the selected native
record at confirmation, preview and execution; source or target changes hold the
row until renewed review. Include the decision in the preview fingerprint.

Workspace JSON is independently editable, so the authenticated endpoint signs
its decision using the current connector credential, bound to workspace, source,
target and reason. Imported or tampered JSON cannot manufacture an approved
identity. Credential rotation requires confirmation again. Store the decision in
workspace revisions, not source CSV round-trips. Check competing decisions and
known target-email rows across the entire included import, not only the current
batch. This does not provide cross-workspace locks or atomic CRM writes.

## September 28, 2026 — Keep HubSpot email aliases in collision checks

The CRM reader validated additional emails but dropped them from the native
record used by confirmed-match and cross-batch checks. An import could therefore
contain two addresses for one Contact and propose competing updates in separate
batches. Retain normalized aliases from the existing provider read; compare
known primary/additional identities against the whole included saved import.
Use native IDs to connect exact matches to saved selections. No account-wide
extra lookup or new write path is needed.

Include the canonical alias set in confirmation freshness and signatures. An
alias change requires renewed review; ordering and case alone do not. Preserve
existing signatures where there are no aliases. Qualify this correction with
simulated provider regressions and preserve the scope of the earlier native
Priya/Jordan evidence; no new native alias qualification is claimed.


## September 28, 2026 — Re-review the row whose match decision changes

Keeping all completed progress after confirmation hid a changed target from the
next preview. Remove only that row from the selected connector's current progress
when a confirmation or clear saves successfully, recomputing counts from the
remaining results. Keep other rows, other connectors and saved receipts intact.
A failed save preserves progress. A new preview and explicit execution remain
required; changing a decision must never replay a CRM write automatically.

Pre-write backup JSON must distinguish the imported email from the actual CRM
email beside its native ID. Both are needed for a changed-email identity review;
the existing portable before-values alone do not establish the target address.

## September 28, 2026 — Separate write acceptance from observed CRM values

Add an on-demand read-back check to saved governed create/update runs, reusing
the native-ID readers and existing run JSON storage. Compare the plan's six
portable after-values, including protected existing fields, plus the expected
primary email. Keep provider acceptance immutable when a read fails or values
differ; never requeue or replay a write as part of verification.

Persist only the latest check with per-record timestamps and differences. Reads
use the current connection, and rollback can deliberately cause a difference
from the original plan. This slice adds no background monitoring, automatic
repair, probability scoring, or new CRM write path.

The first native check exposed a prior linkage bug: execution regenerated the
plan ID although the saved UI evidence retained the preview. After current-state
revalidation, retain the reviewed plan ID in the receipt and rollback. Keep older
mismatched history unchanged and unavailable for verification. Regression checks
cover both providers with time advanced between preview and execution.

## September 28, 2026 — Keep the Pomade handoff optional and updates-only

Extend Pomade's existing preview file rather than coupling the products through
shared services or credentials. Validate all 1–100 rows before loading them into
a new saved Control Tower workspace. Preserve `allowCreate: false` through
comparison and execution, including legacy files; ordinary CSV imports keep
their existing create capability. Pomade proposals require the governed direct
CRM path, not delegated legacy sync.

Keep original proposed values and bounded source context separate from Control
Tower's normalized fields and CRM outcomes. Upstream Ready is not approval or an
accuracy measurement; known review/error/stale statuses use existing exclusions.
Retain origins through correction, reload, local merge, and batch evidence while
labeling source evidence historical when values change. Missing legacy metadata
remains unknown. Local and hosted Pomade stay independent; this adds no research
execution, automatic CRM write, shared database, or two-way synchronization.

## October 6, 2026 — Safe Import is a saved deterministic contact recipe

Extend the governed planner with saved record mode and six field decisions rather
than duplicating import/matching logic. Legacy CSV defaults to create-and-update;
Safe Import forces HubSpot Contacts, update-existing, and the six-field fill-empty
policy. Keep the stricter Pomade source boundary and existing Salesforce Lead
workflow. Approximate identities remain suggestions; suspicious populated values
are preserved. Material contradictory names plus conflicting company/phone hold
exact-email identity until human confirmation.

Assemble all batch comparisons into one immutable whole-file review before any
write. Account for locally skipped, merged, invalid, unmatched, and unread rows;
unresolved CRM reads block approval. Bind the plan to uploaded-text SHA-256,
source/mapping/policy/identity evidence, workspace revision, and HubSpot's verified
portal ID. Recheck the whole comparison on approval and saved source/native values
immediately before each native-ID PATCH. No atomic external-writer guarantee is
claimed.

Persist one unique execution per review and progress before requests. Uncertain
responses require read-only reconciliation, never automatic resend; readback
cannot establish acceptance of a lost response. Verify accepted writes separately.
Preserve per-record evidence in database rows and chunk large reviews. Keep the
assistant replaceable and model-free by default; intent proposals require explicit
adoption and explanations use the same recorded decisions. This slice adds no
model provider, public deployment, native CRM qualification, background monitoring,
or automatic rollback.

## October 6, 2026 — Keep qualification boundaries explicit

Qualify native Safe Import using existing marked development contacts, an
isolated SQLite workspace, two phone fills, and separately reviewed restoration.
Preserve the original raw cleanup report when HubSpot represents a cleared null
phone as an empty string; a separate read-only reconciliation applies the existing
portable blank semantics and compares every other requested property exactly.

Test D1 through production stores in actual local workerd and a temporary cloud
database with a local remote-binding runner. Use a fictional CRM adapter for D1
tests and separate real SQL/storage evidence from injected invocation limits.
The measured 99-update execution exceeds the documented single-invocation budget;
cloud storage passing does not qualify hosted execution. Keep deployment and PR
publication pending while that release blocker remains.

## October 10, 2026 — Add a bounded HubSpot monitor to the self-host

Use deterministic connected-contact checks and a durable human triage queue.
Monitoring polls provider changes after an initial baseline, with saved cursors
and a separate HTTP runner so closing the browser does not stop checks. Default
to five minutes; support an hourly cadence. Keep automatic repairs off until the
operator enables the specific company/job-title whitespace policy. Ambiguous
identity, owner, and lifecycle issues require a person; reports retain evidence.

Use the existing SQLite adapter and operator key, with state scoped to HubSpot's
verified portal ID. Keep this slice out of D1 because its execution budget has
not been qualified. Bound pages and repairs, persist write attempts before send,
and never automatically replay an uncertain write. This adds no AI provider,
outbound Slack messages, public deployment, or new routing-policy assumptions.

## October 10, 2026 — Salesforce operations and a shared inbox

Extend the existing account-bound review/executor and Monitor engines. Safe Import
checks both Salesforce objects and permits uniquely matched unconverted Leads or
Contacts; Contact company/website stay outside scope because they belong to Account.
Use Organization.Id as identity, object-qualified native IDs, and disable Lead
assignment rules on PATCH. Do not infer an order for customized Lead statuses or
copy HubSpot lifecycle/owner rules into Salesforce.

Keep Monitor settings and findings separate by provider, org and object. Poll
Salesforce SystemModstamp windows with stable ID continuation, and preserve
existing HubSpot storage. Only Lead Company/Title and Contact Title whitespace
repairs qualify for the explicit opt-in; no ownership/status/Account mutation.

Add a small SQLite import task above existing workspaces and immutable reviews.
Commit upload/workspace together, deduplicate by provider and source hash, and
derive task status from actual review/execution evidence. Compose Monitor findings
into the same Inbox without duplicating their storage or approval logic. No model,
Slack or role system is required for this operator vertical slice. Hosted bounded
Safe Import execution remains a separate unresolved release requirement.

## October 10, 2026 — Slack notifications for saved operations

Use a server-configured incoming webhook for one selected operations channel,
with the existing HTTP runner draining a small SQLite event queue. Send summaries
and private review links for HubSpot and Salesforce; keep contact/source values,
notes and credentials out of messages. Approval stays in Control Tower.

Deduplicate stable operation events and claim one digest before sending. Honor
Slack rate limits; hold uncertain deliveries instead of risking duplicate posts.
Keep network delivery outside CRM execution. Post-save event enqueue is best
effort, with a documented process-crash gap; a notification never becomes the
authority for whether an import or repair succeeded. No SDK, extra service,
OAuth installation flow, channel reader or inbound Slack bot is added.

## October 10, 2026 — Consolidate completed work into main

Merge the existing main and development histories without rewriting either.
The last mirror commit (`f9d6a79`) contains all main (`d804d9b`) functionality;
its only existing-file differences add inbound routing and related documentation.
Resolve mirrored-history conflicts with the tested newer operations source
(`82035d2`), retaining Safe Import, Monitor, Salesforce, Inbox and Slack work.
Keep the unrelated pre-public-author-rewrite backup outside this merge.

Make TypeScript checking explicit in CI and exclude ignored generated runtime
outputs from lint. Validate the combined source and credential-free Docker
startup before advancing main. This consolidates source; it does not qualify
the whole-file D1 executor, deploy Salesforce metadata, enable automatic repairs
or configure a live Slack destination.

The integration audit found newly published advisories in the existing lockfile.
Update Next.js to the patched 16.3.8 release and Cloudflare tooling to compatible
patched versions. The remaining high-severity [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
has no published fix. Replace its two build-tool dependency paths with a scoped
`fast-glob` adapter backed by `tinyglobby`, preserving only the synchronous APIs
actually consumed by Next's ESLint plugin and Vite's dynamic-import plugin.
Test those real consumers and retain the existing full dependency audit gate.
Remove the adapter when upstream consumers no longer require the vulnerable
chain. This dependency adjustment does not change CRM matching or execution.

## October 10, 2026 — Use CRM Monitor as the feature name

Use CRM Monitor in the interface, messages and guides, with `monitor` for source
files, routes, commands, environment settings and storage. Retire the earlier
feature label instead of treating an interview participant's terminology as our
product name. The public routes are `/app/monitor` and
`/api/control-tower/monitor`; the runner command and Compose profile are `monitor`.

Rename existing SQLite tables in place so account settings, findings, scan
cursors and uncertain repair holds survive upgrades. Update queued generated
Slack messages without resetting event identity or delivery state. Keep retired
storage identifiers only in the upgrade helper and its regression fixtures;
they are compatibility data, not active product names. Stop the prior runner,
update deployment settings and bookmarks, then restart the app and runner as
described in the monitor guide. Historical Git commits remain intact.

## October 10, 2026 — Incident handling and bounded execution

Keep the existing monitor and Safe Import execution boundaries. Add an account-scoped incident layer above observations and native events, version business expectations explicitly, and preserve observed blank versus unavailable values. Group related changes, retain prior decisions and planned exceptions, and show incomplete or stale coverage. Native event actors describe their event; a later fresh read does not prove that actor caused its state. Baselines establish current state without inventing history.

Expand reads to companies/accounts and deals/opportunities while keeping their mutations unsupported. Repair claim budgets and repeated-reversal pauses contain Control Tower's own narrow whitespace recipe. Commit notification intent with incident/finding/repair transitions; forward through the existing optional Slack queue. Investigators have a separate preparation-only credential. Optional model explanations cite bounded evidence and cannot approve, run code or expand recipe authority. No additional framework or always-on model service is needed.

Replace whole-file Safe Import execution with at most ten records per invocation and a between-record time budget. Claim pending rows atomically under a fenced lease; never replay sending/unknown rows. Continue only within the original account/workspace/review scope and approval expiry. Local D1 fixture measurements qualify the bounded storage path against a simulated 1,000-call budget; they do not qualify hosted CRM execution or a 50-call plan.

Generate a reproducible fictional dataset rather than reuse unlabelled real CRM exports. Independent scenario labels cover 600 contacts, 350 companies and 400 deals per provider, plus 200 Salesforce leads. Stress the production worker and SQLite path with controlled timing, losses, permission failures and concurrent workers. Report clean controls, missed labels and false positives as fixture results, not general-world accuracy.

## October 10, 2026 — Qualify native behavior without rewriting the evidence

Load the same seed-42 world into explicitly pinned development accounts, retaining
native IDs and ownership markers in ignored manifests. Preserve the source
fixture and record provider rejections, storage normalization and legal mappings
separately. Repeated synthetic names must not require disabling Salesforce
duplicate rules; reserved HubSpot email domains use `.example.com` because its
native validator rejects `.example`. Unknown native creates remain held for
reconciliation, while explicit rate-limit rejections permit paced retry.

Run production polling and execution against a new SQLite database with a
manifest boundary around reads and writes. This qualifies the marked cohort,
not the entire account population. Use real indexing delays and native readback;
do not inject fictional timestamps or call a rejected value a detected anomaly.
Keep ordinary whitespace normalization distinct from three supplemental Unicode
boundary-space probes. Exercise approved phone fills separately from automatic
trims, preserving protected fields and deliberate human-review cases.

Retain the marked test records and private reports for inspection. Disable each
qualification monitor on exit; do not start background runners, deliver Slack,
call paid models, publish the app or imply native event-subscription qualification.

Native coverage is a statement about current saved observations, not just the
latest page or historical incident status. Keep unresolved record read gaps visible
until a successful reread replaces them, including recovery at an unchanged native
timestamp. HubSpot's precisely scoped `NO_ASSOCIATIONS_FOUND` response represents
an observed empty relationship; unrelated batch errors remain unknown.

Account automations can create records beyond an explicit import manifest. The
351 source-confirmed HubSpot companies created during qualification are retained
and reported as separate manual findings induced by mismatched setup suffixes.
Future HubSpot seeds map both email and company domains to `.example.com`, while
preserving deliberately inconsistent fixture domains. The fixture guard does not acquire
repair authority over them merely because their domains match synthetic contacts.

## October 10, 2026 — Make browser CSV cleanup useful without installation

Put upload, explicit change review, cell editing, and CSV download in the static
site. Keep the file in tab memory with no source-data upload, browser persistence,
or operator API. Retain the existing audit anchor and preserve headers, custom
columns, and row order; omit rows only after an explicit exclusion. Bound files
to 10 MB and 10,000 data rows for a usable browser session.

Use conservative formatting rules separately from the synthetic demo's routing,
lifecycle, and merge policies. Preserve email local parts and only normalize
their domains; missing, malformed, and repeated addresses remain review warnings.
Include unresolved rows in downloads, with counted apostrophe protection for
formula-like cells. Keep saved reviews and CRM operations in the self-hosted app.
