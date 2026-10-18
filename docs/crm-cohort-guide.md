# CRM-only cohort review with Pomade

Control Tower prepares a selected group of existing HubSpot contacts for review.
Pomade proposes only requested missing facts from the supplied CRM evidence.
Control Tower checks returned proposals against its saved request and a fresh
native CRM read. Both products keep their existing storage and operate separately;
the connection is two downloaded JSON files.

This workflow is available in the self-hosted app at `/app/cohort`, linked from
the lab as **Prepare CRM cohort**. It does not write CRM fields, verify email
through an external service, create a sequence, or send messages. Accepting a
proposal records a review decision only. Existing CRM update workflows remain
separate; this release does not automatically open or approve them.

## Try the fictional file loop

1. Open `/app/cohort` and choose **Try fictional cohort**. Inspect each contact's
   eligibility, missing facts, source text, and coverage. The example combines
   repeated native contacts, shows a suppressed contact and shared-email holds,
   and retains conflicting or unattributed evidence. It makes no CRM/model calls.
2. Select the contacts to review, then **Save and download evidence request**.
   The saved request preserves the exact selected source snapshot and identities.
3. In Pomade, choose **Import CRM evidence request**, select the downloaded file,
   review its contacts, and choose **Create CRM review table**. This creates a
   separate saved table; importing does not run extraction.
4. Review fields manually without a model: expand a contact, choose an outcome,
   supply a proposed value and rationale where applicable, and use **Add source
   citation** to select a source and paste an exact excerpt. Save the field
   outcome and wait for the table to save. Unsupported facts stay **Not found**;
   contradictory evidence stays **Conflicting evidence**.
5. Choose **Download CRM evidence result** in Pomade. Back in the saved Control
   Tower cohort, choose **Import Pomade evidence result**. Fictional mode compares
   with its fictional snapshot and labels that limitation. Inspect and accept or
   reject supported proposals, then **Download cohort review**. Reload either app
   to revisit its saved work.

Optional extraction in Pomade uses **Extract from supplied CRM evidence** on at
most ten selected contacts. It sends the selected evidence to the existing
ChatGPT helper in its context-only mode with browsing/tools disabled. CRM-only
describes the evidence source, not local-only computation. An unavailable helper
leaves manual review available; there is no enrichment-provider fallback.

## Configure a real HubSpot cohort

Use the existing direct `HUBSPOT_ACCESS_TOKEN` server configuration and the
operator access key. **Load HubSpot definitions** reads the official portal
identity, pipelines/stages, and property metadata. Credentials remain server-side.
The n8n sample reader is not used as an exhaustive cohort source.

Configure these meanings before **Preview and save new cohort**:

- Choose pipeline and closed, non-winning stage IDs, a deal date property, and an
  inclusive UTC date range. Labels are displayed, while native IDs define scope.
- Identify the contact property that measures meaningful contact, document what
  updates it, and confirm that meaning. The default threshold is 90 elapsed days;
  missing, invalid, future, or unconfirmed dates cannot establish inactivity.
- Map contact exclusion fields with blocked values and explicit blank handling.
  Add required fit values/ranges, relevant active/won deal exclusions, and an
  optional promised follow-up property. No exclusion mapping means a hold.
- Optionally map the existing verification status, verified address, and date,
  plus accepted statuses and freshness. Missing or stale evidence means
  **Unverified**; a syntactically plausible email never means verified.
- Select missing job title, company, phone, or website fields and their CRM
  properties. Choose additional contact/company/deal properties and whether to
  include linked notes. Existing values are protected.

Only selected properties and directly associated CRM notes are covered. Standalone
emails, calls, meetings, Slack, attachments, web changes, and full stage histories
are outside this version. Summaries already stored in a selected property or note
are available as recorded statements. Company properties do not establish a
person's title or phone. Deal notes remain deal context without direct person
attribution. Property snapshots have retrieval times; record modification time
is not presented as the property's event date.

## Coverage and review limits

The native search reads 20 matching deals per explicit page. Use **Read next deal
page** when more remain. Population coverage is separate from individual-contact
coverage: a readable contact does not establish a complete population.

The first version returns at most 100 contacts per page, reads at most 100 IDs per
association, and includes at most 20 linked notes per contact/originating deal.
Omitted IDs/cursors, unreadable properties, unavailable associations, unknown note
age, and search-limit warnings remain visible. Narrow the deal window or reduce
selected evidence when limits are reached. The review can retain up to 1,000
contacts, with at most 100 selected for a request. Each request/result is limited
to 2 MiB; evidence is limited to 10,000 characters per selected contact. Oversized
sources are omitted whole and recorded as coverage gaps rather than cut silently.

Every returned contact and requested field must have an outcome, including
**Not run**, **Not found**, and **Failed**. Unknown requests, wrong portals,
unexpected contacts/fields, invented excerpts, and unsupported versions fail
before saving a review. An exact repeated result leaves saved reviews unchanged
and creates no duplicate proposals.
Real mode rereads native IDs and eligibility inputs: missing targets, newer
values, unavailable evidence, and conflicting eligibility remain protected.

**Ready for review** is not permission to contact someone. Fit, timing, evidence,
and email verification remain separate. Reports retain held contacts and reasons.

## Waiting and resuming

CRM reads share a conservative request gate with Safe Import: starts are spaced
at least 250 ms apart, with at most two concurrent requests per provider,
credential and server process. Temporary rate limits, 502/503/504 responses,
network failures and timeouts receive bounded retries with jitter. Numeric and
date-form `Retry-After` values are honored in full. Authentication, permission
and configuration errors do not become automatic retry loops.

The cohort screen shows the next retry time and **Stop waiting**. A successful
page is saved as a unit; a failed or stopped page leaves the last saved contacts
and cursor unchanged. Reload and choose **Read next deal page** to retry that
saved position. Automatic foreground waiting stops after five minutes. Each
individual server read has a 30-second retry budget and a ten-second attempt
timeout; these are not a five-minute guarantee for every maximum-size page.
Evidence-heavy pages may need a narrower deal window or fewer selected sources.

Quota exhaustion is shown separately. Without a supplied reset time, a one-hour
suggested retry is a conservative probe time, not a claim that the quota resets
then. This gate does not coordinate separate server processes, other credentials,
or traffic sent by other integrations. No native routing flow is changed.

Pomade saves a hosted extraction's original job handle and selection. Reloads
resume read-only checks of that same job, with bounded backoff and visible
stop/resume controls. Checks do not submit the model work again. An ambiguous
initial submission without a saved handle stays held for manual review; local
helper requests are not replayed automatically. See Pomade's CRM evidence guide
for its recovery states.

## Files and qualification

The new `crm-evidence-request` and `crm-evidence-result` version 1 envelopes carry
request correlation and portal/native identities. Their digest checks consistency;
it is not a signature. The older [Pomade handoff](pomade-handoff.md) format and its
updates-only review remain unchanged. Do not interchange the formats.

The implementation follows the [dated plan](crm-cohort-playbook-plan.md).
The October 13, 2026 browser check passed through both actual local applications,
SQLite/D1 persistence, and downloaded request/result/report files. Seven distinct
fictional contacts produced a six-contact request; the final report retained one
accepted-for-review contact, five held contacts, and one excluded contact. CRM and extraction responses were intercepted: no actual model or CRM was called. Reload,
wrong-portal rejection, a failed Control Tower save and retry, repeated-result
handling, unchanged source values, and desktop/390px layouts were checked. The
recovery regression also checks a saved extraction across reload, status throttling,
CRM read retry, and cancellation followed by resuming the saved page cursor.

To repeat the regression, start disposable local Control Tower and Pomade apps
with isolated storage, then run `npm run test:crm-cohort-roundtrip`. Defaults are
`http://127.0.0.1:3217` and `http://127.0.0.1:8896`; override them with
`CONTROL_TOWER_BROWSER_BASE_URL` and `POMADE_BROWSER_BASE_URL`. The script allows
localhost only and saves downloads/screenshots under `/tmp/crm-cohort-roundtrip`
unless `CRM_ROUNDTRIP_OUTPUT` is set. It creates saved fictional workspaces/tables
in those disposable instances.

On October 15, 2026, the full loop passed with three explicitly approved synthetic
contact/deal/note cases created in the development HubSpot account and one actual
helper extraction. Reload, Stop/Resume and four status checks reused one job;
returning the same result again added no review, save or native comparison.
Supported, conflicting and missing-title outcomes matched the supplied notes.
All contacts stayed held, no CRM update occurred during the loop, and nothing
was sent. See the [native test report](crm-cohort-native-check.md) for creation,
retry, preservation and evidence details. These live development-system results
do not qualify production capacity or extraction accuracy on real relationships.
See [HANDOFF.md](../HANDOFF.md) for the latest checks and remaining limits.
