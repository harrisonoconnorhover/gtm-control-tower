# Optional Pomade handoff

Pomade can export selected contact proposals as a JSON file. Control Tower loads
that file for independent review, preserving its source rows and research context.
The handoff permits **updates to existing CRM people only**. It is not a CRM write
plan, a confirmed identity, or permission to create a new record.

Both products still work independently. Control Tower's ordinary CSV workflow
keeps its existing governed create/update behavior. Pomade needs no live connection
to Control Tower to prepare a handoff, and its separate direct CRM actions remain
separate. Local and private hosted Pomade installations can export files without
sharing accounts, sessions, or databases with Control Tower.

## Try the file workflow

1. In Pomade, select the intended contact rows, choose **Prepare CRM handoff**,
   review the portable field mappings and destination, and download the preview
   plan. Select at most 100 rows; larger selections must be reduced, never silently
   truncated. Exporting the handoff does not run research or write to a CRM.
2. Open a persistent self-hosted Control Tower workspace at `/app/lab`. With
   **CSV file** selected as the source, choose **Import Pomade handoff**. No Pomade
   account, connector, or reachable service is required.
3. Inspect the complete file preview: proposed contacts, missing-field checks,
   source-review exclusions, destination hint, and **updates only** scope. Expand
   **Pomade source context** for the original values, table/row references,
   mappings, and any supplied evidence. Previewing does not change the active
   workspace or query a CRM.
4. Choose **Load in new saved workspace**. The previous workspace remains saved;
   the new one becomes active only after its save succeeds. This requires working
   workspace persistence. Loading is not approval to write.
5. Configure a direct HubSpot or Salesforce connector, resolve source-review and
   data-quality issues, and use the existing field policy and **Compare with CRM**
   workflow. Unmatched handoff rows are held with **This handoff permits
   existing-record updates only**. Review ambiguous identities through the normal
   [match review and confirmation controls](confirmed-import-matches.md).
6. Inspect the proposed field changes before explicit execution. Open `/runs` for
   the receipt, [read-only verification](crm-run-verification.md), results CSV,
   and eligible update rollback. Rollback changes CRM fields; it does not edit
   the source Pomade table.

The public portfolio site documents this workflow. It cannot save workspaces or
load a handoff into the operator application. Use the
[self-hosted setup](../README.md#quick-start-one-command-no-accounts-required)
for the actual controls.

## Download a small fictional example

[`pomade-handoff-example.json`](../public/pomade-handoff-example.json) contains
four manually prepared proposals: three named contacts and one incomplete
**Review** row. All people and companies are fictional, and email addresses use
reserved `example.com`. The sample includes no research citations or native CRM
IDs. Its **Ready** labels demonstrate source status, not factual accuracy.

The sample does not seed your CRM or assert that any contact already exists.
Actual comparison results depend on your connected account. If none of its people
match an existing record, they remain held under the updates-only scope.

## What survives review

- Original proposed values and source installation, table, row, export, and
  revision references remain attached to the imported row. A legacy file labels
  missing metadata as unknown.
- Supplied URLs, quotes, observed values, references, and timestamps remain source
  claims. Matching a source value does not prove it is correct. If current values
  change, the original evidence is historical context, not proof of the edit.
- Known upstream Review, error, or stale statuses use the existing import
  exclusion controls. Their reasons stay visible until an operator resolves the
  issue and explicitly restores the row. Missing citations alone do not impose a
  universal hold on manually supplied data.
- Corrections, reloads, and local duplicate repair retain contributing origins.
  Batch comparisons, saved results, and relevant rollback receipts retain source
  context; results CSVs label it separately from CRM outcomes. Origin metadata
  is not sent as CRM contact fields.

The ordinary field protection rules still apply: fill empty fields by default,
replace only selected fields, and clear blanks only when explicitly permitted.
HubSpot Contacts and unconverted Salesforce Leads are supported update targets.
Salesforce Contacts remain review-only. Delegated legacy sync is unavailable for
Pomade rows because it lacks this reviewed updates-only path.

## File boundary and limitations

Version 1 files identify `source: "pomade"`, `mode: "preview"`, an export ID/time,
source installation and table, mapped proposals, and `allowCreate: false`.
Control Tower accepts 1–100 rows within a 2 MB file limit. It validates the entire
package before returning any rows: malformed data, unknown versions, duplicate
source row IDs, excess rows, or unsupported control fields fail without a partial
load. Missing names, emails, and companies stay missing.

Existing unversioned preview files use a narrow compatibility reader. Export time,
installation, revision, row status, and evidence are unknown; their identities
belong to that loaded import. Version 1 identities distinguish source installations.
Neither format automatically appends, merges, or replays a repeated file.
An upstream `externalKey` is context only, never a trusted CRM target or an
identity-check bypass.

This is a one-way file handoff. There is no shared runtime, automatic send, ongoing
two-way sync, or automatic merge. The sample and source-status labels do not
establish research accuracy. The earlier native import and verification evidence
retains its own dated scope.

## Dated qualification

On September 28, 2026, the actual Pomade `createControlTowerHandoff` exporter helper
and Control Tower APIs passed a separate check against both designated development
CRMs: HubSpot STANDARD at 16:53:37–16:53:45 UTC and Salesforce Developer Edition
(`IsSandbox=false`) at 16:53:45–16:53:55 UTC. These were manually supplied fictional
proposals, with no enrichment calls or invented research receipts.

Each provider held one unmatched row and one upstream Review row. Fill-empty
preserved populated values. An explicitly selected title update to Priya verified
while preserving her primary email and unselected fields. Source origins and the
verification survived reload; a stale execution replay was rejected. Rollback
restored the title, and all nine retained records matched their starting compared
fields. A read-only recheck then reported the deliberate title difference while
preserving the original successful receipt. There were **zero creates and zero
deletes**.

Inspect the [dated native result summary](evidence/pomade-handoff-native-2026-09-28.json).
This exporter/API qualification is separate from the
[browser regression](../scripts/check-pomade-handoff.mjs), which uses simulated CRM
responses with real local persistence. It is not a claim of research accuracy, a
test of a deployed Pomade installation, or native execution of the four-row public
sample above.

Implementation: [parser and origin model](../lib/pomade-handoff.ts),
[compatibility and preservation tests](../tests/pomade-handoff.test.ts), and
[CSV evidence tests](../tests/crm-review-export.test.ts).
