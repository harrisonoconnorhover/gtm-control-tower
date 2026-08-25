# GTM Control Tower

A portfolio-grade revenue systems lab that shows how a GTM engineer can turn messy CRM activity into fast routing, tested metrics, and safe operational decisions.

The browser demo is intentionally self-contained and uses synthetic data. The repository also includes deployable building blocks for Salesforce, n8n, BigQuery, and dbt—without credentials or customer data.

## What it demonstrates

- Salesforce Leads and HubSpot Contacts as independently selectable CRM destinations.
- n8n scoring, segmentation, routing, idempotent upsert, and warehouse delivery.
- BigQuery as an append-only CRM event warehouse.
- dbt models for funnel conversion, routing SLA, and data quality.
- A server-side operations API that reads current warehouse truth through n8n without exposing BigQuery credentials to the browser.
- Allow-listed merge, reroute, and lifecycle-replay workers that mutate synthetic CRM state and produce native n8n receipts plus immutable BigQuery audit events.
- A no-warehouse CSV mode that imports, diagnoses, repairs, exports, and explicitly syncs governed contacts to HubSpot and/or Salesforce.
- A guided six-stage walkthrough that visibly ingests, enriches, routes, tests, models, and diagnoses a deliberately messy lead batch.
- A responsive decision dashboard with three interactive failure simulations and a human-approved repair flow.

## Try the dashboard

```bash
npm install
npm run dev
```

Start n8n with `docker compose up -d`, then open the printed dashboard URL. The live warehouse strip and healthy-state funnel query BigQuery through n8n every 30 seconds. Click **Run messy lead batch** to reset ten synthetic CRM rows and watch them move from raw input to governed action. Execute the merge worker, then use **Test another failure** to run the reroute and lifecycle-replay workers. The contact table refreshes from BigQuery after every valid n8n receipt.

CSV analysis needs no n8n or warehouse. HubSpot supports a private-app token or the included n8n OAuth workflow. Salesforce uses a server-side access token and instance URL.

## Use a CSV instead of BigQuery

Click **Import your CSV** in the contact lab. The file is parsed locally and never uploaded. Common headers such as `id`, `name`, `email`, `company`, `region`, `segment`, `stage`, and `owner` are recognized automatically. The local workers can then:

- mark duplicate rows as merged while preserving their canonical contact pointer;
- reroute active Northeast enterprise rows to the overflow owner;
- restore rows whose lifecycle stage is behind `expected_lifecycle_stage`;
- export the complete repaired state as a new CSV;
- explicitly sync clean active contacts to HubSpot Contacts and/or Salesforce Leads in receipt-verified batches of 100.

Use the included [CSV template](public/control-tower-csv-template.csv) for the full recommended schema. Automatic merging uses exact normalized email identity. A provided `normalized_email` may deliberately connect aliases; plus-addresses are flagged but are not silently merged. See [CSV to HubSpot setup](docs/hubspot-csv-setup.md) and [CSV to Salesforce setup](docs/salesforce-csv-setup.md) for connector details.

## Generate synthetic CRM data

```bash
npm run generate:data
# Or: python3 scripts/generate_synthetic_crm.py --count 5000 --output data/crm_events.csv
```

The output is deterministic for a given seed and ignored by Git.

## Connect the real tools

1. Start the private local n8n instance with `docker compose up -d`, then open `http://localhost:5678` and create its local owner login.
2. Run [`warehouse/bigquery/setup.sql`](warehouse/bigquery/setup.sql) after replacing `YOUR_PROJECT`.
3. Import [`integrations/n8n/lead-routing-workflow.json`](integrations/n8n/lead-routing-workflow.json), [`integrations/n8n/control-tower-ops-workflow.json`](integrations/n8n/control-tower-ops-workflow.json), and [`integrations/n8n/csv-hubspot-sync-workflow.json`](integrations/n8n/csv-hubspot-sync-workflow.json) into n8n.
4. Attach your BigQuery and HubSpot credentials in n8n, then follow [CSV to Salesforce setup](docs/salesforce-csv-setup.md) for the portable query-first Lead path. No credentials are stored in Git.
5. Copy `analytics/profiles.yml.example` to your local dbt profiles directory, set the Google Cloud variables in `.env.example`, and run `dbt build --project-dir analytics`.
6. POST [`fixtures/lead-signal.json`](fixtures/lead-signal.json) to the n8n webhook, then inspect the HubSpot contact, raw BigQuery event, dbt marts, and dashboard. Import a CSV to demonstrate the independent Salesforce destination.

n8n node parameters can vary slightly by installed version; review every credentialed node after import before activating a workflow. The disabled Salesforce fan-out node is an organization-specific custom-field example; the verified CSV connector does not depend on it.

Run `npm run sync:n8n` after changing either SQL worker; it deterministically embeds the current SQL and response contracts in the Operations API workflow.

## Live connector validation

The local development stack has been exercised against a dedicated BigQuery project with synthetic events and mutable synthetic CRM state. Its production lead webhook is published locally with HubSpot as the live n8n CRM adapter. In one cumulative warehouse run, n8n merged two duplicate rows, rerouted five active Northeast enterprise rows, and replayed one lifecycle regression. The CSV path completed a live HubSpot upsert and native validation-failure proof. Salesforce access is restored and API v67.0 metadata confirmed the portable field limits. The query-first connector created synthetic Lead `00Qg5000007ulRdEAI`, then updated that same ID on the second call; a native SOQL read returned exactly one record with the changed value.

## Production boundary

The browser calls same-origin route handlers; only those server handlers know CRM or n8n credentials. CSV bytes remain local until an explicit destination action; that request sends only governed standard fields, never the original file. Production CRM sync is disabled unless `CONTROL_TOWER_SYNC_KEY` is configured. Imported workspace state still clears on refresh unless the repaired CSV was exported.

## Portfolio demo script

1. Start with **Run messy lead batch**: ten flawed records arrive with duplicates, inconsistent formatting, plus-addressing, missing identity, Unicode, and impossible lifecycle changes.
2. Follow the six controls as n8n normalizes, enriches, scores, and routes; BigQuery preserves the event history; and dbt tests and rebuilds the funnel.
3. Compare the raw and governed record, then show how bad writes are contained instead of silently corrupting metrics.
4. Explain the revenue consequence—not merely the technical symptom—then execute the merge, reroute, or replay worker. Show the native n8n receipt, affected-row count, and refreshed contact state.
5. Close on the integration boundary: HubSpot, Salesforce, n8n, BigQuery, and dbt are present; the dashboard uses deterministic synthetic data and keeps each provider write separately controlled and receipted.

**Résumé-ready bullet:** Built a dual-CRM GTM control tower spanning HubSpot, Salesforce, n8n, BigQuery, dbt, and a decision dashboard; implemented governed query-first CRM sync, warehouse logging, funnel and routing-SLA models, and receipt-verified workers for duplicate merge, capacity rerouting, and lifecycle replay.

See [`docs/architecture.md`](docs/architecture.md) for system design and [`HANDOFF.md`](HANDOFF.md) for current status.
