# Native import-matching check — September 27, 2026

**Result:** the approximate review and exact-email preview passed a read-only
check against the configured HubSpot account and a Salesforce Developer Edition
org. This is dated development evidence, not measured matching accuracy or
production write qualification.

## Method

Between 19:26 and 19:28 UTC, source commit `d7fc0f0` ran the actual CSV parser,
duplicate-scan route, SQLite persistence, import-match route and exact-email
preview route. A temporary Node runner invoked the handlers directly; external
requests used the real provider APIs. The database was disposable and separate
from the working app. The browser was not part of this native check.

The scans read 17 HubSpot Contacts in one page and 130 Salesforce unconverted
Leads and Contacts in two object pages. Both reached provider completion.
Matching cases used 12 existing labeled HubSpot fixtures and seven Salesforce
fixtures from the [documented seed definitions](../scripts/seed_duplicate_audit.mjs).
The seed script was not run and no CRM records were created or changed.

## Observed approximate results

All five matching fields were selected. Every returned candidate in these cases
belonged to the existing fictional fixtures.

| Imported case | Observed result |
| --- | --- |
| Existing Alex identity | Exact-email candidate ranked first at 100/100; the other Alex remained a weaker suggestion |
| Alex with a different email, matching name/phone/company | Two candidates at 47/100, with visible email conflicts; Salesforce included both Lead and Contact through the Contact's secondary mobile phone |
| Jordan Lee, name only | Two coworker candidates at 32/100; no automatic winner |
| Unrelated fictional person | No suggestions in either snapshot |
| HubSpot front-desk phone shared by four records, with no name/email | No suggestions; shared-phone warning |

These are rule scores, including the 100/100 result, **not certainty percentages**.

## Observed exact-email preview

HubSpot proposed an unchanged existing Contact, a one-field update to another
existing Contact, and a create for an absent fictional email. Its batch read
returned HTTP 207 for the mixed found/missing request; the individual read
confirmed the missing email with HTTP 404.

Salesforce held the existing Contact, left the matching unconverted Lead
unchanged, and proposed a create for the absent email. All existing native IDs
agreed with the stored fixture records. These were proposals only: execution
and rollback were not invoked.

The application made seven external read requests: three scan reads and four
identity reads. HubSpot's batch-read endpoint uses POST; it does not create or
update records. The runner allowed only the expected read endpoints.
Salesforce session refresh and organization-type verification were separate CLI
operations. [Redacted results](evidence/import-matching-native-2026-09-27.json)
retain request statuses, scores, field evidence and assertions, without account
identifiers, native record IDs, credentials or contact details.

## Limits and repeat use

Selected fixtures had no populated state or additional HubSpot emails. Those
matching cases remain covered by simulated tests only. Results fit one page per
object, so this run did not exercise native continuation cursors. No native
writes, duplicate-rule enforcement, converted-Lead case, merges or rollback
were tested. Scores have no measured precision, recall or probability calibration.

Use the [approximate review](approximate-import-matches.md) and
[exact-email comparison](import-crm-comparison.md) walkthroughs to repeat in your
own development account. Check current snapshot coverage and permissions; a
missing suggestion does not establish CRM absence. The earlier illustrated
browser walkthroughs remain separate local/simulated evidence.
