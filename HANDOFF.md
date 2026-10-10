# Morning Handoff

## Finished

- Added Slack digests for HubSpot and Salesforce findings, resolutions, repair outcomes, monitoring failures, CSV intake, saved reviews, execution results and triage changes.
- Added a persistent deduplicated queue, bounded delivery, concurrency protection, rate-limit handling and explicit uncertain outcomes without automatic replay.
- Added the Slack status card to `/app/work`, with setup guidance, queue counts, test delivery and send-queued controls. The existing runner delivers while the browser is closed.
- Retained the shared Operations Inbox, provider-aware Safe Import and Watchdog. Notifications link to saved evidence and carry counts and labels without CRM values or source text.

## Try It

1. Follow [Slack setup](docs/slack-notifications.md): set the channel webhook and private app origin in ignored server environment configuration, then restart the persistent SQLite app.
2. Open `/app/work`, enter the operator key and click **Send test message**. Check its delivery status and the chosen Slack channel.
3. Run `npm run watchdog`; select `hubspot,salesforce` with `CONTROL_TOWER_WATCHDOG_PROVIDERS` for both CRMs. Docker supports the existing `watchdog` profile. CRM monitoring and automatic repairs retain their separate settings.

## Checks

- Full suite: 646 tests across 51 files passed. After the final concurrent-triage adjustment, 27 relevant tests, TypeScript and focused ESLint passed.
- Build, script syntax, Compose configuration, diff checks and secret scan across 2,140 Git objects passed.
- Inbox and Slack browser probes passed with mocked APIs and zero external requests. Slack covered seven states, four intentional send actions, read-only polling and desktop/mobile layouts.
- No live Slack delivery, CRM writes or deployment occurred in this change. Earlier native read-only HubSpot/Salesforce evidence remains recorded in the provider guides and private outputs.

## Decisions

- Use a channel-bound incoming webhook, configured only on the server. Approval stays in the private app.
- Enqueue after source persistence; notification failure cannot undo a CRM result. A crash in that short gap can miss a notice.
- Preserve unknown outcomes and deduplicate unchanged observations. See [decisions](docs/decisions.md).

## Remaining

- Live activation needs a channel webhook and private app URL; neither is configured locally. No live delivery claim yet.
- Native Salesforce writes remain unqualified. Existing whole-file Safe Import D1 execution remains blocked; this slice requires SQLite.
- Polling can miss intermediate changes; tokens can expire. Automatic OAuth refresh, Slack approvals and team roles remain outside this slice.

## Review First

- [Slack setup and delivery behavior](docs/slack-notifications.md).
- `lib/slack-notifications.ts` and `lib/operation-notifications.ts`.
- `/app/work` and `components/slack-notification-status.tsx`.
