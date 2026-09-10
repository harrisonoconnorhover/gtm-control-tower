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
| Lost response after Salesforce saves | Salesforce commits the records, but a webhook times out. The caller retries and creates a second person or task. | The stable request ID returns the saved result. The Worker retries a network failure or 502/503/504 once. A new genuine submission gets its own task while reusing the person. |

The Account names above have a `Hollis Lab - ` prefix. All email domains end in
`.example`; account descriptions identify the records as fictional. Size and
location are simulated CRM context, not enrichment results from a vendor.
Alex remains the SMB/West AE and Jordan the Enterprise/East AE. The routing rule
uses the Account's assigned owner, not a guess from the submitter's phone number.

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
Owner, and Task ID. The task description also explains the decision. The seed
records' original Lead Source and phone fields remain separate from request-level
source (`hollis-website`) and campaign (`request-a-demo`). Native Campaign creation
is unavailable to this connection, so Campaign membership is not part of this demo.

## Repeatable setup and verification

The September 10 live run created **five fictional Accounts, four Contacts, and
two converted marketing Leads**. One additional queued Lead, Avery, is ready for
the manual demonstration. Five unique verified requests produced five tasks: four
AE follow-ups and one review. Enrichment recovery and replay reused their tasks.

Inspect the verified Salesforce requests:

- [Morgan: queue to Alex](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/a03g500000gip8HAAQ)
- [Priya: Contact owner Alex, follow-up owner Jordan](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/a03g500000gip9tAAA)
- [Devon: shared-domain match and duplicate-free replay](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/a03g500000gipBVAAY)
- [Sam: ambiguous business unit held for review](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/a03g500000giYaVAAU)
- [Grace: resumed after enrichment](https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com/a03g500000gipD7AAI)

```sh
node scripts/hollis-routing-scenarios.mjs seed
node scripts/hollis-routing-scenarios.mjs verify
```

The seed command reuses matching fictional records and never resets a converted
Lead. Verification submits the saved payloads through the public endpoint, reads
native Salesforce records, and asserts owners, conversion, identity reuse,
attribution preservation, review holds, and task reuse. It observes the public
rate limit and may wait one minute. Receipts and stable request IDs are stored in
ignored `.runtime/hollis-routing-scenarios.json`. Keep that file when rerunning;
it lets interrupted verification resume without making new submissions.

The first run demonstrates Grace's hold followed by enrichment and recovery.
Later runs verify the recovered state without undoing CRM work. The lost-response
scenario replays a real saved request; a separate Worker test injects an actual
transport exception after a simulated CRM commit. This does not claim a real
vendor outage was caused. The public HTML, CSS, and browser form JavaScript are
unchanged.

## Boundaries and checks

- Duplicate exact Contacts/Leads or exact Account matches stay in review. No
  automatic merging, fuzzy-name matching, or plus-address stripping is performed.
- An inactive Account owner requires review; the system does not invent a backup.
- Historical routed requests remain unchanged on replay. A fresh inquiry uses
  the current Account owner. The private Lead-only intake keeps its prior policy.
- Prolonged outages still need a retry; no durable delivery queue or automatic
  enrichment subscription is represented here. Salesforce accepting a notification
  is separate from a person receiving it on a device.
- Focused checks: `npx vitest run tests/hollis-intake.test.ts tests/demo-intake.test.ts`,
  `npx tsc --noEmit`, focused ESLint, `GTMDemoIntakeTest` in Salesforce, and the live
  verification script above.

The retry design follows Salesforce's guidance to track unique message IDs for
[idempotent integration receivers](https://architect.salesforce.com/docs/architect/fundamentals/guide/integration-patterns).
