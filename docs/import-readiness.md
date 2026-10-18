# Import readiness from saved checks

The self-hosted import review summarizes each row as **Ready to import**,
**Needs review**, or **Excluded**, with reasons and counts. Filter the list by
status to inspect the rows that need attention. It recalculates from current
inputs and saved observations; no new stored decision, provider call or CRM
write is made just to display readiness.

## Rules

A row is Ready only when all of these are true:

- It is active, included in the import, and matches no enabled saved suppression rule.
- Its existing local row checks have no blocking flag: invalid email, missing
  company, missing owner, duplicate identity or lifecycle-stage regression.
- Company, email and website are supplied, and its exact normalized website has
  a saved reachable result.
- The saved Pomade qualification still matches the included source list and ICP.
- Identity is complete/Match, ICP is complete/Fit and email is complete/valid.
- Its latest selected qualification run is resolved successfully.

Missing, loading, failed, stale, blocked, ambiguous or unfinished checks require
review. Mismatch, Not a fit, invalid and catch-all/unknown email results retain
specific reasons. Skipped and merged rows are Excluded, preserving their existing
reason instead of describing them as ready. Saved suppression matches also make
the row Excluded, with each matched rule and its reason.

Existing local holds remain visible even if all provider results are positive.
For example, the HubSpot demonstration row initially required review despite
Match/Fit/valid and a reachable website because it lacked an owner. Assigning
the local sample owner `DEMO-REVOPS` made it Ready without rerunning checks.
The Salesforce and Wikimedia rows still require review for qualification issues.

## What the label means

This is an advisory summary of saved website, Pomade and local row checks.
**CRM matching, field policies and approval still apply.** The readiness label
does not create an import plan, change source values, approve an import or write
to the CRM. [Saved suppression rules](suppressions.md) are enforced separately
and their matches are included in this summary.

Cached provider observations remain usable when bound to the same inputs, even
if their original provider check time is unavailable. No new age-based expiry
policy is introduced. Changing included inputs or draft ICP marks the old
qualification stale. Suppressing a row does not invalidate unchanged observations
for other rows, and disabling a rule can reuse that row's saved results when its
inputs still match. Website results match the exact normalized URL; a changed
address needs its own check.

## API and plugin

The existing qualification endpoint returns derived `readiness` on successful
responses, including before a list is sent to Pomade. GET reads local saved state
only. The Codex plugin's `get_pomade_qualification` returns counts plus paginated
readiness rows with `{code, message}` reasons. Readiness and observation pages
are separate; use source row IDs to correlate them.
