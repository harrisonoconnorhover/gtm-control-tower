# Morning Handoff

## Finished

- Connected the inbound form to the project's Salesforce development org; choose **Use Salesforce** from the lab.
- Added Salesforce intake records, Contact/unconverted Lead matching, owner preservation, follow-up tasks, last-request timestamps, and desktop/mobile notification requests.
- Added request-ID reconciliation and an email lock so retries reuse activity and competing submissions share one person.
- Updated practice mode to create activity per genuine submission; older local traces are retained without invented tasks.
- Added portable metadata, setup guidance, and a repeatable live proof script with saved request IDs.

## Try It

Refresh `http://127.0.0.1:4176/#inbound-lab`, choose **Use Salesforce**, and submit the fictional Elena Foster preset. Open the person and task from the receipt. **Retry same request** keeps the task; **Start a new submission** creates fresh activity for the same person.

For another checkout: deploy `salesforce/manifests/demo-intake.xml`, assign `GTM_Demo_Intake_Integration`, configure the existing Salesforce connection, then run `npm run dev`. See `docs/salesforce-demo-intake.md`.

## Checks

- Salesforce deployment succeeded: 29 components; 10 Apex tests passed, with 169/169 executable service locations covered.
- Live app-to-Salesforce proof: six request records, six tasks, three people; existing Contact preserved, two new Leads, repeated request reused its task, concurrent requests shared one Lead. Salesforce accepted six notifications.
- `npm test`: 93 tests passed across 18 files.
- TypeScript, repository lint, public build, and Sites full build passed. Local root and intake health returned HTTP 200. Secret, diff, and company-reference checks passed.
- Live request IDs and native read-back receipts are in ignored `.runtime/demo-intake-proof.json`; no device-delivery or browser-interaction test was performed.

## Decisions

- Salesforce Apex owns the transaction and email lock; credentials stay on the server behind the existing operator boundary.
- Each genuine submission gets activity. Changed input cannot reuse an old request ID. Notification retries preserve the task.
- Existing queue/inactive ownership is held. New Leads initially belong to the connected integration user; the simulated rep pools do not route real Salesforce records.

## Remaining

- Public site publication still awaits the earlier approval; the static showcase remains practice-only.
- A production integration account needs appropriate CRM record access and `CONTROL_TOWER_SYNC_KEY`; this is not an anonymous public intake endpoint.
- The development proof leaves its fictional records and tasks for inspection. Notification acceptance does not prove human reading or device delivery.

## Review First

- `salesforce/force-app/main/default/classes/GTMDemoIntake.cls` and its tests.
- `app/api/control-tower/demo-intake/route.ts` and `components/salesforce-demo-intake.tsx`.
- `docs/salesforce-demo-intake.md`.
