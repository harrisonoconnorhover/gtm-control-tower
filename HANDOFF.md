# Morning Handoff

## Finished

- Verified saved skip/restore, field protection and comparison/results CSVs through the browser against both designated development CRMs, with no mocked responses.
- Confirmed only Marcus's selected title and Tess's explicitly cleared website changed; skipped Elena and unselected fields stayed unchanged.
- Filled Tess's empty website while preserving her populated title, then rolled back the original run: Marcus restored, Tess already restored.
- Verified the compared fields of all nine retained records per CRM matched their starting values. No creates or deletes occurred.
- Added a repeatable native controls check, dated evidence, masked screenshots, redacted results CSVs and a public walkthrough section.

## Try It

1. Open the [walkthrough](https://gtm-control-tower.pages.dev/enterprise-import-walkthrough#controls), then inspect the two downloadable results CSVs.
2. Read [native operator controls](docs/import-operator-controls-native-check.md) for the scenarios, counts, evidence and limits.
3. To repeat against your designated development accounts, follow the [fixture instructions](docs/enterprise-import-fixtures.md#repeat-the-operator-controls-check). The script makes bounded native updates and restores compared fields; it refuses unexpected baseline state.

## Checks

- HubSpot native run: 2026-09-28 00:12:05–00:12:14 UTC. Salesforce: 00:12:18–00:12:33 UTC. Each passed saved decisions, default preservation, 2 selected updates, 1 fill-empty update, CSV/receipt comparison after reload, and 1 restored / 1 already-restored rollback.
- Each run verified nine native records, zero creates/deletes/failures and zero browser errors. Receipts saved with HTTP 201 and were read back.
- Script syntax, focused ESLint and diff checks passed. Two pre-write harness failures were corrected and retained privately; neither enabled a native mutation.
- Public build, secret scan, desktop/mobile walkthrough checks and local links passed. Temporary runtimes/database and operator key were removed.
- Application code is unchanged from `a666b6c`, previously verified by 310 tests and release CI. This pass adds native evidence rather than another full application test run.

## Decisions

- Reuse retained fictional records; verify account/record ownership and exact approved fields before writing.
- Preserve dated evidence boundaries: native existing-record checks are distinct from simulated failure cases and matching accuracy.
- Keep original receipts private; publish sample CSVs with native, plan and run identifiers redacted.

## Remaining

- Equality covers identity, portable fields, state/city, markers and owners, not every CRM property or audit timestamps.
- HubSpot is a designated STANDARD development portal; Salesforce is Developer Edition, not formally provisioned sandboxes.
- Concurrent writers, other account configurations and duplicate-detection accuracy remain outside this check.

## Review First

- `scripts/check-enterprise-import.mjs` (`--controls-only`).
- `docs/import-operator-controls-native-check.md` and its evidence JSON.
- `public/enterprise-import-walkthrough.html` and the redacted sample CSVs.
