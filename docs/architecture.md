# Architecture

```text
Synthetic lead / Salesforce webhook
                  │
                  ▼
       n8n normalization + scoring
            │                 │
            ▼                 ▼
   Salesforce upsert   BigQuery event log
                              │
                              ▼
                   dbt staging + marts + tests
                              │
                              ▼
                  GTM Control Tower dashboard
```

## Data contract

Every CRM event has a stable `event_id`, lead/account identity, lifecycle stage, event time, routing metadata, commercial segment, and quality flags. BigQuery partitions by event date and clusters by stage, segment, and region. dbt deduplicates on `event_id` before producing decision-ready marts.

## Operational path

The n8n workflow accepts a lead signal, normalizes fields, derives score/segment/owner, upserts Salesforce, and appends the event to BigQuery. The workflow is disabled on import so credentials and mappings can be reviewed safely.

The local n8n and BigQuery leg has been validated end to end with a synthetic lead. Salesforce metadata and mappings are prepared, but the Salesforce leg remains intentionally unpublished until OAuth access to the development organization is restored.

## Analytics path

- `fct_funnel`: monthly lead-to-revenue movement by segment and region.
- `fct_routing_sla`: median assignment time, SLA attainment, and breach volume.
- `fct_data_quality`: duplicate, owner, lifecycle, and aggregate quality measures.

## Failure simulations

The web demo models three concrete revenue-system failures: duplicate identity, routing-capacity overload, and impossible lifecycle regression. Each changes the affected metrics and proposes a repair that requires a human click. The UI is a deterministic simulation; the integration artifacts are ready to connect but are not represented as live until credentials and infrastructure are configured.
