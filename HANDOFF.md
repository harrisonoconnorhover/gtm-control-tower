# Morning Handoff

## Finished

- Added SQLite/D1 workspaces for imports, mapping presets, receipts, repair history, and twenty undo revisions.
- Added a configured-only source/destination picker and shared Preview → Validate → Execute → Receipt → Undo/Export contract.
- Added arbitrary-column CSV mapping and Google Sheets read/write workflows through local n8n.
- Added a production standalone Docker image; `docker compose up --build` starts the app and n8n.
- Preserved the existing CSV, HubSpot, Salesforce, BigQuery, dbt, and credential-free demo paths.

## Try It

- Run `docker compose up --build`, then open `http://localhost:3000`.
- Map and import `public/control-tower-csv-template.csv`; repair, refresh, undo, and export it.
- Follow `docs/google-sheets-setup.md` to bind Google OAuth only inside n8n.

## Checks

- `npm test`: 31/31 passed; TypeScript and ESLint passed.
- `npm run build`: passed and emitted standalone output.
- Docker Compose config/build passed; the 91.6 MB app image served the page and created a persistent workspace.
- Production API proof passed: create, save, reload, and undo against the local SQLite file.
- Doctor and Git-history secret scan passed; high-severity audit gate passed (four moderate Drizzle CLI advisories remain).

## Decisions

- Use a file-backed SQLite adapter in Node/Docker and the same storage contract over D1 on Sites.
- Keep Google credentials in n8n and always write to a separate `GTM Clean` worksheet.
- Hide unconfigured operational connectors instead of presenting broken buttons.

## Remaining

- Exercise the Google Sheets workflows with an operator-owned OAuth credential after import.
- Put internet-accessible self-hosts behind authentication before storing confidential CRM data.
- Upgrade Drizzle Kit when its dependency chain removes the moderate development-server advisory.

## Review First

- `components/self-host-console.tsx`
- `lib/workspace-store.ts`
- `compose.yaml`
