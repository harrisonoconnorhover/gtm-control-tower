# Morning Handoff

## Finished

- Converted the project into a portable MIT-licensed self-hosted release.
- Added zero-account CSV mode plus credential-free BigQuery/n8n asset rendering.
- Added a ten-record browser fallback so the public demo works without connectors.
- Removed personal project IDs and n8n credential bindings from public templates.
- Added CI, setup/doctor tooling, dependency auditing, and history secret scanning.

## Try It

- Run `npm ci && npm run setup && npm run dev` for the credential-free demo.
- Import `public/control-tower-csv-template.csv`, then execute merge, reroute, and replay.
- Add `--project your-gcp-project` to `npm run setup` for generated warehouse assets.

## Checks

- `npm test`: 24/24 passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `npm run audit`: zero known vulnerabilities.
- `npm run doctor`, custom history scan, and Gitleaks: passed with no leaks.
- Public smoke test: loaded anonymously and ran all ten browser-local demo contacts.

## Decisions

- Ship as an open-source self-hosted toolkit, not a shared multi-tenant SaaS.
- Keep the public demo credential-free; CRM writes stay server-side and disabled by default.
- Render local connector assets under ignored `.runtime` rather than storing account IDs.

## Remaining

- Connectors remain optional and must be configured by each self-hosting operator.
- Use refreshable OAuth and app-level authentication before enabling hosted CRM writes.
- Add a custom domain only if the generated demo URL becomes a presentation concern.

## Review First

- `README.md`
- `scripts/setup.mjs`
- `docs/self-hosting.md`
