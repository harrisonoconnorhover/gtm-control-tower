#!/usr/bin/env node
import { resolve } from 'node:path';
import { createSalesforceCdcSubscriber } from './lib/salesforce-cdc.mjs';

if (process.argv.includes('--help')) {
  console.log(`Usage: node --env-file-if-exists=.env.local scripts/subscribe-salesforce-cdc.mjs

Optional native Salesforce CDC subscriber (Bayeux/CometD long polling).
Enable Change Data Capture and grant the subscriber required object permissions.

Required env: SALESFORCE_INSTANCE_URL, SALESFORCE_ACCESS_TOKEN,
SALESFORCE_MONITOR_ORG_ID, CONTROL_TOWER_CDC_RELAY_URL,
CONTROL_TOWER_CDC_RELAY_SECRET (same >=32-character secret as the receiver).

Optional env: SALESFORCE_API_VERSION (67.0), SALESFORCE_CDC_CHANNEL
(/data/ChangeEvents), SALESFORCE_CDC_CHECKPOINT_PATH
(.runtime/salesforce-cdc/checkpoint.json).

Keep one process per channel and retain its checkpoint file across restarts.
A new stream replays available retained history (-2). Future reconnects use
only the last durably acknowledged native replay ID. Invalid replay IDs emit
an explicit gap and restart from retained history; no missing past is invented.
Ctrl+C stops the subscriber. Expired credentials require operator replacement.
No Avro decoder or separate Pub/Sub relay is needed for this subscriber.`);
  process.exit(0);
}
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
const subscriber = createSalesforceCdcSubscriber({
  instanceUrl: process.env.SALESFORCE_INSTANCE_URL,
  accessToken: process.env.SALESFORCE_ACCESS_TOKEN,
  organizationId: process.env.SALESFORCE_MONITOR_ORG_ID,
  apiVersion: process.env.SALESFORCE_API_VERSION,
  channel: process.env.SALESFORCE_CDC_CHANNEL,
  relayUrl: process.env.CONTROL_TOWER_CDC_RELAY_URL,
  relaySecret: process.env.CONTROL_TOWER_CDC_RELAY_SECRET,
  checkpointPath: process.env.SALESFORCE_CDC_CHECKPOINT_PATH || resolve('.runtime/salesforce-cdc/checkpoint.json'),
});
try { await subscriber.run({ signal: controller.signal }); }
catch (error) { console.error(error instanceof Error ? error.message : 'CDC subscriber stopped; inspect the saved checkpoint.'); process.exitCode = 1; }
