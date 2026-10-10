#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { cdcRelayUrl, sendCdcEnvelope } from './lib/salesforce-cdc.mjs';

if (process.argv.includes('--help')) {
  console.log(`Usage: node --env-file-if-exists=.env.local scripts/relay-salesforce-cdc.mjs < decoded-cdc.ndjson

Forwards ordered, decoded Salesforce Pub/Sub envelopes to Control Tower.
For a built-in native subscriber, use scripts/subscribe-salesforce-cdc.mjs.

Required: CONTROL_TOWER_CDC_RELAY_URL (HTTPS Salesforce intake URL),
CONTROL_TOWER_CDC_RELAY_SECRET (same >=32-character secret as receiver).

Each NDJSON line contains organizationId, channel, replayId, previousReplayId
(null for a new stream), and events (decoded native payloads). Use gapReason
for expired replay IDs or reset streams. Preserve opaque replay IDs exactly.
The upstream subscriber must persist the acknowledged replayId and resume
from it. On failure this command exits; it never silently skips a line.
Native CRM credentials are not forwarded by this relay.`);
  process.exit(0);
}
const url = cdcRelayUrl(process.env.CONTROL_TOWER_CDC_RELAY_URL);
const secret = process.env.CONTROL_TOWER_CDC_RELAY_SECRET;
if (!secret || secret.length < 32) throw new Error('Set a CDC relay secret of at least 32 characters.');
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  if (Buffer.byteLength(line) > 1_048_576) throw new Error('CDC envelope exceeds 1 MiB.');
  let value;
  try { value = JSON.parse(line); } catch { throw new Error('Invalid CDC envelope JSON; forwarding stopped.'); }
  const result = await sendCdcEnvelope(url, secret, value);
  console.log(JSON.stringify({ channel: value.channel, replayId: result.replayId, needsReconciliation: result.needsReconciliation, accepted: result.accepted }));
}
