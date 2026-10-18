# Choose the import object

The self-hosted CSV setup asks **What does each row represent?** before mapping.
Choose **Contacts**, **Companies**, or **Contacts + associated companies**. The
choice applies to the next file you validate and load; it does not reinterpret
already saved rows. Saved workspaces and mapping presets retain their object.
Older workspaces and presets default to Contacts.

## Contacts + associated companies

Use one contact and its associated company per CSV row. Mapping choices are
split into **Contact fields** and **Associated Company fields**. A generic `Name`,
`Phone`, or `State` column belongs to the contact. `Company`, `Company name`, and
`Website` map to the associated company; `Company phone` and `Company state` map
separately. Review any ambiguous or unmapped columns before loading.

Contact company context, when explicitly mapped, is separate from the associated
Company record. The parser does not copy values between these objects. The CSV
export preserves both sets of values, including `associated_company_id`,
`associated_company_name`, `associated_company_website`,
`associated_company_phone`, and `associated_company_state`.

The review proposes company groups using a supplied company record ID first,
otherwise an exact normalized website hostname (ignoring scheme, path and `www`).
A company name alone leaves the contact unlinked. Separate IDs sharing a domain
stay separate and get a warning; conflicting names or hostnames need review.
These are proposals, not verified CRM associations or canonical company names.
Search a company or contact and expand the group to inspect its contact rows.

Local duplicate matching uses the associated company's name and website as
context for the person. The company phone is never substituted for a personal
phone. Company suppression rules use the associated company's fields.
Confirm/Dismiss remains an assessment, not a correction or association approval.

## Company-only files

Company rows use company names, websites, phones, and company IDs. They do not
require person names or email addresses. Local suggestions compare companies,
without person-duplicate or name-frequency claims.

## Current scope

Company-only and combined modes support local CSV review/export. CRM Company or
Account creation, CRM association writes, and Pomade qualification are unavailable
in these modes. The server enforces that boundary as well as the UI. Existing
Contact workflows retain their separate CRM and qualification controls.

## Try the 140-contact fixture

Use [messy-contacts.csv](../tests/fixtures/local-matching/messy-contacts.csv) and
choose **Contacts + associated companies**. All email addresses and website hosts
use reserved `.test` domains; run local matching only. See the
[labeled examples and observed limitations](../tests/fixtures/local-matching/README.md).
The deployed local sample has 122 proposed company groups, two groups needing
review, one confirmed duplicate, one dismissed false positive, and 23 pending
suggestions. Those are curated test results, not a real-world accuracy estimate.
