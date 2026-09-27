# Compare an imported file with your CRM

**Later native evidence:** the [enterprise import case](enterprise-import-native-check.md)
verified creates, updates, unchanged records, an existing Salesforce Contact hold,
repeat imports, and update rollback in development accounts on September 27, 2026.
That original run used advisory approximate review. The [native follow-up](enterprise-import-native-check.md#follow-up-control-tower-holds-possible-duplicates) verified the current create guard against both development CRMs; earlier evidence retains its original scope.

In the self-hosted `/app/lab`, **Compare N with CRM** reads current records for
the eligible imported rows before proposing writes. It requires a direct
HubSpot or Salesforce connection. The public static demo performs no CRM reads
or writes. This is an imported-file comparison, not a native merge tool or a
whole-account duplicate scan.

For name, phone, state, company, or approximate email evidence, use the separate
[possible-match review](approximate-import-matches.md). It ranks candidates from
a dated snapshot and exports review JSON; it never selects a write target.
The governed direct preview independently uses all five fields to hold unsafe
creates. Updates and unchanged decisions still require exact-email identity.

## Decisions you can inspect

| Current CRM result for an imported email | HubSpot | Salesforce |
| --- | --- | --- |
| No exact match; fresh complete snapshot and other active import rows have no approximate candidates or search cap | Propose Contact create | Propose Lead create |
| No exact match, but any approximate candidate is returned | Hold create for review | Hold create for review |
| Another active row in the saved import is a possible match, even in a later batch | Hold create for review | Hold create for review |
| Proposed create lacks a fresh complete snapshot, or candidate search is capped | Hold create | Hold create |
| One exact Contact primary or additional email match | Compare portable fields using its native ID; preserve primary email | Hold a Contact match |
| One unconverted Lead, with no other match | Not applicable | Compare portable fields using its native ID |
| Converted Lead | Not applicable | Hold |
| Multiple matching records | Hold | Hold |
| Multiple imported rows target one native record | Hold affected rows | Hold affected rows |
| Matched fields already agree | Unchanged; no write | Unchanged; no write |
| Failed, malformed, or incomplete lookup | Stop comparison | Stop comparison |

Across batches in the current workspace session, the destination summary retains
each row's latest result: created, updated, unchanged, held or failed. Completed
rows stay out of subsequent batches; held and failed rows remain pending. A new
import, local correction, repair, undo or reset clears this progress so the changed
input is compared again. Reload also requires a fresh comparison; saved run
receipts remain available under `/runs`.

Local eligibility checks still apply. The comparison shows matched native IDs,
field differences, and reasons for holds. It does not use fuzzy names or company
similarity to join different, unlinked emails. HubSpot's
[additional email identifiers](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide#additional-emails)
can link an imported secondary email to an existing Contact; the update uses
that Contact's ID and does not replace its primary email.

## Approximate create holds

The latest snapshot for the same workspace and CRM must be complete and
provider-complete (`sourceComplete`), with its scan started within 15 minutes.
Missing, stale, or partial snapshots hold would-be creates. A capped candidate
search also holds them. The server uses the saved import's effective destination
name, state, and all five matching fields, independently of exploratory review checkboxes.
Any returned candidate holds a create, including low-scoring same-name coworkers.

The same guard compares each proposed create against the other active rows in
the full saved import, including rows outside the current 100-row request.
For example, two new rows for Priya Nair with different emails but matching phone
and company are held even when neither appears in the CRM snapshot. The app
shows the other import row's ID, email, score and evidence separately from native
CRM matches. It does not choose a winning row. A row never matches itself, and
rows already merged locally are excluded. Shared-phone weights and search limits
count the other rows only.

Correct or remove unresolved import rows, refresh the snapshot when needed, and
refresh the preview. There is no override, automatic linking, or merge. Holds
can be false positives. An empty candidate list does not prove absence. Snapshot
visibility and changes after the scan limit coverage. Exact-email updates, unchanged
records, and existing Salesforce Contact holds retain their existing behavior.
The import comparison covers the current saved workspace, not other uploaded
files or simultaneous imports in other workspaces. Conflicting or sparse identities
can still evade these matching rules.

Name comparison uses the first and last names that the destination mapper will
actually write. If a CSV also supplies a conflicting full-name column, that
display value cannot silently substitute a different person in the create check.
The exploratory review follows the same name precedence for eligible rows.

## When receipt storage fails

A returned CRM outcome and a saved local receipt are separate results. If run
history cannot confirm a save, completed rows stay completed and the app retains
the full receipt and rollback backup on the current page. **Retry receipt save**
sends that same receipt to local storage only; it never repeats the CRM operation.
**Download receipt** preserves the pending payload as JSON. Keep the page open
until saving succeeds or download the receipt before leaving. Pending recovery
does not survive navigation or reload by itself.

The same handling applies to update rollback. A completed rollback remains
completed while its receipt awaits storage. A failed workspace-summary save is
reported separately from a successful detailed run-history save. These behaviors
are checked with simulated CRM responses and real local persistence; they do not
claim recovery when no CRM response reaches the app.

## Try with your own development CRM

1. Start the [self-hosted workspace](../README.md#quick-start-one-command-no-accounts-required),
   then configure a direct [HubSpot](hubspot-csv-setup.md#option-a-account-service-key)
   or [Salesforce](salesforce-csv-setup.md#local-connection) connection. Use a
   development account and clearly labeled synthetic records.
2. Save the following as `crm-comparison.csv` and import it in `/app/lab`:

   ```csv
   contact_id,full_name,email,company,region,segment,lifecycle_stage,expected_lifecycle_stage,owner_id
   REVIEW-001,Alex Example,existing@comparison.example,Comparison Example,Northeast,Enterprise,lead,lead,NE-ENT
   REVIEW-002,Blair Example,new@comparison.example,Comparison Example,Northeast,Enterprise,lead,lead,NE-ENT
   REVIEW-003,Casey Example,alias@comparison.example,Comparison Example,Northeast,Enterprise,lead,lead,NE-ENT
   ```

3. To exercise matches, first add synthetic CRM records with selected emails
   from the file. For HubSpot, make `alias@comparison.example` an additional
   email on the same Contact as `existing@comparison.example`: both imported
   rows should be held because they target one Contact. For Salesforce, use
   an unconverted Lead for one email and a Contact for another. Leave the new
   email absent. Results depend on the CRM records you actually create.
4. Select HubSpot or Salesforce under **Where should clean records go?**, then
   read a fresh complete snapshot under **Find possible CRM matches**. Choose
   **Compare N with CRM** and inspect the proposed creates, updates,
   unchanged rows, and holds. Comparison itself does not write to the CRM.
   Execute only after reviewing the changes. `/runs` records outcomes and
   eligible update rollback; newly created records are not auto-deleted.

## Execution boundaries

While a CRM comparison or sync is running, workspace controls pause until its
result and receipt saving finish. This keeps imports, reset, undo, CRM switching
and comparison refresh from replacing the input of a pending request. Controls
also wait for an existing workspace save or repair; errors release them for retry.

Plans expire after 15 minutes. Execution rereads the relevant CRM records and
rejects a changed comparison; invalid or incomplete reads cannot prove absence.
The server rechecks the approximate create guard before writing. Its snapshot
requirement does not replace exact-email reads or prove absence. Read visibility
is limited to the configured credentials.

Direct HubSpot creates use the native create operation, including the legacy
direct sync route. A create conflict fails instead of falling back to an update.
Salesforce writes set `allowSave=false` in the
[duplicate-rule header](https://developer.salesforce.com/docs/platform/api-rest/guide/headers-duplicaterules.html),
so configured duplicate rules are not bypassed. A reread and write are separate
operations: neither connector guarantees atomic protection against external
writers.

The existing HubSpot n8n workflow remains a delegated email upsert, without this
comparison promise. The approximate create guard applies only to the governed
`/api/control-tower/crm-writeback` path, not legacy direct-sync or webhook routes.
The disabled Salesforce n8n node is unchanged. No path here merges native CRM
records or converts Leads.

## Verification

The within-import guard is covered separately by local automated tests. Route
tests use simulated provider reads to check both connectors: changed-email
duplicates with an empty CRM, a matching row outside the requested batch, and
an import identity added or changed after preview. The latter requires a fresh
preview before execution. These tests do not establish additional native CRM
qualification.

To repeat the presentation check against a disposable local app:

```bash
CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3000 npm run test:import-holds
```

It imports two fictional Priya Nair rows and one unrelated Nina Alvarez row,
supplies simulated CRM plans and receipts, and checks both connectors' held-row
evidence, a single approved create, local receipt persistence, pending rows and
mobile layout. The server tests exercise the actual matching logic; this browser
check exercises its presentation and workflow.

![Synthetic Salesforce import comparison showing an existing Lead, a new email and a held Contact](screenshots/import-crm-comparison.png)

This local browser capture uses the three-row CSV above and simulated CRM
responses. The CSV import and local persistence ran in the app; the displayed
CRM IDs are fictional. Desktop and 390px browser checks covered matched IDs,
hold reasons, backup download, stale-execution errors and HubSpot alias holds.

The comparison and reader tests use mocked provider responses and synthetic
records, including aliases, cross-object matches, partial reads, stale plans,
and create conflicts:

```bash
npm test -- tests/crm-import-comparison.test.ts tests/crm-existing-hubspot.test.ts tests/crm-existing-salesforce.test.ts
```

A separate [September 27 native read check](import-matching-native-check.md)
verified exact-email preview proposals against existing fictional HubSpot and
Salesforce records: unchanged/update/create proposals, and a held Salesforce
Contact. A later browser follow-up verified rendered native previews after fixing
shared operator-key state and a local worker fetch incompatibility. No proposed
change was executed. Live write execution, duplicate-rule
behavior, converted Leads and additional-email cases remain unqualified by that
run. Historical Salesforce receipts elsewhere describe a separate workflow;
neither those receipts nor these development reads establish behavior under
your account's permissions or duplicate rules.

## Repeat the batch-progress browser check

With a disposable local app running and an installed Chrome/Chromium browser:

```bash
CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3000 \
CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
npm run test:crm-batches
```

This regression imports 105 fictional contacts and supplies simulated CRM
receipts for both providers. It checks that completed rows stay completed across
batches, a successful retry replaces a failure, unchanged rows are not reported
as updates, held rows remain pending, and a replacement import clears progress.
It also pauses comparison, execution and run-history saving to verify that
workspace controls stay disabled, then checks recovery from a failed comparison.
Only local workspace and run-history storage reach the app; private CRM responses
are intercepted and external requests are blocked. This is browser regression
evidence, not native CRM write qualification.

## Repeat the receipt-storage failure check

Run `npm run test:receipt-recovery` with the same local-app URL and Chromium
settings above. For both providers, it simulates a returned CRM success followed
by an HTTP error and a network failure while saving the receipt. It checks the
downloaded backup, unchanged CRM execution count during storage retries, durable
read-back after recovery, rollback receipt recovery, and a separately failed
workspace-summary save. CRM responses are simulated; workspace and run-history
persistence are real. The September 27 check passed with zero live CRM requests.
