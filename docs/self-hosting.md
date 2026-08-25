# Self-hosting

GTM Control Tower works at three levels. Start with CSV-only mode, then add only
the connectors you actually use.

## 1. CSV-only dashboard

Requirements: Node.js 22.13 or newer.

```bash
git clone https://github.com/harrisonoconnorhover/gtm-control-tower.git
cd gtm-control-tower
npm ci
npm run setup
npm run dev
```

Open the printed URL, choose **Import your CSV**, and use the included
[`control-tower-csv-template.csv`](../public/control-tower-csv-template.csv).
Parsing and repairs stay in browser memory. Export the repaired CSV before
refreshing if you want to keep it.

## 2. Add HubSpot or Salesforce

Copy `.env.example` to `.env.local`, then configure only the destination you
need. Use [HubSpot setup](hubspot-csv-setup.md) or
[Salesforce setup](salesforce-csv-setup.md). Credentials are read only by
server routes and `.env.local` is ignored by Git.

For any internet-accessible deployment, set `CONTROL_TOWER_SYNC_KEY`, use
HTTPS, and put the entire application behind authentication. The repository
does not provide multi-tenant identity or secret storage.

## 3. Add BigQuery, n8n, and dbt

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
fork.
