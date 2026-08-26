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

Open `http://localhost:3000/app`, choose **CSV file**, and load the bundled
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

The default public experience is a credential-free synthetic demo. CRM routes
return a configuration error until server-side credentials are present, and
production writes also require `CONTROL_TOWER_SYNC_KEY`. Use a managed secret
store and refreshable OAuth for a long-running instance; do not bake `.env`
files into a build artifact.

Run `npm run doctor` after setup and `npm run check:secrets` before publishing a
fork. For an internet-accessible self-host, put the whole application behind
authentication: workspace keys are capabilities, not user accounts.

Run `npm run smoke:fresh-install` to launch the complete stack with empty
temporary state and random host ports. It verifies credential-free connector
status, persists a workspace across a restart, exercises undo, checks n8n
serialization, and cleans up after itself.
