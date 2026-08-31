# HubSpot setup

The Control Tower can be used without BigQuery. `/app` runs a durable
whole-account Contact duplicate audit; `/app/lab` handles CSV parsing, quality
checks, merge/reroute/replay, preview, and governed Contact writes. Only contacts
that pass the clean-record gate are sent after the operator approves a sync.

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

## Option A: account service key

This is the shortest setup for one HubSpot portal.

1. In HubSpot, create an account service key. Grant
   `crm.objects.contacts.read` for Contact reads and whole-account duplicate
   scans. Grant `crm.objects.contacts.write` for the write connection test.
   Governed preview/write, rollback, and the synthetic seed require both scopes
   because they read current Contacts before writing.
2. Copy `.env.example` to `.env.local`.
3. Set `HUBSPOT_ACCESS_TOKEN` to the service key. Do not put the key in Git.
4. Run `npm install` and `npm run dev`.
5. Use `/app` for a durable whole-account duplicate audit, or `/app/lab` to
   import a CSV or read a bounded Contact sample before reviewing a field-level
   write plan.

Direct service-key mode is the full governed path: native read, exact diff,
stale-plan check, per-record receipt, and update rollback. The server writes
only the portable properties listed above. Empty proposed values explicitly
clear those properties; the rollback snapshot restores their prior nullability.

HubSpot documents the object scopes and bearer-token use in its
[contacts guide](https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide)
and [service-key guide](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys).

### Whole-account Contact audit

The account scanner is available only with the direct service key. It follows
every Contact page, commits the next HubSpot `after` cursor and records to
SQLite/D1, and resumes after a pause or interruption. The ceiling is 25,000
records on local SQLite and 10,000 on D1; a ceiling-limited result is labeled
partial.

The review queue uses deterministic email, Gmail-alias, phone, name, company,
and domain evidence with visible conflicts. **Approve cleanup plan** saves a
human review decision and selected primary record only. It does not invoke a
HubSpot native merge or write the displayed field-recovery plan. See
[whole-account duplicate audit](duplicate-audit.md).

## Option B: n8n OAuth

Use this when n8n already owns connector credentials or OAuth is preferred.

1. Run `docker compose up -d` and create the local n8n owner at `http://localhost:5678`.
2. Import [`csv-hubspot-sync-workflow.json`](../integrations/n8n/csv-hubspot-sync-workflow.json)
   and [`hubspot-source-workflow.json`](../integrations/n8n/hubspot-source-workflow.json).
3. Attach one HubSpot OAuth2 credential with `crm.objects.contacts.read` and
   `crm.objects.contacts.write` to the applicable HTTP nodes.
4. Publish both workflows.
5. Set `N8N_HUBSPOT_SYNC_WEBHOOK_URL=http://127.0.0.1:5678/webhook/gtm-control-tower-hubspot-sync`
   in `.env.local` so the dashboard can discover the connector. Change the URL
   only when n8n is not using the local default.
6. Set `N8N_HUBSPOT_SOURCE_WEBHOOK_URL=http://127.0.0.1:5678/webhook/gtm-control-tower-hubspot-source`.
7. Leave `HUBSPOT_ACCESS_TOKEN` blank; the server will use n8n.

n8n mode supports read-only source preview and delegated receipted writes. It
does not expose the whole-account duplicate scanner. Use a direct service key
when account scans, field-level preflight, or rollback are required, because
those paths need the server to read native records directly.

## Production safety

Set `CONTROL_TOWER_SYNC_KEY` in production. Authorized users enter the matching
value in the self-hosted operator UI; it is retained only for the current
browser tab. Keep n8n private or separately authenticated. Use HTTPS and never
commit the service key.

The current workflow intentionally does not delete contacts, associate
companies, mutate owner IDs, or move lifecycle stages. Those operations need
portal-aware preflight reads and separate review.

## Synthetic development fixtures

With a development service key containing both Contact scopes in `.env.local`,
run:

```bash
npm run seed:duplicate-audit -- hubspot
```

The command finds each clearly labeled synthetic Contact by email before it
creates or updates it. It writes CRM data and does not delete it afterward;
never target a customer or production portal.
