# Morning Handoff

## Finished

- Corrected Docker connector setup: `.env` loads automatically, `.env.local` requires `--env-file`, the app uses the `n8n` service hostname, and changed values require recreating the app.
- HubSpot instructions distinguish Docker from Node development and include the existing production sync-key requirement.
- Sheets documentation separates the August 26 receipt (44 ready, 12 held) from the revised local fixture (seven merges, 57 canonical records, 46 ready, 11 held).
- The previous public runtime remains unchanged: browser CSV audit, all 64 record decisions, shared identity rules, lifecycle coverage and CSV-first operator setup.

## Try It

1. Run `docker compose up --build`, then open `http://localhost:3000/app/lab` for the account-free CSV workspace.
2. When adding a connector, follow `docs/self-hosting.md` and the provider guide. Use `.env` with `docker compose up -d app`, or explicitly pass `--env-file .env.local`.
3. Open [the public demo](https://gtm-control-tower.pages.dev/#decisions), run cleanup, and inspect or download record decisions.

## Checks

- This documentation pass: isolated Compose configuration checks with synthetic values confirmed default `.env` and explicit `.env.local` loading; default Compose ignored `.env.local` as expected. No containers or provider calls were started.
- Focused documentation links, sample-count references, handoff structure and `git diff --check` passed. Runtime tests and builds were not rerun for prose-only changes.
- Previous runtime release: 89 tests passed; lint, operator/public builds and [CI for `569e568`](https://github.com/harrisonoconnorhover/gtm-control-tower/actions/runs/36332613775), including Docker smoke, passed. Deployment `c176923b` serves that runtime; its canonical assets and browser workflow were verified previously.

## Decisions

- Document existing environment and network behavior without changing runtime configuration.
- Preserve historical provider receipts; local fixture results do not establish a new connected run.
- Mirrored the four relevant documents locally as `9aa0641`; preserved the development handoff and unrelated product work without pushing that branch.

## Remaining

- No runtime rebuild, static-site redeployment or provider requalification is needed for this documentation correction.
- Historical provider benchmarks were not rerun; no new connected results are claimed.

## Review First

- `docs/self-hosting.md` and `docs/hubspot-csv-setup.md`.
- `docs/google-sheets-setup.md`.
- `docs/decisions.md` and this handoff.
