# Morning Handoff

## Finished

- Confirmed the live browser workspace opens company files without email or name columns. The reported blocker belongs to the older uploader; both `#audit` and `#clean-csv` now open the generic workspace.
- Added review findings for empty rows and exact repeated whole rows, independent of email mapping. Findings recalculate after edits, exclusions, restoration, and Undo.
- Clarified optional email checks and acceptance of contacts, companies, deals, and other tables. Every included source row and column remains downloadable.
- Preserved the prior native HubSpot/Salesforce work and evidence. See [native qualification](docs/native-incident-qualification.md) for its 2,900-record test and limits.

## Try It

1. Open [the live CSV workspace](https://gtm-control-tower.pages.dev/#clean-csv). Refresh if the older email/name blocker is still visible.
2. For the new review findings locally, run `npm run build:public`, then `npx vite preview --config vite.public.config.ts --host 127.0.0.1 --port 4175`. Open `http://127.0.0.1:4175/#audit` and choose a file with no email or name columns.
3. Repeated and empty rows appear in **Needs review**. Edit, exclude, restore, or download; no row is removed automatically.

## Checks

- All 24 browser CSV unit tests passed. TypeScript, focused lint, script syntax, public production build, and diff checks passed.
- Desktop and 390px mobile browser checks passed against the production build, including company/deal files without identity columns, exact download contents, findings, edits, exclusions, restoration, Undo, and the legacy URL.
- Browser tests confirmed no page errors, API/external calls, processing requests, or persistent browser storage. Desktop/mobile screenshots were visually inspected.
- A fictional company CSV opened successfully on the current live site. The added generic findings have not been publicly deployed.

## Decisions

- Exact full-row equality is a review hint; it does not establish a duplicate person or authorize merging.
- Empty-row and repeated-row checks work without identity; email checks only run when a column is selected.
- Preserve the separate connected contact importer's identity requirement and source-data privacy.

## Remaining

- Publish the additional review findings to the static site when authorized. The current live version already accepts files without identity columns.
- Hosted CRM execution, native event delivery, and Slack qualification remain outside this change.

## Review First

1. `lib/browser-csv.ts` and `tests/browser-csv.test.ts`.
2. `components/browser-csv-workspace.tsx` and [CSV guide](docs/browser-csv.md).
3. `outputs/browser-csv/companies-no-identity.png` and `deals-no-identity.png`.
