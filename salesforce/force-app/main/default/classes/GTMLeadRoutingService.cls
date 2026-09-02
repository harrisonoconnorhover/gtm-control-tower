public with sharing class GTMLeadRoutingService {
    private static final Integer MAX_LEADS_PER_RUN = 200;

    @TestVisible
    private static Map<String, Id> queueIdOverrides;

    @InvocableMethod(
        label='Queue Approved GTM Lead Routing'
        description='Plans and queues one human-approved, auditable routing run for up to 200 Salesforce Leads.'
    )
    public static List<Output> enqueueFromFlow(List<Request> requests) {
        if (requests == null || requests.size() != 1) {
            throw new RoutingException('Submit exactly one approval request containing up to 200 Lead IDs.');
        }

        Request request = requests[0];
        return new List<Output>{
            enqueueApprovedRouting(
                request == null ? null : request.leadIds,
                request == null ? null : request.approvalToken,
                request != null && request.approved
            )
        };
    }

    public static Output enqueueApprovedRouting(List<Id> leadIds, String approvalToken, Boolean approved) {
        if (approved != true) {
            throw new RoutingException('Routing was not queued because human approval was not confirmed.');
        }
        if (String.isBlank(approvalToken)) {
            throw new RoutingException('A unique approval token is required.');
        }
        String normalizedToken = approvalToken.trim();
        if (normalizedToken.length() > 128) {
            throw new RoutingException('The approval token cannot exceed 128 characters.');
        }

        GTM_Routing_Run__c existingRun = findRunByToken(normalizedToken);
        if (existingRun != null) {
            return outputFor(existingRun, true);
        }

        List<Id> uniqueIds = normalizeLeadIds(leadIds);
        if (uniqueIds.isEmpty()) {
            throw new RoutingException('Select at least one Lead.');
        }
        if (uniqueIds.size() > MAX_LEADS_PER_RUN) {
            throw new RoutingException('A routing run supports at most 200 unique Leads.');
        }

        GTM_Routing_Run__c run = new GTM_Routing_Run__c(
            Approval_Token__c = normalizedToken,
            Status__c = 'Queued',
            Requested_Count__c = uniqueIds.size(),
            Planned_Count__c = 0,
            Succeeded_Count__c = 0,
            Failed_Count__c = 0,
            Held_Count__c = 0,
            Stale_Count__c = 0
        );

        try {
            insert as user run;
        } catch (DmlException error) {
            GTM_Routing_Run__c racedRun = findRunByToken(normalizedToken);
            if (racedRun != null) {
                return outputFor(racedRun, true);
            }
            throw new RoutingException('Salesforce could not create the routing run: ' + firstDmlMessage(error));
        }

        Map<Id, Lead> leadsById = new Map<Id, Lead>();
        Set<Id> validLeadIds = new Set<Id>();
        for (Id recordId : uniqueIds) {
            if (recordId != null && recordId.getSObjectType() == Lead.SObjectType) {
                validLeadIds.add(recordId);
            }
        }
        if (!validLeadIds.isEmpty()) {
            leadsById = new Map<Id, Lead>([
                SELECT Id, LastModifiedDate, OwnerId, GTM_Score__c, GTM_Segment__c
                FROM Lead
                WHERE Id IN :validLeadIds
                WITH USER_MODE
            ]);
        }

        List<GTM_Routing_Policy__mdt> policies = [
            SELECT DeveloperName, MasterLabel, Minimum_Score__c, Priority__c,
                Queue_Developer_Name__c, Segment__c
            FROM GTM_Routing_Policy__mdt
            WHERE Active__c = true
            ORDER BY Priority__c ASC, DeveloperName ASC
        ];
        Set<String> configuredQueueNames = new Set<String>();
        for (GTM_Routing_Policy__mdt policy : policies) {
            configuredQueueNames.add(policy.Queue_Developer_Name__c);
        }
        Map<String, Id> queueIds = loadQueueIds(configuredQueueNames);

        Integer plannedCount = 0;
        Integer heldCount = 0;
        Integer failedCount = 0;
        List<GTM_Routing_Result__c> receipts = new List<GTM_Routing_Result__c>();
        for (Id requestedId : uniqueIds) {
            Lead leadRecord = leadsById.get(requestedId);
            GTM_Routing_Result__c receipt = new GTM_Routing_Result__c(
                Routing_Run__c = run.Id,
                Lead_Id__c = String.valueOf(requestedId)
            );

            if (leadRecord == null) {
                receipt.Status__c = 'Failed';
                receipt.Error__c = 'No accessible Salesforce Lead was found for the supplied record ID.';
                failedCount++;
                receipts.add(receipt);
                continue;
            }

            receipt.Lead__c = leadRecord.Id;
            receipt.Expected_Last_Modified__c = leadRecord.LastModifiedDate;
            receipt.Previous_Owner_Id__c = String.valueOf(leadRecord.OwnerId);
            GTM_Routing_Policy__mdt matchingPolicy = firstMatchingPolicy(leadRecord, policies);
            if (matchingPolicy == null) {
                receipt.Status__c = 'Held';
                receipt.Error__c = leadRecord.GTM_Score__c == null
                    ? 'Held because the Lead has no GTM score.'
                    : 'Held because no active routing policy matched score ' + leadRecord.GTM_Score__c +
                        ' and segment ' + String.valueOf(leadRecord.GTM_Segment__c) + '.';
                heldCount++;
            } else if (!queueIds.containsKey(matchingPolicy.Queue_Developer_Name__c)) {
                receipt.Status__c = 'Held';
                receipt.Policy_Name__c = matchingPolicy.DeveloperName;
                receipt.Target_Queue__c = matchingPolicy.Queue_Developer_Name__c;
                receipt.Error__c = 'Held because the configured Salesforce queue does not exist or does not support Leads.';
                heldCount++;
            } else {
                receipt.Status__c = 'Planned';
                receipt.Policy_Name__c = matchingPolicy.DeveloperName;
                receipt.Target_Queue__c = matchingPolicy.Queue_Developer_Name__c;
                plannedCount++;
            }
            receipts.add(receipt);
        }

        if (!receipts.isEmpty()) {
            insert as user receipts;
        }
        run.Planned_Count__c = plannedCount;
        run.Held_Count__c = heldCount;
        run.Failed_Count__c = failedCount;

        if (plannedCount == 0) {
            run.Status__c = failedCount == 0 ? 'Completed' : 'CompletedWithErrors';
            run.Completed_At__c = System.now();
        } else {
            Id jobId = System.enqueueJob(new GTMLeadRoutingQueueable(run.Id, queueIds));
            run.Queueable_Job_Id__c = String.valueOf(jobId);
        }
        update as user run;
        return outputFor(run, false);
    }

    private static List<Id> normalizeLeadIds(List<Id> leadIds) {
        List<Id> ordered = new List<Id>();
        Set<Id> seen = new Set<Id>();
        if (leadIds == null) return ordered;
        for (Id leadId : leadIds) {
            if (leadId != null && !seen.contains(leadId)) {
                seen.add(leadId);
                ordered.add(leadId);
            }
        }
        return ordered;
    }

    private static GTM_Routing_Policy__mdt firstMatchingPolicy(
        Lead leadRecord,
        List<GTM_Routing_Policy__mdt> policies
    ) {
        if (leadRecord.GTM_Score__c == null) return null;
        for (GTM_Routing_Policy__mdt policy : policies) {
            Boolean scoreMatches = leadRecord.GTM_Score__c >= policy.Minimum_Score__c;
            Boolean segmentMatches = String.isBlank(policy.Segment__c) ||
                policy.Segment__c == leadRecord.GTM_Segment__c;
            if (scoreMatches && segmentMatches) return policy;
        }
        return null;
    }

    private static Map<String, Id> loadQueueIds(Set<String> developerNames) {
        if (Test.isRunningTest() && queueIdOverrides != null) {
            return new Map<String, Id>(queueIdOverrides);
        }
        Map<String, Id> queueIds = new Map<String, Id>();
        if (developerNames.isEmpty()) return queueIds;
        for (Group queueRecord : [
            SELECT Id, DeveloperName
            FROM Group
            WHERE Type = 'Queue'
                AND DeveloperName IN :developerNames
                AND Id IN (SELECT QueueId FROM QueueSobject WHERE SobjectType = 'Lead')
        ]) {
            queueIds.put(queueRecord.DeveloperName, queueRecord.Id);
        }
        return queueIds;
    }

    private static GTM_Routing_Run__c findRunByToken(String approvalToken) {
        if (String.isBlank(approvalToken)) return null;
        List<GTM_Routing_Run__c> runs = [
            SELECT Id, Status__c, Requested_Count__c, Planned_Count__c, Succeeded_Count__c,
                Failed_Count__c, Held_Count__c, Stale_Count__c, Queueable_Job_Id__c
            FROM GTM_Routing_Run__c
            WHERE Approval_Token__c = :approvalToken
            WITH USER_MODE
            LIMIT 1
        ];
        return runs.isEmpty() ? null : runs[0];
    }

    private static Output outputFor(GTM_Routing_Run__c run, Boolean duplicateRequest) {
        Output output = new Output();
        output.runId = run.Id;
        output.jobId = run.Queueable_Job_Id__c;
        output.status = run.Status__c;
        output.requestedCount = integerValue(run.Requested_Count__c);
        output.plannedCount = integerValue(run.Planned_Count__c);
        output.heldCount = integerValue(run.Held_Count__c);
        output.duplicateRequest = duplicateRequest;
        output.message = duplicateRequest
            ? 'This approval token was already submitted. Returning the original routing run without queuing a duplicate.'
            : (run.Status__c == 'Queued'
                ? 'Routing was approved and queued. Open the GTM Routing Run for durable per-Lead receipts.'
                : 'Planning completed without an asynchronous job. Review the per-Lead receipts.');
        return output;
    }

    private static Integer integerValue(Decimal value) {
        return value == null ? 0 : value.intValue();
    }

    private static String firstDmlMessage(DmlException error) {
        return error.getNumDml() > 0 ? error.getDmlMessage(0) : error.getMessage();
    }

    public class Request {
        public Request() {}

        @InvocableVariable(
            required=true
            label='Lead IDs'
            description='Collection of up to 200 selected Salesforce Lead IDs.'
        )
        public List<Id> leadIds;

        @InvocableVariable(
            required=true
            label='Approval token'
            description='Unique Flow interview identifier used as an idempotency key.'
        )
        public String approvalToken;

        @InvocableVariable(
            required=true
            label='Human approval confirmed'
            description='Must be true before routing can be queued.'
        )
        public Boolean approved;
    }

    public class Output {
        public Output() {}

        @InvocableVariable(label='Routing Run ID')
        public Id runId;

        @InvocableVariable(label='Queueable Job ID')
        public String jobId;

        @InvocableVariable(label='Status')
        public String status;

        @InvocableVariable(label='Requested Count')
        public Integer requestedCount;

        @InvocableVariable(label='Planned Count')
        public Integer plannedCount;

        @InvocableVariable(label='Held Count')
        public Integer heldCount;

        @InvocableVariable(label='Duplicate Request')
        public Boolean duplicateRequest;

        @InvocableVariable(label='Message')
        public String message;
    }

    public class RoutingException extends Exception {}
}
