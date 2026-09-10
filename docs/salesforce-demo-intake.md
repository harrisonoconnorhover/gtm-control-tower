# Connected Salesforce demo intake

The connected form keeps existing people and ownership intact, then adds a
follow-up task for each genuine demo request. A technical retry reuses the same
request and task. Salesforce owns matching and follow-up; Control Tower captures
input and displays the provider receipt.

## Try it

1. Start the full application with `npm run dev` and open `/#inbound-lab` or
   `/app/inbound`. Choose **Use Salesforce**. The static showroom remains a
   browser-local practice app.
2. Submit fictional details for a Contact or Lead already in the connected org.
   Open the person and task from the result. The owner is preserved and the
   **Last Demo Requested** field is updated.
3. Click **Retry same request**: the request and task links stay the same.
4. Click **Start a new submission**, keep the email, and submit again: the person
   stays the same while a new task and notification request are created.

The connected form explicitly says it writes to Salesforce. Each pending form
body and request ID is retained in this tab's session storage before sending.
Reloading the tab lets the operator reconcile that original request. Salesforce
credentials never enter the browser. An operator key, when required, stays in
component memory and must be entered again after leaving the connected form.

## Install in your development org

Use the existing Salesforce CLI connection and the repository's server setup:

```sh
sf project deploy start --target-org YOUR_ORG --manifest salesforce/manifests/demo-intake.xml --test-level RunSpecifiedTests --tests GTMDemoIntakeTest --wait 10
sf org assign permset --target-org YOUR_ORG --name GTM_Demo_Intake_Integration
npm run configure:salesforce -- YOUR_ORG
npm run dev
```

The connection uses the ignored `.env.local` variables
`SALESFORCE_INSTANCE_URL`, `SALESFORCE_ACCESS_TOKEN`, and the existing setup
script. Refresh an expired session with the same configure command. Do not put
credentials in a public form or commit them. Production requires the existing
`CONTROL_TOWER_SYNC_KEY`; enter that operator key in connected mode. This endpoint
is an authenticated operator integration, not an anonymous public CRM write API.

The integration permission set allows matching across Leads and Contacts and
creating/updating the new intake records and tasks. The integration account also
needs write access to the people whose activity timestamp it updates. Use an
appropriately shared service account; failed Salesforce permissions roll back the
transaction instead of elevating privileges. Do not assign this permission set
to guest users. Requests and identity locks should use one integration account.

## Salesforce records and policy

- **Demo Request** (`GTM_Demo_Request__c`): immutable request key and payload
  fingerprint; original form fields and attribution; received time; matched
  Lead/Contact; follow-up owner/task; status and notification outcome.
- **Demo Intake Identity** (`GTM_Demo_Identity__c`): a unique hash of normalized
  email used to serialize intake for that email. It holds no profile data.
- **Task**: linked to the existing or newly created person, assigned to the
  active owner, high priority, due today, with form source/campaign/request ID.
- **Last Demo Requested**: a timestamp on both Lead and Contact. Older requests
  cannot move it backwards. Existing profile fields and ownership are preserved.
- **Demo Request Follow-up**: a Salesforce desktop/mobile custom notification
  linking the owner to the person. "Requested" means Salesforce accepted the
  notification operation; it does not prove delivery to a device or human reading.

Matching searches **both Contacts and unconverted Leads**. One match is reused;
zero creates a Lead; more than one is held. Converted Leads are excluded so their
resulting Contact can be reused. Queue or inactive ownership is held until an
active owner is assigned in Salesforce. Retrying a held request reruns matching.

New Leads initially belong to the connected integration user, the pilot's intake
owner. The practice region/budget pools are not applied to live Salesforce.
Changing this default is a future business policy decision, not an implicit
ownership transfer for existing records.

## Retry and transaction behavior

```text
Form → Control Tower server → Salesforce intake
                             ├─ unique request ID + email lock
                             ├─ match Contact / unconverted Lead
                             ├─ create or reuse person
                             └─ task + last-request date + owner notification
```

`GTMDemoIntake` is a Salesforce Apex REST service at
`/services/apexrest/gtm/demo-intake`. Apex keeps person matching, creation, and task
creation in one transaction with an email-specific lock. Two different requests
for the same email cannot both create a person through this intake. A race to
create the initial lock returns a retryable response; the original request ID
must be retained. Unrelated integrations still require Salesforce duplicate
rules and their own correct write behavior.

A repeated request ID returns its existing receipt. Reusing that ID with changed
form details returns HTTP 409. A failed Salesforce transaction rolls back the
request, new person, and task together. A notification failure retains the
successful task as **Notification pending**; retry attempts only the unfinished
notification. The web app does not automatically generate a new ID after an
unknown response.

## Verification

- `npx vitest run tests/demo-intake.test.ts tests/inbound-lab.test.ts` checks the
  server boundary, input/receipt contracts, retry IDs, per-request activity, and
  practice persistence compatibility.
- `GTMDemoIntakeTest` checks Contact/Lead reuse, converted Leads, ownership,
  ambiguity holds, new requests versus retries, notification recovery,
  transaction rollback, and permission enforcement in Salesforce.
- `node --env-file=.env.local scripts/verify-demo-intake.mjs LOCAL_APP_URL` runs
  the synthetic end-to-end proof against the running app and reads records back
  from Salesforce. Its request IDs and receipts persist under ignored `.runtime/`
  so rerunning reconciles the same requests. It creates a fictional Contact,
  Leads, tasks, and notifications for the connected user. Inspect its recorded
  IDs when cleaning up development data; it performs no deletions.

## Verified development-org result

On September 10, 2026, the metadata deployment succeeded with 29 components and
all 10 Apex tests passing (169/169 executable service locations covered). The
local application's live API proof created six request records and six tasks
across three people: one existing Contact and two new Leads. Retrying the first
request reused its task; two concurrent requests shared one Lead after a
technical retry. Native Salesforce reads confirmed the records, owners, tasks,
and Contact timestamp. Salesforce accepted six notification requests. Device
delivery and human reading were not verified.

Local checks passed: 93 tests across 18 files, TypeScript, lint, and both app and
static builds. Runtime identifiers remain in ignored `.runtime/demo-intake-proof.json`.
