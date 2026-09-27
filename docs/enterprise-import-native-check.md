# Native enterprise import check — September 27, 2026

GTM Control Tower completed the fictional event-import workflow through its
browser interface against the configured development CRMs. The HubSpot run took
place at **21:24:03–21:24:14 UTC**; Salesforce at **21:28:49–21:29:03 UTC**.
Snapshot reads, exact-email previews, execution, repeat imports, and update
rollback used real provider APIs. No CRM responses were mocked.

HubSpot was a designated development portal with account type `STANDARD`.
Salesforce was `Developer Edition`, with `IsSandbox=false`. These were
development accounts, not formally provisioned sandbox accounts or production
customer work. Account identifiers and native record IDs are excluded here and
masked in the published screenshots.

## Case and operator decision

The [fixture definition and CSVs](enterprise-import-fixtures.md) model eight
existing people and seven event attendees. All people, roles, contact details,
and attendance are invented. Recognizable company names and real websites
provide context; there is no employee-data or company-endorsement claim.
HubSpot rejected the original `.example` email domains, so the final records use
company subdomains of reserved `example.com` and fictional `555-01xx` phones.

Both CRMs produced a **72/100** suggestion for Priya's changed-email row and
**28/100** for each of two Jordan Lee coworkers. Elena's `Washington` import
matched the baseline `WA` state. These are deterministic evidence scores, not
probabilities or measured matching accuracy.

The operator manually excluded Priya and the unresolved Jordan row. Approximate
suggestions did not hold them automatically. The resulting five-row approved
file entered the exact-email write path.

## Observed results

| Stage | HubSpot | Salesforce |
| --- | --- | --- |
| Initial execution | 1 created, 2 updated, 2 unchanged | 1 created, 2 updated, 1 unchanged, 1 held |
| Same approved file repeated | 5 unchanged; 0 created or updated | 4 unchanged, 1 held; 0 created or updated |
| Original updates rolled back | 2 restored; 0 failed or held | 2 restored; 0 failed or held |

Initial execution and repeat had zero failures. Salesforce held Denise because
her email belonged to an existing Contact, outside the direct Lead write path.
HubSpot found her Contact unchanged.

Independent provider read-back verified the changes to Marcus's title and phone,
Tess's website clear and subsequent restoration, and exactly one newly created
Nina per CRM. Each case grew from eight baseline records to nine; rollback kept
Nina. Control records and existing owners remained unchanged. Run receipts were
saved with HTTP `201` and retrieved successfully from the run API.

## Duplicate-rule behavior and limits

Salesforce blocked the second same-name Jordan during fixture setup. Creating
that intended coworker required a **one-record** duplicate-alert acknowledgement
with `allowSave=true`. Application writes retained `allowSave=false`; the fixture
exception was not a change to application behavior or organization-wide rules.

A separate application probe nevertheless created a sparse Jordan row with a
new email and no phone. Only that probe's returned record was soft-deleted, and
zero active matches were verified afterward. The configured rule therefore did
not catch every plausible duplicate. Human review remains necessary; this check
does not establish a general duplicate-prevention guarantee.

This is a small fictional workflow check, not an accuracy benchmark. The import writeback does not synchronize state or
city. Update rollback does not delete created records. No native
merge or Lead conversion was exercised; other CRM configurations and concurrent
external edits remain outside the demonstrated cases.

See the [machine-readable evidence](evidence/enterprise-import-native-2026-09-27.json)
and [illustrated walkthrough](../public/enterprise-import-walkthrough.html).

## Native rejection and a small receipt fix

A separate deliberate probe submitted Priya's changed email with her matching name,
phone, company and title through the app. At 21:35:53 UTC, Salesforce rejected it
with `DUPLICATES_DETECTED`: zero creates, one failed row, zero native records at
the proposed email. The failed receipt was saved and read back from run history.
This is a separate negative test, not part of the five-row approved import.

The native composite response uses `statusCode`, while the app previously kept
only the vague message “Use one of these records?”. Execution and rollback
receipts now retain that code with the message. A regression uses the actual
response shape; 216 tests, lint and TypeScript checks passed after the fix.

Salesforce documents the [duplicate-rule header](https://developer.salesforce.com/docs/platform/api-rest/guide/headers-duplicaterules.html);
its behavior depends on the configured matching rule and supplied fields. The
strong and sparse probes demonstrate that boundary instead of promising universal
duplicate prevention.
