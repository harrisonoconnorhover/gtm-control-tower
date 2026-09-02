@IsTest
private class GTMLeadTriageActionTest {
    @IsTest
    static void previewsCompleteHeldAndWrongObjectRequestsInOrder() {
        Lead completeLead = new Lead(
            LastName='Morgan',
            Company='Synthetic Control Tower',
            Email='alex@example.com',
            Phone='814-555-0100',
            Website='https://example.com',
            Title='VP Revenue Operations',
            LeadSource='Web'
        );
        Lead heldLead = new Lead(
            LastName='No Email',
            Company='Synthetic Control Tower'
        );
        insert new List<Lead>{ completeLead, heldLead };
        Account wrongObject = new Account(Name='Synthetic Wrong Object');
        insert wrongObject;

        List<GTMLeadTriageAction.Request> requests = new List<GTMLeadTriageAction.Request>();
        requests.add(requestFor(completeLead.Id));
        requests.add(requestFor(heldLead.Id));
        requests.add(requestFor(wrongObject.Id));

        Test.startTest();
        List<GTMLeadTriageAction.Result> results = GTMLeadTriageAction.preview(requests);
        Test.stopTest();

        System.assertEquals(3, results.size());
        System.assertEquals(completeLead.Id, results[0].leadId);
        System.assertEquals(true, results[0].eligible);
        System.assertEquals(100, results[0].readinessScore);
        System.assertEquals('PRIORITY_REVIEW', results[0].recommendedQueue);
        System.assert(results[0].explanation.contains('100/100'));

        System.assertEquals(heldLead.Id, results[1].leadId);
        System.assertEquals(false, results[1].eligible);
        System.assertEquals(30, results[1].readinessScore);
        System.assertEquals('HOLD_DATA_QUALITY', results[1].recommendedQueue);
        System.assert(results[1].explanation.contains('usable email'));

        System.assertEquals(wrongObject.Id, results[2].leadId);
        System.assertEquals(false, results[2].eligible);
        System.assertEquals('HOLD_NOT_FOUND', results[2].recommendedQueue);
    }

    @IsTest
    static void handlesEmptyAndNullInputWithoutDml() {
        System.assertEquals(0, GTMLeadTriageAction.preview(null).size());

        List<GTMLeadTriageAction.Request> requests = new List<GTMLeadTriageAction.Request>{ null };
        List<GTMLeadTriageAction.Result> results = GTMLeadTriageAction.preview(requests);
        System.assertEquals(1, results.size());
        System.assertEquals(false, results[0].eligible);
        System.assertEquals('HOLD_NOT_FOUND', results[0].recommendedQueue);
    }

    @IsTest
    static void autolaunchedFlowOrchestratesReadyAndHeldBranches() {
        Lead readyLead = new Lead(
            LastName='Flow Ready',
            Company='Synthetic Control Tower',
            Email='flow-ready@example.com',
            Title='Revenue Systems Manager'
        );
        Lead heldLead = new Lead(
            LastName='Flow Held',
            Company='Synthetic Control Tower'
        );
        insert new List<Lead>{ readyLead, heldLead };

        Test.startTest();
        Flow.Interview readyInterview = Flow.Interview.createInterview(
            'GTM_Lead_Triage',
            new Map<String, Object>{ 'leadId' => readyLead.Id }
        );
        readyInterview.start();
        Flow.Interview heldInterview = Flow.Interview.createInterview(
            'GTM_Lead_Triage',
            new Map<String, Object>{ 'leadId' => heldLead.Id }
        );
        heldInterview.start();
        Test.stopTest();

        System.assertEquals(true, readyInterview.getVariableValue('eligible'));
        System.assertEquals('READY', readyInterview.getVariableValue('triageStatus'));
        System.assertEquals('PRIORITY_REVIEW', readyInterview.getVariableValue('recommendedQueue'));
        System.assertEquals(75, readyInterview.getVariableValue('readinessScore'));

        System.assertEquals(false, heldInterview.getVariableValue('eligible'));
        System.assertEquals('HELD', heldInterview.getVariableValue('triageStatus'));
        System.assertEquals('HOLD_DATA_QUALITY', heldInterview.getVariableValue('recommendedQueue'));
        System.assertEquals(30, heldInterview.getVariableValue('readinessScore'));
    }

    private static GTMLeadTriageAction.Request requestFor(Id recordId) {
        GTMLeadTriageAction.Request request = new GTMLeadTriageAction.Request();
        request.leadId = recordId;
        return request;
    }
}
