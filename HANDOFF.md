# Morning Handoff

## Finished

- Verified actual CRM reads through the application's scan, storage and import-matching handlers: 17 HubSpot Contacts; 94 Salesforce unconverted Leads and 36 Contacts. Both scans completed.
- Existing fictional fixtures produced expected exact-email, changed-email, same-name, shared-phone and unrelated-person suggestions. Salesforce secondary mobile-phone matching also worked.
- Verified exact-email preview proposals: HubSpot unchanged/update/create; Salesforce Contact hold, Lead unchanged and create. Existing native IDs matched the stored fixtures.
- Added a dated native-check report and redacted results; updated both walkthroughs to distinguish native reads from simulated browser evidence.
- Made no CRM writes, new features or runtime-code changes.

## Try It

1. Read `docs/import-matching-native-check.md` for observed cases, request statuses and remaining limits.
2. In a configured self-hosted `/app/lab`, import a fictional CSV and use **Find possible CRM matches** against a fresh snapshot.
3. Use the separate **Compare N with CRM** preview to inspect exact-email proposals. Review does not execute them.

## Checks

- Native run on September 27, 2026 at 19:26–19:28 UTC: three scan reads and four identity reads; expected scores, fixture membership, missing-field handling and preview operations passed assertions.
- HubSpot's mixed batch read returned 207; an individual 404 confirmed the missing fictional email. Salesforce Developer Edition and existing CLI session were verified.
- Prior runtime release passed 210 tests, lint, TypeScript, both builds, simulated/local browser checks and fresh-install CI. This pass changes documentation/evidence only; Markdown links/fences, redacted JSON, credential/contact-detail exclusion and diff checks passed.

## Decisions

- Retain scores out of 100 as uncalibrated review signals; 100/100 does not mean certainty.
- Publish counts and fictional case outcomes; keep account IDs, native record IDs, credentials and contact details out of the evidence artifact.
- Native reads and preview proposals do not qualify writes or replace the earlier browser-test boundary.

## Remaining

- Publish the report and updated website evidence sentence. Documentation is mirrored into the local development checkout, preserving private development differences.
- Native populated state/additional-email cases, continuation cursors, converted Leads, write execution, duplicate rules and rollback remain outside this run. No measured precision/recall claim.

## Review First

- `docs/import-matching-native-check.md` and its redacted JSON evidence.
- `docs/approximate-import-matches.md` and `docs/import-crm-comparison.md` verification sections.
- The existing **Compare with CRM** paragraph on the personal site.
