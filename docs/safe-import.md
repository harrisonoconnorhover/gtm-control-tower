# Safe Import: Update existing contacts

The persistent self-hosted `/app/lab` offers a named CSV-to-HubSpot Contact
workflow. It runs without any AI model, account, or Anthropic dependency.

1. Select **Update existing contacts safely**. Read the visible import rules.
2. Upload a CSV, inspect its existing column mapping, then import it locally.
3. Select **Prepare review**. This reads HubSpot in batches of at most 100 and
   saves one whole-file proposal. Every source row is proposed, unchanged, held,
   unmatched, skipped, or unresolved. Failed/incomplete lookups block approval.
4. Open a row to inspect current, imported, and proposed values for all six fields.
   Held rows include the existing match-review controls. A candidate is only a
   suggestion; confirmation requires a reason and a freshly read native target.
   Skip an unresolved person or confirm them, then prepare a new review.
5. Select **Approve N contact updates**. Inspect execution and verification
   separately. Download the whole review as JSON or field decisions as CSV.

Use `fixtures/safe-import-contacts.csv` with your own development fixtures, or
run the simulated acceptance checks described below. The file does not create
CRM fixtures by itself. Source hashes cover the uploaded CSV text; the review
also retains its mapping, saved source rows, workspace revision, target identities,
policy, and before-values. Source content and review evidence stay in local
workspace storage; do not commit customer files or credentials.

## Protected update contract

The saved recipe requires `importRecordMode: "update-existing"`, HubSpot as the
destination, and the six-field `fill-empty` policy with `clearBlanks: false`.
Writable fields are first name, last name, company, phone, job title, and website.
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
existing stricter Pomade holds remain. Salesforce's existing Lead workflow is
preserved; this recipe does not write Salesforce Contacts.

## Approval, recovery, and verification

The browser submits a saved review ID, never a replacement plan. Approval is
stored with the actual HubSpot portal ID returned by the account-information
API. Both approval and readback require the same account. Preparing a review
requires account-information read permission (`account-info/v3/details`) as well
as the contact read permissions; execution additionally requires contact writes.
No credential digest is used as an account identity.

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
prove that an interrupted request was accepted. Unsent interrupted rows are held
for a new review; interrupted writes are never resumed or resent automatically.
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

## Storage and verification scope

SQLite self-hosts initialize the new tables locally. D1 installations must apply
`drizzle/0003_safe_import.sql` through the existing migration workflow before
using the recipe. Chunked reviews and per-record execution evidence avoid a
whole-import evidence blob in one database binding. D1 execution and native
HubSpot behavior have not been qualified by these local tests.

```bash
npm test -- tests/safe-import-route.test.ts tests/safe-import-review-server.test.ts tests/safe-import-execution.test.ts tests/crm-account.test.ts tests/import-assistant.test.ts
CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3021 node scripts/check-safe-import.mjs
```

The 106-row route fixture uses simulated HubSpot and real temporary SQLite:
99 fills, one unchanged contact, four identity holds, one unmatched row, and one
skipped row. It tests batch boundaries, no preparation writes, preserved titles
and websites, suspicious values, identity contradictions, duplicate targets,
changed CRM/source/account evidence, interrupted responses, repeat requests,
and operation without a model. Execution tests also cover expiry, failed durable
transitions, concurrent claims, large evidence storage, and verification differences.
Browser checks use simulated CRM responses and real workspace persistence.
No native CRM writes, deployment, downstream-effect, or production-scale proof is
claimed for this implementation.
