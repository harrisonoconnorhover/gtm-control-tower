# Morning Handoff

## Finished

- Held possible duplicate creates across the full saved import, including rows outside the current batch, for HubSpot and Salesforce.
- Kept import-row IDs and supporting evidence separate from native CRM matches; neither unresolved row is automatically chosen to create.
- Excluded self and locally merged rows before matching; retained useful identity evidence from active rows with invalid emails.
- Rechecked saved-import evidence at execution, rejecting a preview when another matching identity is added or changed.
- Added route and browser regressions and updated the public walkthrough with the automated-test evidence boundary.

## Try It

1. In the configured self-hosted `/app/lab`, load two fictional rows with different emails but the same name, phone and company, plus an unrelated person.
2. Read a fresh complete CRM snapshot and compare. The two possible duplicates should be held with the other import row's ID and evidence. Correct or remove unresolved rows in the source, reload and compare again.
3. For a disposable local app, run `CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3000 npm run test:import-holds`. Set `CHROMIUM_PATH` if needed.

## Checks

- 253 tests across 25 suites passed. Eight route regressions failed before the correction and passed afterward, including both providers and stale-preview rejection.
- Both-provider browser checks passed: distinct import evidence, only the unrelated create approved, real local receipt persistence, pending holds, and 390px layout. Provider responses were simulated; zero live CRM requests.
- TypeScript, lint, both builds, script syntax, secret scan and diff checks passed.

## Decisions

- Reuse existing deterministic scoring and holds; scores are evidence rankings, not probabilities.
- Check all active saved rows, including ineligible neighbors, without selecting a winner or inferring an update target.
- Keep the dated native CRM evidence unchanged; this correction is qualified by local automated checks.

## Remaining

- Detection is limited to the current saved import and the visible, recent CRM snapshot. It does not coordinate simultaneous imports in other workspaces.
- Sparse or conflicting identities may evade the rules; conservative holds may flag different people.
- Legacy direct-sync and webhook routes do not use this governed create guard.

## Review First

- `lib/import-create-review.ts` and `lib/import-match.ts`.
- `tests/crm-import-comparison.test.ts` and `tests/import-create-review.test.ts`.
- `components/control-tower-dashboard.tsx`, `scripts/check-import-holds.mjs`, and `docs/import-crm-comparison.md`.
