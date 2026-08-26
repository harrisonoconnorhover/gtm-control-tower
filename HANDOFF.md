# Morning Handoff

## Finished

- Set the bundled n8n service to one concurrent production execution, making overlapping webhook calls queue in FIFO order.
- Kept normalized-email append-or-update, so a queued retry updates the first writer's row rather than appending a duplicate.
- Proved two simultaneous webhooks carrying the same unseen synthetic email produced exactly one destination row.
- Removed the synthetic collision-test row and restored `GTM Clean` to 44 rows, 44 unique emails, and zero duplicates.
- Updated the self-host UI, setup guide, architecture, README, and decision record with the concurrency guarantee and throughput tradeoff.

## Try It

- Run `docker compose up --build`, configure the two Sheets workflows, and open `http://localhost:3000/app`.
- Start two syncs against the same `GTM Clean` worksheet; n8n queues one until the other finishes.
- For an existing external n8n instance, set `N8N_CONCURRENCY_PRODUCTION_LIMIT=1` and restart it before publishing the workflow.

## Checks

- `npm test`: 36/36 passed; ESLint and the production build passed.
- Doctor, Git-history secret scan, Docker Compose config, `git diff --check`, and the high-severity audit gate passed.
- Running n8n reported `N8N_CONCURRENCY_PRODUCTION_LIMIT=1` after recreation.
- Collision proof: both simultaneous webhooks returned valid receipts and one matching Sheet row existed afterward.
- Cleanup readback confirmed 44 data rows, 44 unique emails, and no proof row remaining.

## Decisions

- Serialize at n8n's production-execution boundary so direct webhook callers receive the same protection as the app.
- Prefer correctness over parallel connector throughput for this small self-hosted stack.
- Keep email as the identity key; changing an address still creates a new identity.

## Remaining

- Put internet-accessible self-hosts behind authentication before storing confidential CRM data.
- If high parallel throughput becomes necessary, replace the global queue with a durable per-destination worker queue.
- Upgrade Drizzle Kit when its dependency chain removes the moderate development-server advisory.

## Review First

- `compose.yaml`
- `docs/google-sheets-setup.md`
- `tests/self-hosting.test.ts`
