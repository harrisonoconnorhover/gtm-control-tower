# HubSpot setup

The Control Tower can be used without BigQuery. `/app` runs a durable
whole-account Contact duplicate audit; `/app/lab` handles CSV parsing, quality
checks, merge/reroute/replay, preview, and governed Contact writes. Only contacts
that pass the clean-record gate are sent after the operator approves a sync.

## What is written

The direct connector compares at most 100 eligible imported rows with current
Contacts before execution. An exact primary or additional email match selects
the native Contact ID for an update; a confirmed absence permits a create.
Ambiguous matches and multiple imported rows targeting one Contact are held.
Updates preserve the existing primary email. Creates use HubSpot's create API:
a conflict fails instead of silently updating another Contact. See the
[comparison cases and limits](import-crm-comparison.md).

The portable default mapping writes only standard HubSpot properties:

| CSV value | HubSpot property |
| --- | --- |
| `normalized_email` | lookup identity; `email` on create only |
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
4. Run `npm ci`, `npm run db:migrate:local`, and `npm run dev`.
5. Use `/app` for a durable whole-account duplicate audit, or `/app/lab` to
   import a CSV or read a bounded Contact sample. In `/app/lab`, choose
   **Compare N with CRM**, review the matched IDs and field changes, then
   explicitly execute the approved changes.

For an existing Docker installation, put the same settings in `.env` instead,
set `CONTROL_TOWER_SYNC_KEY`, and run `docker compose up -d app` to recreate the
app with those values. See [self-hosting](self-hosting.md#3-add-hubspot-or-salesforce)
if you prefer an explicit `--env-file .env.local`.

Direct service-key mode is the full governed path: native read, exact diff,
stale-plan check, per-record receipt, and update rollback. The server writes
only the portable properties listed above. Empty proposed values explicitly
clear those properties; the rollback snapshot restores their prior nullability.
The comparison must finish successfully; incomplete or invalid responses stop
the plan. Execution rereads the CRM and rejects a changed comparison, though a
separate CRM writer can still change data between that read and the write.

HubSpot treats [additional emails as Contact identifiers](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide#additional-emails).
The comparison uses both `email` and `hs_additional_emails`, while preserving the
primary `email` on updates. It does not infer a match from a similar name or
company when emails are different and unlinked.

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
5. For the Docker app, save these webhook URLs in the ignored `.env` file:

   ```dotenv
   N8N_HUBSPOT_SYNC_WEBHOOK_URL=http://n8n:5678/webhook/gtm-control-tower-hubspot-sync
   N8N_HUBSPOT_SOURCE_WEBHOOK_URL=http://n8n:5678/webhook/gtm-control-tower-hubspot-source
   ```

6. Leave `HUBSPOT_ACCESS_TOKEN` blank so the server uses n8n. Set
   `CONTROL_TOWER_SYNC_KEY` for the Docker app's production runtime and enter the
   same value in the operator UI when authorizing writes.
7. Run `docker compose up -d app` to recreate the app with the new values.

For an app running with `npm run dev`, put the settings in `.env.local`, replace
`http://n8n:5678` with `http://localhost:5678`, and restart the development server.
The browser opens n8n at `localhost:5678`; the Docker app reaches it by the
`n8n` service name. A plain Compose restart does not apply changed environment
values.

n8n mode supports read-only source preview and delegated receipted email
upserts. Its existing workflow does not gain **Compare N with CRM**, the direct
connector's create-only conflict behavior, or rollback. It does not expose the
whole-account duplicate scanner. Use a direct service key when those features
are required, because they need the server to read native records directly.

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
