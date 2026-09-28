# Confirm an imported row is an existing person

In a saved self-hosted `/app/lab` workspace, review a possible match and choose
**Use this existing record** with a reason. This saves an identity decision; it
does not write to the CRM. The next governed comparison uses the selected native
record ID and the existing field-protection policy.

Supported targets are HubSpot Contacts and unconverted Salesforce Leads.
Salesforce Contacts remain review-only. The CRM's existing email is preserved;
a different email in the import is shown as source data, not written over it.
There is no automatic merge, Lead conversion, or confidence-based approval.

## Try it

1. Load a CSV into a saved workspace and select a direct CRM destination.
2. Open **Find possible CRM matches**, read a complete fresh snapshot, choose
   matching fields and generate suggestions. Review compared values and conflicts.
3. Enter why a particular candidate is the same person and select **Use this
   existing record**. The saved confirmation shows the native ID, existing email,
   reason and time. Reloading keeps it visible without another suggestion search.
4. Choose which fields may change. The default fills empty fields only. To replace
   a populated title, choose replacement and select **Job title**.
5. Select **Compare N with CRM** and inspect the human-confirmed target and field
   differences. Download the comparison CSV or execute the reviewed changes.
6. Inspect the receipt and use update rollback if needed. Rollback locates the
   existing CRM email and native ID, and retains the imported email in the receipt.

A reason records the operator's judgment; it does not prove identity. Scores
remain ranking signals, not probabilities. Leave ambiguous rows held or skip
them with a reason. **Clear confirmed match** removes the choice and requires a
new preview; it does not undo an earlier CRM update.

## When a confirmation stops being usable

- Confirmation requires a complete snapshot started within the last 15 minutes.
  The selected candidate must still be present for the saved source row and
  chosen matching fields, and its current native values must match that snapshot.
- Source identity or portable-field edits hold the row until it is confirmed
  again. Changes to skip status or operational timestamps do not change identity.
- Preview and execution read the native target again. A changed email or portable
  field, missing record, converted Lead, or conflicting exact-email target holds
  the row. A changed preview cannot execute.
- Multiple included active rows selecting the same native target hold their
  writes, including rows in later batches. An included source row using the
  selected target's CRM email also conflicts. Skip or resolve the competing row.
- Decisions are bound to the workspace and connector credential. Editing a saved
  JSON decision or rotating a credential requires a new confirmation. CSV exports
  retain source data, not transferable native-ID approval.

The application checks again before writing but cannot make CRM reads and writes
atomic. Concurrent external changes, separate workspaces, unobserved CRM fields,
and permission-limited records remain boundaries. This workflow does not measure
matching accuracy or guarantee that an operator selected the correct person.

## Native check — September 28, 2026

The actual confirmation and writeback endpoints passed against the retained
fictional records in both designated development accounts. HubSpot STANDARD ran
at 14:09:30–14:09:37 UTC; Salesforce Developer Edition (`IsSandbox=false`) at
14:09:37–14:09:47 UTC. No CRM responses were mocked in this API check.

Each run confirmed changed-email Priya with a saved reason, reloaded the saved
choice, updated only her title by native ID, and left her existing email intact.
Unconfirmed Jordan stayed held. A stale execution attempt returned HTTP 409.
Rollback restored Priya, and all nine retained records matched their starting
compared fields. There were no creates or deletes.

Inspect the [dated results](evidence/confirmed-import-match-native-2026-09-28.json),
[HubSpot results CSV](../public/confirmed-match-hubspot-results.csv), and
[Salesforce results CSV](../public/confirmed-match-salesforce-results.csv). CSV
identifiers are redacted; outcomes and field changes come from the native plan
and receipt. The first harness attempt stopped at scan creation because it
expected HTTP 200 instead of 201; it made no native writes.

## Verification

Focused route tests cover authenticated confirmation, rejected or stale choices,
workspace persistence and decision signatures. Writeback tests cover native-ID
updates, field protection, collisions and rollback. The browser check uses
simulated CRM responses with real local workspace persistence; it is separate
from native API evidence.

Run `node scripts/check-import-match-decision.mjs` against a disposable local app
with persistence enabled to exercise the browser workflow. The native check
below requires the retained fictional records from the [enterprise import case](enterprise-import-fixtures.md),
not a newly seeded or reset account:

```bash
GTM_FIXTURE_MANIFEST=/absolute/private/fixture-manifest.json \
GTM_FIXTURE_OUTPUT=/absolute/private/confirmation-evidence \
CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3000 \
HUBSPOT_DEVELOPMENT_ACCOUNT_ID=YOUR_DEVELOPMENT_PORTAL_ID \
  node --env-file=.env.local scripts/check-confirmed-match-native.mjs hubspot
# Use salesforce for the designated Developer Edition or sandbox org.
```

The app and script must use the same operator key and CRM credentials. The check
verifies ownership markers and restored fixture values, confirms changed-email
Priya, updates only her title, keeps sparse Jordan held, checks email preservation,
rejects a stale replay and rolls back. It makes no creates or deletes. If it stops,
reconcile the private receipts and native records before retrying; it does not
retry mutations or reset data automatically.
