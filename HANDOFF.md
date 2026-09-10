# Morning Handoff

## Finished

- Published [Hollis Consulting](https://hollis-consulting.harrisonoconnorhoover.workers.dev) in Harrison's Cloudflare account, with original imagery, consulting content, privacy notice, and the five-field demo form.
- Connected the public form to GTM Control Tower's Salesforce transaction: linked Account/Contact creation, exact identity matching, owner preservation, and native Lead conversion.
- Added follow-up tasks, owner notifications, and review tasks for ambiguous company matches. Request retries reuse activity.
- Configured server-only Salesforce authorization with automatic session renewal; existing Pages projects and the private operator app remain intact.

## Try It

Open the public site and choose **Request a demo**. All fields except phone are required.

Inspect the actual browser submission: [Maya Thompson](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/003g500000gi7GyAAI), [company](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/001g500000gkQPLAA2), and [follow-up task](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/00Tg500002TAh5BEAT). These are clearly labeled fictional verification records in the development org.

Deployment and matching rules: `docs/hollis-consulting.md`.

## Checks

- Submitted the published form in a browser; its success reference matched native Salesforce Account, Contact, Demo Request, and Task records.
- Seven genuine live requests produced seven distinct tasks: six routed requests and one ambiguity review. Same-request replay reused its task; a new submission reused its Contact; a colleague reused its Account; Guesty's known website matched correctly.
- Concurrent new-company requests produced one Account, two Contacts, and two Tasks after a same-ID retry resolved the initial collision. Native records and links were read back; details are in ignored `.runtime/hollis-live-proof.json`.
- 101 application tests and 17 Apex tests passed. TypeScript, lint, syntax, full Sites build, Worker build/deployment, secret scan, and diff checks passed.
- Public pages/assets returned 200; private API, environment file, and missing-page requests returned 404. Salesforce accepted owner notifications; device delivery was not tested.

## Decisions

- Require company name/domain agreement to reuse Accounts; preserve existing Contact identity and ownership.
- Leave unverified websites, company sizes, tiers, and regions unset. New Accounts belong to the integration user.
- Keep held inquiries visible through owner review tasks instead of guessing a company match.

## Remaining

- Temporary Salesforce contention can require a form retry; the same request ID prevents duplicates.
- AE territory/tier assignment is future work, since the requested form supplies neither value.

## Review First

- `hollis/site/index.html` and `hollis/worker.ts`.
- `salesforce/force-app/main/default/classes/GTMDemoIntake.cls`.
- `docs/hollis-consulting.md` and the live Salesforce links above.
