# Google Sheets through n8n

This is the lowest-cost connected setup: GTM Control Tower and n8n run locally,
Google Sheets supplies the table, and BigQuery is not required.

## 1. Start the stack

```bash
docker compose up --build
npm run setup
```

Open n8n at `http://localhost:5678`. Import these inactive, credential-free
workflows from `.runtime/generated/n8n`:

- `google-sheets-read-workflow.json`
- `google-sheets-write-workflow.json`

## 2. Connect Google in n8n

Create a Google Sheets OAuth2 credential in n8n and attach it to each Google
Sheets node. Grant the connected Google account access to the spreadsheet.
Review the nodes, then publish both workflows.

The write workflow uses the Google Sheets node's idempotent create operation:
it creates `GTM Clean` only when that worksheet is absent. Source worksheets
are never overwritten.

## 3. Point the app at the webhooks

Create an ignored `.env` file:

```dotenv
N8N_GOOGLE_SHEETS_READ_WEBHOOK_URL=http://n8n:5678/webhook/gtm-control-tower-sheets-read
N8N_GOOGLE_SHEETS_WRITE_WEBHOOK_URL=http://n8n:5678/webhook/gtm-control-tower-sheets-write
```

Use `http://localhost:5678` instead when the app runs directly with
`npm run dev`. Restart the app service after changing environment values.

## 4. Use it

1. Choose **Google Sheets through n8n** as the source.
2. Paste the spreadsheet URL and source worksheet name.
3. Preview, adjust the visual mapping, and validate the rows.
4. Choose Google Sheets as the destination, paste its URL, and execute.
5. Keep the returned receipt or export the same governed state as CSV.

The app sends spreadsheet identifiers and bounded contact rows to n8n. Google
credentials stay inside n8n and never enter the browser or repository.
