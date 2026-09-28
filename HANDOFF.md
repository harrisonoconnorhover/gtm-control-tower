# Morning Handoff

## Finished

- Added **Verify CRM results** and read-only rechecks to saved governed HubSpot Contact and Salesforce Lead runs. Results distinguish verified values, differences and unavailable reads from the original write outcome.
- Persisted timestamped expected/observed fields, differences and errors; included them in saved JSON and results CSVs.
- Fixed a preview/receipt linkage bug found in native qualification: execution now retains the reviewed plan ID after checking fresh CRM values. Historical mismatched receipts remain unchanged.
- Qualified actual title updates, saved verification, rechecks and deliberate post-rollback differences in both development CRMs. All nine retained records per CRM were restored; no creates or deletes.
- Added workflow documentation and native evidence to the public walkthrough.

## Try It

1. Read the [verification case](https://gtm-control-tower.pages.dev/enterprise-import-walkthrough#verify).
2. After a governed import in a configured self-host, open `/runs`, enter its operator key if required, and select **Verify CRM results**.
3. Inspect differences, download the results CSV, reload, then **Recheck CRM results**. Rechecking does not write to the CRM. See [workflow and limits](docs/crm-run-verification.md).

## Checks

- All 448 tests across 30 suites passed; TypeScript, full ESLint, application/public builds, secret scan and diff checks passed.
- Both-provider plan-ID regressions failed before the fix and passed afterward; all 29 confirmed-match tests passed.
- Both-provider browser checks passed: real local persistence, simulated verification responses, reload, failure retention, JSON/CSV and desktop/mobile layouts. No CRM writes.
- Native checks passed September 28, 2026, 15:03:51–15:04:15 UTC. Each verified one updated person, preserved email, detected the deliberate rollback difference and retained the original receipt. The initial HubSpot linkage failure was restored and reconciled before rerunning.

## Decisions

- Compare primary email and all six portable planned values, including protected fields. Keep verification separate from provider acceptance.
- Save the latest on-demand observation; no monitoring, automatic repair or write retry.
- Native evidence covers updates. Created-record and read-error cases use simulated providers.

## Remaining

- Verification uses the current CRM connection; historical runs do not bind a separately verified account identity.
- Later automation or external changes can alter values; differences do not establish their cause.
- Older missing/mismatched plans, Salesforce Contacts and converted Leads cannot be verified through this workflow. Malformed or cleared email reports unavailable.

## Review First

- `lib/crm-run-verification.ts` and `app/api/control-tower/runs/verify/route.ts`.
- `components/sync-runs.tsx` and `lib/crm-review-export.ts`.
- `docs/crm-run-verification.md` and its dated native evidence.
