# Morning Handoff

## Finished

- Built the responsive GTM Control Tower with healthy-state metrics, lineage, audit activity, and three interactive chaos scenarios.
- Added human-approved repair/replay behavior and deterministic unit-tested scenario logic.
- Published the local n8n production webhook with a live HubSpot contact upsert and BigQuery event append; Salesforce remains a disabled parallel adapter.
- Provisioned a dedicated BigQuery project, loaded 5,000 synthetic events, and added three live dbt marts with quality tests.
- Added Salesforce Lead metadata and a version-pinned local n8n Compose service.
- Documented architecture, setup, demo narrative, honest simulation boundaries, and a résumé-ready portfolio bullet.

## Try It

- The local preview is running at `http://localhost:3001/`; click **Trigger chaos mode**, then **Approve repair & replay**.
- Open n8n at `http://localhost:5678/`; use `docker compose up -d` to restart it later.
- From this directory, use `npm run dev`, `npm run test`, or `npm run generate:data`.

## Checks

- `npm run test`: 3/3 passed.
- `npm run lint`: passed with no warnings.
- `npm run build`: passed.
- n8n production webhook: HTTP 202; execution 7 completed successfully with HubSpot and BigQuery output.
- HubSpot upsert: COMPLETE with the expected company, revenue, lifecycle, status, and employee-band fields; the matching event was verified in BigQuery.
- `dbt build`: PASS=15, WARN=0, ERROR=0.

## Decisions

- Used a dedicated BigQuery project and a least-privilege service account; kept credentials only in ignored local runtime state.
- Reused an existing narrow HubSpot OAuth grant in n8n's encrypted local credential store instead of creating another app or broader token.
- Kept Salesforce disabled while publishing the verified HubSpot-first workflow.

## Remaining

- Public deployment needs explicit approval.
- Salesforce Support must unfreeze the sole Developer Edition admin before OAuth, metadata deployment, and the final full-workflow test.
- The dashboard is currently fed by the deterministic scenario model, not a live warehouse API.
- Remove the superseded fallback BigQuery resources after the Salesforce-to-BigQuery test succeeds.

## Review First

- `components/control-tower-dashboard.tsx`
- `integrations/n8n/lead-routing-workflow.json`
- `compose.yaml`
