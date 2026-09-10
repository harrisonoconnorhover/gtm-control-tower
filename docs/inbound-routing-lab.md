# Inbound Routing Lab

A working, browser-local practice flow inspired by the public fields on MNTN's
demo form. Every CRM record, account, rep, notification, and routing rule in this
lab is simulated. It does not send requests to MNTN or use their private systems.

## Open and practice

Run `npm run preview:public` and open the printed address with `/#inbound-lab`.
The self-hosted application also exposes `/app/inbound`. The showroom navigation
links to the same component. No account or credential is required.

The initial session contains 32 fictional requests: 28 routed, four held,
27 unique CRM contacts, and 27 simulated notifications. The deliberate repeat
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

State is saved in this browser's local storage. **Export session** downloads the
synthetic CRM state, payloads, enrichment, and each attempt. **Reset practice**
clears the session and restores the starting account/rep pool. This is a practice
session, not a durable shared queue; multiple tabs do not coordinate writes.

## What Chrome inspection established

Read-only inspection of [MNTN's request-demo page](https://mountain.com/request-demo/)
on September 10, 2026 found:

| Evidence | Observed value |
| --- | --- |
| Visible form | `wpforms-form-91088` |
| Form classes | `wpforms-validate wpforms-form wpforms-ajax-form` |
| Form action / method | `/request-demo/` / `post` |
| AJAX configuration | `https://mountain.com/wp-admin/admin-ajax.php` |
| First name | `wpforms[fields][10]`, required |
| Last name | `wpforms[fields][11]`, required |
| Business email | `wpforms[fields][3]`, required |
| Phone | `wpforms[fields][4]`, optional; visible telephone input uses a `wpf-temp-` prefix |
| Company | `wpforms[fields][5]`, required |

Loaded assets included WPForms frontend JavaScript at
`/wp-content/plugins/wpforms/assets/js/frontend/wpforms.min.js?ver=2.0.1.1`,
WPForms phone support and intlTelInput, and WordPress theme scripts.
Marketo Forms 2 also loaded from
`https://pages.mountain.com/js/forms2/js/forms2.min.js`, together with a
FormsPlus script. That establishes script presence, not that this visible form
submits to Marketo.

Hidden inputs included additional numbered fields and page/referrer metadata.
Their business meanings were not established. We did not submit the form or
observe a submission response. The server-side integration, any CRM mapping,
LeanData involvement, deduplication, routing rules, and downstream outcomes remain
unverified. WordPress's configured AJAX URL is not a captured submission receipt.

## Lab policy and scope

`Capture → map → match → choose owner → CRM upsert → assign → notify`

- The numeric field mapping follows the observed form. Region, monthly media
  budget, source, and campaign are separate synthetic context added by this lab.
- Exact normalized email identifies a contact. Exact business domain identifies
  an existing account. Conflicting known company/domain evidence is held.
- Preserve active contact/account owners, even above pool capacity. An unavailable
  existing owner is held for review. Restoring availability allows a retry.
- New prospects use region and budget: $35,000/month or more selects Enterprise;
  smaller budgets select Growth. Among active reps with capacity, choose the
  lowest assigned/capacity ratio and break ties by rep ID.
- A retry reconciles a partially created record by email. Assignment consumes
  capacity once; successful notification is recorded once per contact. This
  deliberately simple policy suppresses repeated demo notifications indefinitely.
- Contact source attribution is kept from its first successful creation. Each
  request still retains its own source and campaign. Existing contact fields
  are not silently overwritten.
- Attempts preserve their payload and enrichment snapshots. After a CRM record
  exists, changing its email through correction is refused to prevent creating a
  second identity during recovery.

These are practice rules, not MNTN policies or a LeanData implementation. Real
integration work would replace the local CRM and notification steps with provider
reads/writes, documented identity and notification policies, and durable request
storage. Those are outside this slice. No deliverability or vendor API behavior
has been demonstrated here.

## Verification

`npx vitest run tests/inbound-lab.test.ts` covers field mapping, optional phone,
owner preservation, pool capacity, review holds, duplicate requests, partial-write
recovery, notification recovery, corrected input history, and repeatable fixtures.

The core is `lib/inbound-lab.ts`; both entry points use
`components/inbound-lead-lab.tsx`. Existing CSV, native CRM, and Salesforce proof
workflows retain their separate behavior.
