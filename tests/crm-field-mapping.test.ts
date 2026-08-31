import { describe, expect, it } from 'vitest';
import { toHubSpotFieldPayload, toSalesforceFieldPayload } from '../lib/crm-field-mapping';

const fields = {
  firstName: 'Alex',
  lastName: 'Chen',
  company: 'Northstar',
  phone: '8145550100',
  jobTitle: 'Revenue Operations',
  website: 'https://northstar.example',
};

describe('CRM field payloads', () => {
  it('limits HubSpot rollback payloads to fields changed by the governed write', () => {
    expect(toHubSpotFieldPayload(fields, ['jobTitle'])).toEqual({ jobtitle: 'Revenue Operations' });
  });

  it('limits Salesforce rollback payloads to fields changed by the governed write', () => {
    expect(toSalesforceFieldPayload(fields, ['company', 'phone'])).toEqual({ Company: 'Northstar', Phone: '8145550100' });
  });
});
