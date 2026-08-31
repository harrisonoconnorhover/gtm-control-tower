# Salesforce setup

The Control Tower can run without BigQuery. `/app` scans unconverted Salesforce
Leads and Contacts for duplicate people. `/app/lab` parses and diagnoses CSV
data and can write governed rows to Salesforce Leads. Only allow-listed standard
Lead fields cross the network boundary during that separate write workflow.

## Lead mapping and gate

| CSV value | Salesforce Lead field |
| --- | --- |
| `email` / `normalized_email` | `Email` |
| `first_name` | `FirstName` |
| `last_name` | `LastName` |
| `company` | `Company` |
| `phone` | `Phone` |
| `job_title` | `Title` |
| `website` | `Website` |

Merged rows, malformed or overlong emails, unresolved duplicates, lifecycle regressions, missing company, and missing last name are held back. Salesforce requires `Company` and `LastName` on Leads. Owner, status, source, score, lifecycle, and custom fields are not written because those values are organization-specific.

The connector does a bounded SOQL lookup before every write:

- no active Lead with the email: create one;
- exactly one active Lead: update its portable fields;
- more than one active Lead: return a held failure instead of guessing.

## Local connection

1. Authorize Salesforce CLI with `sf org login web --alias gtm-control-tower-salesforce --set-default`.
2. Run `npm run configure:salesforce`. It reads the current CLI session into ignored, owner-readable `.env.local` without printing the access token.
3. Restart the dashboard. Import a CSV or read a bounded active-Lead sample,
   resolve held rows, preview the exact field diff, then execute the plan.

## Whole-account Lead and Contact audit

Open `/app` after the direct Salesforce connector passes its read test. The
scanner follows `nextRecordsUrl` through every unconverted Lead and then
every Contact visible to the configured user. For Contacts, Account name and
website supply company context. Both `Phone` and `MobilePhone` are considered
when available.

Every provider page and next cursor is committed to SQLite/D1, so the scan can
pause after a page and resume later. The ceiling is 25,000 unique provider
records on local SQLite and 10,000 on D1. Use
`CONTROL_TOWER_MAX_SCAN_RECORDS` to choose a lower value of at least 100. A scan
that reaches the ceiling before Salesforce pagination ends is explicitly
labeled partial.

The identity rules are deterministic and display supporting and conflicting
email, phone, name, company, and domain evidence. A candidate that combines a
Lead and Contact is capped at **needs review** even if its evidence would
otherwise be high confidence. It carries a blocker explaining that conversion
or manual cleanup is required. The Contact is always the recommended survivor
in that cross-object group, and the field-recovery plan retains both primary
and mobile phone values.

If a saved Salesforce `nextRecordsUrl` expires during a long pause, **Start
over** retires the incomplete traversal and begins again from the first Lead
page. A zero-candidate result is labeled clean only after provider pagination
actually reaches the end; a ceiling-limited scan remains partial.

Saving **Not a duplicate** or **Approve cleanup plan** persists the review and,
for confirmation, the chosen primary record. It does not merge Salesforce
records, convert a Lead, delete anything, or apply the displayed field-recovery
plan. See [whole-account duplicate audit](duplicate-audit.md).

## Governed Lead write-back safety

The reviewed plan expires after fifteen minutes and is rejected if a fresh SOQL
read produces a different fingerprint. `/runs` retains the native per-record
receipt and a portable backup for updated fields. Rollback restores exact empty
values as `null`; newly created Leads are never automatically deleted.

The generated environment includes the organization instance URL, its current
API version, and a local access token. Treat `.env.local` as a secret even though
Git ignores it. Rerun the command if Salesforce rotates the CLI token.

For a long-running deployment, obtain and refresh access tokens through a
Salesforce OAuth connected app rather than copying a CLI token. Keep the
resulting secret server-side. Salesforce documents bearer authorization and the
REST Composite resource in its
[REST API guide](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite_composite_post.htm).

## Production boundary

Set `CONTROL_TOWER_SYNC_KEY` in production. Authorized users enter the matching
value in the self-hosted operator UI; it is retained only for the current
browser tab. The server refuses private CRM operations without that second key.
Host behind authentication and HTTPS before exposing CRM data or mutation
controls.

## Synthetic development fixtures

With development credentials in `.env.local`, run:

```bash
npm run seed:duplicate-audit -- salesforce
```

The idempotent fixture setup creates or updates clearly labeled Leads, a
Contact, and a fixture Account so same-object and Lead-to-Contact review can be
exercised. It writes CRM data and does not delete it afterward; never target a
customer or production organization.
