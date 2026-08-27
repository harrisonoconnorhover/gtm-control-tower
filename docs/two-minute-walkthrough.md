# Two-minute portfolio walkthrough

## Narration

GTM Control Tower begins where revenue teams usually lose trust: a file that
looks populated but contains duplicate identities, malformed email, missing
owners, conflicting company data, and lifecycle stages moving backward.

The operator can start for free with a CSV, or read contacts from Google Sheets,
HubSpot, or Salesforce. Every source enters the same visual mapping and
validation path. Nothing writes during preview.

Identity normalization makes comparisons deterministic while preserving the raw
evidence. Duplicate clusters are merged logically, so the source rows remain
queryable. Capacity rules reroute overloaded territories, and lifecycle replay
restores impossible regressions without inventing history.

The destination gate now separates canonical, explainable identities from held
records. A write preview reads the CRM first and shows every field changing from
its current value to its proposed value. The operator can download the pre-write
backup before approving the bounded batch.

After execution, Sync Runs retains input counts, repairs, held reasons, the
field-level plan, native record results, failures, and the provider receipt.
Eligible updates can be rolled back from the same history. Newly created records
are deliberately never auto-deleted.

This is not only a deterministic browser demonstration. A separate seventy-two
row acceptance batch ran against development HubSpot and Salesforce systems.
Eight duplicates were merged, six malformed emails stayed out, and fifty-eight
governed identities reached both CRMs. Repeating the Salesforce batch created
zero duplicates and updated the same fifty-eight Leads.

Bad CRM data goes in. Defensible action, durable evidence, and trustworthy CRM
state come out.

## Recording notes

- The checked-in MP4 is generated from the public synthetic demo only.
- The WebVTT captions match this narration and remain available independently.
- Regenerate on macOS with a local app server by running
  `npm run generate:walkthrough -- http://localhost:3001`.
