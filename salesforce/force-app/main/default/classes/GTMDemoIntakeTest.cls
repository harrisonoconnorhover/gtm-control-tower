@IsTest
private class GTMDemoIntakeTest {
    @TestSetup
    static void setupIntegration() {
        User integration = new User(Alias = 'demoin', Email = 'demo-integration@example.com',
            EmailEncodingKey = 'UTF-8', LanguageLocaleKey = 'en_US', LastName = 'Demo Intake Test',
            LocaleSidKey = 'en_US', ProfileId = UserInfo.getProfileId(), TimeZoneSidKey = 'America/New_York',
            Username = 'demo.intake.' + UserInfo.getOrganizationId() + '.' + System.now().getTime() + '@example.com');
        insert integration;
        User denied = integration.clone(false, false, false, false);
        denied.Alias = 'demono'; denied.Username = 'denied.' + integration.Username;
        insert denied;
        PermissionSet permissions = [SELECT Id FROM PermissionSet WHERE Name = 'GTM_Demo_Intake_Integration' LIMIT 1];
        insert new PermissionSetAssignment(AssigneeId = integration.Id, PermissionSetId = permissions.Id);
        Group queue = new Group(Name = 'Demo Test Queue', DeveloperName = 'Demo_Test_Queue', Type = 'Queue');
        insert queue;
        insert new QueueSobject(QueueId = queue.Id, SobjectType = 'Lead');
    }

    @IsTest
    static void existingContactCreatesActivityWithoutNewLead() {
        Account account = new Account(Name = 'Fictional Cedar');
        insert account;
        Contact person = new Contact(FirstName = 'Elena', LastName = 'Foster', Email = 'elena@cedar.example', AccountId = account.Id);
        insert person;
        Id originalOwner = [SELECT OwnerId FROM Contact WHERE Id = :person.Id].OwnerId;
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = submission('request-contact-0001', ' ELENA@CEDAR.EXAMPLE ');
            GTMDemoIntake.Receipt result = GTMDemoIntake.process(input);
            System.assertEquals('Routed', result.status);
            System.assertEquals(person.Id, result.personId);
            System.assertEquals('Contact', result.personType);
            System.assertEquals(false, result.createdPerson);
            System.assertEquals(originalOwner, result.ownerId);
            Task followUp = [SELECT WhoId, OwnerId, Subject FROM Task WHERE Id = :result.taskId];
            System.assertEquals(person.Id, followUp.WhoId);
            System.assertEquals(originalOwner, followUp.OwnerId);
            System.assertEquals(0, [SELECT COUNT() FROM Lead WHERE Email = 'elena@cedar.example']);
            System.assertNotEquals(null, [SELECT GTM_Last_Demo_Requested_At__c FROM Contact WHERE Id = :person.Id].GTM_Last_Demo_Requested_At__c);
        }
    }

    @IsTest
    static void existingLeadKeepsOwnerAndOriginalFields() {
        Lead person = new Lead(FirstName = 'Original', LastName = 'Person', Company = 'Original Company', Email = 'known@brand.example');
        insert person;
        System.runAs(integration()) {
            GTMDemoIntake.Receipt result = GTMDemoIntake.process(submission('request-lead-000001', person.Email));
            Lead after = [SELECT FirstName, Company, OwnerId FROM Lead WHERE Id = :person.Id];
            System.assertEquals(person.Id, result.personId);
            System.assertEquals('Original', after.FirstName);
            System.assertEquals('Original Company', after.Company);
            System.assertEquals(after.OwnerId, result.ownerId);
            System.assertEquals(false, result.createdPerson);
        }
    }

    @IsTest
    static void newPersonAndRequestRetriesAreDistinctFromNewSubmissions() {
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = submission('request-new-0000001', 'new@brand.example');
            GTMDemoIntake.Receipt first = GTMDemoIntake.process(input);
            GTMDemoIntake.Receipt retry = GTMDemoIntake.process(input);
            System.assertEquals('Routed', first.status);
            System.assertEquals(first.submissionId, retry.submissionId);
            System.assertEquals(first.taskId, retry.taskId);
            System.assertEquals(true, retry.reusedRequest);
            System.assertEquals(1, GTMDemoIntake.notificationRequests);
            GTMDemoIntake.Receipt again = GTMDemoIntake.process(submission('request-new-0000002', input.email));
            System.assertEquals(first.personId, again.personId);
            System.assertNotEquals(first.taskId, again.taskId);
            System.assertEquals(false, again.createdPerson);
            System.assertEquals(2, GTMDemoIntake.notificationRequests);
            System.assertEquals(1, [SELECT COUNT() FROM Lead WHERE Email = 'new@brand.example']);
            System.assertEquals(2, [SELECT COUNT() FROM GTM_Demo_Request__c]);
            System.assertEquals(2, [SELECT COUNT() FROM Task WHERE WhoId = :first.personId]);
        }
    }

    @IsTest
    static void conflictingLeadAndContactAreHeld() {
        // Distinct people can share a mailbox even when native fuzzy duplicate rules are active.
        insert new Lead(FirstName = 'Alex', LastName = 'Rivera', Company = 'Fictional', Email = 'shared@brand.example');
        insert new Contact(FirstName = 'Casey', LastName = 'Morgan', Email = 'shared@brand.example');
        System.runAs(integration()) {
            GTMDemoIntake.Receipt result = GTMDemoIntake.process(submission('request-conflict-001', 'shared@brand.example'));
            System.assertEquals('Held', result.status);
            System.assertEquals(null, result.taskId);
            System.assertEquals(1, [SELECT COUNT() FROM Lead WHERE Email = 'shared@brand.example']);
            System.assertEquals(0, [SELECT COUNT() FROM Task]);
        }
    }

    @IsTest
    static void queueOwnershipIsHeldWithoutReassignment() {
        Id queueId = [SELECT Id FROM Group WHERE DeveloperName = 'Demo_Test_Queue'].Id;
        Lead person = new Lead(LastName = 'Queued', Company = 'Fictional', Email = 'queue@brand.example', OwnerId = queueId);
        insert person;
        System.runAs(integration()) {
            GTMDemoIntake.Receipt result = GTMDemoIntake.process(submission('request-queue-00001', person.Email));
            System.assertEquals('Held', result.status);
            System.assertEquals(null, result.taskId);
            System.assertEquals(queueId, [SELECT OwnerId FROM Lead WHERE Id = :person.Id].OwnerId);
        }
    }

    @IsTest
    static void notificationFailureCanRetryWithoutAnotherTask() {
        System.runAs(integration()) {
            GTMDemoIntake.failNotification = true;
            GTMDemoIntake.Submission input = submission('request-notify-0001', 'notify@brand.example');
            GTMDemoIntake.Receipt first = GTMDemoIntake.process(input);
            System.assertEquals('Notification pending', first.status);
            System.assertNotEquals(null, first.taskId);
            GTMDemoIntake.failNotification = false;
            GTMDemoIntake.Receipt retry = GTMDemoIntake.process(input);
            System.assertEquals('Routed', retry.status);
            System.assertEquals(first.taskId, retry.taskId);
            System.assertEquals(1, [SELECT COUNT() FROM Task WHERE WhoId = :first.personId]);
            System.assertEquals(1, GTMDemoIntake.notificationRequests);
        }
    }

    @IsTest
    static void restRejectsChangedPayloadAndMalformedInput() {
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = submission('request-rest-000001', 'rest@brand.example');
            callRest(input);
            System.assertEquals(200, RestContext.response.statusCode);
            input.company = 'Changed Company';
            callRest(input);
            System.assertEquals(409, RestContext.response.statusCode);
            System.assertEquals(1, [SELECT COUNT() FROM Task]);
            input = submission('request-bad-0000001', 'broken@@brand.example');
            callRest(input);
            System.assertEquals(400, RestContext.response.statusCode);
            System.assertEquals(1, [SELECT COUNT() FROM GTM_Demo_Request__c]);
        }
    }

    @IsTest
    static void convertedLeadMatchesItsContact() {
        Lead person = new Lead(LastName = 'Converted', Company = 'Fictional', Email = 'converted@brand.example');
        insert person;
        Database.LeadConvert conversion = new Database.LeadConvert();
        conversion.setLeadId(person.Id);
        conversion.setConvertedStatus([SELECT MasterLabel FROM LeadStatus WHERE IsConverted = true LIMIT 1].MasterLabel);
        conversion.setDoNotCreateOpportunity(true);
        Database.LeadConvertResult converted = Database.convertLead(conversion);
        System.runAs(integration()) {
            GTMDemoIntake.Receipt result = GTMDemoIntake.process(submission('request-converted-01', person.Email));
            System.assertEquals('Routed', result.status);
            System.assertEquals(converted.getContactId(), result.personId);
            System.assertEquals('Contact', result.personType);
            System.assertEquals(false, result.createdPerson);
        }
    }

    @IsTest
    static void transactionFailureRollsBackBeforeRetry() {
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = submission('request-rollback-001', 'rollback@brand.example');
            GTMDemoIntake.failAfterTask = true;
            callRest(input);
            System.assertEquals(503, RestContext.response.statusCode);
            System.assertEquals(0, [SELECT COUNT() FROM Lead]);
            System.assertEquals(0, [SELECT COUNT() FROM Task]);
            System.assertEquals(0, [SELECT COUNT() FROM GTM_Demo_Request__c]);
            GTMDemoIntake.failAfterTask = false;
            callRest(input);
            System.assertEquals(200, RestContext.response.statusCode);
            System.assertEquals(1, [SELECT COUNT() FROM Lead]);
            System.assertEquals(1, [SELECT COUNT() FROM Task]);
        }
    }

    @IsTest
    static void permissionAndHealthAreExplicit() {
        User denied = [SELECT Id FROM User WHERE Alias = 'demono' LIMIT 1];
        System.runAs(denied) {
            callRest(submission('request-denied-0001', 'denied@brand.example'));
            System.assertEquals(403, RestContext.response.statusCode);
            GTMDemoIntake.health();
            System.assertEquals(403, RestContext.response.statusCode);
            System.assertEquals(0, [SELECT COUNT() FROM GTM_Demo_Request__c]);
        }
        System.runAs(integration()) {
            RestContext.request = new RestRequest(); RestContext.response = new RestResponse();
            GTMDemoIntake.health();
            System.assertEquals(200, RestContext.response.statusCode);
            RestContext.request.requestBody = Blob.valueOf('{broken-json');
            GTMDemoIntake.receive();
            System.assertEquals(400, RestContext.response.statusCode);
        }
    }

    private static User integration() { return [SELECT Id FROM User WHERE Alias = 'demoin' LIMIT 1]; }
    private static GTMDemoIntake.Submission submission(String key, String email) {
        GTMDemoIntake.Submission input = new GTMDemoIntake.Submission();
        input.requestId = key;
        input.firstName = 'Elena'; input.lastName = 'Foster'; input.email = email;
        input.phone = ''; input.company = 'Fictional Brand'; input.source = 'website'; input.campaign = 'demo-request';
        return input;
    }
    private static void callRest(GTMDemoIntake.Submission input) {
        RestContext.request = new RestRequest(); RestContext.response = new RestResponse();
        RestContext.request.httpMethod = 'POST';
        RestContext.request.requestURI = '/services/apexrest/gtm/demo-intake';
        RestContext.request.requestBody = Blob.valueOf(JSON.serialize(input));
        GTMDemoIntake.receive();
    }
}
