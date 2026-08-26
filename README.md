# GTM Control Tower

[![CI](https://github.com/harrisonoconnorhover/gtm-control-tower/actions/workflows/ci.yml/badge.svg)](https://github.com/harrisonoconnorhover/gtm-control-tower/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-174b45.svg)](LICENSE)

**[Run the browser-only two-minute demo](https://gtm-control-tower.pages.dev/)** ·
**[Self-host the operator workspace](#quick-start-one-command-no-accounts-required)**

A self-hosted revenue-systems lab that turns deliberately messy CRM data into
governed records, explainable routing, trusted funnel metrics, and receipted
repairs.

It works immediately with a CSV. Teams can then add HubSpot, Salesforce, n8n,
BigQuery, and dbt without putting credentials or organization-specific IDs in
the repository.

## What it does

- Previews any CSV, lets the operator map arbitrary headers, saves reusable
  mapping presets, and diagnoses duplicate
  identity, missing fields, bad email, owner gaps, and lifecycle regression.
- Persists imports, repairs, receipts, and twenty undo snapshots in a local
  SQLite workspace.
- Reads Google Sheets through n8n and writes governed records to a separate
  `GTM Clean` worksheet without requiring BigQuery.
- Executes reviewed merge, reroute, and lifecycle-replay workers and exports the
  repaired state.
- Syncs eligible contacts to HubSpot Contacts or Salesforce Leads with strict
  per-record receipts and bounded batches.
- Routes synthetic leads through n8n, records immutable BigQuery events, and
  models funnel conversion, routing SLA, and data quality with dbt.
- Shows how operational defects change revenue metrics instead of presenting a
  static dashboard.
- Builds the public proof as a static site while keeping the operator workspace
  and self-host diagnostics in the same repository.

## Public demonstration

The Cloudflare Pages site is a static showroom: it runs the deterministic
64-row cleanup entirely in the browser and uses synthetic data only. It does
not accept uploads, store workspaces, run connectors, or expose the operator
application. The working product remains the Docker self-host below.

## Quick start: one command, no accounts required

Requires Docker. This starts the application and a local n8n Community Edition
instance; neither needs a paid account.

```bash
git clone https://github.com/harrisonoconnorhover/gtm-control-tower.git
cd gtm-control-tower
docker compose up --build
```

Open [http://localhost:3000/app](http://localhost:3000/app), choose **CSV file**,
and either load the bundled 64-row practice batch or try
[`public/control-tower-csv-template.csv`](public/control-tower-csv-template.csv).
The workspace survives browser and container restarts in
`.runtime/sqlite/gtm-control-tower.db`. n8n is available at
[http://localhost:5678](http://localhost:5678). Run `docker compose up app` if
you do not want n8n.

The Node.js development path remains available:

```bash
npm ci
npm run dev
```

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
[Google Sheets](docs/google-sheets-setup.md),
[HubSpot](docs/hubspot-csv-setup.md), and
[Salesforce](docs/salesforce-csv-setup.md).

## Safe-by-default boundaries

- The browser never receives CRM, n8n, or Google credentials.
- Unconfigured connectors do not appear as operational choices.
- Every connector follows Preview → Validate → Execute → Receipt → Undo/Export.
- Destination gates hold unresolved duplicates, invalid email, missing company,
  missing owner, and lifecycle regression out of generic writes.
- Public templates contain no credential bindings or private project IDs.
- CRM writes are explicit, allow-listed, standard-field-only, and reconciled by
  native receipt.
- Multiple matching Salesforce Leads fail closed instead of selecting one.
- Production CRM writes remain disabled until `CONTROL_TOWER_SYNC_KEY` is set.
- The synthetic merge keeps source rows queryable and points them to a canonical
  record rather than deleting them.

This repository is a self-hosted reference implementation, not a managed
multi-tenant service. Put any hosted instance behind authentication and HTTPS.

## Development

```bash
npm run doctor
npm run check:secrets
npm test
npm run lint
npm run build
npm run build:public
```

Run `npm run preview:public` to inspect only the static public site locally.

Run `npm run sync:n8n` after changing the state, seed, or repair SQL so the
portable Operations workflow stays in sync.

## Verified integration behavior

The connector paths have been exercised against dedicated development systems
using synthetic data: n8n read a 64-row Google worksheet, all three local repair
classes executed, and 44 governed rows were upserted to `GTM Clean` by
normalized email while 12 unresolved active rows stayed out. Replaying the
same batch left 44 unique rows, and a changed field updated in place. n8n and
BigQuery also executed the three repair classes. Two simultaneous Sheets
webhooks carrying the same unseen email were serialized and produced one row;
HubSpot completed a native contact upsert plus validation-failure proof; and
Salesforce completed query-first create, update, and SOQL read-back against the
same synthetic Lead identity. The public release contains no access tokens,
credential IDs, customer data, or personal CRM record IDs.

See [architecture](docs/architecture.md), [decisions](docs/decisions.md),
[security](SECURITY.md), and [contributing](CONTRIBUTING.md). Licensed under
the [MIT License](LICENSE).
