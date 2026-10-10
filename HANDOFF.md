# Morning Handoff

## Finished

- Added `/app/incidents` and Inbox integration for grouped changes, retained evidence, investigation, assignment and structured decisions across HubSpot and Salesforce.
- Expanded reads to companies/accounts and deals/opportunities, with signed native event intake and an optional Salesforce CDC subscriber. Writes remain restricted to existing approved recipes.
- Added versioned expectations, planned exceptions, repair budgets, recurring-change containment, explicit coverage gaps and durable incident/repair notification intent. Slack remains optional.
- Added a separate investigator capability and optional evidence-cited model explanations. Local reports work without a model; no live model calls were made.
- Replaced whole-file Safe Import execution with fenced, bounded continuations. Provider scans, imports and Slack now have independent runner schedules.

## Try It

1. Enable your account at `/app/monitor`, run `npm run monitor`, then open `/app/incidents` or `/app/work`.
2. Run `npm run qualify:incidents`; open `outputs/incident-stress/report.html`. CSV/JSON datasets and a paused inspection database are saved alongside it.
3. Configure optional services through `.env.example`; see [incidents](docs/incidents.md), [native events](docs/native-monitor-events.md) and [Slack](docs/slack-notifications.md).

## Checks

- Stress qualification: 144/144 checks; 2,900 baseline records plus 38 supplemental safety fixtures. All 240 labeled static affected records detected, with zero misses or false positives among 2,660 clean controls.
- Desktop/mobile browser checks passed for incidents, Monitor, Inbox, Slack and both Safe Import providers. Actual seeded incident API/UI investigations passed for both CRMs; no external requests.
- App/public builds, TypeScript, lint, doctor, Compose validation and secret scan passed. Audit passed the high-severity gate; four existing moderate development-tool advisories remain.
- All 729 local tests passed (725 general tests plus four stress tests). Local Docker smoke could not start because the Docker daemon is unavailable; the PR CI runs the credential-free container check as an integration gate.

## Decisions

- Retained event values and later snapshots are separate evidence; neither proves root cause. New object types are read-only.
- Business rules and repair limits are explicit policies. Models cannot authorize changes, alter policy or execute tools.
- Generated independently labeled fictional worlds for reproducible failure testing. Fixture accuracy is not a production precision/recall claim.

## Remaining

- Configure and qualify native subscriptions, permissions, live model behavior and Slack in the intended deployment.
- Hosted Safe Import remains unqualified. The local D1 probe measured at most 139 binding calls per ten-record invocation; the 50-call budget remains unsupported.
- Individual team identities, arbitrary workflow repair, autonomous merges and automatic restoration remain outside supported scope.

## Review First

1. [Incident contract](docs/incidents.md) and [stress results](docs/incident-stress-results.md).
2. [Native event setup and limitations](docs/native-monitor-events.md).
3. [Safe Import continuation contract](docs/safe-import.md).
