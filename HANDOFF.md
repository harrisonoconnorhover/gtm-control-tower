# Morning Handoff

## Finished

- CSV import rejects repeated final contact IDs, including generated-ID collisions, with row-specific errors. This prevents a duplicate repair from merging unrelated records sharing an ID.
- Preview and direct import now share normalized-header validation; neither silently overwrites an ambiguous column.
- Starting a replacement preview clears its predecessor. Invalid, oversized or unreadable input cannot leave an old import action available; loaded contacts remain intact.
- Fresh Node development now runs `npm run db:migrate:local` before startup. It applies existing SQL migrations to the same local D1 store used by Vite, without a Cloudflare account.
- The current 64-row example and previous Docker/Sheets documentation corrections remain unchanged.

## Try It

1. In the CSV workspace, preview a valid file, then choose a malformed or oversized replacement. Its error appears, the draft mapping disappears, and already-loaded rows stay unchanged. Choose a corrected file and validate it normally.
2. Import a CSV with two source rows sharing a contact ID. The error identifies both rows; correct the IDs before running repairs.
3. Run `npm test -- tests/csv-control-tower.test.ts tests/messy-lead-demo.test.ts tests/demo-decisions.test.ts tests/crm-audit.test.ts` for the focused importer/demo/audit cases.

## Checks

- New importer regressions failed before correction. All 32 focused tests, changed-file ESLint, TypeScript and diff checks passed in public and development checkouts.
- Public operator and static-site builds passed. The same UI correction was mirrored into the identical development component; development ESLint/TypeScript checks passed.
- Isolated browser reproduced the stale-file import before correction, then verified malformed/oversized replacement rejection, retention of loaded rows and successful recovery with a valid replacement.
- The fresh Node test exposed the missing local migration step. After all three existing migrations, native UI import saved revision1 and reload restored the row. Rerunning the exact npm command applied nothing and preserved the saved row. No provider calls or real CRM rows were used.
- [CI for runtime `cb8d6dc`](https://github.com/harrisonoconnorhover/gtm-control-tower/actions/runs/36338078229) passed. Deployment `fc55e20b` HTML/JS/CSS match the reviewed build; its live audit rejects repeated IDs with the expected row references.

## Decisions

- Reject ambiguous record IDs rather than silently assigning new identities.
- Preserve imported work while invalidating a failed replacement draft.
- Keep current local checks separate from historical provider receipts.

## Remaining

- CSV runtime corrections are published as `cb8d6dc`; local setup correction is `455120e`. Development mirrors remain local. The setup-only addition does not change static assets.
- No connected-provider requalification or private-host deployment is part of this pass.

## Review First

- `lib/csv-control-tower.ts` and `tests/csv-control-tower.test.ts`.
- `components/self-host-console.tsx`: draft clearing and file-read errors.
- `docs/decisions.md`: identity and preview-state choices.
