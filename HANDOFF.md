# Morning Handoff

## Finished

- Deployed five realistic routing scenarios behind the unchanged [Hollis form](https://hollis-consulting.harrisonoconnorhoover.workers.dev/#demo).
- Queued marketing Leads convert into the correct owned Account; new follow-ups use the current Account owner while existing Contact ownership and first-touch fields remain intact.
- Exact company-and-domain matching distinguishes shared-domain business units; uncertain matches stay visible through review tasks.
- Trusted CRM enrichment resumes a held request using the same task. A lost-response replay reuses the original records; the Worker retries transient failures once.
- Seeded five fictional Accounts; live submissions produced four Contacts, two converted marketing Leads, and five tasks. An additional queued Lead is ready for your manual demo. Routing decisions are recorded in Salesforce and task descriptions.

## Try It

Use the ready-to-type names, emails, companies, and native Salesforce links in [the routing walkthrough](docs/hollis-routing-scenarios.md).

Start with Priya Shah at `priya@harbor-routing.example`, company `Hollis Lab - Harbor Cloud`. The Contact stays with Alex; the new task goes to Jordan.

Repeat the automated walkthrough with `node scripts/hollis-routing-scenarios.mjs verify`. It reuses saved request IDs in ignored `.runtime/hollis-routing-scenarios.json` and reads native records back. `seed` is repeatable and does not reset converted Leads.

## Checks

- 22 Salesforce Apex tests passed; deployment `0Afg500000EfNjlCAF` succeeded.
- 20 focused application tests passed, including lost-response recovery, retry exhaustion, and conflict/throttle handling. TypeScript and focused ESLint passed.
- Worker build and deployment passed: `42d73461-8d61-4b90-8a56-25343175a935`.
- Live public endpoint checks verified queue conversion, account-owner precedence, preserved marketing fields, exact business-unit matching, ambiguity review, late-enrichment recovery, and request/task reuse. Native read-back confirmed five Accounts, four Contacts, and two converted Leads.
- Public HTML, CSS, form JavaScript, and form contract are unchanged. Diff and secret checks passed.

## Decisions

- Account ownership supplies trusted routing context; form fields do not guess tier, region, or an AE. Alex remains SMB/West and Jordan Enterprise/East.
- Marketing imports and enrichment are simulated with labeled fictional Salesforce data; no new marketing vendor connection or native Campaign membership is claimed.
- Preserve identity and first-touch fields. Conflicting evidence requires review rather than automatic merging.

## Remaining

- Long outages still require a retry; there is no durable background delivery queue. Enrichment recovery is explicitly replayed, not driven by a vendor subscription.
- Native Campaign creation is unavailable to the connected user. Salesforce accepted owner notifications; device receipt was not tested.

## Review First

- `docs/hollis-routing-scenarios.md` and its native Salesforce examples.
- `salesforce/force-app/main/default/classes/GTMDemoIntake.cls` and `hollis/worker.ts`.
- `scripts/hollis-routing-scenarios.mjs` and ignored live receipts in `.runtime/hollis-routing-scenarios.json`.
