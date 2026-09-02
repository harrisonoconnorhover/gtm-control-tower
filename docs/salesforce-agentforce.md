# Salesforce Flow, Apex, and Agentforce proof

GTM Control Tower includes a source-driven Salesforce development slice that
uses one coherent business case instead of disconnected demo artifacts:

1. `GTMLeadTriageAction` is bulk-safe, `with sharing`, read-only Apex. It queries
   Leads, applies a deterministic data-readiness gate, and returns an explainable
   queue recommendation. Its Apex test covers ready, held, wrong-object, empty,
   and null inputs.
2. `GTM_Lead_Triage` is an active autolaunched Flow. It calls the invocable Apex
   action, branches on eligibility, maps outputs, and returns an explicit
   `READY`, `HELD`, or `ERROR` result.
3. `GTM_Data_Steward` is an internal Agentforce Employee Agent authored as an
   Agent Script bundle. Its only business action invokes the Flow in read-only
   mode. It cannot write, assign, merge, convert, or delete Salesforce records.

This extends the project's existing Salesforce proof: SOQL pagination,
query-before-write REST integration, Composite API creates and updates, standard
and custom Lead field metadata, native receipts, duplicate holds, bounded
workloads, sandbox read-back, and rollback checks.

## Verified project state

The Apex classes, active Flow, and five custom Lead fields are deployed in the
project's Salesforce development org. The focused deployment ran three passing
tests, reported 100% coverage for `GTMLeadTriageAction`, and exercised four of
the Flow's five elements. The unforced element is the defensive fault assignment.

The `GTM_Data_Steward` Agent Script bundle passes Salesforce's authoring-bundle
validator. Publishing it is still pending because the org's Agentforce master
switch requires the built-in **Agentforce Default Admin** permission set. That
permission has not been assigned. Until it is assigned and the published agent
is previewed successfully, describe this as validated Agentforce source—not a
live Agentforce deployment.

## Deploy and verify in a development org

Authorize an Agentforce-enabled development org and choose an alias:

```bash
sf org login web --alias gtm-control-tower-salesforce
```

Before enabling or publishing Agentforce, an org administrator must grant the
builder the built-in **Agentforce Default Admin** permission set. This is a
persistent privilege change; review it in Setup and assign it only to an account
that should administer agents. Then turn on Einstein and Agentforce in Setup.

Deploy the Salesforce metadata and run the focused Apex test:

```bash
sf project deploy start \
  --source-dir salesforce/force-app/main/default/classes \
  --source-dir salesforce/force-app/main/default/flows \
  --source-dir salesforce/force-app/main/default/objects/Lead/fields \
  --target-org gtm-control-tower-salesforce \
  --test-level RunSpecifiedTests \
  --tests GTMLeadTriageActionTest \
  --wait 10
```

Validate and publish the Agent Script bundle after the Flow is deployed:

```bash
sf agent validate authoring-bundle \
  --api-name GTM_Data_Steward \
  --target-org gtm-control-tower-salesforce

sf agent publish authoring-bundle \
  --api-name GTM_Data_Steward \
  --target-org gtm-control-tower-salesforce \
  --concise
```

Preview the agent with a synthetic Lead ID from your development org. Confirm
that the response includes the Flow outputs and explicitly says no record was
changed. Do not point the agent at a customer or production org. Record the
preview result before changing the project status above to “deployed.”

## Honest portfolio boundary

The current evidence supports: “built and deployed a tested invocable Apex
action and autolaunched Flow, plus validated a read-only Agentforce action source
bundle, in a Salesforce development org.” After a successful agent publish and
preview, “validated” can become “published and tested.” Neither statement
establishes years of production Salesforce administration, Apex ownership,
customer deployment, or Agentforce operations. Keep those distinctions explicit
in résumés and interviews.
