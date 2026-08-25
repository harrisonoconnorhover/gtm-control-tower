# Morning Handoff

## Finished

- Reframed GTM Control Tower around a guided messy-lead narrative: ingest, enrich, route, test, model, and diagnose.
- Added a timed batch replay, raw-to-governed record view, progressive control outcomes, and visible bad-data containment.
- Kept the existing funnel, failure scenarios, and human-approved repair flow while making the revenue impact explicit.
- Replaced inflated placeholder connector claims with the verified HubSpot, n8n, BigQuery, dbt, and pending-Salesforce boundary.
- Updated the demo script, architecture, metadata, tests, and durable design decision.

## Try It

- Open `http://localhost:3001/` and click **Run messy lead batch**.
- After the six stages finish, review the quarantined defects and click **Approve repair & replay**.
- Use **Test another failure** to cycle through routing and lifecycle problems.

## Checks

- `npm run test`: 4/4 passed.
- `npm run lint`: passed with no warnings.
- `npm run build`: passed.
- Local preview: HTTP 200 at `http://localhost:3001/`.

## Decisions

- Lead with visible transformation and business judgment instead of a static healthy-state dashboard.
- Keep deterministic synthetic replay for a reliable portfolio demo and label every live, staged, and simulated boundary.
- Preserve human approval for destructive merge and replay actions.

## Remaining

- Salesforce Support must unfreeze the Developer Edition admin before its parallel adapter can be validated.
- The public dashboard remains a deterministic model rather than a live warehouse query surface.
- Public hosting is intentionally pending a separate publish decision.

## Review First

- `components/control-tower-dashboard.tsx`
- `lib/control-tower.ts`
- `README.md`
