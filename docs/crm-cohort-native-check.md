# Development HubSpot roundtrip — October 15, 2026

The full Control Tower → Pomade → Control Tower loop passed using three newly
created fictional cases in the actual development HubSpot account. CRM reads,
linked notes, application persistence and the helper extraction were real.
This qualifies this small development-system test, not customer data quality,
production reliability or outreach eligibility.

## Approved records and outcomes

The user authorized three clearly labeled closed-lost deals, each with a new
contact and note. All use `GTMCT-CRM-ROUNDTRIP-20261015` and explicit test labels;
the pipeline is `default`, stage `closedlost`, and close date October 15, 2026.
No email, phone, website or job title was populated on the contacts. Each note
links to its own contact and deal; no existing record was used for a link.

| Case | Retained development deal | Expected and actual title outcome |
| --- | --- | --- |
| TEST Rowan Supported 20261015 | [Supported case](https://app.hubspot.com/contacts/synthetic-contact-001/record/0-3/synthetic-contact-002) | Supported: Revenue Operations Director |
| TEST Quinn Conflict 20261015 | [Conflicting case](https://app.hubspot.com/contacts/synthetic-contact-001/record/0-3/synthetic-contact-003) | Conflicting: two equally undated titles |
| TEST Taylor Missing 20261015 | [Missing case](https://app.hubspot.com/contacts/synthetic-contact-001/record/0-3/synthetic-contact-004) | Not found: title not recorded |

Creation issued exactly nine successful requests: three contacts, three deals
and three notes. The private setup ledger records pending operations before
submission, retains returned IDs, and refuses to replay an uncertain create.
Running setup again created zero additional objects. Associations were supplied
on creation using IDs read from live HubSpot metadata, following the
[deal](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/guide)
and [note](https://developers.hubspot.com/docs/api-reference/legacy/crm/activities/notes/guide)
APIs. No update or delete request was issued.

## Roundtrip and retry results

The actual browser exported a native request, imported it into a separate saved
Pomade table, submitted one context-only extraction, downloaded its result, and
returned it to Control Tower for a fresh HubSpot comparison and saved review.
The helper used `purpose: plan` with `browser: false`. Original CRM values in
Pomade remained unchanged through reload.

| Check | Observed result |
| --- | --- |
| Native cohort | Exactly the three expected contacts with linked notes |
| Preview retry | Two attempts, one successful native preview and one workspace |
| Extraction submission / actual model execution | One / one |
| Reload, Stop/Resume and status retry | Four status checks, all using one saved job |
| Concurrent claim / claim after completion | Both returned no additional job |
| Repeated completion acknowledgement | Accepted twice; one completed queue entry |
| First result return | One fresh native comparison and one saved review |
| Repeated identical result return | Zero additional comparisons, reviews or saves |
| Source fields and associations after the run | Unchanged on all nine new objects |
| CRM updates during roundtrip / messages sent | Zero / zero |

Three transient failures were deliberately injected: a server-side 429 before
a HubSpot metadata request, a browser-side 503 before cohort preview, and a 429
on a known-job status check. Successful responses came from the real services.
The shared CRM transport logged 52 successful read requests and zero actual
provider errors during the roundtrip. Setup and verification reads are additional.
This demonstrates recovery from the injected failures; it does not establish
that HubSpot itself throttled this run.

The queue contained one completed research request and no recipe/workbook runs.
An independent helper counter recorded exactly one successful `codex exec`.
Desktop/mobile browser checks passed with no page errors or horizontal overflow
at 390px; screenshots were inspected. Node syntax, focused ESLint and diff checks
passed. Product runtime code was unchanged; earlier unit/build checks remain
dated historical evidence rather than checks rerun today.

All three contacts remained **held for review**. Inactivity meaning was not
confirmed, exclusions were not mapped, and no verified email was supplied.
Supported extraction is not permission to update a title or contact anyone.

## Preservation and limits

The before/after comparison found no changes to source fields or associations.
HubSpot's `hs_lastmodifieddate` metadata advanced on the three deals between
17:12 and 17:13 UTC, before extraction began at 17:15 UTC. The source of those
metadata changes was not established; the snapshots are not byte-identical.
No PATCH, PUT or DELETE was sent to HubSpot. Existing records received no writes
or new associations from this test; a whole-account comparison was not performed.

The test records remain in HubSpot for inspection. Isolated servers on ports
3217, 8896 and 9877 were stopped, temporary runtime credentials removed, and the
test databases retained privately. No existing app was restarted or deployed.

## Evidence and repeating the probe

Private ignored artifacts are under `outputs/crm-cohort-native-2026-10-15/` in
each repository. Control Tower retains the fixture manifest, setup ledger,
before/after snapshots, preservation report, request/result/review JSON,
browser report, screenshots and SQLite database. Pomade retains helper counters,
the companion receipt, queue evidence and its SQLite backup. These artifacts
must stay outside version control.

The checked-in browser probe is `scripts/check-crm-cohort-native.mjs`. It does
not create CRM records or start services. To repeat, provision isolated local
apps with the existing read-only CRM transport guard and companion worker,
reuse the approved fixture manifest, and supply private runtime JSON files:

```sh
CRM_NATIVE_OUTPUT=/private/path/to/new-run \
CRM_NATIVE_FIXTURE_MANIFEST=/private/path/to/fixture-manifest.json \
CONTROL_TOWER_RUNTIME_JSON=/private/path/to/tower-runtime.json \
POMADE_RUNTIME_JSON=/private/path/to/pomade-runtime.json \
node scripts/check-crm-cohort-native.mjs
```

Control Tower runtime JSON needs `origin` and `operatorKey`; Pomade needs
`appURL` and `ownerToken`. The original runtime keys were removed after the run.
The probe only allows localhost and the approved development portal, checks
the selected native IDs, and blocks unrelated browser API actions. A repeat
uses a new local workspace/table and requests a new actual extraction; it is
not a status-only replay of this completed test. The server guard, seeding
ledger and helper counter were private test setup, not new product features.
