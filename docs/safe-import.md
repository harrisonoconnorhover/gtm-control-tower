# Safe Import: Update existing contacts

The persistent self-hosted `/app/lab` offers a CSV update workflow for HubSpot
Contacts and Salesforce Leads/Contacts. It requires a connected CRM but no AI model.

1. Select **Update existing contacts safely**. Read the visible import rules.
2. Upload a CSV, inspect its existing column mapping, then import it locally.
3. Choose HubSpot or Salesforce and select **Prepare review**. This reads the CRM in batches of at most 100 and
   saves one whole-file proposal. Every source row is proposed, unchanged, held,
   unmatched, skipped, or unresolved. Failed/incomplete lookups block approval.
4. Open a row to inspect current, imported, and proposed values for all six fields.
   Held rows include the existing match-review controls. A candidate is only a
   suggestion; confirmation requires a reason and a freshly read native target.
   Skip an unresolved person or confirm them, then prepare a new review.
5. Select **Approve N contact updates**. The first bounded chunk starts immediately;
   run `npm run monitor` for background continuation, or select **Continue approved queue**.
   Inspect queued, accepted, held and uncertain records separately from verification. Download the whole review as JSON or field decisions as CSV.

Use `fixtures/safe-import-contacts.csv` with your own development fixtures, or
run the simulated acceptance checks described below. The file does not create
CRM fixtures by itself. Source hashes cover the uploaded CSV text; the review
also retains its mapping, saved source rows, workspace revision, target identities,
policy, and before-values. Source content and review evidence stay in local
workspace storage; do not commit customer files or credentials.

## Protected update contract

The saved recipe requires `importRecordMode: "update-existing"`, HubSpot or Salesforce as the
destination, and the six-field `fill-empty` policy with `clearBlanks: false`.
Writable fields for HubSpot Contacts and Salesforce Leads are first name, last name, company, phone, job title, and website.
Salesforce Contacts support first name, last name, phone and title only; company,
website and the Account relationship are out of scope. Reviews show those field decisions explicitly.
Primary email, ownership, lifecycle stage, consent, subscription status, and
external identifiers are outside the write payload.

Populated values remain populated even when the file disagrees. Blank incoming
cells never clear fields. Placeholders such as `N/A` remain preserved and flagged;
invalid incoming phone/website/placeholders are reviewed instead of filled.
The field-decision evidence powers the screen, CSV/JSON export, and deterministic
explanation. JSON retains exact values; CSV neutralizes spreadsheet formulas.

Exact email or a valid saved human confirmation is required to update a target.
Both materially different first and last names (normalized similarity below
0.55) plus a comparable conflicting company or phone hold even an exact email.
Human confirmation resolves that identity decision without replacing primary
email. Approximate matching uses the existing snapshot review and never approves
an update. Known aliases, confirmations, and targets learned in different batches
are checked for competing rows across the whole import.

The general record mode defaults legacy imports to `create-and-update`. The
existing stricter Pomade holds remain. Legacy Salesforce imports remain Lead-only;
Contact updates are enabled only inside the saved Safe Import recipe. Exact-email
lookup checks both objects, holds multiple matches, and rejects converted Leads.

## Approval, recovery, and verification

The browser submits a saved review ID, never a replacement plan. Approval is
stored with the actual HubSpot portal ID or Salesforce `Organization.Id`.
Both approval and readback require the same account. Preparing a HubSpot review
requires account-information read permission (`account-info/v3/details`) as well
as the contact read permissions; execution additionally requires contact writes.
No credential digest is used as an account identity.

Salesforce requires API access, Organization identity lookup and readable Lead/Contact
fields; writes need edit access to the selected object/fields. Configure
`SALESFORCE_INSTANCE_URL`, `SALESFORCE_ACCESS_TOKEN`, and `SALESFORCE_API_VERSION`.
An expired session fails closed. With the existing authenticated CLI org,
`npm run configure:salesforce` refreshes the ignored local environment; restart the
app and runner afterward. Automatic OAuth refresh is not implemented.
Updates use native object IDs and
[`Sforce-Auto-Assign: FALSE`](https://developer.salesforce.com/docs/platform/api-rest/guide/headers-autoassign.html)
to suppress Lead assignment rules. Other organization automation can still run.

Reviews expire after 15 minutes. The server rebuilds the whole comparison before
approval and checks the saved workspace again before each write. It immediately
rereads the target's primary email and all six before-values. Changed identities
or values are held. Writes use native-ID PATCH and the existing field mapper;
there is no create or upsert fallback.

One immutable review has one unique execution key. Its approval and progress
are durable before the first request. Each row is marked `sending` before its
request. A repeated approval returns the same execution, including after reload.
An uncertain response remains **unknown**, never “failed, retry automatically.”
**Reconcile and verify** reads only: it can observe approved values but cannot
prove that an interrupted request was accepted. A continuation processes at most
10 records, stopping between records after 20 seconds. It can claim only unsent
`pending` rows from the same saved approval. A five-minute durable worker lease
and transactional row/header comparison prevent competing workers from claiming
or overwriting the same progress. An expired or released lease turns abandoned
`sending` rows into `unknown`; those writes are never replayed. Pending rows retain
their original approval, with fresh account, workspace and native baseline checks
before every write. Approval expiry is never extended: remaining rows become held
and need a fresh review and approval. One active CRM operation can exceed the
between-record time budget; its existing request timeout still applies.

The runner invokes `POST /api/control-tower/safe-import/worker` with the operator
key independently of scan success. Each request discovers at most one saved
queued execution and processes one chunk; it cannot create an approval. The
interactive equivalent uses `action: "continue"` with workspace/review IDs.
`action: "recover"` reads at most 10 accepted/unknown records and advances a saved
cursor; repeated reconciliation eventually covers the full execution without
writing to the CRM. Duplicate approval clicks only return saved progress.
Saved reviews can be discovered server-side without a browser receipt pointer.

Accepted updates are reread automatically. Verification compares all protected
and changed portable values plus primary email. Different or unavailable results
preserve the write outcome and never reapply a write. Full per-record observed
values and errors remain in the saved execution and JSON download.

CRM reread and PATCH are separate operations: external writers can race between
them. This implementation does not promise atomic overwrite protection or simulate
all downstream CRM automations. There is no automatic rollback in this recipe;
any restoration must be a separate reviewed decision protecting subsequent work.
Historical legacy run verification retains its documented current-connection
boundary; this recipe's review and execution are separately account-bound.

## Capacity limits and retry behavior

Native Safe Import reads and writes share a process-local pacing gate with cohort
and contact reads: at least 250 ms between request starts and at most two requests
in flight for one provider/credential. Existing ten-record chunks remain in place.
This reduces bursts from this app; it does not control another integration's load
or repair a Salesforce flow that cannot handle its own trigger volume.

A definitively rejected 429 or Salesforce `REQUEST_LIMIT_EXCEEDED` stops the
chunk and saves a cooldown with the original approval. No later row is sent during
that cooldown. A temporary read failure before sending also leaves the row
pending. The worker skips that execution until eligible, and the existing monitor
runner respects the next attempt time. The screen shows why it is waiting and
when continuation is available. Saved progress can be loaded during an outage.

After the wait, continuation rereads the account, target identity and before-values,
checks the saved workspace, and checks the original approval deadline again after
pacing. It does not extend approval. Expired unsent rows become held even when the
CRM is unavailable. Permission rejection during a write holds the remaining
unsent queue. Already accepted and unknown outcomes are preserved.

Only requests known not to have been accepted can return to pending. A lost or
5xx write response remains unknown and is reconciled by reading; it is never
sent again automatically. Deliberate suppressions, missing consent, converted
Leads, wrong mappings and changed CRM fields remain business/review issues.
Retries cannot establish eligibility or justify overwriting protected values.

Provider classification follows [HubSpot usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines)
and [Salesforce REST error codes](https://developer.salesforce.com/docs/platform/api-rest/guide/errorcodes.html).
Provider reset times are honored when supplied. A quota response without a reset
time uses a conservative one-hour retry suggestion; it is not a known reset time.

## Storage and verification scope

SQLite self-hosts initialize the new tables locally. D1 installations must apply
`drizzle/0003_safe_import.sql` through the existing migration workflow before
using the recipe. Chunked reviews and per-record execution evidence avoid a
whole-import evidence blob in one database binding. See the separate
[native and D1 qualification report](safe-import-native-check.md) for current
results. Execution now spans bounded invocations. The actual local D1 probe
processes 99 fictional writes across ten invocations and measures the maximum
binding calls per invocation (139 in the October 10 local run). Its 1,000-call simulated budget passes; the 50-call
budget remains unsupported. The probe bypasses real workspace rereads and provider
requests, so neither that measurement nor passing storage tests qualifies hosted
execution or whole-file preparation limits. No remote or hosted qualification
was performed for this continuation change.

```bash
npm test -- tests/safe-import-route.test.ts tests/safe-import-review-server.test.ts tests/safe-import-execution.test.ts tests/crm-account.test.ts tests/import-assistant.test.ts
CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3021 node scripts/check-safe-import.mjs
SAFE_IMPORT_PROVIDER=salesforce CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3021 node scripts/check-safe-import.mjs
```

The 106-row route fixture uses simulated HubSpot and real temporary SQLite:
99 fills, one unchanged contact, four identity holds, one unmatched row, and one
skipped row. It tests batch boundaries, no preparation writes, preserved titles
and websites, suspicious values, identity contradictions, duplicate targets,
changed CRM/source/account evidence, interrupted responses, repeat requests,
and operation without a model. Execution tests also cover expiry, failed durable
transitions, concurrent claims, large evidence storage, and verification differences.
Browser checks use simulated CRM responses and real workspace persistence.
The separate opt-in native runner uses existing synthetic development contacts
and reviewed restoration. No deployment, downstream-effect, or production-scale
proof is claimed by the simulated acceptance checks.

On October 10, 2026 a read-only Salesforce preparation check verified Organization
identity and one existing Lead plus one Contact: two unchanged rows, complete saved
review, eight GET requests, zero CRM writes. Salesforce fills and uncertain outcomes
were tested with fictional API responses and real temporary SQLite, not native writes.
