# Verify a saved CRM write

A provider's successful response and the values stored in its CRM are separate
evidence. In a configured self-hosted workspace, open **Sync Runs** (`/runs`) and
select **Verify CRM results** on a saved governed import. The check reads each
successfully created or updated native record and saves its observed values beside
the original plan and receipt. **Recheck CRM results** repeats only those reads.

The result for each eligible row is:

- **Verified:** primary email and all six portable fields match the saved plan.
- **Values differ:** the record was read, but one or more values differ. Inspect
  expected versus actual values before deciding what to do.
- **Couldn’t verify:** the target is missing, inaccessible, converted, unsupported,
  or lacks enough saved evidence for a reliable comparison. Read failures are
  retained individually, so one unavailable row does not hide the other results.

The original created/updated outcome stays unchanged. A failed read never puts a
successful row back into the import queue and never causes a new write. Held,
failed and unchanged rows are not counted as verified writes. Older receipts
without a saved governed plan do not offer this check.
Older runs whose execution receipt used a different plan ID also remain
unavailable for verification; the application does not relabel their history.
New executions retain the reviewed preview's ID after revalidating CRM values.

## What is compared

The expected state is the approved plan's first name, last name, company, phone,
job title and website, including existing values the field policy preserved.
Updates also check the existing CRM primary email; creates check the imported
email. A human-confirmed changed-email match therefore checks the **existing**
address, not the incoming alternate address.

Email comparisons ignore case. Other fields compare trimmed text, with blanks
and nulls equivalent. Formatting changes can appear as differences; there is no
fuzzy value comparison or matching probability. Additional email addresses,
ownership, state, city, activity history and other CRM properties are outside
this verification's field scope.
The current CRM readers require a valid primary email, so a cleared or malformed
email reports **Couldn’t verify**, rather than a value difference.

Verification uses the current direct HubSpot or Salesforce connection and its
operator key. Keep that connection pointed at the original account: historical
runs do not capture a separately verified account identity. Salesforce Contacts
and converted Leads remain outside this write/verification workflow.

## Saved evidence and limits

Run history keeps the latest check, including per-record timestamps, expected
and observed values, differences and errors. **Download results CSV** includes
these alongside the original outcome; **Export evidence** includes the complete
saved JSON. An unsuccessful recheck/save leaves the previous saved check intact.
The verification request supplies only the saved workspace and run IDs; targets
and expected values come from that run's plan and receipt.

This is an on-demand observation, not continuous monitoring or an atomic
transaction. CRM automation or another user may change values before or after
the read. A difference does not establish what caused it. For example, rolling
back an update deliberately makes the record differ from that original update's
planned result. Verification does not undo, repair or retry anything.

## Qualification

On September 28, 2026, the actual verification endpoint passed against both
designated development CRMs: HubSpot STANDARD at 15:03:51–15:04:02 UTC and
Salesforce Developer Edition (`IsSandbox=false`) at 15:04:02–15:04:15 UTC. Each
verified Priya's title update and preserved primary email, persisted the result,
and rechecked without a write. After deliberate rollback, the latest check
reported one title difference while leaving the original successful receipt
unchanged. All nine retained records in each CRM matched their starting compared
fields. No creates or deletes were made.

The initial HubSpot attempt exposed the old preview/receipt ID mismatch after
the update. Verification refused that mismatched evidence. Its saved rollback
restored the title, and independent reads confirmed all nine records before the
corrected run. Both-provider regression tests reproduce the mismatch and pass
with the correction.

Inspect the [dated native results](evidence/crm-run-verification-native-2026-09-28.json),
[HubSpot CSV](../public/hubspot-run-verification-results.csv), and
[Salesforce CSV](../public/salesforce-run-verification-results.csv). The CSVs are
downloaded from real saved run history after rollback; identifiers are redacted.
Their deliberate difference is not a claim of failed CRM execution.

The focused tests exercise field differences, preserved email, missing records,
read failures, unsupported targets and persistence. The browser regression uses
simulated verification responses with real local run storage:

```bash
CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3000 npm run test:run-verification
```

The retained-fixture native check is `scripts/check-confirmed-match-native.mjs`;
see [its account and fixture prerequisites](confirmed-import-matches.md#verification).
It verifies an actual title update, rechecks without writing, restores that
update through rollback, then observes the deliberate difference without
reapplying the change. The prior confirmation evidence retains its original date
and scope; it predates the product verification action.
