# Safe Import qualification — October 6, 2026

This checks the current `codex/safe-import` implementation. Native HubSpot,
cloud D1 storage, local Worker execution, and simulated failure boundaries are
reported separately. The published application is still an earlier version.

## Native HubSpot

The account-information API confirmed development portal `246915016`, account
type `STANDARD`. Qualification uses existing reserved-domain synthetic contacts,
fresh ownership markers, a private baseline, and isolated SQLite persistence.
It runs the production request handlers and services with no model configured.

The whole-file comparison contains 106 source rows and two eligible batches of
100 and five. It accounts for one proposed phone fill, three unchanged contacts,
five identity holds, 96 unmatched rows, and one skipped row. Preparation sends no
CRM writes. The held rows include contradictory exact-email evidence, approximate
suggestions, and two source rows competing for the same human-confirmed native
target across the batch boundary.

The first fill was accepted and automatically verified. Repeated approval returns
the same execution without another send. A second proposal using the old native
baseline, an expired proposal, and a proposal with an injected wrong account are
rejected. A second fixture receives one real fill with an injected lost response:
acceptance stays unknown even when fresh-runtime readback sees approved values.
Recovery and repeated approval send nothing again.

Both phone fills were restored through two separately reviewed phone-clearing
operations. Fresh read-only reconciliation confirms the phones are empty and
every other requested property exactly matches the private baseline. HubSpot
returned empty strings after clearing originally null phones. The initial strict
raw comparison flagged that representation difference; its original report is
preserved, with a separate reconciliation applying the existing portable blank
semantics. No extra mutation was needed to reconcile it.

The fixture runner checks primary email, the six portable fields, ownership,
lifecycle, additional emails, fixture markers, and the other requested protected
properties. Restoration is a separate reviewed selected-phone operation, held
if current values differ from the test's approved fill or protected baseline.

Run only against the designated development fixtures:

```bash
node --env-file=.env.local scripts/qualify-safe-import-hubspot.mjs --run
```

Without either `--run` or `--reconcile-cleanup`, it prints usage and sends no
requests. `--reconcile-cleanup <private run directory>` performs fresh reads
without another mutation. Private source files,
native baselines, reviews, outcomes, and restoration evidence go under ignored
`outputs/safe-import-native-2026-10-06/`. No credential is included in reports.
The completed run is `2026-10-07T01-30-11.761Z-598d8306/qualified-result.json`.
It records two fills, two reviewed restorations, zero creates/deletes, and no AI.

## D1 storage and execution limits

The production stores were exercised in actual local D1/workerd, with migrations
`0000` through `0003`. The 106-row Unicode review roundtrips exactly and remains
immutable. Three competing execution claims produce one winner and the same
execution ID. Concurrent progress changes produce one winner; stale progress
cannot overwrite another request. A fresh Worker reconstructs saved progress:
`sending` becomes unknown, unknown stays unknown, accepted values are verified,
and 103 unsent rows are held. Recovery sends zero CRM writes.

The optional local storage test also roundtrips an immutable 5,000-row Unicode
review of 15,469,430 bytes. This proves chunked storage, not execution scale.

The same stores were also exercised against a temporary **cloud D1** database
through a local Worker's `remote: true` binding. All four versioned migrations
applied. The 106-row Unicode review (326,877 bytes), immutable insertion, single
winner among three claims, progress compare-and-set, and read-only recovery all
passed. Cloud execution using the fictional CRM adapter completed and verified
99 updates with the same measured query counts. No CRM credentials or requests
were involved in the D1 probe. Cloudflare reported its primary `v3-prod` service
in ENAM/IAD with read replication disabled. This qualifies cloud SQL/storage
semantics; the local Worker does not enforce hosted Worker invocation limits.

Cloud evidence stays under ignored `outputs/safe-import-d1-2026-10-06/`.
An independent cold restart rehydrated `sending`, unknown, and accepted progress
from cloud storage with zero CRM sends. All test runners were stopped. The owned
temporary cloud database was deleted after qualification; a fresh database list
confirmed cleanup. The published application's database was not modified.

```bash
node scripts/qualify-safe-import-d1.mjs --max-storage
npm test -- tests/safe-import-d1.test.ts
```

**Release blocker: whole-file execution exceeds a single D1 invocation's budget.**
Executing 99 fictional-provider updates measures 1,199 D1 binding calls and
1,496 SQL statements, with workspace rechecks deliberately omitted. Actual
workspace rechecks add database calls. Cloudflare documents limits of 1,000 D1
queries per invocation on Paid and 50 on Free.
[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Explicitly simulated binding-call budgets stop after four fictional writes at
50 calls and 83 at 1,000. These are injected limits, not observed hosted Worker
failures. Durable progress remains available, but the whole approval cannot
finish under those budgets. The production executor therefore needs bounded
requests for the same saved approval before hosted release, with atomic claims
of pending rows and no replay of sending/unknown rows. Preparation and readback
also need to fit the deployment's request limits.

The probe can emit a Worker bundle or connect a local Worker to an explicitly
configured cloud D1 binding. Cloud mode requires a separate synthetic database,
migrations applied first, `remote: true`, and only a generated probe key. It does
not create resources or publish the application itself:

```bash
node scripts/qualify-safe-import-d1.mjs --emit-worker /private/path/probe.mjs
node scripts/qualify-safe-import-d1.mjs --remote-config /private/path/wrangler.json
```

## Release boundary

Read-only Sites inspection confirmed the existing published app has only the
older eight tables: no Safe Import review/execution tables and no configured
runtime environment variables. Its managed database is distinct from the
isolated qualification database. The current source was not deployed and no PR
was published. Hosted application behavior is not qualified by a successful
cloud-storage probe.

A second actual HubSpot account credential was unavailable: a saved-review
account mismatch against the real account tests rejection, not a real credential
switch. Lost-response qualification injects a transport loss after an actual
accepted write; it does not claim a naturally occurring network interruption.
Native reread/PATCH remain separate operations, and downstream CRM effects are
outside this test's comparison contract.
