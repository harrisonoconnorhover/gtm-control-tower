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
    }

    @HttpGet
    global static void health() {
        if (!FeatureManagement.checkPermission('GTM_Submit_Demo_Requests')) {
            respond(403, new Map<String, Object>{'error' => 'The integration needs Submit Demo Requests permission.'});
            return;
        }
        respond(200, new Map<String, Object>{'ready' => true, 'version' => 1});
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

        String payloadHash = digest(JSON.serialize(new List<String>{
            input.firstName, input.lastName, input.email, input.phone, input.company, input.source, input.campaign
        }));
        List<GTM_Demo_Request__c> requests = [
            SELECT Id, Request_Key__c, Payload_Hash__c, Status__c, Reason__c, Lead__c, Contact__c,
                Person_Type__c, New_Person__c, Task_Id__c, Notification_Status__c, Follow_Up_Owner__c,
                Received_At__c, First_Name__c, Last_Name__c, Email__c, Company__c, Source__c, Campaign__c
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
            if (request.Task_Id__c != null) {
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

        List<Contact> contacts = [
            SELECT Id, OwnerId, GTM_Last_Demo_Requested_At__c FROM Contact
            WHERE Email = :input.email WITH USER_MODE LIMIT 2 FOR UPDATE
        ];
        List<Lead> leads = [
            SELECT Id, OwnerId, GTM_Last_Demo_Requested_At__c FROM Lead
            WHERE Email = :input.email AND IsConverted = false WITH USER_MODE LIMIT 2 FOR UPDATE
        ];
        if (contacts.size() + leads.size() > 1) {
            request.Status__c = 'Held';
            request.Reason__c = 'Multiple Contacts or unconverted Leads share this email. Review the matches before creating a person or follow-up.';
            update as user request;
            return receipt(request, reused);
        }

        Id ownerId;
        Datetime lastRequestAt;
        if (!contacts.isEmpty()) {
            Contact person = contacts[0];
            request.Contact__c = person.Id;
            request.Lead__c = null;
            request.Person_Type__c = 'Contact';
            ownerId = person.OwnerId;
            lastRequestAt = person.GTM_Last_Demo_Requested_At__c;
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
            update as user request;
            return receipt(request, reused);
        }
        request.Follow_Up_Owner__c = ownerId;
        Id personId = request.Contact__c != null ? request.Contact__c : request.Lead__c;
        Task followUp = new Task(
            Subject = 'Demo requested - ' + input.firstName + ' ' + input.lastName,
            WhoId = personId, OwnerId = ownerId, Status = 'Not Started', Priority = 'High', ActivityDate = Date.today(),
            Description = 'Demo form submitted at ' + String.valueOf(request.Received_At__c) + ' UTC.\n' +
                'Company: ' + input.company + '\nSource: ' + input.source + '\nCampaign: ' + input.campaign +
                '\nRequest ID: ' + input.requestId
        );
        insert as user followUp;
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
