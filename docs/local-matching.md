# Local matching suggestions

The self-hosted import review compares saved rows with other rows in the same
import, relevant saved CRM snapshots and enabled suppression rules. It makes no
external requests: it does not refresh a CRM, run Pomade, use credits or send mail.
The public browser preview does not expose this saved review.

## Review a suggestion

Open a saved CSV workspace and find **Local matching suggestions**. Review the
imported values beside the candidate, its source, and the supporting and
conflicting reasons. Filter by kind or decision and use pagination to inspect
additional results. The review offers three kinds of finding:

| Kind | Example | Interpretation |
| --- | --- | --- |
| Company variant | `Microsfot` and a known `Microsoft` record | A possible spelling/format variation, not verified company identity |
| Possible duplicate | Same full name with different email addresses | A person worth comparing; supporting phone/company context increases priority |
| Possible suppression | A company name resembles an enabled suppression rule | A potential missed exclusion requiring review; the original rule and reason remain visible |

**Confirm** saves your assessment that the finding is relevant. **Dismiss** saves
your assessment that it is not. **Undo** clears that assessment. These actions do
not apply a correction, merge contacts, change an email, suppress a row, approve a
CRM target or remove an existing hold. Use the existing row-editing and suppression
controls to apply a separately reviewed change. Existing import readiness and
server write guards retain their own rules.

Decisions survive reload and repeated submissions. They apply to the exact
compared evidence and matching-rule version; changed evidence requires a fresh
review. They are stored separately from workspace revisions and cached Pomade
results. A reviewed suggestion is not a newly trained global matching rule.

## Matching practices

- Normalize formatting for comparison while preserving the original displayed
  values. Detect small spelling edits and adjacent character swaps conservatively.
- Combine names with company, domain, email and phone evidence. Keep weak
  same-name warnings visible even when emails differ. Missing fields supply no
  evidence; contradictory populated fields are shown as conflicts.
- Treat common names, shared phone numbers and role inboxes as weaker clues.
  Rarity describes the observed local dataset, not a person's nationality or
  worldwide name frequency. Samples below 100 usable identities report
  insufficient data. Repeated rows for the same email do not inflate the sample.
  The rarity adjustment is bounded so an unusual typo cannot dominate a match.
- Keep Gmail alias handling provider-specific. Do not strip plus tags from every
  corporate email or assume that a similar address is deliverable.
- Keep suggestions as individual comparisons. A resembles B and B resembles C
  does not automatically identify A and C as one person.
- Rank a bounded number of candidates and expose truncation/ambiguity warnings.
  A ranking score is not a calibrated probability. No result does not prove
  uniqueness, especially when a snapshot or candidate search is incomplete.

Saved CRM source dates and coverage are displayed. A snapshot describes what was
saved then; this review does not assert that it is current. Company suggestions
need a comparison name in the available data. Without a known `Microsoft`, a typo
alone cannot invent a verified correction. Short or ambiguous names remain
conservative, and exact suppression enforcement is unchanged.

The current limits are 5,000 imported rows, 20,000 saved CRM records, 5,000 enabled
rules, 120 records per candidate group, 200 candidates per imported row and
100,000 comparisons per report. At most three suggestions of each kind are shown
per row. Caps produce explicit warnings; the report may be incomplete. Separate
active import rows receive one person-pair finding rather than reciprocal copies.
Phone comparison assumes `+1` for ten-digit numbers, recognizes different
extensions as weaker evidence, and reuses the existing US state-name/code mapping.

## Local API and plugin

Authenticated `GET /api/control-tower/local-matches` accepts `workspaceId`,
`offset`, `limit`, `status` and `kind`. It returns reasons, source coverage,
decision counts and a page of findings. `POST` accepts `workspaceId`, `id`,
`fingerprint` and `action` (`confirm`, `dismiss`, `clear`). The server recomputes
the evidence before accepting a decision and rejects stale fingerprints.

The local plugin exposes `get_local_matches` and `decide_local_match`. Neither
calls the existing CRM-target confirmation endpoint or a provider. Read/export
scope is explicit; a single page is not the whole import.

## References and limits

The implementation uses small deterministic rules, without adding a statistical
matching package. The design draws on [Splink's string comparison guidance](https://moj-analytical-services.github.io/splink/topic_guides/comparisons/comparators.html)
and [frequency adjustments and low-frequency outliers](https://moj-analytical-services.github.io/splink/topic_guides/comparisons/term-frequency.html).
The [Census record-linkage quality standard](https://www.census.gov/about/policies/quality/standards/standardc4.html)
also informs the use of reviewable evidence, documented matching parameters and
positive/negative test examples. This does not claim Census compliance or a
measured real-world accuracy rate. Thresholds need evaluation against reviewed
business examples before any future automatic cleanup is considered.

## Object setup and a larger sample

[Import object setup](import-objects.md) separates contact fields from associated
company fields in one CSV. Combined imports use associated-company context for
person warnings, while company-only imports omit person-name frequency and
person-duplicate suggestions. Both new modes remain local review/export only.

The [140-contact fixture](../tests/fixtures/local-matching/README.md) includes
hand-labeled common/rare name pairs, company typos, intentional false positives,
and a known nickname miss. It supplies enough local identities for the bounded
frequency adjustment and supports repeatable Confirm/Dismiss/Undo demonstrations.
