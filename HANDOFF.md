# Morning Handoff

## Finished

- Added optional Pomade JSON preview and import into a new saved workspace. Ordinary CSV create/update workflows remain independent.
- Version 1 and legacy files retain updates-only scope; source status, original proposals and evidence survive corrections, local duplicate repair, reload, saved results, CSV exports and eligible rollback receipts.
- Governed preview and fresh execution hold unmatched Pomade rows. Legacy sync routes reject their reserved IDs; source Review/error/stale rows use existing exclusion controls.
- Added a fictional download and dated native qualification to the public walkthrough at `#pomade`.

## Try It

1. Open the [optional handoff walkthrough](https://gtm-control-tower.pages.dev/enterprise-import-walkthrough#pomade) or [detailed guide](docs/pomade-handoff.md).
2. In a persistent self-host at `/app/lab`, choose CSV file → Import Pomade handoff → inspect all proposals → Load in new saved workspace.
3. Resolve holds, compare using a direct CRM connector, explicitly approve existing-record updates, then inspect `/runs` for source context, receipts, verification and rollback.

## Checks

- All 475 tests across 31 suites, TypeScript, ESLint, application/public builds, secret scan and diff checks passed.
- Both-provider browser qualification passed with real local persistence and simulated CRM responses: ordinary CSV, preview without side effects, failed-save preservation, new workspace, reload, exclusions, malformed/oversized files, updates-only comparison, CSV context and disabled delegated sync. No CRM writes or live requests.
- An actual file downloaded from Pomade passed browser preview/load/reload; its missing email remained held.
- Native exporter/API qualification passed September 28, 2026, 16:53:37–16:53:55 UTC. Each development CRM updated and verified one fictional title; unmatched/Review rows held; zero creates/deletes. Rollback restored all nine retained fixtures' compared fields. See [dated summary](docs/evidence/pomade-handoff-native-2026-09-28.json).

## Decisions

- Keep the file handoff optional; no shared credentials, sessions, services or accounts.
- Source status and citations are context, never accuracy, CRM identity or approval. Edited values retain explicitly historical evidence.
- Initial handoffs update existing HubSpot Contacts and unconverted Salesforce Leads only. Ordinary CSV creates keep their existing controls.

## Remaining

- The public site is a static walkthrough; saving and CRM operations require a configured persistent self-host.
- Legacy files lack source installation/time/status/evidence. Salesforce Contacts remain review-only; no automatic transfer or two-way sync.
- Existing verification uses the current CRM connection and does not independently bind historical account identity.

## Review First

- `lib/pomade-handoff.ts` and `app/api/control-tower/crm-writeback/route.ts`.
- `components/self-host-console.tsx`, `components/pomade-source-context.tsx` and saved result exports.
- `docs/pomade-handoff.md` and `scripts/check-pomade-handoff.mjs`.
