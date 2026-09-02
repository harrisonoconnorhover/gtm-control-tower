public with sharing class GTMLeadTriageAction {
    private static final Integer EMAIL_POINTS = 30;
    private static final Integer COMPANY_POINTS = 20;
    private static final Integer LAST_NAME_POINTS = 10;
    private static final Integer TITLE_POINTS = 15;
    private static final Integer PHONE_POINTS = 10;
    private static final Integer WEBSITE_POINTS = 10;
    private static final Integer LEAD_SOURCE_POINTS = 5;

    @InvocableMethod(
        label='Preview GTM Lead Triage'
        description='Read-only data-readiness check for one or more Salesforce Leads. Returns a score, queue recommendation, and explanation without changing records.'
    )
    public static List<Result> preview(List<Request> requests) {
        List<Request> safeRequests = requests == null ? new List<Request>() : requests;
        Set<Id> leadIds = new Set<Id>();
        for (Request request : safeRequests) {
            if (request != null && request.leadId != null && request.leadId.getSObjectType() == Lead.SObjectType) {
                leadIds.add(request.leadId);
            }
        }

        Map<Id, Lead> leadsById = new Map<Id, Lead>();
        if (!leadIds.isEmpty()) {
            leadsById = new Map<Id, Lead>([
                SELECT Id, Email, LastName, Company, Phone, Website, Title, LeadSource
                FROM Lead
                WHERE Id IN :leadIds
            ]);
        }

        List<Result> results = new List<Result>();
        for (Request request : safeRequests) {
            Lead leadRecord = request == null ? null : leadsById.get(request.leadId);
            results.add(leadRecord == null ? missingLeadResult(request) : triage(leadRecord));
        }
        return results;
    }

    private static Result triage(Lead leadRecord) {
        Boolean emailReady = isUsableEmail(leadRecord.Email);
        Boolean companyReady = !String.isBlank(leadRecord.Company);
        Boolean lastNameReady = !String.isBlank(leadRecord.LastName);
        Integer score = 0;
        score += emailReady ? EMAIL_POINTS : 0;
        score += companyReady ? COMPANY_POINTS : 0;
        score += lastNameReady ? LAST_NAME_POINTS : 0;
        score += !String.isBlank(leadRecord.Title) ? TITLE_POINTS : 0;
        score += !String.isBlank(leadRecord.Phone) ? PHONE_POINTS : 0;
        score += !String.isBlank(leadRecord.Website) ? WEBSITE_POINTS : 0;
        score += !String.isBlank(leadRecord.LeadSource) ? LEAD_SOURCE_POINTS : 0;

        Result result = new Result();
        result.leadId = leadRecord.Id;
        result.eligible = emailReady && companyReady && lastNameReady;
        result.readinessScore = score;
        if (!result.eligible) {
            result.recommendedQueue = 'HOLD_DATA_QUALITY';
            List<String> blockers = new List<String>();
            if (!emailReady) blockers.add('a usable email');
            if (!companyReady) blockers.add('company');
            if (!lastNameReady) blockers.add('last name');
            result.explanation = 'Held because the Lead is missing ' + String.join(blockers, ', ') +
                '. Data-readiness score: ' + score + '/100.';
        } else {
            result.recommendedQueue = score >= 75 ? 'PRIORITY_REVIEW' : 'STANDARD_REVIEW';
            result.explanation = 'Ready for governed routing review. Data-readiness score: ' + score +
                '/100. Recommended queue: ' + result.recommendedQueue + '.';
        }
        return result;
    }

    private static Result missingLeadResult(Request request) {
        Result result = new Result();
        result.leadId = request == null ? null : request.leadId;
        result.eligible = false;
        result.readinessScore = 0;
        result.recommendedQueue = 'HOLD_NOT_FOUND';
        result.explanation = 'No accessible Salesforce Lead was found for the supplied record ID.';
        return result;
    }

    private static Boolean isUsableEmail(String value) {
        if (String.isBlank(value)) return false;
        Integer atIndex = value.indexOf('@');
        Integer dotIndex = value.lastIndexOf('.');
        return atIndex > 0 && dotIndex > atIndex + 1 && dotIndex < value.length() - 1;
    }

    public class Request {
        @InvocableVariable(
            required=true
            label='Lead ID'
            description='The Salesforce Lead ID to inspect.'
        )
        public Id leadId;
    }

    public class Result {
        @InvocableVariable(label='Lead ID')
        public Id leadId;

        @InvocableVariable(label='Eligible for routing review')
        public Boolean eligible;

        @InvocableVariable(label='Data-readiness score')
        public Integer readinessScore;

        @InvocableVariable(label='Recommended queue')
        public String recommendedQueue;

        @InvocableVariable(label='Explanation')
        public String explanation;
    }
}
