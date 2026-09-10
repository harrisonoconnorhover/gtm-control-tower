# Hollis Consulting website and live intake

Hollis is the public consulting website in `hollis/site`. Its Cloudflare Worker
(`hollis/worker.ts`) is GTM Control Tower's anonymous entry point, sharing the
submission/receipt contract in `lib/demo-intake.ts` and the transactional
`GTMDemoIntake` Salesforce service. The existing private operator app and static
practice showroom remain separate.

The implementation builds on the **build for MNTN** task's connected intake
(commit `c9bbfa8`). The supplied form reference asks for first name, last name,
business email, phone number, and company name. Hollis uses those five fields;
phone is optional and accepts an international number. The public copy contains
no claimed clients, testimonials, invented results, or third-party branding.
The hero uses a licensed photograph of workflow planning. It does not depict Hollis staff or a client; source and license are recorded in `hollis/ASSETS.md`.

## Record behavior

- One exact email match reuses its Contact and Account, preserving ownership and
  existing fields. Two or more Contact/unconverted Lead matches are held.
- For an unknown person, both company name (trimmed, case-insensitive, repeated
  spaces collapsed) and the exact business email domain must agree with an
  existing Account's website or intake domain. Website paths and `www.` are
  removed. Similar names, conflicting domains, shared domains with different
  names, or duplicate candidates are held rather than guessed.
- Otherwise, the transaction creates one Prospect Account and a linked Contact.
  The intake domain is labeled as requester-supplied identity evidence; it does
  **not** populate an unverified Website, employee count, tier, or region.
- A single existing Lead with a matching company and active user owner is
  converted to the selected Account and a Contact, without an Opportunity.
- A second person at the same company reuses the Account. Domain and email locks
  serialize submissions. Each genuine request creates one Task, linked to both
  Account and Contact, and requests an owner notification. Retrying the same ID
  reuses the receipt and task; changed details with the same ID return conflict.
- Common personal email domains and uncertain matches are saved as Held Demo
  Requests with a high-priority owner task for manual review. They do not silently create a company. Correct the
  Salesforce data and replay the same request to re-evaluate a held match; its review task becomes the matched follow-up task.
- New Accounts use the integration user's ownership. The form has no territory
  or tier data; it does not guess assignments to the practice AE roster.

## Hosting and authentication

This deployment uses Harrison's existing Cloudflare account, as requested,
through `hollis/wrangler.jsonc`; it does not replace `.openai/hosting.json` or the
existing Pages projects. Assets are restricted to `hollis/site`. Secrets are
server-only Cloudflare secrets. The Worker renews Salesforce OAuth sessions and
retries a rejected session once. Public responses disclose only acceptance and a
request reference, never CRM IDs, matching status, owner identity, or credentials.

A same-origin JSON endpoint, bounded payload, hidden bot field, and Cloudflare's
5-per-minute IP limit reduce accidental and automated spam. This is a basic abuse
limit, not verified identity or a global quota; Cloudflare rate counters are local
to a location. No analytics or advertising trackers are included.

## Deploy and verify

```sh
sf project deploy start --target-org gtm-control-tower-salesforce --manifest salesforce/manifests/demo-intake.xml --test-level RunSpecifiedTests --tests GTMDemoIntakeTest --wait 10
node scripts/configure-hollis-secrets.mjs
npx wrangler deploy --config hollis/wrangler.jsonc --dry-run
npx wrangler deploy --config hollis/wrangler.jsonc
```

The secrets helper passes the explicitly authorized CLI connection through stdin;
it does not print or store its values in source. Revoking that connection stops
new intake until reconnected. The current destination is the user's Developer
Edition org, not an unrelated production CRM.

Tests: `npx vitest run tests/hollis-intake.test.ts tests/demo-intake.test.ts`,
`npx tsc --noEmit`, and `npm run lint`. Apex tests verify real transaction,
matching, conversion, retry, and rollback behavior in Salesforce. Confirm a live
public submission with native `GTM_Demo_Request__c`, Account, Contact, and Task
read-back before calling the deployment complete. Current evidence belongs in
`HANDOFF.md`; detailed receipts stay in ignored `.runtime/`.

Provider references: [Cloudflare rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
and [Salesforce refresh tokens](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_refresh_token_flow.htm&language=en_US&type=5).
