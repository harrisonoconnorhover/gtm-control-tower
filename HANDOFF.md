# Morning Handoff

## Finished

- Built Hollis Consulting's public website with original imagery, service and approach content, privacy notice, and the five-field demo form.
- Extended Control Tower's Salesforce intake to create/reuse linked Accounts and Contacts, convert suitable existing Leads, and preserve ownership.
- Added domain locking, owner review tasks for ambiguity, and retry-safe follow-up activity while preserving the existing operator intake.
- Added a public Cloudflare entry point with automatic Salesforce session renewal and server-only credentials.

## Try It

Local preview: `http://127.0.0.1:4192/` (static preview only). The public release and native submission proof are in progress. Deployment instructions: `docs/hollis-consulting.md`.

## Checks

- Salesforce deployment: 31 components, 17 Apex tests passed.
- All 101 application tests passed, including public intake boundaries and existing operator behavior.
- TypeScript and syntax checks passed. Full Sites build and Cloudflare Worker dry-run passed.
- Secret scan passed; lint's default-export warning was fixed and focused lint passed.

## Decisions

- Publish a dedicated Worker in the user's Cloudflare account; preserve existing Pages projects and the private operator app.
- Require company name/domain agreement for existing Accounts; do not invent websites, territories, or tiers.
- New Accounts use the integration owner. Held matches require human review in Salesforce.

## Remaining

- Publish the configured Worker and verify public submissions against native Salesforce records.

## Review First

- `hollis/worker.ts` and `hollis/site/index.html`.
- `salesforce/force-app/main/default/classes/GTMDemoIntake.cls`.
- `docs/hollis-consulting.md`.
