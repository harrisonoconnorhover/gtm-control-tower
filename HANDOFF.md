# Morning Handoff

## Finished

- Fixed CSV imports that accepted malformed supplied `normalized_email` values as destination-ready; supplied and raw addresses now share the existing validation and IDNA normalization.
- Added regressions for invalid supplied values and valid internationalized domains; pinned the existing sample result at 64 input rows, 56 canonical rows, 44 ready, and 12 held.
- Replaced the vague Quality label with Destination-ready and visible row fractions.
- Clarified the synthetic browser run, fixed overflow rule, supplied expected lifecycle stage, and the steps for trying the existing demo.
- Dated and separated the historical CRM and Salesforce examples, linked the original CRM run notes, and mirrored the focused patch into the development checkout.

## Try It

In `gtm-control-tower-portfolio`, run `npm run preview:public -- --port 4195 --strictPort` and open `http://127.0.0.1:4195/`. Choose **Run the 64-row cleanup**. Use **Try safe sample** in the CSV audit to inspect and download an aggregate report.

## Checks

- Both checkouts: 44 focused tests passed across CSV import, browser audit/demo, identity resolution, public-company fixture, CRM workflow, HubSpot, and Salesforce contracts.
- Both checkouts: changed-file ESLint and `npm run build:public` passed.
- Public-demo test with exact row-count assertions passed; `git diff --check` passed and the diff was reviewed.
- Browser QA passed at desktop and 390px: cleanup reached 44 ready / 12 held, sample audit reached 32 ready / 32 held, and the mobile page had no horizontal overflow.
- No native CRM calls or provider requalification were performed.

## Decisions

- Reuse existing email validation; retain valid supplied identities and preserve raw input.
- Keep historical sandbox metrics as dated records, separate from browser computation and customer outcomes.
- Release from the portfolio checkout; the development checkout retains unrelated inbound-routing work.

## Remaining

- Publish and verify the reviewed static release; merge preserves the existing main-branch n8n smoke cleanup.
- Existing published Agentforce preview still requires its dedicated execution user; this change does not qualify it.

## Review First

- `lib/csv-control-tower.ts` and `tests/csv-control-tower.test.ts`.
- `components/public-demo.tsx` and `tests/messy-lead-demo.test.ts`.
