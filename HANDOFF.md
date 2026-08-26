# Morning Handoff

## Finished

- Imported the 72-row SEC fixture through the visible CSV workflow and executed eight duplicate merges, six reroutes, and four lifecycle replays.
- Synced 58 governed contacts to HubSpot with a complete native receipt; eight merged and six malformed-email rows stayed out.
- Verified Salesforce contains 58 unique active Leads for the batch, then reran it with zero creates, 58 updates, and zero failures.
- Added provider-compatible IDNA email normalization after HubSpot correctly surfaced six rejected internationalized test domains.
- Saved both final CRM receipts in the durable workspace and documented the live acceptance result.

## Try It

- Open `/app`, choose **CSV file**, and import `public/sec-public-company-messy-crm.csv`.
- Select **Validate + load**, then execute merge, reroute, and lifecycle replay.
- Choose a configured CRM and sync the 58 eligible identities; inspect its per-record receipt before rerunning.

## Checks

- HubSpot: final receipt wrote 58/58 with zero failures; the retry updated prior successes instead of creating duplicates.
- Salesforce: SOQL read-back returned 58 unique emails, zero missing, and zero duplicates; rerun was 0 created / 58 updated / 0 failed.
- `npm test` passed 38/38; lint, app build, static build, doctor, secret scan, Compose validation, deterministic fixture check, diff check, and fresh-install smoke passed.
- `npm run audit` passed the high-severity gate; four moderate development-only esbuild advisories remain behind a breaking Drizzle downgrade.

## Decisions

- Internationalized email domains retain their diagnostic flag, while governed writes use the provider-compatible ASCII IDNA identity.
- CRM gates intentionally exclude held and merged records; trustworthy output does not mean writing every input row.
- The public site remains a static demonstration; real CSV and CRM operations remain self-hosted.

## Remaining

- Add a compact sync-runs screen for connector receipts.
- Add a guided Google Sheets connection test when a second account is available.
- Attach a custom public domain when the preferred hostname is chosen.

## Review First

- `lib/csv-control-tower.ts`
- `scripts/generate_public_company_fixture.mjs`
- `tests/public-company-fixture.test.ts`
