# Morning Handoff

## Finished

- Split the product into a two-minute public demo (`/`), operator workspace (`/app`), and self-host setup (`/setup`) without duplicating the codebase.
- Added a deterministic 64-row messy-lead scenario with visible merge, reroute, lifecycle-replay, destination-gate, and receipt outcomes.
- Proved Google Sheets end to end through local n8n: 64 source rows read, 44 governed rows written to `GTM Clean`, and 12 unresolved active rows held back.
- Made Google Sheets reruns tolerate an existing output worksheet and preserve formula-like strings such as `+1...` phone numbers as text.
- Added the public social preview image and documented the verified self-host path.

## Try It

- Public proof: open `/` and click **Run the 64-row cleanup**.
- Real local workflow: run `docker compose up --build`, open `http://localhost:3000/app`, and load the bundled practice batch.
- Connector instructions and current readiness are at `/setup` and `docs/google-sheets-setup.md`.

## Checks

- `npm test`: 34/34 passed; `npm run lint`: passed.
- `npm run build`: passed and emitted standalone output.
- `npm run doctor`, Git-history secret scan, Docker Compose config, and `git diff --check`: passed.
- High-severity audit gate passed; four moderate Drizzle development-tool advisories remain.
- Desktop and 390-pixel mobile browser QA passed with no horizontal overflow.

## Decisions

- Keep one codebase with separate reviewer, operator, and setup experiences.
- Write only destination-ready active records; unresolved duplicates, invalid email, missing company/owner, and lifecycle regression stay out.
- Keep credentials in the self-hoster's n8n instance; the public site remains a credential-free deterministic demonstration.

## Remaining

- Add upsert/idempotency semantics before treating repeated Google Sheets writes as safe production syncs.
- Put internet-accessible self-hosts behind authentication before storing confidential CRM data.
- Upgrade Drizzle Kit when its dependency chain removes the moderate development-server advisory.

## Review First

- `components/public-demo.tsx`
- `components/self-host-console.tsx`
- `integrations/n8n/google-sheets-write-workflow.json`
