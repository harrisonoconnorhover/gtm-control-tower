@RestResource(urlMapping='/gtm/demo-intake')
global with sharing class GTMDemoIntake {
    @TestVisible private static Boolean failNotification = false;
    @TestVisible private static Boolean failAfterTask = false;
    @TestVisible private static Integer notificationRequests = 0;

    global class Submission {
        global String requestId;
        global String firstName;
        global String lastName;
        global String email;
        global String phone;
        global String company;
        global String source;
        global String campaign;
        global Boolean createContact;
    }

    global class Receipt {
        global String requestId;
        global Id submissionId;
        global String status;
        global String reason;
        global Id personId;
        global String personType;
        global Boolean createdPerson;
        global Id ownerId;
        global String ownerName;
        global String taskId;
        global String notificationStatus;
        global Boolean reusedRequest;
        global Id accountId;
        global String routingDetail;
    }

    @HttpGet
    global static void health() {
        if (!FeatureManagement.checkPermission('GTM_Submit_Demo_Requests')) {
            respond(403, new Map<String, Object>{'error' => 'The integration needs Submit Demo Requests permission.'});
            return;
        }
        respond(200, new Map<String, Object>{'ready' => true, 'version' => 3});
    }

    @HttpPost
    global static void receive() {
        Savepoint beforeRequest = Database.setSavepoint();
        try {
            Submission input = (Submission) JSON.deserializeStrict(RestContext.request.requestBody.toString(), Submission.class);
            respond(200, process(input));
        } catch (InvalidSubmissionException error) {
            Database.rollback(beforeRequest);
            respond(400, new Map<String, Object>{'error' => error.getMessage()});
        } catch (ConflictingRequestException error) {
            Database.rollback(beforeRequest);
            respond(409, new Map<String, Object>{'error' => error.getMessage()});
        } catch (MissingPermissionException error) {
            Database.rollback(beforeRequest);
            respond(403, new Map<String, Object>{'error' => error.getMessage()});
        } catch (JSONException error) {
            Database.rollback(beforeRequest);
            respond(400, new Map<String, Object>{'error' => 'Supply a valid demo request.'});
        } catch (Exception error) {
            Database.rollback(beforeRequest);
            // A failed transaction leaves no new Lead, Task, or half-finished request.
            respond(503, new Map<String, Object>{'error' => 'Salesforce could not finish the request. Retry with the same request ID.'});
        }
    }

    public static Receipt process(Submission input) {
        if (!FeatureManagement.checkPermission('GTM_Submit_Demo_Requests')) {
            throw new MissingPermissionException('The integration needs Submit Demo Requests permission.');
        }
        normalizeAndValidate(input);
        String emailKey = digest(input.email);
        // Different request IDs for the same email must not both observe "no Lead".
        // A first-insert collision rolls back and asks the caller to retry the same ID.
        List<GTM_Demo_Identity__c> identities = [
            SELECT Id FROM GTM_Demo_Identity__c WHERE Email_Key__c = :emailKey WITH USER_MODE LIMIT 1 FOR UPDATE
        ];
        if (identities.isEmpty()) insert as user new GTM_Demo_Identity__c(Email_Key__c = emailKey);

        List<String> hashFields = new List<String>{
            input.firstName, input.lastName, input.email, input.phone, input.company, input.source, input.campaign
        };
        // Keep existing operator request hashes valid after this compatible extension.
        if (input.createContact == true) hashFields.add('account-contact-v1');
        String payloadHash = digest(JSON.serialize(hashFields));
        List<GTM_Demo_Request__c> requests = [
            SELECT Id, Request_Key__c, Payload_Hash__c, Status__c, Reason__c, Lead__c, Contact__c,
                Person_Type__c, New_Person__c, Account__c, Task_Id__c, Notification_Status__c, Follow_Up_Owner__c,
                Received_At__c, First_Name__c, Last_Name__c, Email__c, Company__c, Source__c, Campaign__c, Routing_Detail__c
            FROM GTM_Demo_Request__c WHERE Request_Key__c = :input.requestId WITH USER_MODE LIMIT 1 FOR UPDATE
        ];
        Boolean reused = !requests.isEmpty();
        GTM_Demo_Request__c request;
        if (reused) {
            request = requests[0];
            if (request.Payload_Hash__c != payloadHash) {
                throw new ConflictingRequestException('This request ID already belongs to different form details. Start a new submission.');
            }
            if (request.Status__c == 'Routed') return receipt(request, true);
            if (request.Task_Id__c != null && request.Status__c != 'Held') {
                notifyOwner(request);
                return receipt(request, true);
            }
        } else {
            request = new GTM_Demo_Request__c(
                Request_Key__c = input.requestId, Payload_Hash__c = payloadHash,
                First_Name__c = input.firstName, Last_Name__c = input.lastName,
                Email__c = input.email, Phone__c = input.phone, Company__c = input.company,
                Source__c = input.source, Campaign__c = input.campaign,
                Received_At__c = System.now(), Status__c = 'Received', Notification_Status__c = 'Not requested'
            );
            insert as user request;
        }

        request.Routing_Detail__c = null;
        List<Contact> contacts = [
            SELECT Id, OwnerId, AccountId, GTM_Last_Demo_Requested_At__c FROM Contact
            WHERE Email = :input.email WITH USER_MODE LIMIT 2 FOR UPDATE
        ];
        List<Lead> leads = [
            SELECT Id, OwnerId, Company, GTM_Last_Demo_Requested_At__c FROM Lead
            WHERE Email = :input.email AND IsConverted = false WITH USER_MODE LIMIT 2 FOR UPDATE
        ];
        if (contacts.size() + leads.size() > 1) {
            request.Status__c = 'Held';
            request.Reason__c = 'Multiple Contacts or unconverted Leads share this email. Review the matches before creating a person or follow-up.';
            if (input.createContact == true) return hold(request, reused, request.Reason__c);
            update as user request;
            return receipt(request, reused);
        }

        if (input.createContact == true && (contacts.isEmpty() || contacts[0].AccountId == null)) {
            Id newAccountOwner = UserInfo.getUserId();
            if (!leads.isEmpty()) {
                Id leadOwner = leads[0].OwnerId;
                List<User> activeOwners = [SELECT Id FROM User WHERE Id = :leadOwner AND IsActive = true WITH USER_MODE];
                if (companyKey(leads[0].Company) != companyKey(input.company)) {
                    return hold(request, reused, 'The existing Lead company needs review before conversion.');
                }
                // A queue-owned Lead can use a known Account owner, but cannot
                // establish ownership for an unknown business.
                newAccountOwner = activeOwners.isEmpty() ? null : leadOwner;
            }
            AccountMatch match = companyAccount(input, newAccountOwner);
            if (match.reason != null) return hold(request, reused, match.reason);
            request.Account__c = match.account.Id;
            request.Routing_Detail__c = match.detail;
            if (!leads.isEmpty()) {
                Database.LeadConvert conversion = new Database.LeadConvert();
                conversion.setLeadId(leads[0].Id);
                conversion.setAccountId(match.account.Id);
                conversion.setOwnerId(match.account.OwnerId);
                conversion.setConvertedStatus([SELECT MasterLabel FROM LeadStatus WHERE IsConverted = true LIMIT 1].MasterLabel);
                conversion.setDoNotCreateOpportunity(true);
                Database.LeadConvertResult converted = Database.convertLead(conversion);
                Id contactId = converted.getContactId();
                contacts = [SELECT Id, OwnerId, AccountId, GTM_Last_Demo_Requested_At__c FROM Contact WHERE Id = :contactId WITH USER_MODE];
                leads.clear();
                request.New_Person__c = true;
                request.Routing_Detail__c = 'Converted the existing marketing Lead into the matched Account; its current Account owner receives the follow-up.';
            } else if (contacts.isEmpty()) {
                Contact person = new Contact(FirstName = input.firstName, LastName = input.lastName,
                    Email = input.email, Phone = input.phone, AccountId = match.account.Id, OwnerId = match.account.OwnerId);
                insert as user person;
                contacts.add(person);
                request.New_Person__c = true;
            } else {
                contacts[0].AccountId = match.account.Id;
                update as user contacts[0];
            }
        }
        Id ownerId;
        Datetime lastRequestAt;
        if (!contacts.isEmpty()) {
            Contact person = contacts[0];
            request.Contact__c = person.Id;
            request.Account__c = person.AccountId;
            request.Lead__c = null;
            request.Person_Type__c = 'Contact';
            ownerId = person.OwnerId;
            lastRequestAt = person.GTM_Last_Demo_Requested_At__c;
            if (input.createContact == true && person.AccountId != null) {
                Id accountId = person.AccountId;
                Account account = [SELECT Id, OwnerId FROM Account WHERE Id = :accountId WITH USER_MODE LIMIT 1 FOR UPDATE];
                ownerId = account.OwnerId;
                if (String.isBlank(request.Routing_Detail__c)) {
                    request.Routing_Detail__c = 'Matched the existing Contact by exact email; the current Account owner receives the follow-up. Contact identity and ownership are preserved.';
                }
            }
        } else {
            Lead person;
            if (leads.isEmpty()) {
                // Explicit pilot default: the trusted integration user is the intake owner.
                // Existing person ownership is never assigned again.
                person = new Lead(FirstName = input.firstName, LastName = input.lastName,
                    Email = input.email, Phone = input.phone, Company = input.company, OwnerId = UserInfo.getUserId());
                insert as user person;
                request.New_Person__c = true;
            } else person = leads[0];
            request.Lead__c = person.Id;
            request.Contact__c = null;
            request.Person_Type__c = 'Lead';
            ownerId = person.OwnerId;
            lastRequestAt = person.GTM_Last_Demo_Requested_At__c;
        }

        List<User> owners = [SELECT Id, IsActive FROM User WHERE Id = :ownerId WITH USER_MODE LIMIT 1];
        if (owners.isEmpty() || !owners[0].IsActive) {
            request.Status__c = 'Held';
            request.Reason__c = 'The existing owner is a queue or an inactive user. Assign an active follow-up owner in Salesforce and retry.';
            if (input.createContact == true) return hold(request, reused, request.Reason__c);
            update as user request;
            return receipt(request, reused);
        }
        request.Follow_Up_Owner__c = ownerId;
        Id personId = request.Contact__c != null ? request.Contact__c : request.Lead__c;
        Task followUp = new Task(
            Id = request.Task_Id__c,
            Subject = 'Demo requested - ' + input.firstName + ' ' + input.lastName,
            WhoId = personId, WhatId = request.Account__c, OwnerId = ownerId, Status = 'Not Started', Priority = 'High', ActivityDate = Date.today(),
            Description = 'Demo form submitted at ' + String.valueOf(request.Received_At__c) + ' UTC.\n' +
                'Company: ' + input.company + '\nSource: ' + input.source + '\nCampaign: ' + input.campaign +
                '\nRequest ID: ' + input.requestId +
                (request.Routing_Detail__c == null ? '' : '\nRouting: ' + request.Routing_Detail__c)
        );
        upsert as user followUp;
        if (failAfterTask) throw new NotificationFailureException('Simulated downstream transaction failure.');
        request.Task_Id__c = followUp.Id;
        // An older held request must not move the "last requested" date backwards.
        if (lastRequestAt == null || lastRequestAt < request.Received_At__c) {
            if (request.Contact__c != null) update as user new Contact(Id = personId, GTM_Last_Demo_Requested_At__c = request.Received_At__c);
            else update as user new Lead(Id = personId, GTM_Last_Demo_Requested_At__c = request.Received_At__c);
        }
        request.Status__c = 'Notification pending';
        request.Notification_Status__c = 'Pending';
        request.Reason__c = 'Follow-up task created. Owner notification is pending.';
        update as user request;
        notifyOwner(request);
        return receipt(request, reused);
    }

    private class AccountMatch { Account account; String reason; String detail; }

    private static AccountMatch companyAccount(Submission input, Id newAccountOwner) {
        AccountMatch result = new AccountMatch();
        String domain = input.email.substringAfter('@');
        Set<String> personalDomains = new Set<String>{'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','hotmail.com',
            'outlook.com','live.com','aol.com','icloud.com','me.com','proton.me','protonmail.com','msn.com','mail.com','gmx.com'};
        if (personalDomains.contains(domain)) {
            result.reason = 'A personal email domain cannot identify a company. Review this request before creating or linking an Account.';
            return result;
        }
        // Serialize different people at the same business, as well as same-email retries.
        String domainKey = digest('account-domain:' + domain);
        List<GTM_Demo_Identity__c> locks = [SELECT Id FROM GTM_Demo_Identity__c WHERE Email_Key__c = :domainKey WITH USER_MODE LIMIT 1 FOR UPDATE];
        if (locks.isEmpty()) insert as user new GTM_Demo_Identity__c(Email_Key__c = domainKey);
        String websitePattern = '%' + domain + '%';
        List<Account> candidates = [SELECT Id, Name, Website, OwnerId, GTM_Intake_Domain__c FROM Account
            WHERE GTM_Intake_Domain__c = :domain OR Website LIKE :websitePattern OR Name = :input.company
            WITH USER_MODE LIMIT 100];
        List<Account> matches = new List<Account>();
        Boolean conflict = false;
        for (Account candidate : candidates) {
            Boolean sameName = companyKey(candidate.Name) == companyKey(input.company);
            Boolean sameDomain = candidate.GTM_Intake_Domain__c == domain || websiteDomain(candidate.Website) == domain;
            // A same-name company at another website must never be silently selected.
            if (sameName && sameDomain) matches.add(candidate);
            else if (sameName || sameDomain) conflict = true;
        }
        // Shared domains are common across business units. A unique exact name
        // AND domain match is decisive; either field alone never is.
        if (candidates.size() == 100 || matches.size() > 1 || (matches.isEmpty() && conflict)) {
            result.reason = 'Company name and email domain do not identify one unambiguous Account. Review the company matches.';
            return result;
        }
        if (matches.size() == 1) {
            result.account = matches[0];
            result.detail = 'Matched one Account by exact normalized company name and business email domain; its current owner receives the follow-up.';
            Id accountOwner = result.account.OwnerId;
            if ([SELECT COUNT() FROM User WHERE Id = :accountOwner AND IsActive = true WITH USER_MODE] != 1) {
                result.reason = 'The matching Account has an inactive owner. Review ownership before creating a Contact.';
            }
        } else {
            if (newAccountOwner == null) {
                result.reason = 'The existing Lead has no active user owner and no unambiguous owned Account. Review ownership before conversion.';
                return result;
            }
            result.account = new Account(Name = input.company, OwnerId = newAccountOwner, Type = 'Prospect',
                GTM_Intake_Domain__c = domain,
                Description = 'Created from a Hollis Consulting demo inquiry through GTM Control Tower. Business email domain: ' + domain +
                    '. Company name is supplied by the requester; website and company size have not been independently verified.');
            insert as user result.account;
            result.detail = 'Created a new Prospect Account and Contact; retained the active Lead owner when present, otherwise used the intake owner.';
        }
        return result;
    }

    private static Receipt hold(GTM_Demo_Request__c request, Boolean reused, String reason) {
        request.Status__c = 'Held'; request.Reason__c = reason;
        request.Routing_Detail__c = reason;
        if (request.Task_Id__c == null) {
            // Triage is assigned to the integration owner, without linking a guessed person.
            Task review = new Task(Subject = 'Review demo request - ' + request.First_Name__c + ' ' + request.Last_Name__c,
                OwnerId = UserInfo.getUserId(), Status = 'Not Started', Priority = 'High', ActivityDate = Date.today(),
                Description = reason + '\nCompany: ' + request.Company__c + '\nEmail: ' + request.Email__c +
                    '\nDemo Request: ' + URL.getOrgDomainUrl().toExternalForm() + '/' + request.Id);
            insert as user review;
            request.Task_Id__c = review.Id;
            request.Follow_Up_Owner__c = UserInfo.getUserId();
        }
        update as user request;
        return receipt(request, reused);
    }
    private static String companyKey(String value) { return clean(value).toLowerCase().replaceAll('\\s+', ' '); }
    private static String websiteDomain(String value) {
        String domain = clean(value).toLowerCase().replaceFirst('^https?://', '').substringBefore('/').substringBefore('?').substringBefore('#').substringBefore(':');
        return domain.startsWith('www.') ? domain.substring(4) : domain;
    }

    private static void notifyOwner(GTM_Demo_Request__c request) {
        if (request.Notification_Status__c == 'Requested') return;
        try {
            if (failNotification) throw new NotificationFailureException('Simulated notification failure.');
            CustomNotificationType kind = [SELECT Id FROM CustomNotificationType WHERE DeveloperName = 'GTM_Demo_Request' LIMIT 1];
            Messaging.CustomNotification notification = new Messaging.CustomNotification();
            notification.setNotificationTypeId(kind.Id);
            notification.setTitle('Demo requested - ' + request.First_Name__c + ' ' + request.Last_Name__c);
            notification.setBody(request.Company__c + ' submitted a demo request. A follow-up task is due today.');
            notification.setTargetId(request.Contact__c != null ? request.Contact__c : request.Lead__c);
            notification.send(new Set<String>{String.valueOf(request.Follow_Up_Owner__c)});
            notificationRequests++;
            request.Status__c = 'Routed';
            request.Notification_Status__c = 'Requested';
            request.Reason__c = 'Follow-up task created and Salesforce accepted the owner notification.';
        } catch (Exception error) {
            request.Status__c = 'Notification pending';
            request.Notification_Status__c = 'Pending';
            request.Reason__c = 'The follow-up task exists. Owner notification could not be requested; retry this same request.';
        }
        update as user request;
    }

    private static Receipt receipt(GTM_Demo_Request__c request, Boolean reused) {
        Receipt result = new Receipt();
        result.requestId = request.Request_Key__c;
        result.accountId = request.Account__c;
        result.routingDetail = request.Routing_Detail__c;
        result.submissionId = request.Id;
        result.status = request.Status__c;
        result.reason = request.Reason__c;
        result.personId = request.Contact__c != null ? request.Contact__c : request.Lead__c;
        result.personType = request.Person_Type__c;
        result.createdPerson = request.New_Person__c;
        result.ownerId = request.Follow_Up_Owner__c;
        if (result.ownerId != null) result.ownerName = [SELECT Name FROM User WHERE Id = :result.ownerId WITH USER_MODE LIMIT 1].Name;
        result.taskId = request.Task_Id__c;
        result.notificationStatus = request.Notification_Status__c;
        result.reusedRequest = reused;
        return result;
    }

    private static void normalizeAndValidate(Submission input) {
        if (input == null) throw new InvalidSubmissionException('Supply a demo request.');
        input.requestId = clean(input.requestId);
        input.firstName = clean(input.firstName);
        input.lastName = clean(input.lastName);
        input.email = clean(input.email).toLowerCase();
        input.phone = clean(input.phone);
        input.company = clean(input.company);
        input.source = clean(input.source);
        input.campaign = clean(input.campaign);
        if (!Pattern.matches('[A-Za-z0-9_-]{16,80}', input.requestId)) throw new InvalidSubmissionException('A stable request ID between 16 and 80 characters is required.');
        if (input.firstName == '' || input.firstName.length() > 40 || input.lastName == '' || input.lastName.length() > 80 ||
            input.company == '' || input.company.length() > 255 || input.phone.length() > 40 || input.source.length() > 128 || input.campaign.length() > 128 ||
            input.email.length() > 80 || !Pattern.matches('[^\\s@]+@[^\\s@]+\\.[^\\s@]+', input.email)) {
            throw new InvalidSubmissionException('Supply first name, last name, company, and a valid email within Salesforce field limits.');
        }
    }

    private static String clean(String value) { return value == null ? '' : value.trim(); }
    private static String digest(String value) { return EncodingUtil.convertToHex(Crypto.generateDigest('SHA-256', Blob.valueOf(value))); }
    private static void respond(Integer status, Object body) {
        RestContext.response.statusCode = status;
        RestContext.response.addHeader('Content-Type', 'application/json');
        RestContext.response.responseBody = Blob.valueOf(JSON.serialize(body));
    }
    public class InvalidSubmissionException extends Exception {}
    public class ConflictingRequestException extends Exception {}
    public class MissingPermissionException extends Exception {}
    private class NotificationFailureException extends Exception {}
}
