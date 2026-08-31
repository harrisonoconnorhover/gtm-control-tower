# Morning Handoff

## Finished

- Added a resumable, full-account duplicate audit for HubSpot Contacts and Salesforce Leads plus Contacts.
- Added explainable identity resolution with email aliases, both phone fields, Unicode names, company/domain context, conflicts, survivor selection, and overlap safeguards.
- Persisted scan pages, clusters, decisions, progress, and run receipts in local SQLite or migrated D1 storage.
- Added the focused `/app` operator workflow, comparison and recovery review, exports, run history, access-key protection, and a preserved `/app/lab`.
- Proved the workflow against live synthetic sandbox data in both CRMs without accessing the prohibited AxisCare account.

## Try It

- Run `npm run dev`, open `http://localhost:3001/app`, enter the operator key if configured, and choose HubSpot or Salesforce.
- Select **Start fresh scan**; pause and resume safely, review evidence and conflicts, choose a survivor, then save a decision-only cleanup plan.
- For clearly labeled sandbox fixtures, run `npm run seed:duplicate-audit -- --provider both`; see `docs/duplicate-audit.md` before using it.

## Checks

- `npm test`: 16 files and 73 tests passed; `npm run lint` passed.
- `npm run build`, `npm run build:public`, `npm run doctor`, `npm run check:secrets`, and `git diff --check` passed.
- Fresh live proof: HubSpot 14 records / 4 groups; Salesforce 109 records / 6 groups, both complete on `identity-v3` with durable receipts.

## Decisions

- Approval records a cleanup plan but does not execute a native CRM merge; ambiguity and Salesforce cross-object cases remain blocked for human review.
- Local SQLite supports up to 25,000 records per scan; D1 defaults to 10,000 because its runtime has tighter resource limits.
- The public site remains credential-free; connected account scanning belongs only in the self-hosted operator.

## Remaining

- Add a separately reviewed native merge executor only after survivor, rollback, and provider-specific semantics are agreed.
- Add managed OAuth refresh and secret storage before a multi-tenant deployment.
- Use staged/block-partitioned scans for accounts above the configured safety ceiling.

## Review First

- `lib/identity-resolution.ts` and `lib/duplicate-scan-store.ts`
- `components/duplicate-audit.tsx` and `app/api/control-tower/duplicate-scan/route.ts`
- `docs/duplicate-audit.md`
