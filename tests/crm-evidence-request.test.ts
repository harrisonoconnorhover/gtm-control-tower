import { describe, expect, it } from 'vitest';
import { blankCrmEvidenceResult, createCrmEvidenceRequest, createCrmEvidenceResult, crmEvidenceSourceSupportsField, parseCrmEvidenceRequest, parseCrmEvidenceResult, type CrmEvidenceItem, type CrmEvidenceRequest } from '../lib/crm-evidence-request';
import { fictionalCrmCohortRequest } from '../lib/crm-cohort-fixture';
import requestExample from './fixtures/crm-evidence/request.json';
import resultExample from './fixtures/crm-evidence/result.json';

async function changedRequest(change: (request: CrmEvidenceRequest) => void) {
  const request = await fictionalCrmCohortRequest();
  change(request);
  const { kind: _kind, schemaVersion: _version, contentDigest: _digest, ...body } = request;
  void _kind; void _version; void _digest;
  return createCrmEvidenceRequest(body);
}

describe('CRM-only request/result files', () => {
  it('accepts the portable fictional examples used by both applications', async () => {
    const request = await parseCrmEvidenceRequest(requestExample);
    expect(request).toEqual(await fictionalCrmCohortRequest());
    const result = await parseCrmEvidenceResult(resultExample, request);
    expect(result.contacts[0].fields[0]).toMatchObject({ status: 'supported', value: 'Revenue Operations Director' });
    expect(result.contacts.find((row) => row.contactId === '102')!.fields[0].status).toBe('conflicting');
  });
  it('roundtrips exact native identities, evidence and every requested field without approvals', async () => {
    const request = await fictionalCrmCohortRequest();
    expect(await parseCrmEvidenceRequest(JSON.stringify(request))).toEqual(request);
    const result = await blankCrmEvidenceResult(request);
    result.contacts[0].fields[0] = { field: 'jobTitle', status: 'supported', value: 'Revenue Operations Director',
      rationale: 'Recorded title in the contact-specific CRM note; current employment still needs review.',
      evidence: [{ sourceId: 'note-101', quote: 'Maya Stone is Revenue Operations Director at Northstar Demo.' }] };
    expect(await parseCrmEvidenceResult(result, request)).toEqual(result);
    expect(result.contacts).toHaveLength(request.contacts.length);
    expect(result.contacts[1].fields[0].status).toBe('not_run');
    expect(result).not.toHaveProperty('approved');
    expect(result).not.toHaveProperty('allowCreate');
  });

  it('rejects edits to the snapshot rather than accepting a stale consistency digest', async () => {
    const request = await fictionalCrmCohortRequest();
    request.contacts[0].evidence[0].text = 'Edited after export';
    await expect(parseCrmEvidenceRequest(request)).rejects.toThrow('digest');
  });

  it('rejects wrong request, portal, native identity and missing rows', async () => {
    const request = await fictionalCrmCohortRequest();
    for (const key of ['requestId', 'requestDigest', 'portalId'] as const) {
      const result = await blankCrmEvidenceResult(request);
      result[key] = 'wrong';
      await expect(parseCrmEvidenceResult(result, request)).rejects.toThrow('match');
    }
    const unknown = await blankCrmEvidenceResult(request);
    unknown.contacts[0].contactId = 'unrequested';
    await expect(parseCrmEvidenceResult(unknown, request)).rejects.toThrow('native contact');
    const missing = await blankCrmEvidenceResult(request);
    missing.contacts.pop();
    await expect(parseCrmEvidenceResult(missing, request)).rejects.toThrow('every requested contact');
  });

  it('requires explicit outcomes for missing fields and rejects populated or unsupported targets', async () => {
    const request = await fictionalCrmCohortRequest();
    const result = await blankCrmEvidenceResult(request);
    result.contacts[0].fields = [];
    await expect(parseCrmEvidenceResult(result, request)).rejects.toThrow('Every requested field');
    const unsupported = await blankCrmEvidenceResult(request);
    (unsupported.contacts[0].fields[0] as { field: string }).field = 'email';
    await expect(parseCrmEvidenceResult(unsupported, request)).rejects.toThrow('unrequested');
    await expect(changedRequest((input) => { input.contacts[0].existingValues.jobTitle = 'Existing title'; })).rejects.toThrow('populated field');
  });

  it('rejects forged excerpts, unknown sources and unattributed person facts', async () => {
    const request = await fictionalCrmCohortRequest();
    const result = await blankCrmEvidenceResult(request);
    const outcome = result.contacts[0].fields[0];
    Object.assign(outcome, { status: 'supported', value: 'CEO', evidence: [{ sourceId: 'note-101', quote: 'Maya is CEO' }] });
    await expect(parseCrmEvidenceResult(result, request)).rejects.toThrow('exact excerpt');
    outcome.evidence = [{ sourceId: 'invented', quote: 'Maya' }];
    await expect(parseCrmEvidenceResult(result, request)).rejects.toThrow('exact excerpt');
    const unassigned = await blankCrmEvidenceResult(request);
    const unknown = unassigned.contacts.find((row) => row.contactId === '106')!;
    unknown.fields[0] = { field: 'jobTitle', status: 'supported', value: 'Finance Director', rationale: 'A company note', evidence: [{ sourceId: 'company-context', quote: 'Someone at Northstar Demo is a finance director.' }] };
    await expect(parseCrmEvidenceResult(unassigned, request)).rejects.toThrow('attributed');
  });

  it('supports company facts only from one matching associated company and never treats company facts as person facts', async () => {
    const request = await fictionalCrmCohortRequest();
    const contact = request.contacts[0];
    const company: CrmEvidenceItem = { id: 'company-name', objectType: 'company', recordId: 'company-northstar', property: 'name', noteId: null,
      text: 'Northstar Demo', eventAt: null, retrievedAt: request.createdAt, contactIds: [], url: null };
    expect(crmEvidenceSourceSupportsField('company', company, contact)).toBe(true);
    expect(crmEvidenceSourceSupportsField('website', company, contact)).toBe(true);
    company.contactIds = [contact.contactId];
    expect(crmEvidenceSourceSupportsField('jobTitle', company, contact)).toBe(false);
    expect(crmEvidenceSourceSupportsField('phone', company, contact)).toBe(false);
    contact.companyIds.push('another-company');
    expect(crmEvidenceSourceSupportsField('company', company, contact)).toBe(false);
    expect(crmEvidenceSourceSupportsField('company', contact.evidence[0], contact)).toBe(true);
  });

  it('preserves conflicts and unknowns without inventing proposed values', async () => {
    const request = await fictionalCrmCohortRequest();
    const result = await blankCrmEvidenceResult(request);
    const conflict = result.contacts.find((row) => row.contactId === '102')!.fields[0];
    Object.assign(conflict, { status: 'conflicting', rationale: 'Two notes disagree and provide no role-effective dates.',
      evidence: [{ sourceId: 'note-102-a', quote: 'Devon Brooks introduced themself as Sales Operations Manager.' },
        { sourceId: 'note-102-b', quote: 'Devon Brooks introduced themself as Revenue Operations Director.' }] });
    await expect(createCrmEvidenceResult(request, result.contacts)).resolves.toMatchObject({ contacts: expect.any(Array) });
    conflict.value = 'Chosen without resolving conflict';
    await expect(parseCrmEvidenceResult(result, request)).rejects.toThrow('Only supported');
  });

  it('rejects unsupported controls, versions, duplicate identities and false complete coverage', async () => {
    const request = await fictionalCrmCohortRequest();
    await expect(parseCrmEvidenceRequest({ ...request, approved: true })).rejects.toThrow('unsupported fields');
    await expect(parseCrmEvidenceRequest({ ...request, schemaVersion: 2 })).rejects.toThrow('version 1');
    await expect(changedRequest((input) => { input.contacts[1].contactId = input.contacts[0].contactId; })).rejects.toThrow('unique native');
    await expect(changedRequest((input) => { input.contacts[0].coverage.missing = ['Unreadable notes']; })).rejects.toThrow('cannot be complete');
  });

  it('enforces 100 contacts, 10k evidence characters and 2 MiB without truncation', async () => {
    await expect(changedRequest((input) => {
      input.contacts = Array.from({ length: 101 }, (_, i) => ({ ...structuredClone(input.contacts[0]), contactId: String(i) }));
    })).rejects.toThrow('1–100');
    await expect(changedRequest((input) => { input.contacts[0].evidence[0].text = 'x'.repeat(10_001); })).rejects.toThrow('invalid identity, text or dates');
    await expect(parseCrmEvidenceRequest('x'.repeat(2 * 1024 * 1024 + 1))).rejects.toThrow('2 MiB');
  });
});
