# Codex plugin

The [local plugin package](../plugins/gtm-control-tower/README.md) connects Codex to
saved Control Tower workspaces through MCP and bundles an import-review workflow.
Its maintained server is `scripts/control-tower-mcp.mjs`. The app remains the
source of saved state, website observations and CRM review decisions.

The local marketplace is `.agents/plugins/marketplace.json`. Follow the package
README to configure the existing operator key, install, and open a fresh chat.
Only loopback app origins are accepted. No credentials belong in the package.

Supported tools: `get_status`, `list_workspaces`, `get_workspace`,
`prepare_import_review`, `get_import_review`, `get_website_checks`, `check_websites`,
`send_to_pomade`, `get_pomade_qualification`, `refresh_pomade_qualification`,
`preview_pomade_qualification`, `run_pomade_qualification`, `get_pomade_run`,
`cancel_pomade_run`.
Workspace and review rows are paginated. The authenticated metadata endpoint
`GET /api/control-tower/workspaces` supports discovery without loading contact data.

Preparing a review reads CRM records and persists the proposed changes; checking
websites reads public sites and persists observations. CRM approval and execution
remain in the existing app. The [Pomade qualification connection](pomade-qualification.md)
prepares a dedicated table, previews provider usage and runs explicitly confirmed
checks through Pomade's existing background controls. Status reads automatically
save partial/final observations. None of these qualification tools writes CRM.

`get_pomade_qualification` also returns derived [import readiness](import-readiness.md)
with counts and separately paginated row reasons, even before Pomade preparation.
It reads saved state only and never approves or executes an import.

The plugin can also manage [saved suppression lists](suppressions.md) through
`list_suppressions`, `save_suppression`, `import_suppressions` and
`delete_suppression`. Rules apply across the local installation. These tools only
change local rules; they do not run providers, send email or write CRM records.

`get_local_matches` provides paginated [local matching suggestions](local-matching.md)
and `decide_local_match` saves Confirm/Dismiss/clear assessments against current
evidence. Both stay local. These assessments are separate from confirmed CRM
targets, exact suppression rules, source corrections and import approval.
