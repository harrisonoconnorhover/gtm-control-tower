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

The org administrator has the built-in **Agentforce Default Admin** permission,
and the Agentforce master setting is enabled. `GTM_Data_Steward` passes the
Agent Script validator, is published as version 1, and is active in the org.
Salesforce's publish command also retrieved the generated Bot, BotVersion, and
planner metadata into source control.

A live-action preview from the Agent Script executed the real Flow and Apex
action against a synthetic Lead. Its trace recorded action status `success`,
status `READY`, score `85`, eligibility `true`, and queue `PRIORITY_REVIEW`.
The Lead's before-and-after fields and `LastModifiedDate` were identical. The
activated published agent still needs a dedicated Einstein Agent User before a
published-agent preview can start; no such user has been created yet.

`GTM_Data_Steward_Read_Only` is deployed and ready to assign to that agent user.
It grants only Flow execution, this Apex class, Lead read access, and read access
to the non-required Lead fields used by the score. It grants no create, edit,
delete, modify-all, or view-all permissions.

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
  --source-dir salesforce/force-app/main/default/permissionsets \
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

For an activated published agent, create a dedicated non-login Einstein Agent
User, assign `GTM_Data_Steward_Read_Only`, add its username to an Agent Script
`access` block as `default_agent_user`, and republish. The user is a persistent
org account with Salesforce-provided licenses and base permissions, so creation
must be an explicit administrator decision.

Preview with a synthetic Lead ID only. Confirm the trace includes the successful
Flow outputs and that a before-and-after SOQL read shows an unchanged
`LastModifiedDate`. Do not point the agent at a customer or production org.

## Honest portfolio boundary

The current evidence supports: “built and deployed a tested invocable Apex
action and autolaunched Flow, and published an activated read-only Agentforce
agent whose real Flow/Apex action passed a live development-org preview.” It does
not yet support claiming the activated published agent itself passed preview;
that final session needs the dedicated execution user described above. Neither
statement establishes years of production Salesforce administration, Apex
ownership, customer deployment, or Agentforce operations. Keep those
distinctions explicit in résumés and interviews.
