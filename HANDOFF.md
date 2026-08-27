# Morning Handoff

## Finished

- Added durable Sync Runs with filters, evidence export, native receipts, field-level plans, rollback backups, and idempotent undo.
- Added guided HubSpot and Salesforce read/write checks plus CRM-as-source imports into the standard mapping and repair workflow.
- Added governed two-step CRM write-back: bounded preview, fresh provider re-read, exact diffs, conflict holds, and update rollback.
- Added the inactive-by-default HubSpot source workflow and documented direct-token versus n8n connector modes.
- Added and embedded a captioned, reproducible 120-second portfolio walkthrough with live 72-row sandbox evidence.

## Try It

- Run `docker compose up --build`, open `http://localhost:3000/setup`, and prove each configured connector.
- Open `/app`, import a CSV or CRM source, repair it, preview a CRM write plan, execute it, then inspect `/runs`.
- Regenerate the walkthrough with `npm run generate:walkthrough -- http://localhost:3001` while the local dev server is running.

## Checks

- `npm test`: 11 files and 43 tests passed; TypeScript, lint, app build, static build, diff check, and secret scan passed.
- Fresh-install Docker smoke passed with isolated state and no credentials; app and n8n both became ready and undo survived restart.
- Salesforce live acceptance passed for read, preview, exact-null write, conflict hold, rollback, and repeated rollback; original data was restored.
- Walkthrough verified as 1600x900 H.264/AAC, exactly 120 seconds; local setup, Sync Runs, and public demo passed DOM and visual inspection.
- `npm audit --audit-level=high` passed; four moderate Drizzle development-tool advisories remain because the offered fix is breaking.

## Decisions

- All CRM writes remain preview-first, limited to 100 records, and blocked when provider state changes after preview.
- Creates are never auto-deleted during rollback; only snapshotted updates are eligible, and a second undo is a safe no-op.
- The public site stays static and synthetic; credentials, durable workspaces, and real provider actions remain self-hosted.

## Remaining

- Reauthorize the local n8n HubSpot credential with `crm.objects.contacts.read`; the checked-in source workflow is installed but correctly reports the missing scope.
- Choose a custom public domain if desired.

## Review First

- `app/api/control-tower/crm-writeback/route.ts`
- `components/sync-runs.tsx`
- `docs/two-minute-walkthrough.md`
