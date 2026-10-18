# GTM Control Tower Codex plugin

A local desktop plugin with an MCP server and an import-review skill. It uses the
real self-hosted app and its saved SQLite workspaces, not the public preview.
Install Control Tower's Node dependencies and keep its app running before use.

## Configure

Create a private environment file outside this plugin directory:

```dotenv
CONTROL_TOWER_API_URL=http://127.0.0.1:3100
CONTROL_TOWER_SYNC_KEY=your-existing-operator-key
```

Use the same key as the running app. Do not commit this file or put credentials in
`plugin.json`, `mcp.json` or the skill. Restrict its file permissions to its owner.

```sh
node plugins/gtm-control-tower/scripts/configure.mjs \
  --repo /absolute/path/to/gtm-control-tower \
  --env-file /absolute/path/to/private.env
codex plugin marketplace add /absolute/path/to/gtm-control-tower
codex plugin add gtm-control-tower@gtm-control-tower-local
```

The configuration saves paths only in `~/.config/gtm-control-tower/codex-plugin.json`.
For a separate configuration, set `CONTROL_TOWER_PLUGIN_CONFIG` to another absolute
file path. The launcher uses the repository's maintained MCP implementation and
installed dependencies. It does not start Docker, install dependencies, or run
checks automatically. Removing the plugin leaves the app and its data intact.

Start a fresh Codex chat after installation. In desktop versions that require it,
restart the app and select the local marketplace in the Plugins Directory.

Try: “Use GTM Control Tower to list my saved imports and show the latest website
checks for the workspace I select.” Or: “Prepare a Safe Import review and explain
which properties would change.” The latter reads the configured CRM; neither
request authorizes a CRM write.

The tools inspect status, list/read workspaces, prepare/read import reviews, and
read/run saved website checks. They expose no CRM approval, execution, sending,
workspace deletion, or arbitrary HTTP request tool. Pomade handles its own saved
company identity, ICP and email-verification recipes through its separate plugin.

The [qualification connection](../../docs/pomade-qualification.md) adds
`send_to_pomade`, `get_pomade_qualification` and `refresh_pomade_qualification`.
Sending prepares a saved table; refresh brings completed observations into the
import review. Neither action runs recipes or writes to the CRM.
Use `preview_pomade_qualification` and `run_pomade_qualification` to review and
confirm provider usage without switching apps. `get_pomade_run` follows progress
and saves results; `cancel_pomade_run` stops future work. Existing limits apply.

This package requires Node.js 22.13+ and a local Control Tower checkout with its
normal dependencies. It is private/local distribution, not a public-directory or
remote ChatGPT connector. See [the official packaging guide](https://developers.openai.com/plugins/build/plugins).

Saved qualification reads include [import readiness](../../docs/import-readiness.md)
counts and row reasons. This advisory summary preserves existing holds and
exclusions; it does not approve or execute CRM changes.

Manage reusable [suppression lists](../../docs/suppressions.md) with
`list_suppressions`, `save_suppression`, `import_suppressions` and
`delete_suppression`. Match contacts by email/domain and companies by website
domain/name, with a required reason. Rules apply to all imports in the local
installation; manual skips and saved Pomade observations remain separate.

Review [local fuzzy suggestions](../../docs/local-matching.md) with
`get_local_matches`, then record an authorized Confirm/Dismiss or undo with
`decide_local_match`. These tools use saved data only. Assessments do not correct
fields, merge records, alter suppression lists, approve CRM targets or run checks.
