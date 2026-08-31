# Whole-account duplicate audit

The self-hosted operator route at `http://localhost:3000/app` scans a configured
CRM account, produces deterministic duplicate-person candidates, and saves the
operator's review decisions. It is separate from:

- `/`: the static public demonstration and browser-only CSV audit;
- `/app/lab`: CSV mapping, repair, destination sync, BigQuery, and the guided
  messy-data lab;
- `/runs`: durable scan and write-back evidence.

The public demonstration cannot call the account scanner or read CRM data.

## Connect a CRM

Duplicate scans require persistence and a direct connector. Local SQLite is the
recommended self-host path. The same schema supports D1 on an adequately
provisioned Worker, but the account resolver is not intended for the
[10-millisecond Workers Free CPU limit](https://developers.cloudflare.com/workers/platform/limits/).
n8n-only HubSpot preview mode does not
expose the account scanner.

### HubSpot

Create an account service key and set it as `HUBSPOT_ACCESS_TOKEN` in the
ignored `.env.local` file.

| Intended use | Service-key scopes |
| --- | --- |
| Whole-account Contact scan and read connection test | `crm.objects.contacts.read` |
| Write connection test only | `crm.objects.contacts.write` |
| Governed preview/write, update rollback, or synthetic seed | `crm.objects.contacts.read` and `crm.objects.contacts.write` |

Use both scopes when one installation needs the complete read/write workflow.
The seed command also reads by email before it creates or updates a Contact, so
write scope alone is insufficient for that command. Restart the self-host after
changing `.env.local`, then verify the connector at `/setup`. The service key
stays on the server; it is not sent to the browser.

### Salesforce

Authorize the Salesforce CLI and run `npm run configure:salesforce`, as
described in [Salesforce setup](salesforce-csv-setup.md). The configured user
must be able to query Leads, Contacts, and the Account name/website fields used
as Contact company context.

The scan reads:

1. unconverted Leads;
2. Contacts, including their Account name and website.

Lead and Contact records can appear in the same candidate group, but that group
is always limited to human review. A Lead-to-Contact result needs a conversion
or manual cleanup decision and is not presented as a same-object merge. The
recommended survivor is always the Contact, and both primary and mobile phone
values remain available in the field-recovery plan.

## Run and resume a scan

Choose HubSpot or Salesforce at `/app`, then select **Scan the account**.
The browser requests one provider page at a time:

- HubSpot uses 100-Contact pages and its `after` cursor;
- Salesforce follows `nextRecordsUrl`, scanning Leads before Contacts.

Each accepted provider record and the next cursor are committed to SQLite/D1.
The operator can pause after the current page. A browser refresh or later visit
loads the active scan and resumes from its durable cursor. Upserts by provider
record key make a repeated page safe.

Salesforce query locators can expire while a scan is paused. If Salesforce
rejects a saved `nextRecordsUrl`, choose **Start over** to retire that scan and
begin from the first Lead page. Records are stored under the new scan rather
than mixed with an expired traversal.

The saved rule version must also match the running resolver. After an upgrade
that changes identity rules, the server refuses to finish an older paused scan
under new logic; **Start over** creates one internally consistent audit.

Provider pagination reaching its natural end sets **source complete**. The
ceiling is 25,000 unique provider records on local SQLite and 10,000 on D1. Use
`CONTROL_TOWER_MAX_SCAN_RECORDS` to choose a lower value of at least 100. If the
ceiling is reached first, the result and `/runs` receipt are marked partial
instead of claiming whole-account coverage. A zero-candidate
result is called **clean** only when `sourceComplete` is true; a ceiling-limited
zero remains a partial audit.

Finalization writes a connector-run receipt with the same scan ID. If the
client retries a step after completion, the server reconciles that receipt by
ID instead of creating a second run.

Transient rate-limit and server failures use up to four attempts. Broad shared
phone or fuzzy buckets may be excluded to prevent false positives; exact
identifier groups that are too large for ordinary comparison are reduced to
reviewable pairs. These cases appear as analysis warnings rather than silently
inflating confidence.

## How matching works

Matching is deterministic, not an AI probability. Current scans use
`identity-v3`; every scan stores its rule version, and the UI shows the
contributing evidence and conflicts.

Candidate generation uses normalized identifiers and context:

- exact non-generic email;
- Gmail dot/plus alias families (`googlemail.com` is normalized to Gmail);
- primary and secondary normalized phone numbers;
- compatible first and last names;
- normalized company;
- company website and non-free email domains.

Plus tags are not stripped for corporate domains. Generic inboxes such as
`sales@`, `support@`, or `info@` are warnings rather than decisive identity
anchors. A phone appearing on more than three records is context-only: it can
add weak evidence to another candidate, but it cannot generate a candidate by
itself. Conflicting first or last names, phone numbers, company domains, and
different email domains without a phone anchor subtract evidence.

The current rule bands are:

| Band | Deterministic rule |
| --- | --- |
| High confidence | score at least 95, an anchored strong identifier, and no conflict |
| Needs review | score from 75 through 94, or a cross-object or overlapping group that would otherwise be high confidence |
| Possible | score from 60 through 74 |

Name, company, and domain context without an email or low-frequency phone
anchor is capped below the review threshold. Multi-record groups use the lowest
pair score as their displayed confidence, and additional members must remain
compatible with the existing group; a weak bridge cannot join two otherwise
unrelated people. If one record still appears in competing candidate groups,
those groups are capped below high confidence.

## Review decisions and blockers

Each group shows:

- every native record and object type;
- evidence and conflicts for each comparison;
- a recommended primary based on portable-field completeness, object type, a
  clean email, and provider creation date as the final tie-breaker; Salesforce
  Contact always wins over Lead in a cross-object group;
- a field-recovery plan and any conflicting values;
- actionability blockers.

The operator can save **Not a duplicate** or **Approve cleanup plan**. Approval
stores `confirmed_duplicate`, the selected primary record, and the review time.
Stable cluster IDs let the same decision reappear when a later scan contains the
same provider records.

This release is decision-only. It does **not** call HubSpot or Salesforce native
merge APIs, delete a record, convert a Lead, or apply the displayed field plan.
The default blocker states that native merge is not automatic; cross-object
Salesforce groups carry the stricter conversion/manual-cleanup blocker.
Overlapping groups carry an additional blocker, and the API requires the
reviewer to mark each competing group **Not a duplicate** before approving the
remaining cleanup plan.

Use **Export review JSON** to hand the evidence and decisions to another
controlled workflow. Existing field-level write preview, rollback, and native
receipts under `/app/lab` and `/runs` remain separate operations.

## Seed safe development fixtures

The seed command writes clearly labeled synthetic records to the configured
development systems:

```bash
npm run seed:duplicate-audit -- hubspot
npm run seed:duplicate-audit -- salesforce
npm run seed:duplicate-audit -- both
```

It reads credentials from `.env.local`. HubSpot fixtures are idempotently found
by email before create/update. Salesforce fixtures include unconverted Leads, a
Contact, and a labeled fixture Account so the scan exercises same-object and
Lead-to-Contact review. The command intentionally mutates CRM data and does not
delete it afterward. Do not run it against a customer or production account.

## Operator access key

When `CONTROL_TOWER_SYNC_KEY` is configured, private CRM operations require the
same value in the self-hosted UI. The browser keeps it in `sessionStorage` for
the current tab and sends it only as `x-control-tower-key`; it is not written to
SQLite, exported review JSON, or a URL.

Production refuses private CRM operations when no key is configured. This
shared key is a second local control, not multi-user authentication. Put any
internet-accessible self-host behind authentication and HTTPS.
