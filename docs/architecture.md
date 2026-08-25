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

The dashboard browser never receives Google or n8n credentials. It calls same-origin `/api/control-tower/state`, `/api/control-tower/funky`, and `/api/control-tower/repair` handlers. Those server routes validate request and response contracts before proxying to a separate n8n Operations API workflow.

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

The web demo models three concrete revenue-system failures: duplicate identity, routing-capacity overload, and impossible lifecycle regression. Each proposes an allow-listed worker that requires a human click. The metrics overlay is deterministic; the contact table and its worker results are live BigQuery state queried through n8n.

## Guided demo path

The primary walkthrough uses a ten-record synthetic batch with realistic CRM defects: inconsistent company/domain formatting, exact and plus-address duplicates, a malformed personal email, missing identity and owner, a Unicode domain, ambiguous same-name contacts, and regressive lifecycle writes. Six visible stages explain the path while the adjacent lab exposes the actual records and their mutations.

## Live operations path

The state webhook executes a bounded BigQuery query with a 100 MB billing ceiling, shapes events, funnel measures, contact state, and repair history into a strict dashboard contract, and returns it server-side. The seed webhook replaces only the named synthetic batch. The repair webhook accepts three known scenario keys and executes one parameterized worker: logical duplicate merge, Northeast enterprise reroute, or expected-lifecycle replay. Every run writes a repair receipt and immutable event. The dashboard reports success only after contract validation, then refreshes the changed rows from BigQuery.

The merge is deliberately non-destructive: source rows remain queryable but are marked `merged` and point at the canonical contact. The lab does not mutate live HubSpot or Salesforce records. Public repair access stays disabled until the same-origin mutation routes are authenticated.
