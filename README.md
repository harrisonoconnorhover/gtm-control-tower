# GTM Control Tower

A portfolio-grade revenue systems lab that shows how a GTM engineer can turn messy CRM activity into fast routing, tested metrics, and safe operational decisions.

The browser demo is intentionally self-contained and uses synthetic data. The repository also includes deployable building blocks for Salesforce, n8n, BigQuery, and dbt—without credentials or customer data.

## What it demonstrates

- Salesforce as the operational system of record.
- n8n scoring, segmentation, routing, idempotent upsert, and warehouse delivery.
- BigQuery as an append-only CRM event warehouse.
- dbt models for funnel conversion, routing SLA, and data quality.
- A responsive decision dashboard with three interactive failure simulations and a human-approved repair flow.

## Try the dashboard

```bash
npm install
npm run dev
```

Open the printed local URL. Click **Trigger chaos mode** to cycle through duplicate-account pressure, routing overload, and lifecycle regression. Click **Approve repair & replay** to restore the baseline.

## Generate synthetic CRM data

```bash
npm run generate:data
# Or: python3 scripts/generate_synthetic_crm.py --count 5000 --output data/crm_events.csv
```

The output is deterministic for a given seed and ignored by Git.

## Connect the real tools

1. Run [`warehouse/bigquery/setup.sql`](warehouse/bigquery/setup.sql) after replacing `YOUR_PROJECT`.
2. Import [`integrations/n8n/lead-routing-workflow.json`](integrations/n8n/lead-routing-workflow.json) into n8n.
3. Attach your own Salesforce and BigQuery credentials in n8n. No secrets are stored here.
4. Copy `analytics/profiles.yml.example` to your local dbt profiles directory, set the two Google Cloud variables in `.env.example`, and run `dbt build --project-dir analytics`.
5. POST [`fixtures/lead-signal.json`](fixtures/lead-signal.json) to the n8n webhook and inspect the Salesforce lead, raw BigQuery event, dbt marts, and dashboard.

n8n node parameters can vary slightly by installed version; review the Salesforce and BigQuery nodes after import before activating the workflow.

## Portfolio demo script

1. Explain the lineage: **Salesforce → n8n → BigQuery → dbt → decision layer**.
2. Show the healthy route-time SLA, data-quality score, funnel, and audit trail.
3. Trigger a failure and explain the revenue consequence—not merely the technical symptom.
4. Approve the recommended repair and describe how an immutable event log makes replay safe.

**Résumé-ready bullet:** Built a synthetic GTM control tower spanning Salesforce, n8n, BigQuery, dbt, and a decision dashboard; modeled funnel and routing SLAs, added data-quality tests, and designed human-approved recovery for duplicate, capacity, and lifecycle failures.

See [`docs/architecture.md`](docs/architecture.md) for system design and [`HANDOFF.md`](HANDOFF.md) for current status.
