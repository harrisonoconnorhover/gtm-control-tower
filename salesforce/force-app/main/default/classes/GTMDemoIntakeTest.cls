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

    @IsTest
    static void publicInquiryCreatesAccountContactAndIdempotentActivity() {
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = publicSubmission('hollis-new-company-01', 'maya@cedarworks.example', 'Cedar Works');
            GTMDemoIntake.Receipt first = GTMDemoIntake.process(input);
            GTMDemoIntake.Receipt retry = GTMDemoIntake.process(input);
            System.assertEquals('Routed', first.status);
            System.assertEquals('Contact', first.personType);
            System.assertNotEquals(null, first.accountId);
            System.assertEquals(first.taskId, retry.taskId);
            System.assertEquals(first.accountId, [SELECT AccountId FROM Contact WHERE Id = :first.personId].AccountId);
            System.assertEquals(first.accountId, [SELECT WhatId FROM Task WHERE Id = :first.taskId].WhatId);
            Account account = [SELECT Name, Website, GTM_Intake_Domain__c FROM Account WHERE Id = :first.accountId];
            System.assertEquals('Cedar Works', account.Name);
            System.assertEquals(null, account.Website);
            System.assertEquals('cedarworks.example', account.GTM_Intake_Domain__c);
            GTMDemoIntake.Receipt colleague = GTMDemoIntake.process(publicSubmission('hollis-colleague-0001', 'ben@cedarworks.example', 'Cedar Works'));
            System.assertEquals(first.accountId, colleague.accountId);
            System.assertNotEquals(first.personId, colleague.personId);
            System.assertEquals(1, [SELECT COUNT() FROM Account]);
            System.assertEquals(2, [SELECT COUNT() FROM Contact]);
            System.assertEquals(0, [SELECT COUNT() FROM Lead]);
            System.assertEquals(2, [SELECT COUNT() FROM Task]);
        }
    }

    @IsTest
    static void publicInquiryMatchesWebsiteAndPreservesOwnership() {
        Account account = new Account(Name = 'DECKED', Website = 'https://www.decked.com/products'); insert account;
        System.runAs(integration()) {
            GTMDemoIntake.Receipt first = GTMDemoIntake.process(publicSubmission('hollis-decked-000001', 'morgan@decked.com', 'decked'));
            System.assertEquals('Routed', first.status);
            System.assertEquals(account.Id, first.accountId);
            Id owner = [SELECT OwnerId FROM Account WHERE Id = :account.Id].OwnerId;
            System.assertEquals(owner, first.ownerId);
            GTMDemoIntake.Receipt again = GTMDemoIntake.process(publicSubmission('hollis-decked-000002', 'morgan@decked.com', 'Newly entered company'));
            System.assertEquals(first.personId, again.personId);
            System.assertEquals(account.Id, again.accountId);
            System.assertEquals(false, again.createdPerson);
            System.assertNotEquals(first.taskId, again.taskId);
            System.assertEquals(1, [SELECT COUNT() FROM Account]);
            System.assertEquals(1, [SELECT COUNT() FROM Contact]);
        }
    }

    @IsTest
    static void similarCompanyAndPersonalEmailAreHeldWithoutFalseMatch() {
        insert new Account(Name = 'Northline Express', Website = 'https://northlineexpress.com');
        System.runAs(integration()) {
            GTMDemoIntake.Receipt sameName = GTMDemoIntake.process(publicSubmission('hollis-wrong-domain01', 'person@northlinefreight.example', 'Northline Express'));
            System.assertEquals('Held', sameName.status);
            GTMDemoIntake.Receipt sameDomain = GTMDemoIntake.process(publicSubmission('hollis-wrong-name-01', 'person@northlineexpress.com', 'Northline Logistics'));
            System.assertEquals('Held', sameDomain.status);
            GTMDemoIntake.Receipt personal = GTMDemoIntake.process(publicSubmission('hollis-personal-0001', 'a.person@gmail.com', 'Unverified Company'));
            System.assertEquals('Held', personal.status);
            System.assertEquals(1, [SELECT COUNT() FROM Account]);
            System.assertEquals(0, [SELECT COUNT() FROM Contact]);
            System.assertEquals(3, [SELECT COUNT() FROM Task]);
        }
    }

    @IsTest
    static void publicInquiryConvertsKnownLeadWithoutNewOpportunity() {
        Lead lead = new Lead(FirstName = 'Original', LastName = 'Requester', Company = 'Cedar Works', Email = 'known@cedar.example'); insert lead;
        System.runAs(integration()) {
            GTMDemoIntake.Receipt result = GTMDemoIntake.process(publicSubmission('hollis-convert-00001', lead.Email, lead.Company));
            System.assertEquals('Routed', result.status);
            System.assertEquals('Contact', result.personType);
            Lead after = [SELECT IsConverted, ConvertedContactId, ConvertedAccountId, OwnerId FROM Lead WHERE Id = :lead.Id];
            System.assertEquals(true, after.IsConverted);
            System.assertEquals(result.personId, after.ConvertedContactId);
            System.assertEquals(result.accountId, after.ConvertedAccountId);
            System.assertEquals(after.OwnerId, result.ownerId);
            System.assertEquals('Original', [SELECT FirstName FROM Contact WHERE Id = :result.personId].FirstName);
            System.assertEquals(0, [SELECT COUNT() FROM Opportunity]);
        }
    }

    @IsTest
    static void publicFailureRollsBackCompanyAndContactTogether() {
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = publicSubmission('hollis-rollback-0001', 'rollback@cedar.example', 'Cedar Works');
            GTMDemoIntake.failAfterTask = true; callRest(input);
            System.assertEquals(503, RestContext.response.statusCode);
            System.assertEquals(0, [SELECT COUNT() FROM Account]);
            System.assertEquals(0, [SELECT COUNT() FROM Contact]);
            System.assertEquals(0, [SELECT COUNT() FROM GTM_Demo_Request__c]);
            GTMDemoIntake.failAfterTask = false; callRest(input);
            System.assertEquals(200, RestContext.response.statusCode);
            System.assertEquals(1, [SELECT COUNT() FROM Account]);
            System.assertEquals(1, [SELECT COUNT() FROM Contact]);
        }
    }

    @IsTest
    static void companyCollisionAndModeChangeCannotCreateDuplicates() {
        insert new Account(Name = 'Cedar Works', Website = 'https://cedar.example');
        insert new Account(Name = 'Cedar Works', Website = 'https://www.cedar.example');
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = publicSubmission('hollis-collision-001', 'p@cedar.example', 'Cedar Works');
            System.assertEquals('Held', GTMDemoIntake.process(input).status);
            input.createContact = false; callRest(input);
            System.assertEquals(409, RestContext.response.statusCode);
            System.assertEquals(0, [SELECT COUNT() FROM Contact]);
            System.assertEquals(0, [SELECT COUNT() FROM Lead]);
        }
    }

    @IsTest
    static void heldCompanyCanBeReviewedAndRetriedWithoutDuplicateActivity() {
        Account account = new Account(Name = 'Cedar Works'); insert account;
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = publicSubmission('hollis-review-000001', 'review@cedar.example', 'Cedar Works');
            GTMDemoIntake.Receipt held = GTMDemoIntake.process(input);
            System.assertEquals('Held', held.status);
            System.assertNotEquals(null, held.taskId);
            System.assertEquals(null, [SELECT WhoId FROM Task WHERE Id = :held.taskId].WhoId);
            System.assertEquals(held.taskId, GTMDemoIntake.process(input).taskId);
            account.Website = 'https://cedar.example'; update account;
            GTMDemoIntake.Receipt routed = GTMDemoIntake.process(input);
            System.assertEquals('Routed', routed.status);
            System.assertEquals(held.taskId, routed.taskId);
            System.assertEquals(account.Id, routed.accountId);
            System.assertEquals(routed.personId, [SELECT WhoId FROM Task WHERE Id = :routed.taskId].WhoId);
            System.assertEquals(1, [SELECT COUNT() FROM Task]);
        }
    }

    private static GTMDemoIntake.Submission publicSubmission(String key, String email, String company) {
        GTMDemoIntake.Submission input = submission(key, email);
        input.createContact = true; input.company = company; input.source = 'hollis-website'; return input;
    }

    @IsTest
    static void queuedMarketingLeadUsesKnownAccountOwner() {
        Account account = new Account(Name = 'Cedar Analytics', Website = 'https://cedar.example', OwnerId = UserInfo.getUserId()); insert account;
        Id queueId = [SELECT Id FROM Group WHERE DeveloperName = 'Demo_Test_Queue'].Id;
        Lead person = new Lead(FirstName = 'Morgan', LastName = 'Reed', Company = account.Name,
            Email = 'morgan@cedar.example', OwnerId = queueId, LeadSource = 'Trade Show', Description = 'Original marketing context');
        insert person;
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = publicSubmission('queue-account-000001', person.Email, account.Name);
            GTMDemoIntake.Receipt result = GTMDemoIntake.process(input);
            System.assertEquals('Routed', result.status);
            System.assertEquals(account.OwnerId, result.ownerId);
            System.assertEquals(account.Id, result.accountId);
            Lead converted = [SELECT IsConverted, ConvertedContactId, LeadSource, Description FROM Lead WHERE Id = :person.Id];
            System.assertEquals(true, converted.IsConverted);
            System.assertEquals(result.personId, converted.ConvertedContactId);
            System.assertEquals('Trade Show', converted.LeadSource);
            System.assertEquals('Original marketing context', converted.Description);
            System.assertEquals(result.taskId, GTMDemoIntake.process(input).taskId);
            System.assertEquals(1, [SELECT COUNT() FROM Contact]);
            System.assertEquals(1, [SELECT COUNT() FROM Account]);
            System.assertEquals(0, [SELECT COUNT() FROM Opportunity]);
            System.assert(result.routingDetail.contains('existing marketing Lead'));
        }
    }

    @IsTest
    static void queuedUnknownCompanyWaitsForEnrichmentAndReusesReviewTask() {
        Id queueId = [SELECT Id FROM Group WHERE DeveloperName = 'Demo_Test_Queue'].Id;
        Lead person = new Lead(LastName = 'Reed', Company = 'Cedar Analytics', Email = 'waiting@cedar.example', OwnerId = queueId); insert person;
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = publicSubmission('queue-enrichment-001', person.Email, person.Company);
            GTMDemoIntake.Receipt held = GTMDemoIntake.process(input);
            System.assertEquals('Held', held.status);
            System.assertEquals(0, [SELECT COUNT() FROM Account]);
            System.assertEquals(0, [SELECT COUNT() FROM Contact]);
            System.assertEquals(false, [SELECT IsConverted FROM Lead WHERE Id = :person.Id].IsConverted);
            // A trusted marketing/RevOps update supplies the verified business and owner.
            Account enriched = new Account(Name = person.Company, Website = 'https://cedar.example'); insert enriched;
            GTMDemoIntake.Receipt resumed = GTMDemoIntake.process(input);
            System.assertEquals('Routed', resumed.status);
            System.assertEquals(held.taskId, resumed.taskId);
            System.assertEquals(enriched.Id, resumed.accountId);
            System.assertEquals(1, [SELECT COUNT() FROM Task]);
        }
    }

    @IsTest
    static void accountHandoffWinsWithoutOverwritingContactOrFirstTouch() {
        Account account = new Account(Name = 'Cedar Analytics', Website = 'https://cedar.example', OwnerId = UserInfo.getUserId()); insert account;
        Id priorOwner = integration().Id;
        Contact person = new Contact(FirstName = 'Priya', LastName = 'Shah', Email = 'priya@cedar.example',
            AccountId = account.Id, OwnerId = priorOwner, LeadSource = 'Partner Referral', Phone = '555-0105'); insert person;
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = publicSubmission('account-handoff-0001', person.Email, account.Name);
            GTMDemoIntake.Receipt first = GTMDemoIntake.process(input);
            System.assertEquals(account.OwnerId, first.ownerId);
            Contact after = [SELECT OwnerId, LeadSource, Phone FROM Contact WHERE Id = :person.Id];
            System.assertEquals(priorOwner, after.OwnerId);
            System.assertEquals('Partner Referral', after.LeadSource);
            System.assertEquals('555-0105', after.Phone);
            System.assertEquals(account.OwnerId, [SELECT OwnerId FROM Task WHERE Id = :first.taskId].OwnerId);
            System.assert(first.routingDetail.contains('current Account owner'));
            input.requestId = 'account-handoff-0002'; input.campaign = 'returning-demo';
            GTMDemoIntake.Receipt again = GTMDemoIntake.process(input);
            System.assertEquals(first.personId, again.personId);
            System.assertNotEquals(first.taskId, again.taskId);
            System.assertEquals('returning-demo', [SELECT Campaign__c FROM GTM_Demo_Request__c WHERE Id = :again.submissionId].Campaign__c);
        }
    }

    @IsTest
    static void sharedDomainUsesExactBusinessUnitAndHoldsUnknownUnit() {
        Account analytics = new Account(Name = 'Cedar Analytics', Website = 'https://cedar.example'); insert analytics;
        insert new Account(Name = 'Cedar Payments', Website = 'https://www.cedar.example/payments');
        insert new Account(Name = 'Cedar Analytics', Website = 'https://unrelated.example');
        System.runAs(integration()) {
            GTMDemoIntake.Receipt matched = GTMDemoIntake.process(publicSubmission('business-unit-000001', 'devon@cedar.example', 'cedar analytics'));
            System.assertEquals('Routed', matched.status);
            System.assertEquals(analytics.Id, matched.accountId);
            GTMDemoIntake.Receipt unknown = GTMDemoIntake.process(publicSubmission('business-unit-000002', 'sam@cedar.example', 'Cedar Group'));
            System.assertEquals('Held', unknown.status);
            System.assertEquals(null, unknown.accountId);
            System.assertEquals(3, [SELECT COUNT() FROM Account]);
            System.assertEquals(1, [SELECT COUNT() FROM Contact]);
        }
    }

    @IsTest
    static void publicCrossObjectCollisionHasOneReviewTaskAndNoNewPerson() {
        insert new Lead(FirstName = 'Alex', LastName = 'Rivera', Company = 'Cedar Analytics', Email = 'shared@cedar.example');
        insert new Contact(FirstName = 'Casey', LastName = 'Morgan', Email = 'shared@cedar.example');
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = publicSubmission('cross-object-000001', 'shared@cedar.example', 'Cedar Analytics');
            GTMDemoIntake.Receipt held = GTMDemoIntake.process(input);
            System.assertEquals('Held', held.status);
            System.assertEquals(held.taskId, GTMDemoIntake.process(input).taskId);
            System.assertEquals(1, [SELECT COUNT() FROM Task]);
            System.assertEquals(1, [SELECT COUNT() FROM Contact]);
            System.assertEquals(1, [SELECT COUNT() FROM Lead]);
            System.assertEquals(0, [SELECT COUNT() FROM Account]);
        }
    }

    private static User integration() { return [SELECT Id FROM User WHERE Alias = 'demoin' LIMIT 1]; }

    @IsTest
    static void savedActionResumesPublicHoldAndReusesTask() {
        Account account = new Account(Name = 'Saved Action Company'); insert account;
        System.runAs(integration()) {
            GTMDemoIntake.Receipt held = GTMDemoIntake.process(publicSubmission('saved-action-public01', 'p@saved.example', account.Name));
            System.assertEquals('Held', held.status);
            account.Website = 'https://saved.example'; update account;
            GTMDemoIntake.RetryResult resumed = retry(held.submissionId);
            System.assertEquals('Routed', resumed.status);
            System.assertEquals(held.taskId, resumed.taskId);
            System.assertEquals(held.submissionId, resumed.requestRecordId);
            System.assertEquals(resumed.taskId, retry(held.submissionId).taskId);
            System.assertEquals(1, [SELECT COUNT() FROM Contact]);
            System.assertEquals(0, [SELECT COUNT() FROM Lead]);
            System.assertEquals(1, [SELECT COUNT() FROM Task]);
        }
    }

    @IsTest
    static void savedActionPreservesLegacyLeadModeAndAttribution() {
        Id queueId = [SELECT Id FROM Group WHERE DeveloperName = 'Demo_Test_Queue'].Id;
        Lead person = new Lead(LastName = 'Saved', Email = 'legacy@saved.example', Company = 'Legacy Company', OwnerId = queueId); insert person;
        System.runAs(integration()) {
            GTMDemoIntake.Submission input = submission('saved-action-legacy01', person.Email);
            input.source = 'original-partner'; input.campaign = 'original-webinar';
            GTMDemoIntake.Receipt held = GTMDemoIntake.process(input);
            System.assertEquals('Held', held.status);
            person.OwnerId = UserInfo.getUserId(); update person;
            System.assertEquals('Routed', retry(held.submissionId).status);
            System.assertEquals(false, [SELECT IsConverted FROM Lead WHERE Id = :person.Id].IsConverted);
            System.assertEquals(0, [SELECT COUNT() FROM Account]);
            GTM_Demo_Request__c saved = [SELECT Source__c, Campaign__c FROM GTM_Demo_Request__c WHERE Id = :held.submissionId];
            System.assertEquals(input.source, saved.Source__c); System.assertEquals(input.campaign, saved.Campaign__c);
        }
    }

    @IsTest
    static void savedActionRejectsChangedDetailsAndUnauthorizedCallers() {
        Id requestId;
        System.runAs(integration()) {
            GTMDemoIntake.Receipt first = GTMDemoIntake.process(submission('saved-action-altered1', 'altered@saved.example'));
            requestId = first.submissionId;
            update new GTM_Demo_Request__c(Id = requestId, Company__c = 'Changed after receipt');
            GTMDemoIntake.RetryResult result = retry(requestId);
            System.assertEquals('Error', result.status);
            System.assert(result.message.contains('saved form details changed'));
            System.assertEquals(1, [SELECT COUNT() FROM Task]);
        }
        User denied = [SELECT Id FROM User WHERE Alias = 'demono' LIMIT 1];
        System.runAs(denied) {
            System.assertEquals('Error', retry(requestId).status);
            System.assertEquals(null, retry(requestId).requestRecordId);
        }
    }

    @IsTest
    static void savedActionRollsBackFailedRecoveryAndCanResume() {
        Account account = new Account(Name = 'Rollback Saved Company'); insert account;
        System.runAs(integration()) {
            GTMDemoIntake.Receipt held = GTMDemoIntake.process(publicSubmission('saved-action-rollback', 'person@rollback-saved.example', account.Name));
            account.Website = 'https://rollback-saved.example'; update account;
            GTMDemoIntake.failAfterTask = true;
            System.assertEquals('Error', retry(held.submissionId).status);
            System.assertEquals(0, [SELECT COUNT() FROM Contact]);
            System.assertEquals(null, [SELECT WhoId FROM Task WHERE Id = :held.taskId].WhoId);
            System.assertEquals('Held', [SELECT Status__c FROM GTM_Demo_Request__c WHERE Id = :held.submissionId].Status__c);
            GTMDemoIntake.failAfterTask = false;
            System.assertEquals('Routed', retry(held.submissionId).status);
            System.assertEquals(1, [SELECT COUNT() FROM Task]);
        }
    }

    private static GTMDemoIntake.RetryResult retry(Id recordId) {
        GTMDemoIntake.RetryInput input = new GTMDemoIntake.RetryInput(); input.recordId = recordId;
        return GTMDemoIntake.retrySavedRequest(new List<GTMDemoIntake.RetryInput>{input})[0];
    }

    @IsTest
    static void importedSpacingCannotHideConflictingCompany() {
        insert new Account(Name = 'Cedar   Analytics', Website = 'https://actual-cedar.example');
        System.runAs(integration()) {
            GTMDemoIntake.Receipt conflict = GTMDemoIntake.process(publicSubmission('import-space-conflict', 'p@different-cedar.example', 'Cedar Analytics'));
            System.assertEquals('Held', conflict.status);
            System.assertEquals(1, [SELECT COUNT() FROM Account]);
            System.assertEquals(0, [SELECT COUNT() FROM Contact]);
            GTMDemoIntake.Receipt exact = GTMDemoIntake.process(publicSubmission('import-space-matched1', 'p@actual-cedar.example', 'Cedar Analytics'));
            System.assertEquals('Routed', exact.status);
            System.assertEquals(1, [SELECT COUNT() FROM Account]);
        }
    }

    @IsTest
    static void wildcardCharactersInCompanyNameStayLiteral() {
        insert new Account(Name = '100% Data_Works', Website = 'https://literal.example');
        insert new Account(Name = '100x DataXWorks', Website = 'https://unrelated.example');
        System.runAs(integration()) {
            GTMDemoIntake.Receipt conflict = GTMDemoIntake.process(publicSubmission('import-literal-00001', 'p@different.example', '100% Data_Works'));
            System.assertEquals('Held', conflict.status);
            System.assertEquals(2, [SELECT COUNT() FROM Account]);
            System.assertEquals(0, [SELECT COUNT() FROM Contact]);
        }
    }
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
