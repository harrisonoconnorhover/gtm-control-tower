# Self-hosting

GTM Control Tower works at three levels. Start with CSV-only mode, then add only
the connectors you actually use.

## 1. CSV + SQLite dashboard

Requirements: Docker.

```bash
git clone https://github.com/harrisonoconnorhover/gtm-control-tower.git
cd gtm-control-tower
docker compose up --build
```

Open `http://localhost:3000/app/lab`, choose **CSV file**, and load the bundled
64-row practice batch or use the included
[`control-tower-csv-template.csv`](../public/control-tower-csv-template.csv).
The more adversarial
[`SEC public-company messy CRM fixture`](../public/sec-public-company-messy-crm.csv)
contains 72 rows with duplicates, malformed and Unicode emails, missing company
and owner values, stage regressions, plus-addresses, inconsistent casing, and
quoted punctuation. Only company metadata comes from the public SEC snapshot;
all contact-level data is synthetic.
Preview the first rows, map the source columns, and choose **Validate + load**.
Imports, mappings, repair history, connector receipts, and the latest twenty
revisions persist in `.runtime/sqlite/gtm-control-tower.db`. The browser stores
only an unguessable workspace key; SQLite remains the source of truth.
Open `/runs` to inspect or export durable connector evidence and to restore
eligible updated CRM fields from their pre-write backup.

Plain `docker compose up` also starts n8n at `http://localhost:5678` so it is
ready when you add Google Sheets. Use `docker compose up app` for the app alone.
Set `CONTROL_TOWER_PORT=3100` before the command if port 3000 is occupied.
Set `N8N_PORT=5680` if port 5678 is occupied. Compose-generated container names
and optional runtime-directory variables allow independent checkouts to run
without sharing saved state.

For local development without Docker, use Node.js 22.13 or newer:

```bash
npm ci
npm run dev
```

## 2. Add Google Sheets through n8n

Import the two generated Google Sheets workflows, bind your own Google Sheets
OAuth credential, and publish both webhooks. The read path diagnoses a chosen
worksheet through the same visual mapper as CSV. The write path creates a
separate `GTM Clean` worksheet if needed, appends new destination-ready records,
and updates existing normalized emails in place. Formula-trigger characters are
escaped before sync. The included n8n service runs one production webhook at a
time, preventing simultaneous Sheets upserts from racing; queued calls resume in
FIFO order.

Follow [Google Sheets setup](google-sheets-setup.md). BigQuery is not required.

## 3. Add HubSpot or Salesforce

Copy `.env.example` to `.env.local`, then configure only the destination you
need. Use [HubSpot setup](hubspot-csv-setup.md) or
[Salesforce setup](salesforce-csv-setup.md). Credentials are read only by
server routes and `.env.local` is ignored by Git.

For any internet-accessible deployment, set `CONTROL_TOWER_SYNC_KEY`, use
HTTPS, and put the entire application behind authentication. The repository
does not provide multi-tenant identity or secret storage.

Both CRMs can also be sources. The CSV lab reads a bounded contact/Lead sample
into the same mapper used by CSV; that read never writes. A direct HubSpot
service key needs `crm.objects.contacts.read` for reads and account scans, plus
`crm.objects.contacts.write` for governed writes and rollback. Those governed
paths need both scopes because they read current Contacts before writing. n8n
users import both the write workflow and the separate read-only
`hubspot-source-workflow.json`, bind the same appropriately scoped OAuth
credential, and set both webhook URLs. Salesforce source access is included in
the CLI-authorized connector.

Direct CRM mode adds a second approval gate: preview a field-level plan,
download its portable backup, then execute within fifteen minutes. The server
re-reads provider state before execution. Updated fields can be rolled back from
`/runs`; created records are left in place for deliberate provider-side review.

### Scan the connected account for duplicate people

Open `http://localhost:3000/app` after configuring a direct CRM connector.
HubSpot account scans require a service key with
`crm.objects.contacts.read`. The write connection test requires
`crm.objects.contacts.write`; governed preview/write, rollback, and the
synthetic seed require both scopes. The n8n HubSpot source preview is
intentionally not presented as a whole-account scanner.

Salesforce scans read every unconverted Lead and then every Contact
visible to the configured user. Contacts use Account name and website as
company context. A Lead-to-Contact match stays in human review because it is a
cross-object cleanup or conversion decision, not a same-object merge.

The UI advances one provider page at a time and commits both records and the
next cursor to SQLite/D1. Pause after a page or return later to resume the saved
scan. The ceiling is 25,000 unique provider records on local SQLite and 10,000
on D1. Use `CONTROL_TOWER_MAX_SCAN_RECORDS` to choose a lower value of at least
100. When the ceiling is reached before provider pagination ends, the UI and
durable run receipt label the result as partial.

The duplicate queue is deterministic and decision-only. The scan stores its
field-recovery proposal; the review saves **not a duplicate** or **confirmed
duplicate** and, for confirmation, the selected primary record. It does not
execute a native HubSpot or Salesforce merge. See
[whole-account duplicate audit](duplicate-audit.md) for the matching rules,
blockers, evidence export, and safe development fixtures.

Local SQLite is the recommended scanner runtime. The schema also supports D1,
but whole-account resolution is compute-heavy and is not designed for the
[10-millisecond Workers Free CPU limit](https://developers.cloudflare.com/workers/platform/limits/);
use an adequately provisioned Worker and test it at the configured ceiling.

## 4. Add BigQuery and dbt

Requirements: a Google Cloud project with BigQuery enabled, Docker, and a
least-privilege Google service account for n8n.

```bash
npm run setup -- --project your-gcp-project --dataset gtm_control_tower
```

This produces personalized, ignored assets under `.runtime/generated`:

- `bigquery/setup.sql` and the synthetic repair lab SQL;
- credential-free n8n workflows with your project and dataset IDs;
- `dbt/profiles.yml` and `connection.env` with non-secret warehouse identifiers.

Run `bigquery/setup.sql` in BigQuery. Start n8n with `docker compose up -d`,
import the generated workflows, and attach your own BigQuery and HubSpot
credentials to the relevant nodes before publishing them. Copy the values from
`connection.env` into `.env.local`. For dbt, load those non-secret variables in
your terminal and use the generated profile:

```bash
set -a
source .runtime/generated/connection.env
set +a
dbt build --project-dir analytics --profiles-dir .runtime/generated/dbt
```

Review every imported n8n node. Templates are inactive and intentionally
contain no credential IDs.

## Production notes

The default public experience is a credential-free static demonstration. It can
audit a visitor-selected CSV inside the browser, but it cannot open `/app`, call
the whole-account scanner, persist decisions, or reach CRM credentials. Those
operator features exist only in the self-hosted application.

Private CRM routes return a configuration error until server-side credentials
are present. In production, account scans and CRM writes also require
`CONTROL_TOWER_SYNC_KEY`. The operator enters the matching value in the
self-hosted UI; it is retained only for the browser tab and sent as a request
header. Use a managed secret store and refreshable OAuth for a long-running
instance; do not bake `.env` files into a build artifact.

Run `npm run doctor` after setup and `npm run check:secrets` before publishing a
fork. For an internet-accessible self-host, put the whole application behind
authentication: workspace keys are capabilities, not user accounts.

Run `npm run smoke:fresh-install` to launch the complete stack with empty
temporary state and random host ports. It verifies credential-free connector
status, persists a workspace across a restart, exercises undo, checks n8n
serialization, and cleans up after itself.
