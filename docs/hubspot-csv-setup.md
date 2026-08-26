# CSV to HubSpot setup

The Control Tower can be used without BigQuery. CSV parsing, quality checks, merge/reroute/replay, and preview happen in the browser. Only contacts that pass the clean-record gate are sent after the user clicks **Sync to HubSpot**.

## What is written

Contacts are upserted by normalized email in batches of at most 100. The portable default mapping writes only standard HubSpot properties:

| CSV value | HubSpot property |
| --- | --- |
| `normalized_email` | contact identity (`email`) |
| `first_name` / parsed `full_name` | `firstname` |
| `last_name` / parsed `full_name` | `lastname` |
| `company` | `company` |
| `phone` | `phone` |
| `job_title` | `jobtitle` |
| `website` | `website` |

Merged rows, invalid emails, unresolved duplicates, and unreplayed lifecycle regressions are held back. Missing company or owner remains visible as a warning but does not prevent a valid contact from syncing. Lifecycle and owner values are not written because HubSpot only permits lifecycle movement forward and owner IDs are portal-specific.

## Option A: private app token

This is the shortest setup for one HubSpot portal.

1. In HubSpot, create a private app with `crm.objects.contacts.write`.
2. Copy `.env.example` to `.env.local`.
3. Set `HUBSPOT_ACCESS_TOKEN` to the private app token. Do not put the token in Git.
4. Run `npm install` and `npm run dev`.
5. Import a CSV, resolve the held rows, review the eligible count, and click **Sync to HubSpot**.

HubSpot documents both the required write scope and bearer-token authentication in its [contacts guide](https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide) and [authentication guide](https://developers.hubspot.com/docs/apps/legacy-apps/authentication/intro-to-auth).

## Option B: n8n OAuth

Use this when n8n already owns connector credentials or OAuth is preferred.

1. Run `docker compose up -d` and create the local n8n owner at `http://localhost:5678`.
2. Import [`csv-hubspot-sync-workflow.json`](../integrations/n8n/csv-hubspot-sync-workflow.json).
3. Open **Batch Upsert HubSpot Contacts** and attach a HubSpot OAuth2 credential with `crm.objects.contacts.write`.
4. Publish the workflow.
5. Set `N8N_HUBSPOT_SYNC_WEBHOOK_URL=http://127.0.0.1:5678/webhook/gtm-control-tower-hubspot-sync`
   in `.env.local` so the dashboard can discover the connector. Change the URL
   only when n8n is not using the local default.
6. Leave `HUBSPOT_ACCESS_TOKEN` blank; the server will use n8n.

## Production safety

Set `CONTROL_TOWER_SYNC_KEY` in production. Authorized users enter the matching value in the CSV panel; it is kept only in component memory. Keep n8n private or separately authenticated. Use HTTPS, never commit access tokens, and remember that HubSpot automatically deactivates tokens detected in public GitHub repositories.

The current workflow intentionally does not delete contacts, associate companies, mutate owner IDs, or move lifecycle stages. Those operations need portal-aware preflight reads and separate review.
