# Morning Handoff

## Finished

- Added explicit Contact, Company, and Contact + associated Company setup, separate mappings, saved presets, and round-trip CSV exports.
- Added proposed company associations grouped by supplied company ID or exact website hostname; ambiguous groups show reasons, and name-only rows remain unlinked.
- Added a 140-contact fictional fixture with authored positive/negative cases for common/rare names, company typos, shared phones, false positives, and known misses.
- Deployed locally and tested the mixed import through the actual UI and installed plugin. Left 23 pending suggestions, one confirmed duplicate and one dismissed false positive.
- Preserved every pre-existing database row, including the original sample and cached qualification evidence. No paid checks or CRM writes occurred.

## Try It

1. Open the [140-contact sample](http://127.0.0.1:3100/app/lab?workspaceId=<workspace-id>).
2. In Local matching suggestions, compare John Smith (low priority) with Zelyra Quenholt (medium). Filter Confirmed/Dismissed to inspect saved decisions or Undo.
3. Search “microsoft” under proposed company associations; inspect the conflicting spellings and the two associated contacts. See [object setup](docs/import-objects.md) and [fixture labels](tests/fixtures/local-matching/README.md).

## Checks

- 161 focused tests passed across object parsing/persistence, association grouping, matching, decisions, suppression, readiness, and Pomade boundaries.
- Full lint, TypeScript, diff checks, and production Docker build passed.
- Native UI passed CSV upload/mapping/preset save, 140-row load, Confirm/Dismiss/Undo, reload persistence, mixed export, and mobile layout. Installed plugin readback passed; zero browser errors or unexpected requests.
- Screenshots inspected. Database comparison confirmed every original row preserved; only the new sample, local CSV receipts, preset and assessments were added.
- Fixture: 10/11 labeled positive pairs surfaced; 13/21 negative pairs intentionally produced reviewable warnings. No findings on the 100 clean background rows.

## Decisions

- Keep Contact and Company fields separate; similar names never create company associations.
- Keep company modes local review/export only, with server-side guards before CRM/provider work.
- Interpret rarity within 138 local named identities; scores rank evidence rather than estimate probability.

## Remaining

- Company/Account CRM imports, association writes, and Pomade qualification for combined imports are not implemented.
- Robert/Bob nickname equivalence remains a known miss. Candidate caps are disclosed; real-world accuracy is not established.

## Review First

- [Object mapping](lib/csv-control-tower.ts), [association proposals](lib/company-associations.ts), and [labeled fixture](tests/fixtures/local-matching/README.md).
- Local evidence: `outputs/messy-import-2026-10-16/native-receipt.json`, `preservation.json`, and screenshots in that folder.
