# Fictional messy-contact evaluation

Import `messy-contacts.csv` as **Contacts + associated companies** to review people and proposed company associations together. Contact-only mode is also supported for the matching regression. It contains 140 rows (100 clean background rows and 40 curated messy rows). Map `contact_id` to Contact ID, `full_name` to Full name, `email` to Email, `company` to Associated company name, and `website` to Associated company website. The `scenario` column is explanatory fixture metadata and need not be mapped.

All people, addresses, and websites are invented; email and website hosts use reserved `.test` domains. Microsoft/IBM/IBN are spelling examples, not verified companies. Run only local matching; this fixture needs no website, email-provider, or CRM requests. Provider-specific Gmail alias behavior remains in the existing unit tests so the live sample contains no potentially deliverable address.

`expected-pairs.json` contains authored ground truth, not conclusions derived from matcher scores. Use both record IDs to find each review item; company suggestions may appear in both directions. Scores rank evidence and are not probabilities.

| Try | Rows | Expected demonstration |
| --- | --- | --- |
| Common name | `common-01` / `common-02` | Different John Smiths at one company; low warning, score 40, six local identities with this name. Dismiss is appropriate. |
| Uncommon name | `rare-01` / `rare-02` | Same Zelyra Quenholt with changed email/phone; medium warning, score 54, two local identities with this name. Same supporting evidence as the common-name example, 14-point rarity difference. |
| Confirm | `confirm-01` / `confirm-02` | Same Zorelia Mossvale, different emails, matching personal phone/company/domain; high warning, score 82. |
| Company typo | `company-01` / `company-02` | Microsfot / Microsoft with matching fictional website; high suggestion, score 80. |
| Dismiss | `phone-01` / `phone-02` | Different Xandrel Larkspurs sharing a switchboard with different extensions; medium warning, score 58. The explicit conflict needs human judgment. |
| Known miss | `nickname-01` / `nickname-02` | Robert / Bob Bramblewick is authored as one person, but nickname equivalence is not inferred without a stronger anchor. No warning. |

Also covered: initials, reordered names, accents, email transposition, repeated personal email, legal company suffixes, preserved business plus addresses, shared inboxes, unrelated switchboard users, conflicting middle names, and short acronyms.

## Observed fixture result

With `local-match-v1`, the 140 rows yield **138 named identities** after exact-email deduplication, so local name-frequency weighting is available. No population rarity is inferred.

Of 32 hand-labeled pairs:

- 10 of 11 known same-person/same-company pairs have suggestions. The Robert/Bob nickname pair is the known miss.
- 13 of 21 known distinct-person/distinct-company pairs have suggestions: 12 common-name pairs and the same-name switchboard pair. These are deliberate false-positive warnings for review, not automatic merges.
- Eight labeled negative pairs are unflagged, including the shared inbox, unrelated switchboard, conflicting middle names, and short acronym controls.
- None of the 100 clean background rows has a finding.

This is a curated behavior test, not a population accuracy estimate. The six common-name records exceed the three-suggestions-per-row limit, and the shared `.test` suffix fills a common domain-trigram candidate bucket. The report exposes both limits; omitted pairs must not be interpreted as verified nonmatches.

Run the reproducible local check:

```sh
npx vitest run tests/local-match-messy.test.ts
```

For the live review, Confirm `confirm-01` / `confirm-02`, Dismiss `phone-01` / `phone-02`, reload to verify both saved decisions, and try Undo. These decisions record an assessment; they do not edit source contacts or write to a CRM.
