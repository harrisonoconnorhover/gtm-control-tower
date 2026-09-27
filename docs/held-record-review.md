# Review held imported records

Use **Resolve held records** in the self-hosted `/app/lab` to correct an imported
row's email, company, owner, or lifecycle stage. The expected lifecycle stage
stays as imported. This workflow belongs to the operator workspace; it is not
part of the static public demonstration.

## Try three fictional rows

Save this as `held-record-review.csv`. Every person and address is fictional.

```csv
contact_id,full_name,email,company,lifecycle_stage,expected_lifecycle_stage,owner_id
A,Alex Example,alex.example.com,Northstar Example,lead,lead,NE-ENT
B,Blair Example,blair@northstar.example,Northstar Example,lead,lead,NE-ENT
C,Casey Example,casey@northstar.example,,lead,lead,
```

Open `/app/lab`, choose **CSV file**, preview the file, confirm the column
mapping, and select **Validate + load**. Keep both lifecycle columns mapped.
The starting result should be one ready row (B) and two held rows: A has an
invalid email; C lacks a company and owner.

In **Resolve held records**, select the named row, enter the correction and a
reason, then save and revalidate:

| Step | Correction and suggested reason | Result to inspect |
| --- | --- | --- |
| 1 | Set A's email to `blair@northstar.example`. Reason: `Exercise the duplicate guard with fictional data.` | A and B both have a duplicate hold. C remains held. Zero ready, three held. |
| 2 | Set A's email to `alex@northstar.example`. Reason: `Correct Alex's address from the fictional source.` | A and B become ready; their duplicate holds clear. Two ready, one held. |
| 3 | Set C's company to `Northstar Example`, leaving its owner blank. Reason: `Company confirmed; owner still unassigned.` | C remains held for its missing owner. Two ready, one held. |

Email changes recheck duplicate identity across all active rows. Sharing the
same domain alone does not make these rows duplicates. Use the optional email
recheck when an unchanged address needs validation again; this checks its format,
not whether an inbox exists. Unresolved and unrelated flags remain visible.

## Inspect history and export

Inspect each correction's reason, before/after values, and resulting counts.
Corrections and their history persist in the existing workspace snapshots.
Undo restores the rows and correction history together. Resetting or importing
a replacement clears the current correction history; older snapshots remain
subject to the existing twenty-revision retention limit.

Use the existing CSV export to inspect the resulting rows and remaining flags.
For connected destinations, the existing readiness gates and reviewed CRM write
plans still apply. Saving a correction makes no provider call and produces no
native CRM write receipt.
