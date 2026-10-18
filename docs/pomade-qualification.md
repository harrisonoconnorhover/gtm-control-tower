# Pomade qualification in the import review

The self-hosted import review can send its included rows to a saved Pomade table
and bring company identity, ICP fit and email-verification observations back.
It does not write to a CRM, send email, change source values or approve an import.
The public browser preview and the older CRM-evidence file exchange are unchanged.

## Connect the local apps

In Pomade, create a dedicated key with `read,run` scopes:

```sh
npm run api:key -- create "Control Tower qualification" --scopes read,run
```

Rebuild and restart Pomade as described in its API setup guide. Configure these
values privately on the Control Tower server, then restart that app:

```dotenv
CONTROL_TOWER_POMADE_API_URL=http://host.docker.internal:8798
CONTROL_TOWER_POMADE_API_KEY=the-key-from-pomades-private-env-file
CONTROL_TOWER_POMADE_PUBLIC_URL=http://localhost:8798
```

The first URL is for Control Tower in Docker Desktop reaching Pomade on the host.
If both apps run directly on the host, use `http://127.0.0.1:8798` instead. The
public URL is the local address opened by your browser, not a public deployment.
Use the same Pomade instance for both URLs. Keys remain on the server and are
never returned to the browser or included in plugin packages.

## Use the handoff

1. Save the import and choose the included rows. In **Pomade qualification**, enter
   explicit ICP requirements/exclusions and click **Send to Pomade**.
2. Choose the rows and checks, then **Preview checks**. Review Pomade's provider
   readiness, maximum submissions and warnings. Confirm that those provider
   requests may consume credits or subscription usage, then **Run checks**.
3. Stay in Control Tower. Progress and saved observations update automatically;
   reloading resumes status checks without starting another run. Expand evidence
   for explanations, sources and check times. **Open in Pomade** and manual
   **Refresh Pomade results** remain available.

Sending prepares a saved list of up to 500 rows without running providers. Lists
over 100 rows start with no run selection; use the explicit first-16 shortcut or
select individual rows. Each later run needs its own reviewed preview and consent.

The existing background limits remain: 50 maximum provider submissions, 100 rows
and 10 submissions per row. All three standard checks allow 16 fully populated
rows per run. Select fewer rows or checks when the preview exceeds the limit;
the app does not silently create extra batches. Request counts are not monetary
credit prices or a guarantee of available balance. Provider execution still uses
Pomade's saved connections, conditions, cache and worker.

Cancel stops future work; an already submitted request can still finish and use
credits. Failures and paused work stay visible and do not automatically rerun.
After an uncertain start, reconcile the saved request and retry that same ID if
needed. A different list cannot replace the saved link while a run is unresolved.

Cached research is labeled as reused. When its original check time is unavailable,
the review leaves that time blank rather than showing the latest run as a fresh check.

Up to 500 included rows and 256 KiB can be sent per saved list. Missing fields stay
missing; they are not fabricated. Duplicate sends with the same source IDs,
company/website/email values and ICP reuse the same Pomade table and its results.
Changed qualification inputs produce a separate table; older tables remain saved.

Results live outside Control Tower's workspace revision. Changes to relevant
inputs or ICP mark earlier results stale. Pomade also binds observations to the
executed inputs and recipe: changing inputs, recipes or result cells cannot turn
old evidence into current qualification. Match/Review/Mismatch, Fit/Review/Not a
fit, and provider email statuses remain separate judgments. Missing, pending or
failed checks do not become positive results.

## Combined Contact + Company imports

Choose **Contacts + associated companies** during CSV mapping. Company identity
and ICP use `associatedCompany.name` and `associatedCompany.website`; email
verification uses that row's Contact email. Missing associated-company values stay
missing, even if contact-company context exists. Different contacts at one company
keep distinct row IDs and email results; no fuzzy company grouping chooses inputs.

The same review shows contact names, associated companies, website checks and all
three Pomade results. Changes to the checked company name, website, contact email,
or ICP make the saved list stale; unrelated Contact context does not. Existing
cached-result, preview, credit consent, polling, cancellation and retry controls
apply unchanged. Status/refresh reads do not execute checks.

Combined imports remain unavailable for CRM import or association writes. Even
positive qualification results cannot make them Ready to import. Their readiness
reasons still show missing, negative, failed, pending or stale checks alongside
that explicit CRM limitation. Company-only files remain local review/export.

## Import readiness

The review now shows **Ready to import**, **Needs review** and **Excluded** counts
and row reasons using saved checks plus existing local holds. Missing or stale
checks never become positive readiness. This is advisory; CRM matching, field
policies and approval still apply. See [readiness rules](import-readiness.md).

## Codex tools

`send_to_pomade(workspaceId, icpCriteria)` prepares the handoff;
`get_pomade_qualification(workspaceId)` reads the local saved observations;
`refresh_pomade_qualification(workspaceId)` reads Pomade and saves the return.
`preview_pomade_qualification` reviews selected checks; `run_pomade_qualification`
starts the confirmed scope; `get_pomade_run` reconciles progress and saves partial
or final results; `cancel_pomade_run` cancels the tracked run. These fixed tools
expose no CRM execution capability. Observation lists default to 10 rows; use
`offset` and `limit` (up to 25) to page.

After an uncertain send, reload saved state and repeat the same inputs if needed;
Pomade's deterministic table ID makes creation idempotent. After an uncertain
recipe run, inspect Pomade's saved receipts before running it again. A cached
Control Tower result is still readable when Pomade is unavailable.
