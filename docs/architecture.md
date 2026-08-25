# Architecture

```text
        Synthetic lead / CRM webhook
                  │
                  ▼
       n8n normalization + scoring
             │              │
             ▼              ▼
         HubSpot       BigQuery event log
          upsert              │
                              ▼
                   dbt staging + marts + tests
                              │
                              ▼
                  GTM Control Tower dashboard
```

The dashboard browser never receives Google or n8n credentials. It calls same-origin `/api/control-tower/state`, `/api/control-tower/funky`, and `/api/control-tower/repair` handlers. Those server routes validate request and response contracts before proxying to a separate n8n Operations API workflow.

Users without a warehouse can choose a separate local path:

```text
CSV file → browser parser + field aliases → in-memory contact state
                                              │
                                  merge / reroute / replay
                                      │               │
                              repaired CSV      clean-record gate
                                                        │
                                      HubSpot Contacts  Salesforce Leads
                                         batch upsert   query + create/update
```

No CSV bytes cross a network boundary or persist after a refresh. Explicit destination actions send only allow-listed, governed fields through server-validated batch contracts. The browser produces receipt-shaped local repair records and preserves each CRM's per-record results so the same table shows both boundaries without conflating them.

## Data contract

Every CRM event has a stable `event_id`, lead/account identity, lifecycle stage, event time, routing metadata, commercial segment, and quality flags. BigQuery partitions by event date and clusters by stage, segment, and region. dbt deduplicates on `event_id` before producing decision-ready marts.

## Operational path

The n8n workflow accepts a lead signal, normalizes fields, derives score/segment/owner, upserts HubSpot, and appends the event to BigQuery. The local production webhook has HubSpot and BigQuery live. Its disabled Salesforce node remains an organization-specific custom-field example; the verified Salesforce path is the portable query-first CSV connector shown below.

The n8n and BigQuery leg has been validated end to end with synthetic leads. HubSpot is the validated n8n CRM leg. Salesforce has a separate query-first CSV Lead connector so its required fields and duplicate-email ambiguity can be handled without custom fields. Public workflow templates contain portable placeholders and no credential bindings.

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

The merge is deliberately non-destructive: source rows remain queryable but are marked `merged` and point at the canonical contact. CSV destinations write governed standard fields only after an explicit click. They do not delete or provider-merge records. Production mutation routes require an access key.

## CSV compatibility path

The CSV parser accepts quoted cells and newlines, maps common CRM header aliases, and infers missing email/company/owner, lifecycle regression, Unicode-domain, plus-address, and exact normalized-email duplicate flags. It does not guess fuzzy name/company identity. A user may provide `normalized_email` when aliases are already governed upstream. Imports are capped at 10 MB to keep synchronous browser work bounded.

HubSpot sync uses the current contacts batch-upsert API, email identity, a 100-record request ceiling, and `objectWriteTraceId` for per-record reconciliation. The server can call HubSpot directly with a private-app bearer token or proxy through the included n8n OAuth workflow. Both produce the same strict receipt contract.

Salesforce sync uses a bounded SOQL lookup by normalized email followed by sObject Collection creates and updates. Missing company, missing last name, and emails beyond the standard Lead field limit are held before transmission. Multiple active Lead matches return a failure receipt rather than selecting one. Owner, status, source, score, and custom fields are never guessed.
