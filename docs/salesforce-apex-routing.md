# Human-approved Salesforce routing

This is GTM Control Tower's write-side Salesforce proof. It turns an operator's
approved Lead selection into safe, asynchronous ownership changes with a durable
receipt for every record. Agentforce remains read-only and cannot cross this
boundary.

## Verified development-org result

The complete routing slice is deployed in the project's Salesforce development
org. On 2026-09-02, all six focused routing tests passed, including the
200-Lead bulk case. The final validation reported 85.4% coverage for
`GTMLeadRoutingService` and 81.6% for `GTMLeadRoutingQueueable`.

A live run selected three synthetic Leads. Two were routed to the expected
priority and standard queues; the score-40 Lead remained with its owner and
received a deliberate `Held` receipt. The parent run recorded `Completed`, two
successes, one hold, zero failures, and zero stale writes. Its Queueable job
completed with zero errors. Replaying the same approval token returned the same
run and did not create a duplicate job.

## Execution path

1. `GTM_Approve_Lead_Routing` receives a collection named `ids`, explains the
   consequences, and requires the operator to confirm the ownership change.
2. `GTMLeadRoutingService` treats the Flow interview GUID as an idempotency key,
   deduplicates and caps the request at 200 Leads, reads records in user mode,
   and plans every outcome against active `GTM_Routing_Policy__mdt` records.
3. The planner writes one `GTM_Routing_Run__c` and one
   `GTM_Routing_Result__c` per requested Lead before it enqueues work. A repeat
   token returns the existing run and never creates a second job.
4. `GTMLeadRoutingQueueable` locks the run, receipts, and accessible Leads. It
   compares the current `LastModifiedDate` with the planning snapshot and marks
   changed records `Stale` instead of overwriting newer work.
5. The worker uses user-mode `Database.update(records, false)`. Successful
   records keep their ownership change even when another Lead fails. Every
   receipt finishes as `Succeeded`, `Held`, `Stale`, or `Failed`, and the parent
   run stores aggregate counts and the `AsyncApexJob` ID. An expected policy
   hold is visible without incorrectly labeling the parent run as an error.
6. The Queueable attaches a Transaction Finalizer. If an unhandled async error
   rolls back the worker transaction, the finalizer records the terminal error
   and `Failed` status in its own transaction instead of leaving the run stuck.

## Why this is substantive Apex

- Bulk design is the starting point: one SOQL query per object type, collection
  DML, one Queueable job, and a hard 200-record boundary.
- Concurrency is explicit: row locks protect the execution window, while the
  last-modified snapshot protects the longer approval-to-execution window.
- Idempotency is enforced twice: a unique external-ID field protects storage,
  and the service returns the original run on a duplicate token.
- Security is part of the data path: classes use `with sharing`, business data
  is queried with `WITH USER_MODE`, and writes use user-mode DML. The separate
  `GTM_Routing_Operator` permission set grants only the needed Flow, Apex,
  object, and field access.
- Configuration is separated from code: ordered Custom Metadata policies map
  score and segment to portable Salesforce Lead queues.
- Failure is modeled as data: holds, stale rows, missing access, and individual
  DML errors are queryable receipts rather than an all-or-nothing exception.
- Async failure recovery uses the platform's Transaction Finalizer boundary, so
  an unhandled worker exception can still produce a durable terminal run state.

## Focused test contract

`GTMLeadRoutingServiceTest` is designed to prove these acceptance cases with
synthetic data when it runs in a Salesforce development org:

- 200 Leads complete through one Queueable job and produce 200 success receipts.
- Reusing an approval token returns the original run with one job and one set of
  receipts.
- The Flow-facing invocable contract queues one approved collection and returns
  the durable run.
- One approved batch can finish with a success, an invalid-owner DML failure, a
  policy hold, and a stale-record refusal without rolling back the success.
- A policy hold can finish synchronously as a completed, zero-error run without
  scheduling unnecessary async work.
- An unconfirmed request fails before a run or job is created.

## Portable configuration

The included policy records evaluate in ascending priority:

| Policy | Segment | Minimum score | Queue |
| --- | --- | ---: | --- |
| Enterprise High Score | Enterprise | 75 | GTM Priority Review |
| High Score | Any | 75 | GTM Priority Review |
| Default Ready | Any | 60 | GTM Standard Review |

Scores below 60, missing scores, inaccessible records, and missing queues fail
closed. Queue developer names and all sample records are portable metadata; no
user, role, territory, or organization-specific ID is committed.

`GTM_Routing_Operator` intentionally does not grant Salesforce's broad
`Transfer Leads` user permission. An org administrator must decide which human
operators receive that business permission through their profile or another
permission set. Without it, user-mode ownership updates fail individually and
their receipts retain the Salesforce error; the Apex never elevates itself to
bypass the operator's authority.

## Reviewer path

Read these in order:

1. `GTMLeadRoutingService.cls` for planning, policy evaluation, idempotency, and
   the Flow contract.
2. `GTMLeadRoutingQueueable.cls` for locking, stale protection, partial DML, and
   receipt aggregation.
3. `GTMLeadRoutingServiceTest.cls` for the 200-record and mixed-outcome proofs.
4. `GTM_Approve_Lead_Routing.flow-meta.xml` and
   `GTM_Routing_Operator.permissionset-meta.xml` for the human and security
   boundaries.

## Résumé-ready wording

> Built a Salesforce-native bulk Lead-routing control plane using Screen Flow,
> invocable and Queueable Apex, Custom Metadata policies, user-mode security,
> row locking, stale-write protection, idempotency, partial-success DML, and
> Transaction Finalizer recovery with durable per-record receipts; designed for
> 200-Lead approval batches and deployed with six passing focused tests in a
> Salesforce development org.

The implementation and live synthetic run are portfolio evidence, not a claim
of production tenure or customer deployment.
