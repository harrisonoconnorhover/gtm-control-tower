# Morning Handoff

## Finished

- Deployed Salesforce's **Retry saved request** action, **Needs attention** view, expanded request page, and direct task links.
- Corrected CRM data can resume an inquiry without re-entering form details, changing original attribution, or duplicating its task. Older Lead-only requests retain their original mode.
- Worker recovery now handles an interrupted response body after Salesforce saves, with a 40-second total deadline inside the existing form timeout.
- Imported company names with repeated spaces no longer hide conflicting company matches and cause duplicates.
- Left Mason Turner held at fictional Bluebird Data for your manual recovery demo; Elena's completed recovery and Leo's interrupted-response drill are verified examples.

## Try It

Follow [the routing walkthrough](docs/hollis-routing-scenarios.md), including its native Salesforce links. For Mason: add `https://bluebird-routing.example` to Bluebird's Website, then choose **Retry saved request** on his inquiry. Refresh to see Alex's follow-up using the same task.

Run `node scripts/hollis-routing-scenarios.mjs verify` for the five original cases; `recover` verifies Elena's native retry. Run `node scripts/verify-hollis-interrupted-receipt.mjs` for a local connection-failure drill using real Salesforce. Keep ignored `.runtime/` receipts so reruns reuse the same IDs.

## Checks

- 28 Salesforce Apex tests passed; deployment `0Afg500000EfWFBCA3` succeeded. Task-link metadata deployment `0Afg500000EfWNFCA3` succeeded.
- 22 focused application tests, TypeScript, Node syntax, and focused ESLint passed. Worker build/deploy passed: `5cca7354-4967-4f9a-b276-47ff7242bf4d`.
- All five original scenarios passed through the deployed public endpoint. Native retry recovered Elena with one task. The locally interrupted real-Salesforce response recovered with identical record IDs and one task.
- Salesforce APIs confirmed the action, layout, task hyperlink, and Mason's ready held state. Browser interaction/visual rendering was not tested.
- Public HTML, CSS, and form JavaScript are unchanged. Diff and secret checks passed; no credentials are committed.

## Decisions

- Account ownership supplies routing context. Alex remains SMB/West and Jordan Enterprise/East; form fields do not guess tier or territory.
- Recovery belongs in native Salesforce and reuses the existing transaction. Original submission details remain protected by their fingerprint.
- Marketing/enrichment fixtures and the connection failure are simulated; Salesforce writes and read-back are real. No new vendor integration is claimed.

## Remaining

- Long outages still require a retry; there is no durable background queue or automatic vendor enrichment subscription.
- Native Campaign creation remains unavailable. Notification device delivery was not tested.

## Review First

- The routing walkthrough and Mason's saved Salesforce inquiry.
- `GTMDemoIntake.retrySavedRequest`, its Screen Flow, and `hollis/worker.ts`.
- The interrupted-receipt script and ignored native receipts under `.runtime/`.
