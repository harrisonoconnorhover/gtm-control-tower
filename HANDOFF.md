# Morning Handoff

## Finished

- Proved a public GitHub clone can start without `.env`, credentials, or saved state, then persist and undo a workspace across an app restart.
- Removed hard-coded Docker container names and made host ports and runtime directories configurable so independent installs do not collide.
- Added a 72-row messy CRM fixture using public SEC company metadata and privacy-safe synthetic contacts.
- Added a reusable clean-install smoke test to local scripts and CI.
- Kept the static public showroom and self-hosted operator boundary intact.

## Try It

- Run `npm run smoke:fresh-install` for the disposable clean-machine acceptance test.
- Open `http://localhost:3000/app`, import `public/sec-public-company-messy-crm.csv`, and select **Validate + load**.
- Review the held records, apply repairs, then export the cleaned CSV or send it to a configured CRM.

## Checks

- `npm run smoke:fresh-install`: passed with empty temporary SQLite/n8n state and no credentials.
- `npm test`: 38/38 passed; ESLint, Vinext build, static public build, doctor, secret scan, Compose validation, deterministic fixture generation, and `git diff --check` passed.
- `npm run audit`: passed the high-severity gate; four moderate development-only esbuild advisories remain behind a breaking Drizzle downgrade.
- An independent shallow clone of public `main` completed startup, save, restart, reload, and undo before these fixes were added.

## Decisions

- Public source data is limited to company, ticker, exchange, and CIK; every person and contact field is synthetic.
- The smoke test uses random loopback ports and isolated temporary storage, then removes only the resources it created.
- The public site remains a static demonstration; real CSV and CRM operations remain self-hosted.

## Remaining

- Add a guided Google Sheets connection test when a second account is available.
- Add a compact sync-runs screen for connector receipts.
- Attach a custom public domain when the preferred hostname is chosen.

## Review First

- `scripts/fresh-install-smoke.sh`
- `scripts/generate_public_company_fixture.mjs`
- `tests/public-company-fixture.test.ts`
