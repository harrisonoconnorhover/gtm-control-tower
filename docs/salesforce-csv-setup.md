# CSV to Salesforce setup

The Control Tower can write governed CSV contacts to Salesforce Leads without BigQuery. Parsing, diagnosis, and repair remain in the browser until the user explicitly clicks **Sync to Salesforce**. Only allow-listed standard Lead fields cross the network boundary.

## Lead mapping and gate

| CSV value | Salesforce Lead field |
| --- | --- |
| `email` / `normalized_email` | `Email` |
| `first_name` | `FirstName` |
| `last_name` | `LastName` |
| `company` | `Company` |
| `phone` | `Phone` |
| `job_title` | `Title` |
| `website` | `Website` |

Merged rows, malformed or overlong emails, unresolved duplicates, lifecycle regressions, missing company, and missing last name are held back. Salesforce requires `Company` and `LastName` on Leads. Owner, status, source, score, lifecycle, and custom fields are not written because those values are organization-specific.

The connector does a bounded SOQL lookup before every write:

- no active Lead with the email: create one;
- exactly one active Lead: update its portable fields;
- more than one active Lead: return a held failure instead of guessing.

## Local connection

1. Authorize Salesforce CLI with `sf org login web --alias gtm-control-tower-salesforce --set-default`.
2. Run `npm run configure:salesforce`. It reads the current CLI session into ignored, owner-readable `.env.local` without printing the access token.
3. Restart the dashboard, import a CSV, resolve held rows, and click **Sync to Salesforce**.

The generated environment includes the organization instance URL, its current API version, and a local access token. Treat `.env.local` as a secret even though Git ignores it. Rerun the command if Salesforce rotates the CLI token.

For a long-running deployment, obtain and refresh access tokens through a Salesforce OAuth connected app rather than copying a CLI token. Keep the resulting secret server-side. Salesforce documents bearer authorization and the REST Composite resource in its [REST API guide](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite_composite_post.htm).

## Production boundary

Set `CONTROL_TOWER_SYNC_KEY` in production. Authorized users enter the matching value in the Salesforce panel; it stays only in component memory. The server refuses production writes without that second key. Host behind authentication and HTTPS before exposing mutation controls.
