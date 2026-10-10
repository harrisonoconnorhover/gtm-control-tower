# GTM Control Tower

[![CI](https://github.com/harrisonoconnorhover/gtm-control-tower/actions/workflows/ci.yml/badge.svg)](https://github.com/harrisonoconnorhover/gtm-control-tower/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-174b45.svg)](LICENSE)

**[Clean a CSV in your browser](https://gtm-control-tower.pages.dev/#clean-csv)** ·
**[Try the synthetic cleanup](https://gtm-control-tower.pages.dev/#decisions)** ·
**[Follow a real CRM import](https://gtm-control-tower.pages.dev/enterprise-import-walkthrough.html)** ·
**[Self-host the operator workspace](#quick-start-one-command-no-accounts-required)**

A browser CSV cleaner and self-hosted revenue-systems lab. Start by uploading,
reviewing, and downloading a CSV without installing anything or creating an
account. The operator workspace adds saved reviews, explainable routing,
trusted funnel metrics, and receipted CRM repairs.

Teams can add HubSpot, Salesforce, n8n, BigQuery, and dbt without putting
credentials or organization-specific IDs in the repository.

## Review the work in two minutes

1. Open [Clean a CSV](https://gtm-control-tower.pages.dev/#clean-csv), load the sample or choose your file, preview and apply selected changes, then download the result. Headers and custom columns stay intact; repeated or malformed emails remain for your review. See the [browser CSV guide](docs/browser-csv.md).
2. Inspect the [browser CSV transformations and export](lib/browser-csv.ts) and [their regression tests](tests/browser-csv.test.ts). Email cleanup preserves local-part case, plus tags, and dots; internationalized domains use IDNA. Row exclusions are explicit.
3. In the self-hosted `/app/lab`, follow the [three-row held-record review](docs/held-record-review.md): correct an email, inspect a new duplicate hold, resolve it, and leave a partially corrected row held.
4. Inspect the [possible CRM match walkthrough](docs/approximate-import-matches.md): choose imported fields, compare a dated snapshot, and examine ranked suggestions and conflicts. The scores are review signals, not identity probabilities or permission to sync.
5. For the separate Salesforce development work, read the [approval, stale-write, and partial-success test contract](docs/salesforce-apex-routing.md). Its dated native results are historical evidence, separate from the browser demonstration and the current CI run.

The bundled examples use fictional records. Your uploaded CSV stays in your browser tab. The separate [synthetic cleanup](https://gtm-control-tower.pages.dev/#decisions) demonstrates owner, lifecycle, and merge policies with inspectable record decisions. Those policies are not applied to your uploaded file. The [enterprise import walkthrough](https://gtm-control-tower.pages.dev/enterprise-import-walkthrough.html) shows a separate, verified HubSpot/Salesforce development run: review seven attendees, manually exclude two unresolved identities, write five approved rows, repeat without new writes, and restore the two updates. Inspect the [native results and limitations](docs/enterprise-import-native-check.md) or [download the case files](docs/enterprise-import-fixtures.md). Connected operations require your own configured operator workspace.

That original run used advisory approximate review. A later [native follow-up](docs/enterprise-import-native-check.md#follow-up-control-tower-holds-possible-duplicates) verified the new governed create guard: Priya and sparse Jordan were held in both CRMs, with zero creates or updates and unchanged native records.

## What it does

- Cleans a CSV entirely in the browser: preview conservative formatting changes,
  edit individual cells, review email warnings, explicitly exclude or restore
  rows, undo edits, and download all included rows with the original columns.
- Prepares a saved [Safe Import review](docs/safe-import.md) for existing HubSpot
  Contacts and Salesforce Leads/Contacts, with exact field decisions, identity
  holds, account-bound approval, durable execution and native readback. Unmatched
  rows never create records; populated CRM values are preserved.
- Provides a connected [CRM Monitor](docs/monitor.md) at `/app/monitor` for
  HubSpot Contacts/Companies/Deals and Salesforce Leads/Contacts/Accounts/Opportunities: recurring checks, a durable human triage queue, downloadable reports,
  and optional verified company/job-title whitespace repairs. A separate runner
  continues with the browser closed. Requires the self-hosted SQLite app.
- Groups unusual changes into [incidents](docs/incidents.md) at `/app/incidents`: field clearing, repeated reversals, broken relationships, deadlines and coverage failures. Retains native change events, separates evidence from possible causes, and pauses recurring repairs. Optional model explanations have no write authority.
- Replays [2,900 generated messy records](docs/incident-stress-results.md) through the actual monitor with `npm run qualify:incidents`, producing inspectable data, expected outcomes and a local HTML report.
- Combines incoming CSV lists, incidents and CRM Monitor findings in the [Operations Inbox](docs/operations-inbox.md)
  at `/app/work`, with saved ownership, exact-review links, and verified outcomes.
- Sends optional [Slack notifications](docs/slack-notifications.md) for findings,
  repairs, import reviews/results and follow-up changes across both CRMs. The
  Inbox shows delivery status; approvals stay in the private operator app.
- Includes an [Inbound Routing Lab](docs/inbound-routing-lab.md): a working demo
  request form, 32 fictional requests, account matching, rep assignment, and
  deliberately broken handoffs with replay. Open `/#inbound-lab` in the showroom
  or `/app/inbound` when self-hosted. Practice mode simulates CRM actions;
  [connected Salesforce intake](docs/salesforce-demo-intake.md) reuses existing
  people and creates a task and owner notification for each genuine submission.
- Previews any CSV, lets the operator map arbitrary headers, saves reusable
  mapping presets, and diagnoses duplicate
  identity, missing fields, bad email, owner gaps, and lifecycle regression.
- Optionally imports a [Pomade JSON handoff](docs/pomade-handoff.md) into a new
  saved review workspace, retaining original proposals and source context.
  These files permit existing-record updates only; ordinary CSV imports retain
  their create workflow. Neither product requires the other to operate.
- Lets the operator [correct held imported rows](docs/held-record-review.md) in
  `/app/lab` with a reason, revalidation, and before/after history. Email changes
  recheck active-row duplicates; unresolved holds remain.
- Scans every HubSpot Contact or every unconverted Salesforce Lead and Contact,
  persists provider-page progress, and produces an evidence-backed duplicate
  review queue without performing a native CRM merge.
- Offers [possible CRM match review](docs/approximate-import-matches.md)
  for imported rows using selected name, email, phone, state, and company fields.
  Shows up to three suggestions per row with native IDs, evidence, conflicts,
  missing values, and snapshot coverage; exports the review as JSON.
- Persists imports, repairs, field-level write plans, native receipts, rollback
  backups, and twenty workspace revisions in local SQLite.
- Reads Google Sheets through n8n and writes governed records to a separate
  `GTM Clean` worksheet without requiring BigQuery.
- Executes reviewed merge, reroute, and lifecycle-replay workers and exports the
  repaired state.
- Reads HubSpot Contacts or Salesforce Leads back through the same visual
  mapping path used by CSV, then proposes rather than silently applies changes.
- Syncs eligible contacts to HubSpot Contacts or Salesforce Leads with
  [imported-file CRM comparison](docs/import-crm-comparison.md), field diffs,
  100-record ceilings, per-record receipts, and update rollback. Direct
  connectors distinguish new records from exact email matches and hold unsafe
  matches before execution. Governed previews also hold proposed creates when
  any approximate candidate exists in the CRM snapshot or another active row of
  the saved import, including later batches. A missing fresh complete snapshot
  also holds creates. Import matches show source row IDs separately from CRM IDs.
  Newly created records are never auto-deleted.
- Supports [human-confirmed import matches](docs/confirmed-import-matches.md):
  choose an existing HubSpot Contact or unconverted Salesforce Lead, save a reason,
  and preview protected field updates by native ID while preserving CRM email.
  Stale source/target data or competing import rows hold the write. A dated native
  check updated and restored one fictional person in each development CRM.
- Provides [operator import controls](docs/import-operator-controls.md): save
  per-row skip/restore decisions, fill empty CRM fields or replace selected ones,
  explicitly permit blank clearing, and download batch comparisons and saved
  results as spreadsheet CSVs. Existing CRM values are protected by default.
- Keeps returned CRM outcomes separate from local receipt-save failures. Failed
  history saves expose the full receipt for download or storage-only retry;
  retrying receipt storage does not repeat CRM writes or rollback.
- Offers [read-only verification of saved CRM writes](docs/crm-run-verification.md):
  compare expected fields and primary email with current native records, retain
  timestamped differences or read errors, and export results without replaying writes.
- Includes a source-driven Salesforce development slice: a published read-only
  Agentforce triage path plus a separate human-approved Screen Flow, invocable
  Apex planner, Queueable executor, Custom Metadata policies, stale-record
  protection, idempotency, partial-success DML, and durable per-Lead receipts.
- Routes synthetic leads through n8n, records immutable BigQuery events, and
  models funnel conversion, routing SLA, and data quality with dbt.
- Shows how operational defects change revenue metrics instead of presenting a
  static dashboard.
- Builds the public proof as a static site while keeping the operator workspace
  and self-host diagnostics in the same repository.

## Salesforce-native proof: Agentforce, Flow, and advanced Apex

The Salesforce slice is one governed business workflow, not a folder of syntax
examples:

```text
Agentforce -> read-only triage Flow -> explainable Apex recommendation
                                          |
                                          v
operator -> approval Screen Flow -> invocable Apex planner -> Queueable executor
                                                |                    |
                                      Custom Metadata policy   locked Lead updates
                                                \____________________/
                                                          |
                                              run + per-Lead receipts
```

The write path accepts up to 200 selected Leads. A unique Flow interview token
prevents duplicate jobs; `WITH USER_MODE` and `with sharing` enforce the
operator's access; `FOR UPDATE` plus a captured `LastModifiedDate` prevents an
async job from overwriting newer work; and `Database.update(..., false)` records
individual failures without rolling back valid ownership changes. Routing rules
are deployable Custom Metadata, so an admin can change thresholds and queues
without changing Apex. A Transaction Finalizer records terminal async failures
in a separate transaction instead of leaving a run stuck at `Processing`.

Verified in the Salesforce development org on 2026-09-02: all six focused
routing tests passed, including the 200-Lead bulk case; validation reported
85.4% coverage for the planner and 81.6% for the Queueable worker. A live
three-Lead run routed two records to the expected queues, held one below-policy
record, recorded zero failures or stale writes, completed its async job with
zero errors, and returned the original run when the approval token was replayed.

Start with the [architecture and test contract](docs/salesforce-apex-routing.md),
then inspect the
[`GTMLeadRoutingService`](salesforce/force-app/main/default/classes/GTMLeadRoutingService.cls),
[`GTMLeadRoutingQueueable`](salesforce/force-app/main/default/classes/GTMLeadRoutingQueueable.cls),
and [`GTM_Approve_Lead_Routing`](salesforce/force-app/main/default/flows/GTM_Approve_Lead_Routing.flow-meta.xml)
source.

<a id="public-demonstration"></a>

## Clean a CSV in your browser

Open **[Clean a CSV](https://gtm-control-tower.pages.dev/#clean-csv)**. No install,
account, or CRM connection is required. Choose a CSV up to 10 MB and 10,000 data
rows, select the email and whitespace-cleanup columns, then preview changes
before applying them. You can also edit cells, exclude or restore rows, and
undo your last edit. Download the cleaned CSV when you are ready.

The file and edits stay in tab memory: there is no source-data upload, browser
storage, or operator API call. Refreshing or leaving loses the session, so
download before you close it. Original headers, column order, custom columns,
and row order remain; only explicitly excluded rows are omitted. Unresolved
email warnings do not prevent download or remove rows automatically.

Formula-like cells are prefixed with an apostrophe on export, with a count shown
before download. Spreadsheet programs may still change types such as leading-zero
IDs when opening CSVs. See the [browser CSV guide](docs/browser-csv.md) for the
exact cleanup rules and export limits. Existing `#audit` links open this workflow.

The static site also retains the separate deterministic 64-row synthetic cleanup
and its record decisions, plus the dated development-system walkthrough. It does
not save workspaces, read a CRM, or expose the operator application. Use the
self-hosted workspace below for those capabilities.

## Safe Import: Update existing contacts

In the persistent self-hosted `/app/lab`, select **Update existing contacts safely**,
upload and map your CSV, then **Prepare review** for the whole file. Existing
HubSpot Contacts or Salesforce Leads/Contacts receive only approved blank-field fills; populated fields and
primary email stay protected. Identity holds require review, and unmatched rows
never create contacts. Approval is bound to the saved review and actual CRM
account, with durable execution and automatic readback. No AI model is required.
See the [workflow, recovery, and verification guide](docs/safe-import.md).

<a id="quick-start-one-command-no-accounts-required"></a>

## Self-host the full operator workspace

Requires **Docker installed and running**. On macOS or Windows, open Docker
Desktop and wait until its engine is ready before running these commands. This
starts the app with a saved local workspace; no CRM account is required.

```bash
git clone https://github.com/harrisonoconnorhover/gtm-control-tower.git
cd gtm-control-tower
docker compose up --build app
```

Open [http://localhost:3000/app/lab](http://localhost:3000/app/lab), choose **CSV
file**, and either load the bundled 64-row practice batch or try
[`public/control-tower-csv-template.csv`](public/control-tower-csv-template.csv).
For a rougher test, use the 72-row
[`SEC public-company messy CRM fixture`](public/sec-public-company-messy-crm.csv):
company, ticker, exchange, and CIK fields come from the SEC's
[Company Tickers Exchange](https://www.sec.gov/files/company_tickers_exchange.json),
while every person, email, phone number, and website is synthetic and uses a
reserved example domain.
The workspace survives browser and container restarts in
`.runtime/sqlite/gtm-control-tower.db`. To add the optional n8n Community Edition
service, run `docker compose up --build app n8n`; n8n opens at
[http://localhost:5678](http://localhost:5678). Connector checks live at `/setup`;
durable field diffs, provider receipts, failures, evidence export, and eligible
rollbacks live at `/runs`.

After configuring a direct HubSpot or Salesforce connector, open
[http://localhost:3000/app](http://localhost:3000/app) for the whole-account
duplicate scanner. That optional scanner requires a connector and persistence;
the CSV workspace above is the account-free starting point.

## Whole-account duplicate audit

The self-hosted `/app` scanner follows provider pagination instead of loading a
fixed preview. HubSpot contributes Contacts. Salesforce contributes unconverted
Leads first and then Contacts, so a possible Lead-to-Contact match
can be reviewed without being treated as a same-object merge.

Matching is deterministic and versioned. Exact non-generic email, Gmail alias
families, normalized phone, compatible names, company, and business-domain
context add evidence; conflicting names, phones, and domains subtract evidence.
Candidates are grouped as **high confidence**, **needs review**, or **possible**,
and each group shows the evidence, conflicts, recommended primary record, and
field-recovery plan. A Salesforce Lead-to-Contact group is always capped at
review and carries a cross-object blocker.

Provider records, the next-page cursor, candidate groups, warnings, and review
decisions are durable in SQLite/D1. A paused or interrupted scan resumes at the
saved page. The measured ceiling is 25,000 records on local SQLite and 10,000 on
D1; reaching it produces a clearly labeled partial-account result rather than
claiming full coverage or a clean account.

**Approve cleanup plan** records the operator's duplicate decision and chosen
survivor. It does not call HubSpot or Salesforce merge APIs. Existing governed
write-back and rollback features remain separate under `/app/lab` and `/runs`.
See the [duplicate-audit guide](docs/duplicate-audit.md) for connector scopes,
confidence rules, limits, and the synthetic seed command.

The Node.js development path remains available:

```bash
npm ci
npm run db:migrate:local
npm run dev
```

The development server stores its local D1 database in `.wrangler/state`.
Run the migration step for a fresh checkout or after pulling new SQL migrations.
The command is pinned to the local database and requires no Cloudflare account.

## Add the warehouse and workflow layer

```bash
npm run setup -- --project your-gcp-project --dataset gtm_control_tower
```

The setup command renders personalized SQL and credential-free n8n workflows
under ignored `.runtime/generated`. Run the generated BigQuery setup, import
the generated workflows, and bind your own least-privilege credentials in n8n.
Templates are inactive by default.

```text
CSV --------------------> browser repair lab ------> repaired CSV
  \                                                   /     \
   \----> governed contact gate ----------------> HubSpot  Salesforce

Lead webhook -> n8n normalize/score/route -> CRM + BigQuery -> dbt -> dashboard
                                             ^                    |
                                             +--- receipted repair+
```

Full instructions: [self-hosting](docs/self-hosting.md),
[duplicate audit](docs/duplicate-audit.md),
[imported-file CRM comparison](docs/import-crm-comparison.md),
[possible import matches](docs/approximate-import-matches.md),
[Google Sheets](docs/google-sheets-setup.md),
[HubSpot](docs/hubspot-csv-setup.md), and
[Salesforce](docs/salesforce-csv-setup.md). The deployable Salesforce developer
slice is documented in [Flow, Apex, and Agentforce proof](docs/salesforce-agentforce.md).

## Safe-by-default boundaries

- The browser never receives CRM, n8n, or Google credentials.
- Unconfigured connectors do not appear as operational choices.
- Direct CRM connectors offer Compare with CRM → Review → Execute → Receipt
  → eligible update rollback. The HubSpot n8n path remains a delegated email
  upsert and does not provide this comparison or rollback.
- Governed CRM execution refuses a plan after 15 minutes or whenever a fresh
  provider read no longer matches the reviewed fingerprint. Failed or incomplete
  reads cannot establish that a record is absent.
- Governed direct creates require the latest same-workspace/provider snapshot
  to be complete, provider-complete, and started within 15 minutes. Server-side
  checks use all five matching fields, independently of review checkboxes;
  any candidate or capped search holds the create. Execution rechecks the guard.
  Exact-email updates and unchanged records retain their existing behavior.
  This guard applies to `/api/control-tower/crm-writeback`, not legacy direct-sync
  or webhook routes. It does not prove absence or eliminate false positives.
- Destination gates hold unresolved duplicates, invalid email, missing company,
  missing owner, and lifecycle regression out of generic writes.
- Public templates contain no credential bindings or private project IDs.
- CRM writes are explicit, allow-listed, standard-field-only, and reconciled by
  native receipt.
- Rollback restores only previously updated portable fields; it never guesses
  at provider merges or deletes records created by a successful run.
- Duplicate-audit approval saves a review decision only; no confidence band
  triggers an automatic native merge.
- Legacy Salesforce imports hold Contact matches. Safe Import supports existing
  Contacts, preserving their Account relationship; converted Leads and ambiguous matches stay held.
  Both direct connectors hold multiple imported rows targeting the same CRM
  record. Exact matching does not infer identity from names or companies.
- HubSpot direct creates never fall back to an update on conflict. Salesforce
  writes retain configured duplicate rules with `allowSave=false`. Comparison
  and reread do not make the later write atomic against other CRM writers.
- Production CRM writes remain disabled until `CONTROL_TOWER_SYNC_KEY` is set.
- The synthetic merge keeps source rows queryable and points them to a canonical
  record rather than deleting them.

This repository is a self-hosted reference implementation, not a managed
multi-tenant service. Put any hosted instance behind authentication and HTTPS.
The imported-file CRM comparison has both focused simulated tests and a
[dated native development check](docs/enterprise-import-native-check.md). Its
fictional cases do not establish behavior under every account configuration.

## Development

```bash
npm run doctor
npm run check:secrets
npm run audit
npm test
npm run lint
npm run build
npm run build:public
npm run smoke:fresh-install
```

With development CRM credentials in `.env.local`, run:

```bash
npm run seed:duplicate-audit -- both
```

The command upserts clearly labeled synthetic duplicate-audit fixtures into
both systems. Use `hubspot` or `salesforce` instead of `both` to target one
development account. This writes CRM records; do not run it against a customer
or production portal.

Run `npm run preview:public` to inspect only the static public site locally.
The fresh-install smoke test creates isolated temporary Docker state, verifies
credential-free startup, persists and reloads a workspace across an app restart,
tests undo, confirms n8n's serialized-execution setting, and removes its own
containers and temporary data.

Run `npm run sync:n8n` after changing the state, seed, or repair SQL so the
portable Operations workflow stays in sync.

## Verified integration behavior

The connector paths have been exercised against dedicated development systems
using synthetic data. The 72-row SEC fixture produced eight duplicate merges,
six reroutes, and four lifecycle replays; 58 governed identities then synced to
both HubSpot and Salesforce while eight merged rows and six malformed-email
rows stayed out. HubSpot's first native receipt exposed six provider-rejected
internationalized domains instead of counting them as successes. After IDNA
normalization and a provider-valid reserved example subdomain, the final retry
completed all 58 writes: it updated the 52 prior successes rather than
duplicating them and created the six corrected contacts. Salesforce SOQL read-back found
58 unique active Leads with no missing or duplicate identities; a repeat created
zero and updated the same 58. n8n also read a 64-row Google worksheet, executed
all three repair classes, and idempotently upserted 44 governed rows to `GTM
Clean`. Two simultaneous Sheets webhooks carrying the same unseen email were
serialized and produced one row. A separate anonymous-clone acceptance run
started with no environment file or saved state, then persisted, reloaded, and
undid a workspace across a container restart. The public release contains no
access tokens, credential IDs, customer data, or personal CRM record IDs.

See [architecture](docs/architecture.md), [decisions](docs/decisions.md),
[security](SECURITY.md), and [contributing](CONTRIBUTING.md). Licensed under
the [MIT License](LICENSE).
