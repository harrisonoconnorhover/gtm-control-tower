# Inbound Routing Lab

A working, browser-local practice flow for demo requests and lead routing. Practice mode uses fictional records and simulated CRM actions in this browser.
Connected Salesforce mode sends submissions through the server to the configured
Salesforce org. See [Salesforce intake setup](salesforce-demo-intake.md).

## Open and practice

Run `npm run preview:public` and open the printed address with `/#inbound-lab`.
The self-hosted application also exposes `/app/inbound`. The showroom navigation
links to the same component. No account or credential is required.

The initial session contains 32 fictional requests: 28 routed, four held,
27 unique CRM contacts, 28 follow-up tasks, and 28 simulated notifications. The deliberate repeat
explains why successful requests exceed contacts. Reserved `.example` addresses
and 555-01xx phone numbers avoid usable contact destinations. Company budgets
and regions are consistent within the generated batch.

1. Submit **New growth brand**. Expand its captured payload and CRM record.
   Explain how source field 3 becomes a normalized email and why the selected
   East growth rep wins. Repeat the submission and compare contact/notification
   counts.
2. Filter the queue to **Held**, inspect **Missing enrichment**, and select
   **Correct source fields**. Choose a region in enrichment and save the correction.
   Compare the old and new attempts. Other holds cover bad email, conflicting
   company/domain evidence, and an unavailable account owner.
3. Under **Break a handoff**, choose **Lose response after creation**. Submit
   **Enterprise prospect** with a fresh fictional email. A CRM record now exists
   without an assignment. Restore healthy settings and retry the same request.
   It finishes with one record, one assignment, and one notification.
4. With another new email, fail the rep notification. Inspect the completed CRM
   assignment, restore notifications, and retry. Assignment and capacity remain
   unchanged while the unfinished notification completes.

Submitted practice state is saved in this browser's local storage. Pending form
and correction edits stay in tab memory when you visit the overview or CSV
workspace and return; refreshing or closing the tab discards those pending edits.
**Export session** downloads the
synthetic CRM state, payloads, enrichment, and each attempt. **Reset practice**
clears the session and restores the starting account/rep pool. This is a practice
session, not a durable shared queue; multiple tabs do not coordinate writes.

## Practice form schema

The lab models a five-field demo request using WPForms-style payload keys.
These keys are a concrete mapping exercise; no form service is connected.

| Field | Practice payload key | Required |
| --- | --- | --- |
| First name | `wpforms[fields][10]` | Yes |
| Last name | `wpforms[fields][11]` | Yes |
| Business email | `wpforms[fields][3]` | Yes |
| Phone | `wpforms[fields][4]` | No |
| Company | `wpforms[fields][5]` | Yes |

Region, media budget, source, and campaign are added as separate synthetic
context. The lab's routing decisions and recovery behavior use this context.

## Lab policy and scope

`Capture → map → match → choose owner → CRM upsert → assign → create task → notify`

- The numeric field mapping follows the practice schema above. Region, monthly media
  budget, source, and campaign are separate synthetic context added by this lab.
- Exact normalized email identifies a contact. Exact business domain identifies
  an existing account. Conflicting known company/domain evidence is held.
- Preserve active contact/account owners, even above pool capacity. An unavailable
  existing owner is held for review. Restoring availability allows a retry.
- New prospects use region and budget: $35,000/month or more selects Enterprise;
  smaller budgets select Growth. Among active reps with capacity, choose the
  lowest assigned/capacity ratio and break ties by rep ID.
- A retry reconciles a partially created record by email. Assignment consumes
  capacity once. Each genuine submission creates its own task and notification.
  Retrying that same request reuses the task and suppresses duplicate notifications.
- Contact source attribution is kept from its first successful creation. Each
  request still retains its own source and campaign. Existing contact fields
  are not silently overwritten.
- Attempts preserve their payload and enrichment snapshots. After a CRM record
  exists, changing its email through correction is refused to prevent creating a
  second identity during recovery.

These pool and enrichment rules belong to practice mode. Connected intake uses
Salesforce person matching and ownership, and stores real request and task records.
Older practice sessions retain their original traces; the upgrade does not invent
historical tasks. New requests use the current activity policy.

## Verification

`npx vitest run tests/inbound-lab.test.ts` covers field mapping, optional phone,
owner preservation, pool capacity, review holds, duplicate requests, partial-write
recovery, notification recovery, corrected input history, and repeatable fixtures.

The core is `lib/inbound-lab.ts`; both entry points use
`components/inbound-lead-lab.tsx`. Existing CSV, native CRM, and Salesforce proof
workflows retain their separate behavior.
