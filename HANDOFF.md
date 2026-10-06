# Morning Handoff

## Finished

- Implemented **Safe Import: Update existing contacts** for CSV → HubSpot Contacts, extending the existing governed planner and matching controls. No AI model is required.
- Saved update-only policy and six-field decisions preserve populated values, reject blank clearing/creates, and expose deliberate nonchanges and questionable values.
- Whole-file review accounts for every source row; integrated identity review, filtering, downloadable evidence, and exact approval wording share the saved contract.
- Account-bound approval and one durable execution per review prevent repeat sends. Interrupted outcomes stay unknown; recovery reads only. Accepted updates receive automatic verification.
- Prepared four focused local commits on `codex/safe-import`: policy, unified review, durable execution, and optional deterministic assistant. Nothing published.

## Try It

1. Start the persistent self-host, open `/app/lab`, and configure direct HubSpot contact/account reads and contact writes.
2. Select **Update existing contacts safely**, upload CSV, inspect mapping, and **Prepare review**. Confirm or skip held identities, then prepare a fresh review.
3. Inspect all field decisions, **Approve N contact updates**, then inspect acceptance/readback separately. Use **Reload saved execution** or **Reconcile and verify** after interruption. See [workflow guide](docs/safe-import.md).

## Checks

- All 556 tests across 39 files passed, including a 106-row route fixture with real temporary SQLite and simulated HubSpot. No native CRM writes.
- TypeScript passed. ESLint passed with one preexisting warning in an ignored historical output script.
- Application and public builds passed. All SQL migrations applied successfully to fresh SQLite; four Safe Import tables present.
- 103-row browser regression passed with simulated CRM and real local workspace saves: incomplete review blocks approval, held-row changes invalidate it, interrupted acceptance stays unknown, and recovery never repeats approval. Desktop/mobile screenshots inspected.
- Secret scan and Git diff checks passed.

## Decisions

- Preserve the six populated CRM fields conservatively; names plus company/phone contradictions require identity review. Primary email and marketing/ownership fields are never writable.
- Bind approval to saved source/mapping/revision, exact field evidence, and a verified HubSpot portal ID. Each send rechecks workspace and native baseline.
- Model-free intent/explanations are optional convenience. Manual mapping and recipe selection remain available.

## Remaining

- Live HubSpot and hosted D1 qualification have not run. D1 requires the new versioned migration before use.
- Native reread/PATCH are separate operations; downstream effects and external races are not fully prevented or simulated.
- Salesforce Contact writes and automatic rollback are outside this recipe. Restoration requires a new reviewed decision protecting subsequent edits.
- Commits are local; GitHub PR creation and publication remain release work.

## Review First

- `lib/crm-workflow.ts` and `lib/governed-crm-plan.ts`.
- `app/api/control-tower/safe-import/route.ts`, review/store/execution services, and acceptance tests.
- `components/safe-import-review.tsx` and `docs/safe-import.md`.
