# Morning Handoff

## Finished

- CSV preview/import reject inconsistent row widths; the synthetic demo uses shared raw-email rules, preserving corporate plus addresses and encoding internationalized domains correctly.
- All 64 cleanup records expose before/after state, rules, Ready/Held/Merged status, remaining blockers, and downloadable JSON. Incoming `#decisions` links work before a run; keyboard focus and mobile layout are supported.
- Rerouting clears resolved missing-owner flags without clearing independent blockers. The sample produces seven merges, 57 canonical records, 46 ready and 11 held.
- Dependency patches remove all reported high/critical findings; CI now builds the public site too. The high-severity audit gate is unchanged.
- Further improvements disclose lifecycle comparison coverage and mapped headers. New installations start in CSV mode with actual imported metrics; synthetic warehouse results no longer appear as current native checks.

## Try It

1. Open [the public demo](https://gtm-control-tower.pages.dev/#decisions), run cleanup, and use the merged/owner/held examples. Download decisions and reconcile all 64 records.
2. In the CSV audit, try an unquoted comma in a company field, then its quoted equivalent. Missing expected-stage data must produce a visible coverage limitation.
3. Self-host with `docker compose up --build`, then open `http://localhost:3000/app/lab`. `/app` is the optional configured-CRM scanner.

## Checks

- Local full suite: 89 tests passed across 17 files. Full lint, operator/public builds, doctor, audit, secret scan and dependency-tree checks passed. Final dashboard/download changes also passed TypeScript, focused lint and both affected builds.
- Browser: merged pair, owner change, held record, status filter, actual JSON download, malformed/quoted CSV, partial-coverage Markdown download, and fresh `#decisions` landing verified. Mobile at 390px had no page overflow; keyboard expansion/collapse retained focus.
- Downloaded JSON reconciled 46 Ready + 11 Held + 7 Merged, retained original CSV, preserved the corporate alias, and showed IDNA plus the corrected invalid-email hold.
- [Final CI on `569e568`](https://github.com/harrisonoconnorhover/gtm-control-tower/actions/runs/36332613775) passed every gate, including isolated Docker smoke. Fresh setup, sample mapping/import and a 14-row local reroute with saved receipt passed browser checks.
- Final Cloudflare deployment `c176923b` serves source `569e568`; canonical HTML/JS/CSS matched local files exactly. Live cleanup, held-record inspection and final Markdown download passed. No live CRM/provider qualification is claimed.

## Decisions

- Reuse the existing importer, repair engine and destination gate; expose decisions without a second cleanup implementation.
- Report measured sample counts and comparison coverage separately from readiness. A supplied expected stage is not CRM history.
- Preserve unrelated development work; runtime mirrored locally through `4feb2fe` without pushing it. Four moderate Drizzle/esbuild toolchain advisories remain below the unchanged audit threshold.

## Remaining

- No required work remains. Personal-site source `b8fca2a` was built by GitHub Pages and canonical HTML byte-matched the corrected counts and runnable link. Historical provider benchmarks were not rerun.

## Review First

- `lib/csv-control-tower.ts`, `lib/demo-decisions.ts` and their regression tests.
- `components/public-demo.tsx` and `components/instant-crm-audit.tsx`.
- `.github/workflows/ci.yml`, `README.md` and `docs/decisions.md`.
