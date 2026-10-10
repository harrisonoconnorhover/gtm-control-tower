# Incident investigation

`/app/incidents` groups CRM observations into work a person can investigate: clustered field clearing, repeated reversals, duplicate candidates, invalid amounts/dates, broken relationships, missed business expectations and lost coverage. It uses the same saved account, monitor worker and Operations Inbox for HubSpot and Salesforce. See [object coverage and native events](native-monitor-events.md).

## Use it

1. Enable the connected account at `/app/monitor` and run `npm run monitor`. Initial pages establish a baseline; missing permissions or incomplete history remain visible.
2. Open `/app/incidents`, select the saved account and inspect the evidence. The page remains readable when the CRM connection is unavailable. Download includes retained observations, native events, relevant current records, detection-time policy and previous decisions.
3. Choose **Prepare investigation** for a local evidence report. Record an assignee, status, next step and resolution reason. These decisions remain in the incident timeline. Repeated defects can reopen work.
4. Use the detection policy to express actual business requirements. Examples: a qualified opportunity must acquire an owner within ten minutes; every deal needs a company; negative deal amounts are invalid for this business. Custom stage names have no inferred ordering.

The observation window defaults to 30 minutes, with at least ten affected records and 20% of the full observed object population required for a bulk-clear incident. Changing these thresholds creates a new policy version. Planned exceptions suppress named fields only until their expiry; evidence is still retained. Cached records are reconsidered in bounded batches after a policy change or completed baseline. Unchanged records with pending deadlines are also checked. A configured rule whose fields cannot be observed creates a coverage incident and preserves its existing deadline; missing data does not count as a satisfied rule. A pending sweep is not evidence that every current record has already been evaluated.

## Evidence and uncertainty

Observations retain the prior observed value, newly observed value, read time, native modification time and supplied source metadata. Older observations do not overwrite the record head. Equal native timestamps with conflicting values create ambiguous evidence and block repair eligibility until a newer timestamp establishes an ordering. Baseline records never imply a historical clearing.

Native event values are retained separately from fresh snapshots. Strictly ordered returns in supported reported fields can also trigger the configured reversal threshold, even if fresh reads miss the intermediate state. For these events A → B → A is one return, and A → B → A → B is two. Ambiguous timestamp ties, truncated values and planned exceptions do not establish a return. This detection can pause Control Tower repairs but never changes the current snapshot or invents a restoration. A reported actor belongs to that event, not automatically to the later record state. A webhook or CDC replay gap requires a fresh baseline; a baseline cannot recreate missing intermediate history. Deletion events create review evidence, never fabricated empty records.

Incident counts come from saved data. Lists are bounded and indicate truncation. Observation retention defaults to 30 days / 50,000 observations per account; processed native events are bounded to 30 days / 10,000, while pending or held events are retained. Investigation packets include at most 100 observations, 50 affected snapshots and 30 related native IDs. These are investigation samples, not a complete CRM archive.

The coverage card distinguishes baseline, healthy, degraded and stale states. A failed connection, denied field, backlog or overdue runner cannot become a clean result. Healthy means the configured read process completed recently within its stated limits; it does not certify that every business process is correct.

## Containment and repairs

Incidents do not gain arbitrary CRM write access. Company/account and deal/opportunity records are read-only. Existing contact/lead whitespace repairs still require explicit account opt-in, supported fields, fresh values and readback. An incident report, source text or model suggestion cannot approve an import, merge records, alter native workflows or expand the write recipe.

Saved budgets default to 50 repairs per hour and two per record per day. Repeated reversals and exhausted budgets pause Control Tower's own repairs. The claim and budget check are atomic. Resuming clears the pause, not the already-spent budget. Unknown outcomes stay held; no automatic resend occurs. Native CRM automation remains active and may require separate investigation.

Incident, monitor finding and repair transitions commit notification intent in the same SQLite transaction. A durable outbox forwards that intent into the existing optional Slack queue. Slack delivery remains independent of CRM execution and retains its uncertain-delivery hold. See [Slack](slack-notifications.md).

## Optional model and investigator access

Without a model, every detection, evidence report and supported repair works locally. To enable explicitly requested model explanations, configure `OPENAI_API_KEY` and `CONTROL_TOWER_INVESTIGATION_MODEL`. There is no default model and no automatic model call. The button sends a bounded evidence packet to the OpenAI Responses API, with `store: false`, a strict output schema, a 30-second timeout and an output budget. API usage may incur the provider's normal charges when enabled and invoked.

Facts and counts are rendered from the saved evidence. The model may supply cited hypotheses, unknowns, read-only next steps and a policy-review suggestion. Invalid citations, refusal, incomplete output or network failure fall back to the local report. Instructions inside CRM values and notes remain untrusted data. No shell, CRM credentials, approval endpoint or arbitrary HTTP tool is exposed to the model. This boundary is implemented in [`lib/incident-investigator.ts`](../lib/incident-investigator.ts), using [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

For a preparation-only API client, configure a distinct `CONTROL_TOWER_INVESTIGATOR_KEY` and send it as `x-control-tower-investigator-key` to `/api/control-tower/incidents`. It can read evidence and prepare investigations; it cannot triage, change policy, resume repairs, retry reads or approve Safe Import. The interactive app still uses the existing shared operator key. This is capability separation, not individual team identity or a complete multi-tenant authorization system.

## Qualification

Run `npm run qualify:incidents` for the generated 2,900-record world and fault scenarios. The HTML report, machine-readable results, CSV/JSON datasets and a paused inspection database are written under ignored `outputs/incident-stress/`. See [the results and boundaries](incident-stress-results.md).

Tests use real local SQLite and the production monitor/store/executor with fictional CRM adapters. Native subscriptions, live model quality, production throughput and new native object permissions require separate deployment-specific qualification. No production connection is needed for the fixture run.
