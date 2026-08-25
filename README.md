# GTM Control Tower

[![CI](https://github.com/harrisonoconnorhover/gtm-control-tower/actions/workflows/ci.yml/badge.svg)](https://github.com/harrisonoconnorhover/gtm-control-tower/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-174b45.svg)](LICENSE)

A self-hosted revenue-systems lab that turns deliberately messy CRM data into
governed records, explainable routing, trusted funnel metrics, and receipted
repairs.

It works immediately with a CSV. Teams can then add HubSpot, Salesforce, n8n,
BigQuery, and dbt without putting credentials or organization-specific IDs in
the repository.

## What it does

- Imports a CSV locally, recognizes common CRM headers, and diagnoses duplicate
  identity, missing fields, bad email, owner gaps, and lifecycle regression.
- Executes reviewed merge, reroute, and lifecycle-replay workers and exports the
  repaired state.
- Syncs eligible contacts to HubSpot Contacts or Salesforce Leads with strict
  per-record receipts and bounded batches.
- Routes synthetic leads through n8n, records immutable BigQuery events, and
  models funnel conversion, routing SLA, and data quality with dbt.
- Shows how operational defects change revenue metrics instead of presenting a
  static dashboard.

## Quick start: no accounts required

Requires Node.js 22.13 or newer.

```bash
git clone https://github.com/harrisonoconnorhover/gtm-control-tower.git
cd gtm-control-tower
npm ci
npm run setup
npm run dev
```

Open the printed URL, choose **Import your CSV**, and try
[`public/control-tower-csv-template.csv`](public/control-tower-csv-template.csv).
CSV contents and repairs stay in browser memory until you explicitly export or
sync governed records.

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
[HubSpot](docs/hubspot-csv-setup.md), and
[Salesforce](docs/salesforce-csv-setup.md).

## Safe-by-default boundaries

- The browser never receives CRM, n8n, or Google credentials.
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
```

Run `npm run sync:n8n` after changing the state, seed, or repair SQL so the
portable Operations workflow stays in sync.

## Verified integration behavior

The connector paths have been exercised against dedicated development systems
using synthetic data: n8n and BigQuery executed the three repair classes;
HubSpot completed a native contact upsert plus validation-failure proof; and
Salesforce completed query-first create, update, and SOQL read-back against the
same synthetic Lead identity. The public release contains no access tokens,
credential IDs, customer data, or personal CRM record IDs.

See [architecture](docs/architecture.md), [decisions](docs/decisions.md),
[security](SECURITY.md), and [contributing](CONTRIBUTING.md). Licensed under
the [MIT License](LICENSE).
