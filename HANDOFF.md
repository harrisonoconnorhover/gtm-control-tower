# Morning Handoff

## Finished

- Changed Google Sheets output from append-only writes to normalized-email append-or-update.
- Added a strict native receipt contract: the app accepts completion only when n8n confirms `idempotent: true` and `matchKey: email`.
- Proved repeated live syncs through local n8n: every run processed 44 ready rows while `GTM Clean` stayed at 44 unique emails.
- Proved updates occur in place by changing one company value, reading it back on the same row, then restoring the reference value.
- Removed the obsolete internal spreadsheet-ID column from the synthetic proof sheet and verified the visible output.

## Try It

- Run `docker compose up --build`, open `http://localhost:3000/app`, and load the bundled 64-row practice batch.
- Configure the two n8n Sheets workflows, select Google Sheets as the destination, and click **Sync 44 ready rows to GTM Clean**.
- Run the same batch again; matching normalized emails update rather than append.

## Checks

- `npm test`: 35/35 passed; ESLint and the production build passed.
- Doctor, Git-history secret scan, Docker Compose config, `git diff --check`, and the high-severity audit gate passed.
- Live webhook receipts confirmed 44 email-keyed idempotent upserts per run.
- Google Sheets API readback confirmed 44 data rows, 44 unique emails, zero duplicates, restored reference values, and text-formatted `+1...` phone numbers.
- Signed-in Google Sheets visual verification passed after removing the obsolete internal column.

## Decisions

- Normalized email is the portable Sheets identity because destination-ready rows are already valid and deduplicated by email.
- A changed email is a new identity; the workflow does not guess that two addresses belong to one person.
- The guarantee covers sequential reruns through the local n8n workflow, not simultaneous competing writers.

## Remaining

- Add a concurrency lock before supporting multiple simultaneous n8n workers against the same worksheet.
- Put internet-accessible self-hosts behind authentication before storing confidential CRM data.
- Upgrade Drizzle Kit when its dependency chain removes the moderate development-server advisory.

## Review First

- `integrations/n8n/google-sheets-write-workflow.json`
- `lib/google-sheets.ts`
- `app/api/control-tower/google-sheets/route.ts`
