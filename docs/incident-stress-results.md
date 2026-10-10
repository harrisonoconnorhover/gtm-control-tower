# CRM Monitor incident stress qualification

The October 10, 2026 local qualification passed **144 scenario checks** across
four tests. It used the actual `tickMonitor` worker, local SQLite, incident
correlation, durable repair claims, readback and notification-intent storage.
Provider responses were fictional and every external `fetch` was blocked.
This is local fixture qualification, not native CRM or production qualification.

## Dataset

The generator is reproducible (`messy-crm-v1`, seed 42). Its scenario labels are
written independently of the detector results. The simulated clock starts on
October 1, 2026; saved incident dates reflect that fictional event timeline.

| Provider | Contacts | Companies / Accounts | Deals / Opportunities | Leads | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| HubSpot | 600 | 350 | 400 | 0 | 1,350 |
| Salesforce | 600 | 350 | 400 | 200 | 1,550 |
| Total | 1,200 | 700 | 800 | 200 | **2,900** |

Each world includes 219 event deliveries, multilingual names, custom stages,
multiple currencies, varied amounts, relationships, duplicate candidates and
instruction-like CRM text. Separate account scopes add 19 contact fixtures per
provider for interruption, conflict, budget, routing and coverage scenarios.

## Results

- All **240 independently labeled static affected records** were detected, with
  no misses and **zero static false positives among 2,660 clean controls**.
  These are results against the planted labels, not an estimate of general
  production precision or recall.
- For each provider, 120 cleared contact titles, 30 cleared company domains and
  40 cleared deal amounts became exactly three incidents with correct affected
  counts. The system proposed no invented restoration.
- All 24 eligible contact title trims per provider were applied and verified.
  Blank-only trimming, missing/invalid emails, company/deal changes, ownership,
  relationship creation and merges were never given repair authority.
- Repeated reversals paused repairs; a subsequently eligible dirty record stayed
  unsent. Twenty legitimate updates retained their values. Twenty separately
  planned clears kept suppressed, source-linked evidence without expanding the
  unexpected-clear incident.
- Duplicate observations added no ledger entries or notification requests.
  Delayed source values could not replace newer snapshots. Human resolutions
  retained history and did not silently alter policies.
- Supplemental cases preserved unknown outcomes after lost responses, readback
  mismatch and protected-field changes; stopped on fresh human edits; recovered
  expired sending claims without resending; fenced stale workers; and allowed
  only one repair under competing ticks. Reintroduced whitespace stopped at the
  two-per-record daily budget, including after an attempted resume.
- Routing deadlines escalated unchanged records after their grace period.
  Prior activity becoming quiet, omitted fields, expired connections and stale
  runners produced the corresponding investigation or coverage state.

The explicit stress policy uses a minimum of 10 records and **5% of the observed
object population** for bulk clears. It requires the configured company links
and rejects negative amounts. These are business policy choices: the default
20% clearing threshold would intentionally not flag 30 of 350 company records.
Shared email/domain findings are review candidates, not verified identities.

## Reproduce and inspect

```bash
npm run qualify:incidents
# Or select another generated-artifact directory:
node scripts/qualify-incident-stress.mjs /absolute/path/to/fictional-results
```

The command exports these ignored, local artifacts under `outputs/incident-stress`:

- `report.html`: searchable report with every expected and observed assertion.
- `results.json`: machine-readable results and explicit coverage boundaries.
- `dataset/<provider>/`: contacts/companies/deals/leads CSVs, complete world JSON,
  ground-truth manifest and event JSONL.
- `fixture.db` and `fixture-metadata.json`: retained SQLite evidence for an
  isolated application preview. Exported monitoring and automatic repairs are
  paused. Notification intent is retained for inspection.

Use an isolated app environment with empty CRM, model and Slack credentials when
opening this database. Do not point an operational runner at it. The main scopes
are HubSpot `4242` and Salesforce `salesforce_00D000000000042`; supplemental scopes
are listed in the metadata. Ordinary `npm test -- tests/incident-stress.test.ts`
uses a disposable temporary database and leaves no retained fixture.

## Boundaries

The run checks fictional provider contracts through the real worker, not native
HubSpot/Salesforce API parsing or authorization. Separate provider and signed
event-intake tests cover those adapters and protocols with fictional responses.
No live model, CRM, Slack, hosted worker or paid service was used. Database
notification intent does not prove Slack delivery. Polling may miss intermediate
changes, and missing links or correlated events do not prove a root cause.
Unlabeled business anomalies, live throughput, hosted limits and downstream
CRM automation still require separate qualification.
