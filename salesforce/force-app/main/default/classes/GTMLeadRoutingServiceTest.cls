@IsTest
private class GTMLeadRoutingServiceTest {
    @TestSetup
    static void grantOperatorApplicationAccess() {
        User operatorUser = new User(
            Alias = 'gtmroute',
            Email = 'gtm-routing-operator@example.com',
            EmailEncodingKey = 'UTF-8',
            LanguageLocaleKey = 'en_US',
            LastName = 'GTM Routing Operator',
            LocaleSidKey = 'en_US',
            ProfileId = UserInfo.getProfileId(),
            TimeZoneSidKey = 'America/New_York',
            UserName = 'gtm.routing.' + UserInfo.getOrganizationId() + '.' +
                String.valueOf(System.now().getTime()) + '@example.com'
        );
        insert as system operatorUser;
        PermissionSet operatorPermissions = [
            SELECT Id
            FROM PermissionSet
            WHERE Name = 'GTM_Routing_Operator'
            WITH SYSTEM_MODE
            LIMIT 1
        ];
        insert as system new PermissionSetAssignment(
            AssigneeId = operatorUser.Id,
            PermissionSetId = operatorPermissions.Id
        );
    }

    @IsTest
    static void routesTwoHundredLeadsWithOneQueueableJob() {
        GTMLeadRoutingService.queueIdOverrides = new Map<String, Id>{
            'GTM_Priority_Review' => UserInfo.getUserId(),
            'GTM_Standard_Review' => UserInfo.getUserId()
        };
        List<Lead> leads = new List<Lead>();
        for (Integer index = 0; index < 200; index++) {
            leads.add(new Lead(
                LastName = 'Bulk ' + index,
                Company = 'Synthetic ' + index,
                GTM_Score__c = 80,
                GTM_Segment__c = 'SMB'
            ));
        }
        insert as system leads;
        List<Id> leadIds = new List<Id>();
        for (Lead leadRecord : leads) leadIds.add(leadRecord.Id);

        GTMLeadRoutingService.Output output;
        Test.startTest();
        System.runAs(operatorUser()) {
            output = GTMLeadRoutingService.enqueueApprovedRouting(leadIds, 'bulk-200', true);
        }
        Test.stopTest();

        GTM_Routing_Run__c run = [
            SELECT Status__c, Requested_Count__c, Planned_Count__c, Succeeded_Count__c,
                Failed_Count__c, Held_Count__c, Stale_Count__c, Queueable_Job_Id__c
            FROM GTM_Routing_Run__c
            WHERE Id = :output.runId
            WITH SYSTEM_MODE
        ];
        System.assertEquals('Completed', run.Status__c);
        System.assertEquals(200, run.Requested_Count__c.intValue());
        System.assertEquals(200, run.Planned_Count__c.intValue());
        System.assertEquals(200, run.Succeeded_Count__c.intValue());
        System.assertEquals(0, run.Failed_Count__c.intValue());
        System.assertEquals(0, run.Held_Count__c.intValue());
        System.assertEquals(0, run.Stale_Count__c.intValue());
        System.assertNotEquals(null, run.Queueable_Job_Id__c);
        System.assertEquals(
            200,
            [SELECT COUNT() FROM GTM_Routing_Result__c WHERE Routing_Run__c = :run.Id AND Status__c = 'Succeeded' WITH SYSTEM_MODE]
        );
        System.assertEquals(
            200,
            [SELECT COUNT() FROM Lead WHERE Id IN :leadIds AND GTM_Routed_Owner__c = 'GTM_Priority_Review' WITH SYSTEM_MODE]
        );
    }

    @IsTest
    static void approvalTokenMakesSubmissionIdempotent() {
        GTMLeadRoutingService.queueIdOverrides = new Map<String, Id>{
            'GTM_Priority_Review' => UserInfo.getUserId(),
            'GTM_Standard_Review' => UserInfo.getUserId()
        };
        Lead leadRecord = new Lead(
            LastName = 'Idempotent',
            Company = 'Synthetic',
            GTM_Score__c = 90,
            GTM_Segment__c = 'Enterprise'
        );
        insert as system leadRecord;

        GTMLeadRoutingService.Output first;
        GTMLeadRoutingService.Output second;
        Test.startTest();
        System.runAs(operatorUser()) {
            first = GTMLeadRoutingService.enqueueApprovedRouting(
                new List<Id>{ leadRecord.Id },
                'same-approval-token',
                true
            );
            second = GTMLeadRoutingService.enqueueApprovedRouting(
                new List<Id>{ leadRecord.Id },
                'same-approval-token',
                true
            );
        }
        Test.stopTest();

        System.assertEquals(first.runId, second.runId);
        System.assertEquals(true, second.duplicateRequest);
        System.assertEquals(1, [SELECT COUNT() FROM GTM_Routing_Run__c WHERE Approval_Token__c = 'same-approval-token' WITH SYSTEM_MODE]);
        System.assertEquals(1, [SELECT COUNT() FROM GTM_Routing_Result__c WHERE Routing_Run__c = :first.runId WITH SYSTEM_MODE]);
        System.assertEquals(
            'Enterprise_High_Score',
            [SELECT Policy_Name__c FROM GTM_Routing_Result__c WHERE Routing_Run__c = :first.runId WITH SYSTEM_MODE LIMIT 1].Policy_Name__c
        );
    }

    @IsTest
    static void invocableContractQueuesOneApprovedCollection() {
        GTMLeadRoutingService.queueIdOverrides = new Map<String, Id>{
            'GTM_Priority_Review' => UserInfo.getUserId(),
            'GTM_Standard_Review' => UserInfo.getUserId()
        };
        Lead leadRecord = new Lead(
            LastName = 'Flow Contract',
            Company = 'Synthetic',
            GTM_Score__c = 80,
            GTM_Segment__c = 'SMB'
        );
        insert as system leadRecord;
        GTMLeadRoutingService.Request request = new GTMLeadRoutingService.Request();
        request.leadIds = new List<Id>{ leadRecord.Id };
        request.approvalToken = 'invocable-contract';
        request.approved = true;

        List<GTMLeadRoutingService.Output> outputs;
        Test.startTest();
        System.runAs(operatorUser()) {
            outputs = GTMLeadRoutingService.enqueueFromFlow(
                new List<GTMLeadRoutingService.Request>{ request }
            );
        }
        Test.stopTest();

        System.assertEquals(1, outputs.size());
        System.assertEquals(
            'Completed',
            [SELECT Status__c FROM GTM_Routing_Run__c WHERE Id = :outputs[0].runId WITH SYSTEM_MODE].Status__c
        );
    }

    @IsTest
    static void recordsSuccessFailureHoldAndStaleWithoutRollingBackTheBatch() {
        Account invalidQueueOwner = new Account(Name = 'Not a valid Lead owner');
        insert as system invalidQueueOwner;
        GTMLeadRoutingService.queueIdOverrides = new Map<String, Id>{
            'GTM_Priority_Review' => UserInfo.getUserId(),
            'GTM_Standard_Review' => invalidQueueOwner.Id
        };
        List<Lead> leads = new List<Lead>{
            new Lead(LastName = 'Success', Company = 'Synthetic', GTM_Score__c = 90, GTM_Segment__c = 'SMB'),
            new Lead(LastName = 'Stale', Company = 'Synthetic', GTM_Score__c = 90, GTM_Segment__c = 'Enterprise'),
            new Lead(LastName = 'DmlFailure', Company = 'Synthetic', GTM_Score__c = 65, GTM_Segment__c = 'SMB'),
            new Lead(LastName = 'Held', Company = 'Synthetic', GTM_Score__c = 40, GTM_Segment__c = 'SMB')
        };
        insert as system leads;
        List<Id> leadIds = new List<Id>();
        for (Lead leadRecord : leads) leadIds.add(leadRecord.Id);

        GTMLeadRoutingService.Output output;
        Test.startTest();
        System.runAs(operatorUser()) {
            output = GTMLeadRoutingService.enqueueApprovedRouting(leadIds, 'mixed-results', true);
        }
        GTM_Routing_Result__c staleReceipt = [
            SELECT Id, Expected_Last_Modified__c
            FROM GTM_Routing_Result__c
            WHERE Routing_Run__c = :output.runId AND Lead__c = :leads[1].Id
            WITH SYSTEM_MODE
        ];
        staleReceipt.Expected_Last_Modified__c = System.now().addDays(-1);
        update as system staleReceipt;
        Test.stopTest();

        GTM_Routing_Run__c run = [
            SELECT Status__c, Succeeded_Count__c, Failed_Count__c, Held_Count__c, Stale_Count__c
            FROM GTM_Routing_Run__c
            WHERE Id = :output.runId
            WITH SYSTEM_MODE
        ];
        System.assertEquals('CompletedWithErrors', run.Status__c);
        System.assertEquals(1, run.Succeeded_Count__c.intValue());
        System.assertEquals(1, run.Failed_Count__c.intValue());
        System.assertEquals(1, run.Held_Count__c.intValue());
        System.assertEquals(1, run.Stale_Count__c.intValue());
        System.assertEquals(1, [SELECT COUNT() FROM GTM_Routing_Result__c WHERE Routing_Run__c = :run.Id AND Status__c = 'Succeeded' WITH SYSTEM_MODE]);
        System.assertEquals(1, [SELECT COUNT() FROM GTM_Routing_Result__c WHERE Routing_Run__c = :run.Id AND Status__c = 'Failed' WITH SYSTEM_MODE]);
        System.assertEquals(1, [SELECT COUNT() FROM GTM_Routing_Result__c WHERE Routing_Run__c = :run.Id AND Status__c = 'Held' WITH SYSTEM_MODE]);
        System.assertEquals(1, [SELECT COUNT() FROM GTM_Routing_Result__c WHERE Routing_Run__c = :run.Id AND Status__c = 'Stale' WITH SYSTEM_MODE]);
    }

    @IsTest
    static void treatsAnExpectedHoldAsACompletedRun() {
        Lead heldLead = new Lead(
            LastName = 'Expected Hold',
            Company = 'Synthetic',
            GTM_Score__c = 40,
            GTM_Segment__c = 'SMB'
        );
        insert as system heldLead;

        GTMLeadRoutingService.Output output;
        System.runAs(operatorUser()) {
            output = GTMLeadRoutingService.enqueueApprovedRouting(
                new List<Id>{ heldLead.Id },
                'expected-hold',
                true
            );
        }

        GTM_Routing_Run__c run = [
            SELECT Status__c, Planned_Count__c, Held_Count__c, Failed_Count__c,
                Queueable_Job_Id__c, Completed_At__c
            FROM GTM_Routing_Run__c
            WHERE Id = :output.runId
            WITH SYSTEM_MODE
        ];
        System.assertEquals('Completed', run.Status__c);
        System.assertEquals(0, run.Planned_Count__c.intValue());
        System.assertEquals(1, run.Held_Count__c.intValue());
        System.assertEquals(0, run.Failed_Count__c.intValue());
        System.assertEquals(null, run.Queueable_Job_Id__c);
        System.assertNotEquals(null, run.Completed_At__c);
        System.assertEquals(
            1,
            [SELECT COUNT() FROM GTM_Routing_Result__c WHERE Routing_Run__c = :run.Id AND Status__c = 'Held' WITH SYSTEM_MODE]
        );
    }

    @IsTest
    static void rejectsMissingHumanApproval() {
        System.runAs(operatorUser()) {
            try {
                GTMLeadRoutingService.enqueueApprovedRouting(new List<Id>{ UserInfo.getUserId() }, 'not-approved', false);
                System.assert(false, 'Expected missing approval to be rejected.');
            } catch (GTMLeadRoutingService.RoutingException error) {
                System.assert(error.getMessage().contains('human approval'));
            }
        }
    }

    private static User operatorUser() {
        return [SELECT Id FROM User WHERE Alias = 'gtmroute' WITH SYSTEM_MODE LIMIT 1];
    }
}
