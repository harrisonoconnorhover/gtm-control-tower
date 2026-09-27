# Native import-matching check — September 27, 2026

**Later native evidence:** the [enterprise import case](enterprise-import-native-check.md)
verified creates, updates, unchanged records, an existing Salesforce Contact hold,
repeat imports, and update rollback in development accounts on September 27, 2026.
Those runs used advisory approximate review. The current [governed direct
preview](import-crm-comparison.md#approximate-create-holds) also holds proposed
creates with possible matches; the [native follow-up](enterprise-import-native-check.md#follow-up-control-tower-holds-possible-duplicates) verifies those holds in both CRMs.
The dated read-only results below retain their original scope.

**Result:** the approximate review and exact-email preview passed a read-only
check against the configured HubSpot account and a Salesforce Developer Edition
org. This is dated development evidence, not measured matching accuracy or
production write qualification.

## Method

Between 19:26 and 19:28 UTC, source commit `d7fc0f0` ran the actual CSV parser,
duplicate-scan route, SQLite persistence, import-match route and exact-email
preview route. A temporary Node runner invoked the handlers directly; external
requests used the real provider APIs. The database was disposable and separate
from the working app. The browser was not part of this initial handler check; the later browser run below exercises the complete local app path.

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

## Browser follow-up — 20:09 UTC

A fresh local Vite/Cloudflare runtime with isolated D1 storage ran the complete
browser flow against both native providers: CSV import, authenticated scan,
displayed suggestions, JSON export and exact-email preview. No provider responses
were mocked in this run. It reproduced the 17/130 record counts and expected
fixture suggestions above; the existing Salesforce Contact was held in the
rendered preview. No CRM writes were requested.

Browser qualification exposed two defects that the earlier Node-only check missed;
the successful run above includes both fixes:

- The top operator-key field maintained separate state from matching and preview.
  A valid key entered there still produced HTTP 401. All workspace controls now
  share the dashboard's current key; entry, reverse updates, clearing, reload and
  invalid-key rejection passed browser checks.
- The local worker rejected `redirect: 'error'` before sending a request. Scan
  readers and Salesforce exact-email reads now use manual redirects and reject
  non-success responses. Focused tests retain redirect rejection.

A separate imported row derived from an accessible existing Salesforce record
verified populated state-name/code equivalence through the same screen. Its
personal values are excluded from published evidence. Desktop and 390px checks
found no browser exceptions or horizontal overflow. The initial illustrated
walkthrough still shows local fictional records, not this native run.

The [credential-free operator-key regression](duplicate-audit.md#operator-access-key)
passed for both providers with 21 intercepted private requests and zero native
CRM requests. It checks the repaired UI separately from native-provider qualification.

## Limits and repeat use

The initial synthetic fixtures had no populated state or additional HubSpot
emails. The follow-up verifies Salesforce state equivalence, while populated
HubSpot state and additional-email cases remain covered by simulated tests only. Results fit one page per
object, so this run did not exercise native continuation cursors. No native
writes, duplicate-rule enforcement, converted-Lead case, merges or rollback
were tested. Scores have no measured precision, recall or probability calibration.

Use the [approximate review](approximate-import-matches.md) and
[exact-email comparison](import-crm-comparison.md) walkthroughs to repeat in your
own development account. Check current snapshot coverage and permissions; a
missing suggestion does not establish CRM absence. The earlier illustrated browser walkthroughs remain separate local/simulated
evidence; the dated browser follow-up above adds native read verification.
