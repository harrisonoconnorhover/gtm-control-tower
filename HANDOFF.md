# Morning Handoff

## Finished

- Connected shared import templates to verified HubSpot Contact and Company properties, labels, internal names, and actual picklist options.
- Added saved field bindings and value rules with separate object mapping, explicit record-ID lookup controls, and portal mismatch handling. Missing custom fields are flagged rather than created.
- Added a persisted normalized dry run with original/current/normalized/proposed values, reasons, and separate create/update/unchanged/review/skipped counts. Existing values are preserved by default.
- Added company grouping/conflict review, unresolved lookup holds, and stale-result detection. This feature has no CRM execution path or paid checks.
- Rebuilt the local Docker app using the existing connection through the dedicated import-read variable; legacy write connectors remain unconfigured.

## Try It

Open [the live 120-row demo](http://127.0.0.1:3100/app/lab?workspaceId=<workspace-id>). In **HubSpot fields and normalized import**, load fields, review mappings and picklist aliases, save the mapping, and run the dry run. Save/update a shared template to reuse these choices. See `docs/import-normalization.md`.

## Checks

- 146 focused tests across 9 files passed, including native-reader mocks, planner behavior, route persistence, normalization, templates, CSV, workspace, and CRM mapping compatibility.
- Repository TypeScript and lint checks passed; Docker build and live schema API passed (403 Contact fields, 247 Company fields, 148 Industry options).
- Five mocked browser scenario groups passed: property/option mapping, save, policies, pagination, stale review, explicit IDs, and cross-portal handling. Screenshot inspected.
- Native 120-row browser test passed: actual Industry mapping, saved template/review, reload, 1,529 normalized changes, 120 proposed company creates, and 120 contacts held with reasons. Zero CRM writes/paid checks; original sample unchanged.
- Native screenshots inspected; all pre-existing SQLite rows preserved. Secret scan (2,948 Git objects), final changed-file lint, and diff checks passed. Evidence: `outputs/hubspot-import-native/2026-10-16T17-11-29-584Z/result.json`; backup/build/preservation under `outputs/hubspot-import-2026-10-16/`.

## Decisions

- Portal-bound templates use actual metadata refreshed at each dry run; custom fields and picklist choices are never invented.
- The default is fill-empty; overwrite remains preview-only. Blanks never clear values and email/IDs remain identity fields.
- Preview is limited to 500 source rows. Association execution and broader CRM writers remain outside this change.

## Remaining

- No implementation blockers. Existing-record update/unchanged behavior is covered with mocked CRM fixtures; the native sample uses fictional identities.
- Country/state are free text in the connected portal; Persona has no exposed choices, and Fav. Ice Cream is absent. Those limitations are visible in review.

## Review First

- `lib/hubspot-import-read.ts` and `lib/hubspot-import-preview.ts`: read-only identity lookup and field proposals.
- `app/api/control-tower/hubspot-import/route.ts`: local persistence and stale guards.
- `components/hubspot-import-review.tsx`: real schema mapping and review.
