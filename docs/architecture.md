# Architecture

```text
        Synthetic lead / CRM webhook
                  │
                  ▼
       n8n normalization + scoring
          │          │          │
          ▼          ▼          ▼
      HubSpot   Salesforce   BigQuery event log
       upsert    upsert            │
                                  ▼
                       dbt staging + marts + tests
                                  │
                                  ▼
                      GTM Control Tower dashboard
```

The dashboard browser never receives Google or n8n credentials. It calls same-origin `/api/control-tower/state` and `/api/control-tower/repair` handlers. Those server routes validate both request and response contracts before proxying to a separate n8n Operations API workflow.

## Data contract

Every CRM event has a stable `event_id`, lead/account identity, lifecycle stage, event time, routing metadata, commercial segment, and quality flags. BigQuery partitions by event date and clusters by stage, segment, and region. dbt deduplicates on `event_id` before producing decision-ready marts.

## Operational path

The n8n workflow accepts a lead signal, normalizes fields, derives score/segment/owner, fans out to HubSpot and Salesforce, and appends the event to BigQuery. The local production webhook is published with HubSpot and BigQuery live. The Salesforce node is disabled until its development organization is recovered and its mapping can be reviewed safely.

The local n8n and BigQuery leg has been validated end to end with a synthetic lead. Salesforce metadata and mappings are prepared, but the Salesforce leg remains intentionally unpublished until OAuth access to the development organization is restored.

## Analytics path

- `fct_funnel`: monthly lead-to-revenue movement by segment and region.
- `fct_routing_sla`: median assignment time, SLA attainment, and breach volume.
- `fct_data_quality`: duplicate, owner, lifecycle, and aggregate quality measures.

## Failure simulations

The web demo models three concrete revenue-system failures: duplicate identity, routing-capacity overload, and impossible lifecycle regression. Each changes the affected metrics and proposes a repair that requires a human click. The UI is a deterministic simulation; the integration artifacts are ready to connect but are not represented as live until credentials and infrastructure are configured.

## Guided demo path

The primary walkthrough uses an eight-record synthetic batch with realistic CRM defects: inconsistent company/domain formatting, duplicate account identity, a missing company, a blank owner, and a regressive lifecycle write. Six visible stages reveal when enrichment, routing, validation, modeling, and diagnosis become available. The UI intentionally distinguishes its deterministic replay from the validated live HubSpot → n8n → BigQuery path.

## Live operations path

The state webhook executes a bounded 30-day BigQuery query with a 100 MB billing ceiling, shapes the result into a strict dashboard contract, and returns current event, routing, quality, and funnel measures. The repair webhook accepts only three known scenario keys, maps each to a named action, writes an immutable approval event, and returns a receipt. The dashboard changes repaired state only after validating that receipt, then refreshes from BigQuery. Action executors for account merge, routing-capacity mutation, and event replay remain separate future workers.
