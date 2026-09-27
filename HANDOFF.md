# Morning Handoff

## Finished

- Added an inspectable imported-file comparison to direct HubSpot and Salesforce writes: create, update, unchanged or hold, with matched native IDs and field changes.
- HubSpot checks primary/additional emails, confirms absent batch results individually, holds shared native targets and uses create-only requests. Conflicts never become unreviewed updates.
- Salesforce checks both Leads and Contacts, including converted Leads. Contact, converted and ambiguous matches are held; incomplete lookups stop writes.
- Existing execution rereads now include matched identities in the reviewed fingerprint. Legacy direct routes share the same readers; n8n behavior remains separately labeled.
- Added a synthetic walkthrough and browser screenshot. Live-provider qualification for these new cases is pending.

## Try It

1. Start the self-hosted app using the README and configure a direct CRM connection.
2. Import the fictional CSV in `docs/import-crm-comparison.md` at `/app/lab` and select the CRM destination.
3. Click **Compare N with CRM**, inspect matched IDs and holds, then review changes before execution. The public static demo does not connect to a CRM.

## Checks

- All 158 tests across 21 suites passed, including 66 focused CRM tests with mocked provider responses.
- TypeScript, full lint, secret scan and diff checks passed. Operator and public builds passed.
- Isolated browser/local D1 checks passed: real CSV import, comparison rows, matched IDs, backup download, stale-execution error/refresh and shared HubSpot alias holds, using simulated CRM responses.
- Desktop and 390px screenshots were visually checked; no page errors or horizontal overflow. No real provider writes occurred.

## Decisions

- Exact email matching only; different unlinked emails and inaccessible CRM records are outside this protection.
- Hold cross-object Salesforce matches rather than creating a duplicate Lead or silently switching write targets.
- Reuse existing plans, receipts and rollback; add no schema, dependencies, fuzzy matching or native merge behavior.

## Remaining

- The development mirror passed the same 66 focused CRM tests and TypeScript, preserving its inbound-routing link. Development stays local; public-source publication is the next step.
- Qualify against live development accounts before relying on account-specific visibility, permissions or duplicate rules. Reads and writes are separate operations; concurrent writers remain a limitation.

## Review First

- `lib/crm-existing-hubspot.ts`, `lib/crm-existing-salesforce.ts` and their focused tests.
- `app/api/control-tower/crm-writeback/route.ts` and `tests/crm-import-comparison.test.ts`.
- `docs/import-crm-comparison.md` for behavior, screenshot and boundaries.
