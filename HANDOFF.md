# Morning Handoff

## Finished

- Added Salesforce as an independently selectable governed CSV destination alongside HubSpot.
- Added query-first Lead identity: create on zero email matches, update on one, and hold duplicate matches.
- Added Salesforce-required company/last-name gates, standard-field limits, 100-record batches, and per-row receipts.
- Added a safe CLI-to-`.env.local` configurator; its ignored file is owner-readable and never prints the token.
- Live proof created then updated the same synthetic Salesforce Lead `00Qg5000007ulRdEAI`.

## Try It

- Run `sf org login web --alias gtm-control-tower-salesforce --set-default`, then `npm run configure:salesforce`.
- Restart the site, import a CSV, and repair held duplicates or lifecycle regressions.
- Sync either destination; Salesforce creates or updates Leads and shows the native ID on each row.

## Checks

- `npm test`: 20/20 passed, including Salesforce gate, contracts, receipt aggregation, and query-first branching.
- `npm run lint`: passed with no warnings.
- `npm run build`: passed with both CRM API routes.
- Live Salesforce route receipts: one create, then one update; both used `00Qg5000007ulRdEAI`.
- SOQL verification: exactly one matching Lead with the updated title.

## Decisions

- Salesforce `Email` is not treated as an external ID; ambiguous matches fail closed.
- Send only governed standard fields; never write owner, status, lifecycle, score, or custom fields.
- Require `CONTROL_TOWER_SYNC_KEY` for production writes and refreshable OAuth for long-running hosting.

## Remaining

- Optionally archive the clearly labeled HubSpot and Salesforce proof records after review.
- Add lifecycle/owner preflight only if provider-side writes become valuable.
- Replace the copied local Salesforce token with connected-app token refresh for hosted use.
- Add stable authenticated HTTPS hosting before publishing CRM mutation controls.

## Review First

- `app/api/control-tower/salesforce-sync/route.ts`
- `lib/salesforce-sync.ts`
- `docs/salesforce-csv-setup.md`
