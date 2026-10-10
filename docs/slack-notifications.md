# Slack notifications

Control Tower can send a short operations digest to a Slack channel for both
HubSpot and Salesforce. Messages link to the private review or finding. Approval
and CRM changes still happen in Control Tower; there are no Slack approval buttons.

## Connect a channel

1. In your Slack app, enable **Incoming Webhooks** and add a webhook to the channel
   that should receive alerts. Follow Slack's [incoming webhook setup](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).
   Slack binds this URL to the chosen channel; Control Tower does not override it.
2. Set these values in the app server's ignored `.env.local` (Node) or `.env` (Docker):

   ```dotenv
   CONTROL_TOWER_SLACK_WEBHOOK_URL=<the channel's secret incoming webhook URL>
   CONTROL_TOWER_APP_URL=https://your-private-control-tower.example.com
   ```

   Use the reachable origin of the private operator app, not the static public
   showcase. HTTPS is required except for localhost development. Keep the webhook
   secret out of Git, browser settings and logs. It is never stored in the database.
3. Restart the app. Open `/app/work`, enter the operator key, and use **Send test
   message** on the Slack card. It shows whether that specific test was accepted,
   queued, rejected or unconfirmed. Looking at the page does not send a message.
4. Run `npm run monitor` to keep delivery going while the browser is closed. The
   CRM Monitor runner drains notifications after its CRM checks and wakes at least
   every 30 seconds between checks. A slow CRM check can delay that cycle.
   For Docker use the `monitor` Compose profile; it sends only the operator key
   to the app, and the Slack secret remains on the app service.

To pause Slack, remove `CONTROL_TOWER_SLACK_WEBHOOK_URL` and restart the app.
Previously queued notifications remain paused; events created while disconnected
are not backfilled. Reconnecting resumes pending notices. Changing the webhook
changes the destination for subsequent delivery, including pending notices.

## What gets sent

| Trigger | Notification |
| --- | --- |
| New or reopened CRM Monitor finding | Rule and object type, with a finding link |
| Issue no longer present | Resolution notice |
| Whitespace repair finished | Verified repair or uncertain outcome requiring review |
| Monitoring page fails | Failure notice; identical failures stay quiet until a successful page |
| CRM connection cannot be verified | At most one connection notice per provider per day |
| Inbox CSV received | Row count and saved workspace link; identical uploads reuse the task |
| Safe Import review saved | Proposed, held, unmatched, unresolved, unchanged and skipped counts |
| Import execution or reconciliation changes | Verified, uncertain and remaining counts from saved evidence |
| Assignment, note or triage decision changes | Notice pointing to the current owner and next step |

The payload includes no contact names, emails, field values, filenames, notes,
assignee names or raw provider errors. Slack links contain internal workspace,
review and finding identifiers. Users need access to the operator app to inspect
the evidence. Source text cannot become a Slack mention or change a destination.

## Delivery behavior

SQLite stores a deduplicated event queue and each delivery attempt. A worker
claims up to 20 events for one digest before making one HTTP request. Concurrent
workers cannot claim the same digest. The queue enforces at least one second
between requests and honors Slack's [`Retry-After` rate limit response](https://docs.slack.dev/apis/web-api/rate-limits/).

Only HTTP 200 with Slack's `ok` body confirms delivery. HTTP 429 keeps the digest
pending for later delivery. Definite HTTP 400/403/404 rejections stay failed;
correct the webhook/channel configuration and send a test before relying on new
alerts. Previously failed digests are retained and are not automatically replayed.
Network interruptions, server errors, unexpected responses and expired sending
claims remain unconfirmed, since the message may already be in Slack. They are
never blindly resent. A later event can still be delivered normally.

The Inbox card exposes queue counts and the latest delivery result. **Send queued**
attempts one eligible digest; it does not retry failed or unconfirmed messages.
Slack delivery failure does not undo a CRM action or mark that action failed.

Events are enqueued after the source operation is saved. A process crash or
storage failure in that short gap can miss a notice; this is not an exactly-once
notification guarantee. The durable review and finding remain the source of
truth. This feature currently requires the self-hosted SQLite runtime.

## Verification

```bash
npx vitest run tests/slack-notifications.test.ts tests/slack-notification-route.test.ts tests/operation-notifications.test.ts tests/monitor-runner.test.ts
CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3197 npm run test:slack-ui
```

The tests use fictional Slack responses and temporary SQLite; browser checks
block external requests. A live channel delivery is not qualified until a
configured test message is accepted and observed in that channel.

## Incident events and durable intent

New, reopened and resolved incidents, changed human follow-up and automatic repair pauses use the same configurable destination. Incident/monitor-finding/repair state transitions now commit notification intent atomically in SQLite, then forward through a durable outbox. The existing notification queue deduplicates forwarded events. A forwarding interruption leaves intent available for the next drain; it cannot erase the saved operation or authorize a CRM write. Import notifications retain their existing post-save behavior. No destination is configured by this change.
