# Morning Handoff

## Finished

- Added explicit “Use this existing record” decisions with a saved reason for HubSpot Contacts and unconverted Salesforce Leads.
- Governed previews and execution recheck the source, selected native record, exact-email conflicts and competing rows across the saved import. Stale or invalid decisions hold the row.
- Preserved CRM email, reused selected-field protection, added confirmation details to previews/CSVs, and supported rollback when the imported email differs.
- Verified a title-only update and rollback against each designated development CRM: confirmed Priya updated, unresolved Jordan held, all nine retained records restored to their starting compared fields.
- Added repeatable checks, dated evidence, redacted results CSVs and a public walkthrough section.

## Try It

1. Open the [walkthrough](https://gtm-control-tower.pages.dev/enterprise-import-walkthrough#confirm) and download the native results CSVs.
2. In a configured saved `/app/lab` workspace, read a fresh snapshot, find suggestions, enter a reason and select **Use this existing record**. Compare permitted changes before executing.
3. Follow [confirmed import matches](docs/confirmed-import-matches.md) for supported targets, safeguards and repeat instructions.

## Checks

- 405 tests across 29 suites passed; TypeScript, ESLint, application/public builds, secret scan and diff checks passed.
- Both-provider browser regression passed: required reasons, failed-save retention, confirmation/clear across reload, stale-source warning, plan/CSV labels, unsupported Salesforce Contact and 390px width. CRM responses were simulated; workspace storage was real.
- Native HubSpot: September 28, 14:09:30–14:09:37 UTC. Salesforce: 14:09:37–14:09:47 UTC. Each: 1 update, 1 hold, unchanged email, stale replay HTTP 409, 1 rollback restoration, zero creates/deletes.
- Static walkthrough desktop/mobile layout, all anchors and 15 local targets passed; both results downloads matched their files.
- One harness attempt stopped before writes on an incorrect expected scan-creation status; corrected to HTTP 201. Native runtimes, temporary databases and operator keys were removed.

## Decisions

- Confirmation records human judgment; it does not turn a score into a probability or authorize a duplicate create.
- Bind decisions to workspace/source/target/current connector credential; token rotation requires renewed confirmation. Source CSVs do not transfer native-ID approval.
- Keep native API proof separate from simulated browser and failure tests.

## Remaining

- Salesforce Contacts remain review-only; no native merge, Lead conversion or CRM email replacement.
- Development accounts are HubSpot STANDARD and Salesforce Developer Edition, not formally provisioned sandboxes.
- External concurrent writes, other workspace decisions, unobserved fields and matching accuracy remain outside this qualification.

## Review First

- `app/api/control-tower/import-match-decision/route.ts` and `lib/import-match-decision-server.ts`.
- `app/api/control-tower/crm-writeback/route.ts` and `tests/crm-confirmed-match.test.ts`.
- `docs/confirmed-import-matches.md` and the walkthrough’s `#confirm` section.
