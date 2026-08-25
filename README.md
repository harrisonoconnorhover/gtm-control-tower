# GTM Control Tower

A portfolio-grade revenue systems lab that shows how a GTM engineer can turn messy CRM activity into fast routing, tested metrics, and safe operational decisions.

The browser demo is intentionally self-contained and uses synthetic data. The repository also includes deployable building blocks for Salesforce, n8n, BigQuery, and dbt—without credentials or customer data.

## What it demonstrates

- Salesforce as the operational system of record.
- n8n scoring, segmentation, routing, idempotent upsert, and warehouse delivery.
- BigQuery as an append-only CRM event warehouse.
- dbt models for funnel conversion, routing SLA, and data quality.
- A server-side operations API that reads current warehouse truth through n8n without exposing BigQuery credentials to the browser.
- Allow-listed repair approvals that produce native n8n receipts and immutable BigQuery audit events.
- A guided six-stage walkthrough that visibly ingests, enriches, routes, tests, models, and diagnoses a deliberately messy lead batch.
- A responsive decision dashboard with three interactive failure simulations and a human-approved repair flow.

## Try the dashboard

```bash
npm install
npm run dev
```

Start n8n with `docker compose up -d`, then open the printed dashboard URL. The live warehouse strip and healthy-state funnel query BigQuery through n8n every 30 seconds. Click **Run messy lead batch** to watch eight flawed records move from raw CRM input to governed action. Use **Test another failure** to cycle through duplicate-account pressure, routing overload, and lifecycle regression, then **Approve repair workflow** to send an allow-listed approval through n8n and record its receipt in BigQuery.

## Generate synthetic CRM data

```bash
npm run generate:data
# Or: python3 scripts/generate_synthetic_crm.py --count 5000 --output data/crm_events.csv
```

The output is deterministic for a given seed and ignored by Git.

## Connect the real tools

1. Start the private local n8n instance with `docker compose up -d`, then open `http://localhost:5678` and create its local owner login.
2. Run [`warehouse/bigquery/setup.sql`](warehouse/bigquery/setup.sql) after replacing `YOUR_PROJECT`.
3. Import [`integrations/n8n/lead-routing-workflow.json`](integrations/n8n/lead-routing-workflow.json) and [`integrations/n8n/control-tower-ops-workflow.json`](integrations/n8n/control-tower-ops-workflow.json) into n8n.
4. Attach your own Salesforce and BigQuery credentials in n8n. No credentials are stored in Git.
5. Copy `analytics/profiles.yml.example` to your local dbt profiles directory, set the Google Cloud variables in `.env.example`, and run `dbt build --project-dir analytics`.
6. POST [`fixtures/lead-signal.json`](fixtures/lead-signal.json) to the n8n webhook and inspect the Salesforce lead, raw BigQuery event, dbt marts, and dashboard.

n8n node parameters can vary slightly by installed version; review the Salesforce and BigQuery nodes after import before activating the workflow.

## Live connector validation

The local development stack has been exercised against a dedicated BigQuery project with synthetic events. Its production lead webhook is published locally with HubSpot as the live CRM adapter and Salesforce staged as a disabled parallel adapter. The operations workflow now powers a real dashboard snapshot and repair-approval endpoint. A validated repair request crossed the same-origin dashboard API, ran successfully in n8n, appended an audit event to BigQuery, and appeared in the next live snapshot. The repair workflow currently records the approved action and receipt; it does not yet merge CRM accounts, change capacity rules, or replay production events. Salesforce remains disabled until its development organization is recovered and OAuth is attached.

## Production boundary

The browser calls same-origin route handlers; only those server handlers know the n8n webhook URLs. Local development defaults to `localhost:5678`. Production has no default connector and safely shows the demo fallback until hosted HTTPS webhook URLs are configured. Put authentication in front of the repair route before enabling it on a public deployment.

## Portfolio demo script

1. Start with **Run messy lead batch**: eight flawed records arrive with duplicates, inconsistent formatting, missing identity, and an impossible lifecycle change.
2. Follow the six controls as n8n normalizes, enriches, scores, and routes; BigQuery preserves the event history; and dbt tests and rebuilds the funnel.
3. Compare the raw and governed record, then show how bad writes are contained instead of silently corrupting metrics.
4. Explain the revenue consequence—not merely the technical symptom—then approve the recommended repair. Show the native n8n receipt and refreshed BigQuery repair event; distinguish this approval record from a future destructive merge/replay worker.
5. Close on the integration boundary: HubSpot, n8n, BigQuery, and dbt are validated; the dashboard uses deterministic synthetic data; Salesforce is built but awaiting account recovery.

**Résumé-ready bullet:** Built a dual-CRM GTM control tower spanning HubSpot, Salesforce, n8n, BigQuery, dbt, and a decision dashboard; implemented live HubSpot upserts and warehouse logging, modeled funnel and routing SLAs, and designed human-approved recovery for duplicate, capacity, and lifecycle failures.

See [`docs/architecture.md`](docs/architecture.md) for system design and [`HANDOFF.md`](HANDOFF.md) for current status.
