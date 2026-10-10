# Morning Handoff

## Finished

- Renamed the feature to **CRM Monitor** across HubSpot and Salesforce screens, the Operations Inbox, Slack notifications, routes, commands, configuration, source files and guides.
- Added an automatic SQLite upgrade that preserves account settings, scan cursors, findings, repair history and uncertain repair holds.
- Updated queued Slack links and generated titles without changing notification identity or delivery state. Previously delivered messages remain historical records.
- Retained the Safe Import and other completed feature work already integrated into main.

## Try It

1. Existing installations: stop the previous runner, retain the SQLite directory, and follow the configuration update in [CRM Monitor](docs/monitor.md) before restarting.
2. Run `docker compose up --build`, then open `/app/monitor` or `/app/work`.
3. For background checks, use `npm run monitor` or the Compose `monitor` profile. Configure your own CRM connections and [Slack destination](docs/slack-notifications.md).

## Checks

- 655 tests across 53 files passed, including five upgrade tests covering saved history, unknown repair holds, queued Slack messages, partial schemas and transactional rollback.
- Full TypeScript, lint, application/public builds, Compose configuration, runner help and diff checks passed.
- Mocked Monitor and Inbox browser checks passed on desktop/mobile, including both CRM providers and report downloads; zero external requests. Monitor desktop and Salesforce mobile were visually inspected.
- Secret scanning passed before publication. The pull request CI also checks the credential-free Docker installation and SQLite restart persistence.
- No CRM writes, Slack messages, native provider probes or application deployment occurred.

## Decisions

- Use CRM Monitor as the product name and `monitor` for technical identifiers.
- Keep retired storage identifiers only in the upgrade helper and regression fixtures so existing installations can migrate safely; preserve Git history.
- Update runner configuration and bookmarks during the upgrade; retired routes and commands are not aliases.

## Remaining

- Slack needs a configured webhook and private app URL. Native Salesforce automatic writes and hosted Safe Import execution remain unqualified.
- Four moderate development-tool dependency findings remain from the prior integration; production dependencies are clear at that integration's audit.

## Review First

- [Upgrade instructions](docs/monitor.md) and `.env.example`.
- `lib/monitor-migration.ts` and `tests/monitor-migration.test.ts`.
- The pull request's CI result and `/app/monitor`.
