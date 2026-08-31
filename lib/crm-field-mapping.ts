import { portableCrmFieldNames, type NativeCrmRecord, type PortableCrmFieldName } from './crm-workflow';

const hubSpotNames: Record<PortableCrmFieldName, string> = {
  firstName: 'firstname',
  lastName: 'lastname',
  company: 'company',
  phone: 'phone',
  jobTitle: 'jobtitle',
  website: 'website',
};

const salesforceNames: Record<PortableCrmFieldName, string> = {
  firstName: 'FirstName',
  lastName: 'LastName',
  company: 'Company',
  phone: 'Phone',
  jobTitle: 'Title',
  website: 'Website',
};

export function toHubSpotFieldPayload(fields: NativeCrmRecord['fields'], included: PortableCrmFieldName[] = [...portableCrmFieldNames]) {
  return Object.fromEntries(included.map((field) => [hubSpotNames[field], fields[field] ?? '']));
}

export function toSalesforceFieldPayload(fields: NativeCrmRecord['fields'], included: PortableCrmFieldName[] = [...portableCrmFieldNames]) {
  return Object.fromEntries(included.map((field) => [salesforceNames[field], fields[field] ?? null]));
}
