public with sharing class GTMLeadRoutingQueueable implements Queueable, Finalizer {
    private final Id runId;
    private final Map<String, Id> queueIds;

    public GTMLeadRoutingQueueable(Id runId, Map<String, Id> queueIds) {
        this.runId = runId;
        this.queueIds = queueIds == null ? new Map<String, Id>() : new Map<String, Id>(queueIds);
    }

    public void execute(QueueableContext context) {
        System.attachFinalizer(this);
        processRun();
    }

    public void execute(FinalizerContext context) {
        if (context.getResult() == ParentJobResult.SUCCESS) return;
        Exception error = context.getException();
        String failure = error == null
            ? 'Queueable ended with ' + String.valueOf(context.getResult()) + '.'
            : error.getTypeName() + ': ' + error.getMessage();
        markRunFailed(failure);
    }

    private void processRun() {
        List<GTM_Routing_Run__c> runs = [
            SELECT Id, Status__c
            FROM GTM_Routing_Run__c
            WHERE Id = :runId
            WITH USER_MODE
            LIMIT 1
            FOR UPDATE
        ];
        if (runs.isEmpty() || runs[0].Status__c != 'Queued') return;

        GTM_Routing_Run__c run = runs[0];
        run.Status__c = 'Processing';
        run.Started_At__c = System.now();
        update as user run;

        List<GTM_Routing_Result__c> receipts = [
            SELECT Id, Lead__c, Lead_Id__c, Status__c, Expected_Last_Modified__c,
                Target_Queue__c, Previous_Owner_Id__c, New_Owner_Id__c, Error__c
            FROM GTM_Routing_Result__c
            WHERE Routing_Run__c = :runId AND Status__c = 'Planned'
            WITH USER_MODE
            FOR UPDATE
        ];
        Set<Id> leadIds = new Set<Id>();
        for (GTM_Routing_Result__c receipt : receipts) {
            if (receipt.Lead__c != null) leadIds.add(receipt.Lead__c);
        }

        Map<Id, Lead> leadsById = new Map<Id, Lead>();
        if (!leadIds.isEmpty()) {
            leadsById = new Map<Id, Lead>([
                SELECT Id, LastModifiedDate, OwnerId
                FROM Lead
                WHERE Id IN :leadIds
                WITH USER_MODE
                FOR UPDATE
            ]);
        }

        List<Lead> updates = new List<Lead>();
        List<GTM_Routing_Result__c> updateReceipts = new List<GTM_Routing_Result__c>();
        for (GTM_Routing_Result__c receipt : receipts) {
            Lead currentLead = leadsById.get(receipt.Lead__c);
            if (currentLead == null) {
                receipt.Status__c = 'Failed';
                receipt.Error__c = 'The Lead was deleted or became inaccessible after approval.';
            } else if (
                receipt.Expected_Last_Modified__c == null ||
                currentLead.LastModifiedDate.getTime() != receipt.Expected_Last_Modified__c.getTime()
            ) {
                receipt.Status__c = 'Stale';
                receipt.Error__c = 'The Lead changed after planning, so Salesforce refused to overwrite newer work.';
            } else if (!queueIds.containsKey(receipt.Target_Queue__c)) {
                receipt.Status__c = 'Failed';
                receipt.Error__c = 'The planned Salesforce queue is unavailable.';
            } else {
                receipt.Previous_Owner_Id__c = String.valueOf(currentLead.OwnerId);
                updates.add(new Lead(
                    Id = currentLead.Id,
                    OwnerId = queueIds.get(receipt.Target_Queue__c),
                    GTM_Routed_Owner__c = receipt.Target_Queue__c,
                    GTM_Last_Routed_At__c = System.now()
                ));
                updateReceipts.add(receipt);
            }
        }

        if (!updates.isEmpty()) {
            List<Database.SaveResult> saveResults = Database.update(updates, false, AccessLevel.USER_MODE);
            for (Integer index = 0; index < saveResults.size(); index++) {
                Database.SaveResult saveResult = saveResults[index];
                GTM_Routing_Result__c receipt = updateReceipts[index];
                if (saveResult.isSuccess()) {
                    receipt.Status__c = 'Succeeded';
                    receipt.New_Owner_Id__c = String.valueOf(updates[index].OwnerId);
                    receipt.Error__c = null;
                } else {
                    receipt.Status__c = 'Failed';
                    receipt.Error__c = joinErrors(saveResult.getErrors());
                }
            }
        }

        if (!receipts.isEmpty()) {
            update as user receipts;
        }
        finishRun(run);
    }

    private void finishRun(GTM_Routing_Run__c run) {
        Integer succeeded = 0;
        Integer failed = 0;
        Integer held = 0;
        Integer stale = 0;
        for (GTM_Routing_Result__c receipt : [
            SELECT Status__c
            FROM GTM_Routing_Result__c
            WHERE Routing_Run__c = :runId
            WITH USER_MODE
        ]) {
            if (receipt.Status__c == 'Succeeded') succeeded++;
            else if (receipt.Status__c == 'Held') held++;
            else if (receipt.Status__c == 'Stale') stale++;
            else if (receipt.Status__c == 'Failed') failed++;
        }
        run.Succeeded_Count__c = succeeded;
        run.Failed_Count__c = failed;
        run.Held_Count__c = held;
        run.Stale_Count__c = stale;
        run.Status__c = failed == 0 && stale == 0 ? 'Completed' : 'CompletedWithErrors';
        run.Completed_At__c = System.now();
        update as user run;
    }

    private void markRunFailed(String failure) {
        try {
            List<GTM_Routing_Run__c> runs = [
                SELECT Id, Status__c
                FROM GTM_Routing_Run__c
                WHERE Id = :runId
                WITH USER_MODE
                LIMIT 1
            ];
            if (!runs.isEmpty() && runs[0].Status__c != 'Completed') {
                runs[0].Status__c = 'Failed';
                runs[0].Error__c = truncate(failure);
                runs[0].Completed_At__c = System.now();
                update as user runs[0];
            }
        } catch (Exception ignored) {
            // Preserve the original exception if even the best-effort status update is unavailable.
        }
        System.debug(LoggingLevel.ERROR, 'GTM routing run ' + runId + ' failed: ' + failure);
    }

    private static String joinErrors(Database.Error[] errors) {
        List<String> messages = new List<String>();
        for (Database.Error error : errors) {
            messages.add(String.valueOf(error.getStatusCode()) + ': ' + error.getMessage());
        }
        String message = String.join(messages, ' | ');
        return truncate(message);
    }

    private static String truncate(String message) {
        if (message == null) return null;
        return message.length() > 32768 ? message.substring(0, 32768) : message;
    }
}
