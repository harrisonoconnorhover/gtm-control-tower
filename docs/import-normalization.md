# Shared templates and local normalization

Use the self-hosted **Import workspace** with Contacts, Companies, or Contacts +
associated companies. Everything in this guide saves locally. It does not run
paid checks or write records to a CRM.

1. Upload a CSV and review source columns → destination fields.
2. For a custom property, enter its CRM label, internal property name, and object.
   For example, add **Fav. Ice Cream**, property `favorite_ice_cream`, Contact;
   map the source **Favorite icecream** column to it.
3. Save a **shared import template**. Templates retain header mappings, custom
   definitions, normalization rules, and optional HubSpot property bindings across workspaces on the same installation.
   Future matching headers show **Auto-mapped · template name**. Manual selection
   clears that flag. Conflicting templates or duplicate header aliases stay for
   review; choose a template explicitly to resolve different rule sets.
4. Choose **Validate + load**, then open **Normalize values**. Inspect paged
   before/after values and warnings, edit rules, and choose **Apply local
   normalization**. Original imported values remain available through reset;
   **Undo saved change** restores the prior saved workspace.
5. Save or update the shared template after editing rules. Export the prepared
   CSV to retain country/address/category/custom values. Custom export headers
   include their object and stable property key. Reuse the template when importing
   the export. Old workspace-only mapping presets remain available.

## Supported rules

| Data | Behavior |
| --- | --- |
| Countries | English country names and ISO codes → full names by default, including US/USA → United States; codes are an optional template setting. |
| States/provinces | US states and Canadian provinces/territories, using the row country or an explicit default country; other regions remain for review. |
| Names | Clean spacing; optional title case; split simple two-part or “Last, First” names without replacing existing parts. Ambiguous names require review. |
| Phones | Parse using explicit international prefix or country context; format internationally and preserve extensions. This does not establish reachability. |
| Addresses | Clean spacing while preserving address content, city, and postal code. No geocoding or postal-address verification. |
| Job titles | Editable word/phrase rules fill blank department/persona fields; conflicting categories produce warnings. Exact-value rules can standardize the title itself. |
| Custom and other data fields | Exact-value replacements ignore case and extra spaces, with conflict/cycle warnings. IDs, emails, owners, and review controls are excluded. |

Skipped, merged, and suppressed rows are not normalized. Contact and associated
company values stay separate. Settings do not change row values until Apply.
Existing Pomade credits, consent, stale-result checks, and CRM gates remain in
place. The added custom property mapping is for local preparation/export; it does
not expand the existing CRM connector write allowlists.

The shared library is protected by the existing operator key and stored in the
self-hosted SQLite database. It is not a cloud/team account service. The current
saved-workspace limit remains 5,000 rows and 8 MiB; templates support 50 custom
fields, 100 title rules, and 200 exact-value rules.

Country and phone parsing use the local
[ISO country library](https://github.com/michaelwittig/node-i18n-iso-countries) and
[libphonenumber-js](https://github.com/catamphetamine/libphonenumber-js).

## HubSpot fields and normalized dry run

On the self-hosted server, use the existing `HUBSPOT_ACCESS_TOKEN`, or configure
`HUBSPOT_IMPORT_READ_TOKEN` for this preview alone. The latter variable does not
enable the existing CRM write connectors. The connection needs permission to read
contact/company property definitions and matching records.

1. Open **HubSpot fields and normalized import** and click **Load HubSpot fields**.
   This verifies the portal and reads its actual contact/company properties.
   Each selector shows the label and internal name; picklists expose actual labels
   and stored values. Free-text country/state properties remain free text.
2. Review suggested mappings. Contact fields and associated-company fields have
   separate destinations. Missing custom properties are flagged; this feature
   never creates them. Use **Add value mapping** to translate source aliases to
   actual picklist choices, then **Save HubSpot mapping**. Save/update a shared
   template to remember these choices for later files.
3. Click **Run normalized HubSpot dry run** for up to 500 source rows. Normalization
   runs in memory; imported originals and current workspace rows are preserved.
   Compare original, normalized, current HubSpot, and proposed values per field.
   Counts distinguish proposed creates, updates, unchanged, review, and skipped
   objects. Identical company projections are grouped by ID or exact hostname;
   conflicting company values and ambiguous identities require review.
4. The default fills empty CRM fields and preserves existing values. The optional
   overwrite policy only changes the preview. Blanks never propose clearing CRM
   data, and email/record IDs are lookup identities, never proposed replacements.

The latest dry run is saved locally and reappears on reload without a CRM request.
Changed rows, mappings, rules, or policy mark it stale. Each new run refreshes the
schema and current CRM values; a template cannot silently switch HubSpot portals.
Unmapped populated fields, invalid/hidden picklist choices, read-only properties,
unreadable values, failed lookups, and existing import holds have explicit reasons.
This advisory review does not enable execution, verify contact-company
associations, or replace Pomade qualification and existing import-readiness gates.

The implementation uses HubSpot's
[property definitions](https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/guide)
and the existing allowlisted CRM read transport. There are no paid-check calls or
CRM mutation routes in this feature. Run `node scripts/check-hubspot-import.mjs`
for the mocked browser check. The separate
`node scripts/check-hubspot-import-native.mjs` reads the configured HubSpot portal
and creates a new local demo workspace/template; it never writes to HubSpot.

For a repeatable synthetic UI check, run
`CONTROL_TOWER_BROWSER_BASE_URL=http://127.0.0.1:3100 node scripts/check-import-normalization.mjs`.
It creates fresh local workspaces and a uniquely named demo template, uses the
120-row fixture under `tests/fixtures/import-normalization`, and blocks provider
execution and CRM requests.
