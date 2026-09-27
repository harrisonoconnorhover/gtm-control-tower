# Morning Handoff

## Finished

- CSV import rejects repeated final contact IDs, including generated-ID collisions, with row-specific errors. This prevents a duplicate repair from merging unrelated records sharing an ID.
- Preview and direct import now share normalized-header validation; neither silently overwrites an ambiguous column.
- Starting a replacement preview clears its predecessor. Invalid, oversized or unreadable input cannot leave an old import action available; loaded contacts remain intact.
- The current 64-row example and previous Docker/Sheets documentation corrections remain unchanged.

## Try It

1. In the CSV workspace, preview a valid file, then choose a malformed or oversized replacement. Its error appears, the draft mapping disappears, and already-loaded rows stay unchanged. Choose a corrected file and validate it normally.
2. Import a CSV with two source rows sharing a contact ID. The error identifies both rows; correct the IDs before running repairs.
3. Run `npm test -- --run tests/csv-control-tower.test.ts tests/messy-lead-demo.test.ts tests/crm-audit.test.ts` for the focused importer/demo/audit cases.

## Checks

- New importer regressions failed before correction. All 32 focused tests, changed-file ESLint, TypeScript and diff checks passed in public and development checkouts.
- Public operator and static-site builds passed. The same UI correction was mirrored into the identical development component; development ESLint/TypeScript checks passed.
- Isolated browser reproduced the stale-file import before correction, then verified malformed/oversized replacement rejection, retention of loaded rows and successful recovery with a valid replacement.
- Browser verification covered session CSV state; the disposable development database was uninitialized, so persistence was not qualified by that check. No provider calls or real CRM rows were used.

## Decisions

- Reject ambiguous record IDs rather than silently assigning new identities.
- Preserve imported work while invalidating a failed replacement draft.
- Keep current local checks separate from historical provider receipts.

## Remaining

- Publish and verify the reviewed public source and static assets. Development mirrors stay local.
- No connected-provider requalification or private-host deployment is part of this pass.

## Review First

- `lib/csv-control-tower.ts` and `tests/csv-control-tower.test.ts`.
- `components/self-host-console.tsx`: draft clearing and file-read errors.
- `docs/decisions.md`: identity and preview-state choices.
