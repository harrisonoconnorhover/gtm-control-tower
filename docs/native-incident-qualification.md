# Native messy CRM qualification

The native runner loads the unchanged `messy-crm-v1`, seed 42 world into explicitly
selected development accounts: 600 Contacts, 350 Companies/Accounts and 400
Deals/Opportunities per provider, plus 200 Salesforce Leads. It records how each
original fixture maps to the native service. Rejections, normalizations and
Control Tower detections are different outcomes.

## Run

Configure native credentials in ignored `.env.local`. Salesforce must identify
itself as a sandbox or Developer Edition. HubSpot has no equivalent guarantee
for an ordinary development portal, so explicitly pin the designated portal in
`HUBSPOT_DEVELOPMENT_ACCOUNT_ID`; do not select a customer or production portal.
The token needs Contact, Company and Deal read/write access for this setup.
Object metadata and relationship reads must also be available. Salesforce must
allow the four objects and OpportunityContactRole creation.

```bash
HUBSPOT_DEVELOPMENT_ACCOUNT_ID=YOUR_TEST_PORTAL npm run qualify:incidents:native -- \
  --run --provider hubspot --account YOUR_TEST_PORTAL --run-id native-YYYYMMDD --phase seed
npm run qualify:incidents:native -- \
  --run --provider salesforce --account YOUR_TEST_ORG --run-id native-YYYYMMDD --phase seed --cached-cli
```

`--cached-cli` uses the existing `gtm-control-tower-salesforce` authorization in
memory and verifies that its organization and origin match the selected account.
A read-only organization query refreshes and proves the session before token retrieval.
It does not print or rewrite the token. Without `--run`, no requests are sent.

After seeding, repeat the provider arguments with `--phase formatting`,
`--phase monitor`, then `--phase import`. `--phase all` performs all stages. Keep the same run ID
when resuming setup; the private manifest saves confirmed native IDs before
readback. Unknown creates/associations stay pending and require reconciliation;
the runner never blindly sends them again.

## What runs

- Native metadata chooses valid stages, required fields and association types.
  Synthetic IDs, owners and timestamps cannot be copied into a real CRM. Reserved
  addresses and run markers distinguish the synthetic cohort. Native duplicate
  rules remain enabled.
- Production native adapters and `tickMonitor` scan native pages. A manifest
  boundary filters observations and verifies ownership before repairs. A fresh
  SQLite database prevents unrelated pending repairs from joining the test.
- Actual accepted blank identities, duplicate candidates, relationship gaps,
  invalid values and supported whitespace trims are checked against the native
  baseline. Every automatic trim gets fresh readback and protected-field checks.
  Three supplemental Unicode boundary-space probes use existing marked Contacts
  and are reported separately from the unchanged source dataset. These exercise
  native auto-repairs only when the provider retains the boundary spaces; a
  provider-normalized probe is reported separately.
- The runner clears 120 titles, 30 company domains and 40 deal amounts and makes
  20 legitimate title updates. It waits for the production indexing delay before
  checking native change searches, exact incident membership and saved triage.
- Safe Import prepares 12 empty-phone fills with deliberately conflicting
  incoming titles, approves the immutable review, continues bounded work and
  checks native readback, preserved fields, unchanged controls and repeated
  approval. Its stable checkpoint prevents replay of previously attempted writes.

Native evidence remains under ignored `outputs/native-incidents/<run>/<provider>`.
Fixtures remain in the test accounts for inspection. Monitor configuration in
each qualification database is disabled on exit. Outbound Slack and model calls
are disabled. The normal operator database is never selected by this runner.

## Limits

This qualifies real native polling, supported writes and scripted authenticated
operator triage. Browser presentation is a separate check. It does not establish
webhook/CDC subscription delivery, Slack delivery, hosted performance, production
precision/recall or recovery from every possible upstream failure. Native storage
may reject impossible dates/numbers/relationships and clean whitespace before the
monitor can observe it. Those cases are not counted as monitor successes.

Temporal mutations change the retained cohort. A fresh monitor run against that
already changed cohort does not recreate the original timeline. Reconcile and
restore only this run's documented mutations, or explicitly seed a new run after
checking test-account capacity; never relabel a repeated baseline as temporal proof.

## Inspect the result

Generate a private, offline report after the phases finish:

```bash
node scripts/report-native-incidents.mjs --run-id native-YYYYMMDD
```

Open `outputs/native-incidents/<run>/report.html`. It separates native storage
validation from detections, automatic trims, approved fills and browser evidence.
Missing or failed phases remain visible. Full native evidence stays in ignored
output files and is never embedded wholesale into the report.

For browser qualification, start the local app with `CONTROL_TOWER_SQLITE_PATH`
pointing to the completed provider monitor run's `qualification.db` and a temporary
`CONTROL_TOWER_SYNC_KEY`. Leave native credentials, model and Slack configuration
unset. Run `scripts/check-native-incidents-ui.mjs` with the same key, a localhost
`CONTROL_TOWER_BROWSER_BASE_URL`, `CONTROL_TOWER_NATIVE_PROVIDER`, and absolute
`CONTROL_TOWER_NATIVE_OUTPUT_DIR` pointing to the provider directory containing
`manifest.json`. It uses actual app routes and retained native evidence, saves and
reloads human triage, checks the downloaded evidence against the native manifest,
and captures desktop/mobile screenshots. It makes no browser-triggered CRM writes.

## Native findings from October 10, 2026

The completed run `native-20261010` passed 158 recorded checks across native
monitoring, Safe Import and the real local browser. The private HTML report and
underlying JSON retain the per-check results.

| Final qualification | HubSpot | Salesforce |
| --- | ---: | ---: |
| Explicitly seeded records | 1,350 | 1,550 |
| Native monitor checks passed | 64 | 38 |
| Automatic trims with native protected-field readback | 27 | 2 |
| Approved empty-phone fills verified | 12 | 12 |
| Controlled temporal changes accepted and detected | 210 | 210 |
| Real browser checks passed | 22 | 22 |

Each provider's temporal cases contain 120 title clears, 30 domain clears, 40
amount clears and 20 legitimate title updates. Clear incidents matched exactly;
the legitimate updates were excluded. All qualification monitor configurations
were disabled at completion. These are test-account and local browser results,
with the limits above; they are not a production accuracy claim.

The first HubSpot run exposed a real adapter defect: a completed association batch
can return HTTP 207 with successful relationships alongside record-scoped
`crm.associations.NO_ASSOCIATIONS_FOUND` errors. Only that exact, correctly scoped
response means an empty relationship. The adapter now preserves successful
siblings and recognizes those explicit empties; unknown, conflicting, truncated
or unscoped responses remain coverage gaps. The failed run is retained separately
from the subsequent qualification.

The same run exposed an aggregate health defect: a healthy Contact page could
hide unresolved Deal read gaps. Coverage now includes gaps on current saved
records. Fresh successful reads clear them even when native values and timestamps
are unchanged; cached or older observations cannot. Historical incident records
remain available without permanently forcing degraded health. Blocked rechecks
use the normal polling interval instead of repeatedly running every second.

HubSpot also created 351 additional companies through its existing “Create and
associate companies with contacts” setting. Native source metadata and a complete
company inventory link these to the synthetic contacts. This was induced by the
test setup: the accepted `.example.com` email suffix did not match the seeded
`.example` company domains. Future seeds use the same legal suffix for both;
intentional fixture domain mismatches remain intact. That correction does not
retroactively change this run or prove a new native seed without side effects.
These are a manual qualification finding, not claimed automatic Monitor detections. They are outside
the explicit 2,900-record seed manifest and repair authority. The report counts
them separately; neither those companies nor the account setting were deleted or
changed.

Salesforce rejected ambiguous repeated synthetic names under its enabled duplicate
rules and normalized ordinary boundary whitespace. Unique fixture name tokens
allow setup without disabling those rules. Retained Unicode probes separately
exercise the narrow native trim recipe. Native storage normalization is not
credited to Control Tower.

The browser run also caught a contaminated accessible name on the triage note
field and an incident list that pushed selected evidence far down the mobile
page. The note now has a stable label, and the list scrolls within a bounded area.
