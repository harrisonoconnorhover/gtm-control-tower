# Saved suppression lists

The self-hosted import review accepts reusable suppression lists for contacts and
companies. Rules are saved in this local Control Tower installation and apply to
all its import workspaces, including future imports. The public browser preview
does not save these lists.

Each rule has a list name, match type, value, reason and enabled state. Add a rule
individually, or paste/upload a CSV. Review the parsed rules and current matches,
then save. Search, edit, disable, delete or export saved rules in the same panel.

## Matching rules

| Type | Matches | Example |
| --- | --- | --- |
| `email` | Exact contact email, ignoring case and outer whitespace | `person@vendor.example` |
| `email_domain` | Domain after the contact email's `@` | `vendor.example` |
| `website_domain` | Company website hostname; scheme, path and `www` do not matter | `https://www.vendor.example/about` |
| `domain` | Either contact email domain or company website domain | `vendor.example` |
| `company_name` | Exact company name after case/whitespace normalization | `Example Vendor Inc` |

Domain rules match the named domain by default. **Include subdomains** is opt-in:
`vendor.example` then also matches `sales.vendor.example`, but never
`notvendor.example` or `vendor.example.other.test`. Internationalized domains are
normalized consistently. Company names are not fuzzy matched: legal suffixes,
punctuation and distinct names remain distinct. Blank fields do not match.

Company rules suppress contact/lead import rows associated with the matching
company. They do not delete or modify company objects in a CRM. Contact IDs are
not global suppression keys because different CSVs can reuse the same row IDs.

## CSV format

Required columns: `type,value,reason`. Optional columns: `list_name`,
`include_subdomains`, `enabled`. Missing optional values use `Suppression list`,
`false` and `true`, respectively. Use `true`/`false` for booleans. For example:

```csv
list_name,type,value,reason,include_subdomains,enabled
Vendors,domain,vendor.example,Existing vendor,true,true
Do not contact,email,person@example.test,Requested no contact,false,true
Competitors,website_domain,https://competitor.example/,Competitor,false,true
Partners,company_name,Example Partner Inc,Partner relationship,false,true
```

Lists support up to 5,000 saved rules and CSV uploads up to 5 MiB. All input rows
are validated before any are saved. A batch adds rules instead of replacing the
existing library. Identical entries are reused; edit an existing rule to change
its reason or enabled state. Export preserves list names, reasons and settings.

## Import behavior

Matching rows show **Excluded** with their matching rules and reasons. Matches
are recalculated from current rules; source values and manual skip decisions
remain separate. Disabling/deleting a rule removes only that rule's suppression.
A row still excluded manually or by another rule stays excluded.

Suppressed rows are omitted from eligible import selections and provider check
selections. Current rules are also checked by the server before CRM import writes;
changing relevant matches invalidates an older Safe Import approval. Saving rules
itself never contacts a provider, sends email or writes CRM records.

Existing website/Pomade evidence is retained. Suppressing or restoring a row does
not require a new paid check when its saved inputs still match. The CSV review
export keeps all rows for audit and includes suppression metadata; it is not an
automatic import of those rows into another system.

## API and Codex plugin

Authenticated `GET /api/control-tower/suppressions` reads `{rules}`.
`POST` supports `save` with `rule`, `import` with `rules`, and `delete` with `id`.
The local Codex plugin provides `list_suppressions`, `save_suppression`,
`import_suppressions` and `delete_suppression`. Rule reads are paginated in the
plugin. Its existing workspace/readiness tools show effective matches.
