# Lead routing through the unchanged Hollis form

The public form still asks only for first name, last name, business email, phone,
and company. These scenarios use that exact endpoint and real records in the
connected Salesforce development org. Marketing imports, ownership handoffs, and
enrichment are deliberately simulated with fictional records. No Marketo,
HubSpot, enrichment vendor, or scheduling service is connected by this work.

## Five scenarios to explain in an interview

| Scenario | What usually breaks | What this setup does |
| --- | --- | --- |
| Marketing Lead stuck in a queue | A webinar/import Lead lands with an SDR queue. A second form integration creates another person or cannot convert a queue-owned Lead. | Finds Morgan Reed by exact email, matches Cedar Analytics by company and domain, converts the existing Lead, and gives Alex Bennett the follow-up. No Opportunity is invented. |
| Ownership changed in only one place | A territory handoff changes the Account owner to Jordan while the Contact still belongs to Alex. A contact-first rule sends the inquiry to the wrong AE. | Reuses Priya Shah, preserves her Contact owner and original fields, and assigns the new task to Harbor Cloud's current Account owner, Jordan Hayes. |
| Shared corporate domain | Analytics and Commerce share a domain. Domain-only matching selects the wrong business unit; name-only matching can select an unrelated company. | Both normalized company name and exact domain must identify one Account. Devon Price at Meridian Analytics reaches Jordan; an unknown Meridian Group request is held with a review task and no new person. |
| Enrichment arrives after the form | Grace Kim's queued Lead arrives before reliable company/ownership data. A naive integration guesses an owner or creates a duplicate company. | Saves a held request and review task. After a trusted CRM update supplies Alder Systems and Jordan as owner, replaying the same request converts the Lead and updates that same task. |
| Lost response after Salesforce saves | Salesforce commits the records, but a webhook times out or the response body is interrupted. The caller retries and creates a second person or task. | The stable request ID returns the saved result. The Worker retries a network failure or 502/503/504 once, including a failure after response headers arrive. A new genuine submission gets its own task while reusing the person. |

The Account names above have a `Hollis Lab - ` prefix. All email domains end in
`.example`; account descriptions identify the records as fictional. Size and
location are simulated CRM context, not enrichment results from a vendor.
Alex remains the SMB/West AE and Jordan the Enterprise/East AE. The routing rule
uses the Account's assigned owner, not a guess from the submitter's phone number.

## A three-minute interview demonstration

Start with: "I kept the form short and moved the complexity into the integration.
It uses CRM identity and ownership to decide where the inquiry belongs, saves
uncertain matches for review, and preserves the request ID when delivery fails."

1. Show Priya's Contact owner beside the request's follow-up owner: Alex retains
   the existing Contact while Jordan receives the new task after an Account handoff.
2. Show Meridian Analytics versus Meridian Group: a shared domain needs company
   context; an ambiguous business unit gets a review task and no invented Contact.
3. Complete Mason's recovery below. Show the same task before and after correction.
   The lost-response drill offers a separate technical example of retrying safely.

Describe the companies and marketing imports as fictional practice data in a real
Salesforce development org. This demonstrates a working implementation, not a
claim of production scale or a connected marketing vendor.

## Try the ordinary form

Open [Hollis Consulting](https://hollis-consulting.harrisonoconnorhoover.workers.dev/#demo).
Phone can be left blank.

| First / last name | Business email | Company | Expected result |
| --- | --- | --- | --- |
| Avery Collins | avery@cedar-routing.example | Hollis Lab - Cedar Analytics | Alex; convert the queued marketing Lead |
| Priya Shah | priya@harbor-routing.example | Hollis Lab - Harbor Cloud | Jordan; Priya's Contact remains owned by Alex |
| Natalie Brooks | natalie@meridian-routing.example | Hollis Lab - Meridian Analytics | Jordan; exact business unit for a new person |
| Sam Lopez | sam@meridian-routing.example | Hollis Lab - Meridian Group | Held for review; no guessed company/person |
| Grace Kim | grace@alder-routing.example | Hollis Lab - Alder Systems | Jordan after the verified enrichment recovery |

Avery is a separate queued Lead left ready for your first manual demonstration.
Natalie is intentionally not pre-created as a Contact, so her first submission
exercises company matching. After either succeeds, the next genuine submission
reuses that Contact and creates a new follow-up task. For another first-time
business-unit example, use a fresh fictional email at `meridian-routing.example`.

The visitor sees only a request reference. In Salesforce, inspect the matching
`GTM_Demo_Request__c` record's **Routing Decision**, Account, Contact, Follow-Up
Owner, and **Follow-up or review task** link. The task description also explains the decision. The seed
records' original Lead Source and phone fields remain separate from request-level
source (`hollis-website`) and campaign (`request-a-demo`). Native Campaign creation
is unavailable to this connection, so Campaign membership is not part of this demo.

## Recover a held inquiry inside Salesforce

This exercise is ready to use without submitting another form or running code:

1. Open [Mason Turner's saved inquiry](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/a03g500000gj5kvAAA).
   It is **Held** because Bluebird's company name exists but its website is missing.
   Note the task link and request reference. No Contact has been created.
2. Open [Hollis Lab - Bluebird Data](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/001g500000gldc1AAA),
   set **Website** to `https://bluebird-routing.example`, and save. This represents
   a trusted company-data correction; Alex Bennett already owns the Account.
3. Return to Mason's inquiry, choose **Retry saved request**, review the saved
   details, and click **Retry saved request** in the action. Close the action and
   refresh the record. It should be **Routed** to Alex with a linked Contact and
   the **same task**, now assigned to Alex. Retrying again preserves those records.

The [Needs attention view](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/lightning/o/GTM_Demo_Request__c/list?filterName=00Bg500000OicqAEAR)
collects held, pending, and unfinished requests. **All demo requests** is available
from the same list selector. The record page separates routing results from the
original submission and includes a direct task link.

Correct the underlying Account or owner, not the original form fields. The retry
action checks the saved fingerprint, preserves source/campaign and request ID,
and refuses altered original details. It also supports older private Lead-only
requests using their original mode. It requires the Demo Intake Integration
permission set and existing record access.

[Elena Reed's completed recovery](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/a03g500000gj5UnAAI)
is the verified example: missing company website, held inquiry, trusted correction,
native retry action, then Jordan's follow-up using the original task. The native
action and record configuration were verified through Salesforce APIs; browser
interaction and visual rendering were not tested in this pass.

## Repeatable setup and verification

The initial September 10 live run created **five fictional Accounts, four Contacts, and
two converted marketing Leads**. One additional queued Lead, Avery, is ready for
the manual demonstration. Five unique verified requests produced five tasks: four
AE follow-ups and one review. Enrichment recovery and replay reused their tasks.
The subsequent recovery exercises added Willow Systems and Bluebird Data, with
Elena and Leo as verified Willow Contacts and Mason left held for the manual exercise.

Inspect the verified Salesforce requests:

- [Morgan: queue to Alex](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/a03g500000gip8HAAQ)
- [Priya: Contact owner Alex, follow-up owner Jordan](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/a03g500000gip9tAAA)
- [Devon: shared-domain match and duplicate-free replay](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/a03g500000gipBVAAY)
- [Sam: ambiguous business unit held for review](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/a03g500000giYaVAAU)
- [Grace: resumed after enrichment](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/a03g500000gipD7AAI)

```sh
node scripts/hollis-routing-scenarios.mjs seed
node scripts/hollis-routing-scenarios.mjs verify
node scripts/hollis-routing-scenarios.mjs recover
node scripts/hollis-routing-scenarios.mjs prepare-recovery
node scripts/verify-hollis-interrupted-receipt.mjs
```

The seed command reuses matching fictional records and never resets a converted
Lead. Verification submits the saved payloads through the public endpoint, reads
native Salesforce records, and asserts owners, conversion, identity reuse,
attribution preservation, review holds, and task reuse. It observes the public
rate limit and may wait one minute. Receipts and stable request IDs are stored in
ignored `.runtime/hollis-routing-scenarios.json`. Keep that file when rerunning;
it lets interrupted verification resume without making new submissions.

The first run demonstrates Grace's hold followed by enrichment and recovery.
Later runs verify the recovered state without undoing CRM work. `recover` verifies
Elena's native action; `prepare-recovery` leaves Mason's exercise ready and never
undoes a completed recovery. The interrupted-receipt command builds the current
Worker, makes real Salesforce intake calls, injects a local response-body failure
after the first successful CRM response, and verifies that the retry reused all
record IDs and one task. Its local authentication adapter uses the existing CLI
session; it does not test Cloudflare OAuth or interrupt the public website. Keep
ignored `.runtime/hollis-interrupted-receipt-proof.json` for duplicate-free reruns.
The public HTML, CSS, and browser form JavaScript are unchanged.

## Boundaries and checks

- Duplicate exact Contacts/Leads or exact Account matches stay in review. No
  automatic merging, fuzzy-name matching, or plus-address stripping is performed.
- An inactive Account owner requires review; the system does not invent a backup.
- Imported Account names with repeated whitespace are included in the candidate
  lookup, then checked by exact normalized name and domain. Literal `%` and `_`
  in names are escaped; a broader lookup never authorizes a fuzzy match.
- Historical routed requests remain unchanged on replay. A fresh inquiry uses
  the current Account owner. The private Lead-only intake keeps its prior policy.
- Prolonged outages still need a retry; no durable delivery queue or automatic
  enrichment subscription is represented here. Salesforce accepting a notification
  is separate from a person receiving it on a device.
- The Worker shares a 40-second deadline across token renewal, routing attempts,
  and receipt reading, leaving time inside the unchanged form's 45-second timeout.
- Focused checks: `npx vitest run tests/hollis-intake.test.ts tests/demo-intake.test.ts`,
  `npx tsc --noEmit`, focused ESLint, `GTMDemoIntakeTest` in Salesforce, and the live
  verification script above.

The retry design follows Salesforce's guidance to track unique message IDs for
[idempotent integration receivers](https://architect.salesforce.com/docs/architect/fundamentals/guide/integration-patterns).
