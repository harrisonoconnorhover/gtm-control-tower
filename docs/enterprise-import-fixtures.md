# Fictional enterprise event import

This case models a revenue operations specialist reviewing a trade-show attendee
list before updating a CRM. The eight existing records and seven imported rows
include an unchanged attendee, a promotion, a new contact, uncertain identities,
and an intentional field clear. It is a designed exercise, not customer data or
evidence of measured matching accuracy.

All people, roles, contact details, attendance, and business relationships are
fictional. Microsoft, Adobe, Salesforce, ServiceNow, Costco, and Cisco supply
recognizable company context and public website domains; the records do not
describe their employees or imply endorsement. Email addresses use company subdomains of reserved `example.com`
domains (for example, `elena.marquez@microsoft.example.com`), and telephone numbers use the fictional NANP `555-0100`–`555-0199` range.
`fictional_demo_operator` is an import completeness value, not a native CRM owner.

HubSpot rejected `.example` as an invalid email suffix during setup; the accepted
fixture uses subdomains of [IANA-reserved example.com](https://www.iana.org/help/example-domains).

## Files

- [Case definition](../fixtures/enterprise-import-case.json): eight baseline
  people, seven review rows, and five approved rows. Seed all baseline people as
  HubSpot Contacts. In Salesforce, seed Denise as a Contact and the other seven
  as Leads. Description fields identify the case and fictional record key.
- [Review CSV](../public/enterprise-import-review.csv): the complete attendee
  import for inspecting approximate matches. Do not execute this file directly:
  its two uncertain identities require a human decision.
- [Approved CSV](../public/enterprise-import-approved.csv): the same file after
  manually excluding Priya's changed email and the ambiguous Jordan Lee row.
  This is a prepared example of an operator decision, not an automatic matching
  decision or a saved-review feature.

## Expected decisions

These are fixture expectations; this guide alone does not establish that a
native CRM run occurred.

| Import row | Scenario | Expected handling |
| --- | --- | --- |
| Elena Marquez, Microsoft | Same portable fields; `Washington` instead of `WA` | Exact-email preview reports unchanged. Approximate state comparison recognizes the equivalent state. |
| Marcus Bell, Adobe | Promotion and new direct phone | Update only job title and phone on the existing record. |
| Nina Alvarez, ServiceNow | New attendee | Create once; repeat import finds the created record and reports unchanged. |
| Priya Nair, Salesforce | Different email; same name, phone, company, and state | Review the possible existing person and conflicting email; manually exclude from the approved file. |
| Jordan Lee, Cisco | New email, no phone or title; two coworkers have the same name | Review both candidates; manually exclude until identity is resolved. |
| Denise Carter, ServiceNow | Existing person | HubSpot reports unchanged. Salesforce holds the row because the email belongs to a Contact, outside the direct Lead write path. |
| Tess Morgan, Microsoft | Website intentionally blank | Clear the existing website; update rollback should restore it. |

Omar Haddad and both original Jordan Lee records are control records that should
remain unchanged. Priya's original record should also remain unchanged. Tess's
blank website is intentional: empty portable fields request a clear, so ordinary
imports must inspect those changes before execution.

## Demonstration sequence

1. Seed the baseline in designated development accounts and save native IDs
   privately. Import the review CSV into a saved `/app/lab` workspace.
2. Read a complete CRM snapshot and inspect suggestions using name, email,
   phone, state, and company. A score out of 100 ranks evidence; it is not a
   probability or measured certainty. Suggestions do not hold rows or grant
   permission to create them.
3. Import the approved CSV and preview exact-email writes. Confirm each intended
   create, update, unchanged record, and Salesforce Contact hold before execution.
4. Execute, read back the actual CRM records, and repeat the same approved import
   to verify that no additional Nina record is created.
5. Roll back the original update receipt and read back Marcus and Tess. Update
   rollback restores prior fields; it does not delete the newly created Nina.

The app writes portable contact fields only. State and city provide fixture
context; this workflow does not synchronize CRM addresses, assign native owners,
merge people, or convert Leads. See the [exact-email workflow](import-crm-comparison.md)
and [approximate review behavior](approximate-import-matches.md) for boundaries.

## Repeat in your own development accounts

The seeder defaults to a local count/usage report and makes no network calls
without `--seed`. Configure direct CRM credentials in an ignored `.env.local`
using the existing [HubSpot](hubspot-csv-setup.md) and
[Salesforce](salesforce-csv-setup.md) setup guides. Use the same operator key in
that file and your running local app.

```bash
# Preview only; does not connect or write.
node scripts/seed_enterprise_import.mjs

# Native IDs are saved privately under the ignored outputs directory.
GTM_FIXTURE_MANIFEST="$PWD/outputs/enterprise-fixtures-private.json" \
  HUBSPOT_DEVELOPMENT_ACCOUNT_ID=YOUR_DEVELOPMENT_PORTAL_ID \
  node --env-file=.env.local scripts/seed_enterprise_import.mjs hubspot --seed

GTM_FIXTURE_MANIFEST="$PWD/outputs/enterprise-fixtures-private.json" \
  node --env-file=.env.local scripts/seed_enterprise_import.mjs salesforce --seed
```

The Salesforce seeder requires a sandbox or Developer Edition. It supplies the
United States country with state values and sets email/call opt-outs only where
the object exposes those fields. The verified org did not expose those opt-outs;
the records still use reserved email domains and fictional phone numbers.
Existing case-owned records are skipped, never reset. Other records sharing a
fixture email stop setup before new writes.

Salesforce's standard rule blocked the second fictional Jordan Lee during our
setup. To construct this deliberately ambiguous baseline, the explicit environment
option `GTM_ALLOW_AMBIGUOUS_FIXTURE=1` acknowledges the alert **only for the
`jordan_marketing` fixture**. Add it to the Salesforce command only when that
specific setup exception is intended. The manifest records the exception;
application import writes continue to use `allowSave=false`.

For a fresh baseline with eight people and no Nina yet, start a disposable saved
operator workspace and run the native browser check for each provider:

```bash
GTM_FIXTURE_OUTPUT="$PWD/outputs/enterprise-run" \
  CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3000 \
  node --env-file=.env.local scripts/check-enterprise-import.mjs hubspot

GTM_FIXTURE_OUTPUT="$PWD/outputs/enterprise-run" \
  CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3000 \
  node --env-file=.env.local scripts/check-enterprise-import.mjs salesforce
```

These checks **execute native CRM writes and update rollback**. They use installed
Chrome on macOS; set `CHROMIUM_PATH` for a different Chromium executable. Full
snapshots, backup files, run history and browser storage are private output, not
publication assets. Provider responses are not mocked.

The completed development accounts retain nine fictional people each, including
Nina. Running the seeder again preserves them. Reimporting the approved CSV after
rollback proposes the two updates again; Nina is already present, so there is no
new create. The first-run browser check intentionally refuses that state instead
of silently deleting or resetting records to manufacture another first run.
