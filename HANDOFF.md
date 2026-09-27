# Morning Handoff

## Finished

- CSV preview/import reject inconsistent row widths; the synthetic demo uses shared raw-email rules, preserving corporate plus addresses and encoding internationalized domains correctly.
- All 64 cleanup records expose before/after state, rules, Ready/Held/Merged status, remaining blockers, and downloadable JSON. Incoming `#decisions` links work before a run; keyboard focus and mobile layout are supported.
- Rerouting clears resolved missing-owner flags without clearing independent blockers. The sample produces seven merges, 57 canonical records, 46 ready and 11 held.
- Dependency patches remove all reported high/critical findings; CI now builds the public site too. The high-severity audit gate is unchanged.
- Further improvements disclose missing/partial lifecycle comparison coverage, expose mapped headers, lead new installations to the account-free CSV workspace, and clarify dated connector evidence.

## Try It

1. Open [the public demo](https://gtm-control-tower.pages.dev/#decisions), run cleanup, and use the merged/owner/held examples. Download decisions and reconcile all 64 records.
2. In the CSV audit, try an unquoted comma in a company field, then its quoted equivalent. Missing expected-stage data must produce a visible coverage limitation.
3. Self-host with `docker compose up --build`, then open `http://localhost:3000/app/lab`. `/app` is the optional configured-CRM scanner.

## Checks

- Local full suite: 89 tests passed across 17 files. Full lint, operator build, public build, doctor, dependency audit, secret scan and dependency-tree checks passed.
- Browser: merged pair, owner change, held record, status filter, actual JSON download, malformed/quoted CSV, partial-coverage Markdown download, and fresh `#decisions` landing verified. Mobile at 390px had no page overflow; keyboard expansion/collapse retained focus.
- Downloaded JSON reconciled 46 Ready + 11 Held + 7 Merged, retained original CSV, preserved the corporate alias, and showed IDNA plus the corrected invalid-email hold.
- Remote CI, fresh Docker install, canonical deployment and final setup navigation verification are pending. No live CRM/provider qualification is claimed.

## Decisions

- Reuse the existing importer, repair engine and destination gate; expose decisions without a second cleanup implementation.
- Report measured sample counts and comparison coverage separately from readiness. A supplied expected stage is not CRM history.
- Preserve unrelated development work. Four moderate Drizzle/esbuild toolchain advisories remain below the unchanged audit threshold.

## Remaining

- Publish and verify the reviewed release, including passing public CI and the isolated Docker smoke test.
- Align the personal website's sample counts and decision link with the published release.

## Review First

- `lib/csv-control-tower.ts`, `lib/demo-decisions.ts` and their regression tests.
- `components/public-demo.tsx` and `components/instant-crm-audit.tsx`.
- `.github/workflows/ci.yml`, `README.md` and `docs/decisions.md`.
