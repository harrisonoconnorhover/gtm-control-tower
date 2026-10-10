# Native change intake and object coverage

CRM Monitor reads HubSpot Contacts, Companies, and Deals, plus Salesforce unconverted Leads, Contacts, Accounts, and Opportunities. Company/account and deal/opportunity records are read-only. The existing whitespace recipe still only permits HubSpot Contact company/job title, Salesforce Lead Company/Title, and Salesforce Contact Title.

## What the records mean

| Normalized evidence | HubSpot | Salesforce |
| --- | --- | --- |
| `name` | Contact name, Company name, Deal name | Lead/Contact name, Account/Opportunity Name |
| `owner_id` | `hubspot_owner_id` | `OwnerId` |
| `domain` | Company `domain` | Account `Website` (retained as supplied) |
| `stage` | Deal `dealstage`; `pipeline` is retained | Opportunity `StageName` |
| `amount` / `close_date` | Deal `amount` / `closedate` | Opportunity `Amount` / `CloseDate` |
| `company_id` | Contact's primary company property; a Deal's single associated company when unambiguous | Contact/Opportunity `AccountId` |
| `company_ids` / `contact_ids` | JSON arrays from bounded native association reads for Companies and Deals | Opportunity `contact_ids` from native contact roles |

Native custom stage values have no inferred ordering. Salesforce `IsClosed`/`IsWon` are retained. A missing property means **unobserved**, while a present empty value means **observed blank**. Multiple HubSpot company associations remain in `company_ids`; the monitor does not invent a primary relationship. Association reads are limited to 1,000 associations per HubSpot result or fewer than 2,000 Salesforce contact roles per page. Truncation and permission failures produce explicit coverage evidence and omit the incomplete relationship field. They never become an empty list.

Each native source supports an object capability check. Rate limits, server errors, timeouts, malformed metadata, and authentication failures fail the tick without advancing its saved scan position. Only explicit permission/object denials or verified missing required fields exclude an object from that scan. If a previously excluded object becomes readable again, its scope must complete a fresh baseline before coverage can become healthy. Missing fields, denied objects, and failed metadata reads are degraded coverage. An available object does not imply every relationship was readable. Polling continues for readable objects; a failed tick does not advance its cursor. The previous HubSpot Contact cursor and record keys remain compatible. Other object keys include the object type.

## HubSpot webhooks

Configure an app with appropriate CRM read scopes and subscriptions for Contact, Company, and Deal creation, property changes, deletion, restoration, associations, or merges. Set:

```text
HUBSPOT_MONITOR_CLIENT_SECRET=<the HubSpot app client secret>
HUBSPOT_MONITOR_PORTAL_ID=<the same portal connected to CRM Monitor>
HUBSPOT_MONITOR_WEBHOOK_URL=https://your-app.example/api/control-tower/events/hubspot
```

Use that exact URL as the app's subscription target. The receiver requires the v3 signature and a timestamp within five minutes. It signs the raw body using the configured external URL, so proxy Host headers cannot change the signed destination. Legacy signature versions are not accepted. A signed request from a different portal is rejected.

The receiver accepts at most 100 events and 1 MiB per request and acknowledges only after SQLite commits the event hints. Retries are deduplicated using the account, event, subscription, object, timestamp, and changed property; `eventId` alone is not assumed unique. Association-change events use native `fromObjectId`, `toObjectId`, and `associationType` to refresh both supported endpoints. Merge events refresh `newObjectId` when supplied, otherwise the native `primaryObjectId`, and preserve bounded `mergedObjectIds` evidence. A merge also requests a baseline for affected relationships; saved identities and repair authorization are never silently transferred to a survivor. Missing or ambiguous family fields become visible reconciliation gaps instead of causing an unrelated valid event in the batch to be rejected.

Incoming values are retained as bounded reported event evidence, not instructions or proof of an earlier value. This preserves evidence of intermediate values even if a later fresh read sees a subsequent update.

## Salesforce native CDC subscriber

The optional built-in subscriber uses Salesforce's supported Streaming API (CometD/Bayeux long polling), so it receives decoded JSON directly and needs no Avro decoder. Enable Change Data Capture for the objects to monitor and grant the subscriber the necessary object permissions. CDC ignores record sharing; the connected user must have the appropriate View All Records permission. A subscription to the combined channel can succeed while permission restrictions exclude some objects; native polling capability checks remain necessary.

Use the same Salesforce connection as CRM Monitor, plus the receiver settings below:

```text
SALESFORCE_INSTANCE_URL=https://your-org.my.salesforce.com
SALESFORCE_ACCESS_TOKEN=<access token>
SALESFORCE_MONITOR_ORG_ID=<native organization ID>
SALESFORCE_API_VERSION=67.0
CONTROL_TOWER_CDC_RELAY_SECRET=<a random secret of at least 32 characters>
CONTROL_TOWER_CDC_RELAY_URL=https://your-app.example/api/control-tower/events/salesforce
SALESFORCE_CDC_CHANNEL=/data/ChangeEvents
SALESFORCE_CDC_CHECKPOINT_PATH=.runtime/salesforce-cdc/checkpoint.json
```

Start it separately from the regular monitor runner:

```sh
node --env-file-if-exists=.env.local scripts/subscribe-salesforce-cdc.mjs
```

Alternatively, the optional Docker Compose `cdc` profile runs the subscriber against the internal `app:3000` receiver. Enable it with `docker compose --profile monitor --profile cdc up -d`. The helper permits HTTP only for loopback or this exact Compose destination; remote endpoints require HTTPS.

Retain the checkpoint file across restarts and run one subscriber per channel. The subscriber verifies `Organization.Id`, negotiates replay-capable long polling, preserves native cookies, and sends Salesforce credentials only to the configured Salesforce origin. The separately signed receiver requests contain no Salesforce access token or cookie. Redirects are never followed.

A new channel replays available retained history (`-2`). The subscriber then uses the last durably acknowledged native replay ID. It saves each pending envelope before sending, and advances its checkpoint only after Control Tower confirms durable receipt. A lost response causes an exact retry; process restart delivers the saved pending envelope before reconnecting. Transient interruptions back off to 30 seconds. Invalid/expired replay positions produce an explicit coverage gap and restart retained-history replay. Authentication failure, denied subscriptions, corrupted/unwritable checkpoint files, or a conflicting receiver checkpoint stop the subscriber with its state preserved. Replace expired credentials and restart; automatic OAuth refresh is not implemented.

The combined channel is `/data/ChangeEvents`; optional single-object channels are `/data/LeadChangeEvent`, `/data/ContactChangeEvent`, `/data/AccountChangeEvent`, and `/data/OpportunityChangeEvent`. This implementation intentionally supports those four standard entities. Oversized native batches or unsupported entities fail visibly without advancing the saved position; choose the relevant single-object channels if other CDC entities are enabled in the org. Each process/channel needs its own checkpoint file. Keep the regular monitor runner running to consume saved hints and reconcile current state.

## Salesforce Pub/Sub trusted relay alternative

The same receiver also accepts **decoded, ordered CDC envelopes from an existing Pub/Sub subscriber**. For this alternative, supply the subscriber/Avro decoder in the deployment and forward decoded payloads with the included transport:

```sh
node --env-file-if-exists=.env.local scripts/relay-salesforce-cdc.mjs < decoded-cdc.ndjson
```

Server settings:

```text
SALESFORCE_MONITOR_ORG_ID=<the same organization connected to CRM Monitor>
CONTROL_TOWER_CDC_RELAY_SECRET=<a random secret of at least 32 characters>
```

Relay settings use the same secret and:

```text
CONTROL_TOWER_CDC_RELAY_URL=https://your-app.example/api/control-tower/events/salesforce
```

Every line has this shape (synthetic identifiers):

```json
{"organizationId":"00D000000000001","channel":"/data/ChangeEvents","replayId":"opaque-base64-replay-id","previousReplayId":null,"events":[{"ChangeEventHeader":{"entityName":"Opportunity","recordIds":["006000000000001"],"changeType":"UPDATE","transactionKey":"native-transaction-key","sequenceNumber":1,"commitTimestamp":1791205200000,"commitUser":"005000000000001","changeOrigin":"native-change-origin","changedFields":["StageName"]},"StageName":"Discovery"}]}
```

Preserve Pub/Sub replay bytes as base64 strings; do not increment or compare replay IDs numerically. The first accepted envelope uses `previousReplayId: null`. Subsequent envelopes use the last acknowledged ID. The sender emits an acknowledgement only after durable receipt and stops on failure. The upstream subscriber must retain the envelope after a lost response, retry that exact envelope, and persist/resume from the acknowledgement. A checkpoint mismatch returns HTTP 409; inspect the saved checkpoint before resuming. Checkpoints and their record hints commit together, with a compare-and-swap guard against concurrent advancement.

For an expired replay ID or an intentional subscriber reset, send an envelope with `gapReason` describing the gap (an empty `events` array is allowed in that case). Native `GAP_*` events, wildcard IDs, and a restart beyond the documented 72-hour retention window also require reconciliation. A full baseline can reestablish current state; it cannot recreate missing intermediate changes. The receiver retains this limitation as an incident and clears the pending reconciliation flag only after a baseline that began after the gap.

## Processing and limitations

The existing monitor worker processes at most ten native hints per tick under the account lease. Ready events wake an enabled account on the next runner poll (normally within 60 seconds, plus in-flight work and backlog), even when its ordinary interval is longer. Ready backlog continues promptly; held events and delayed retries do not cause a tight loop. Disabled accounts remain paused. Refresh hints trigger a fresh native read and the same observation/incident processing as polling. Attribution records only actor/origin/transaction metadata actually supplied by the provider. Every attached native source is tagged `refresh_trigger_only`: the freshly read state may be newer than the event, so its actor does not establish who caused those current values. Separately queryable event history retains up to 60 reported scalar fields, 1,000 characters per value and 8,000 characters total, with explicit truncation markers. Null fields in a CDC payload are provider-reported values, not proof of a change unless the changed-field metadata establishes that. Processed event evidence is retained for 30 days and at most 10,000 events per account; pending and held events are never removed by retention. A deletion or gap is evidence for investigation, not a fabricated blank record. Native events have no independent repair authority.

A read failure is delayed for one minute and held after three failures, so one inaccessible record cannot starve polling. Operators can explicitly retry held hints after correcting the connection or permissions. Keep periodic polling and daily reconciliation: subscription omissions, deletion details, permissions, and provider retention can limit event coverage.

The receivers, relay, and native subscriber are fixture-tested. Their presence does not mean an app subscription, Salesforce subscriber, or public deployment is configured, nor that a native tenant has been qualified.

## Provider references

- [HubSpot request validation](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation)
- [HubSpot webhook subscriptions](https://developers.hubspot.com/docs/apps/developer-platform/add-features/configure-webhooks)
- [HubSpot merge and association webhook schemas](https://developers.hubspot.com/changelog/new-subscription-types-for-webhooks)
- [HubSpot association batch paging](https://developers.hubspot.com/changelog/bug-fix-batch-read-limit-for-hubspot-associations-api)
- [Salesforce Streaming API connection protocol](https://developer.salesforce.com/docs/platform/api-streaming/guide/using-streaming-api-client-connection.html)
- [Salesforce Streaming API replay](https://developer.salesforce.com/docs/platform/api-streaming/guide/using-streaming-api-durability.html)
- [Salesforce CDC subscriber permissions](https://developer.salesforce.com/docs/platform/change-data-capture/guide/cdc-security-perms.html)
- [Salesforce CDC headers](https://developer.salesforce.com/docs/platform/change-data-capture/guide/cdc-event-fields-header.html)
- [Salesforce event retention and replay](https://developer.salesforce.com/docs/platform/pub-sub-api/guide/event-message-durability.html)
