import { describe, expect, it } from 'vitest';
import { resolveDuplicateIdentities, type IdentityRecord } from '../lib/identity-resolution';

function person(overrides: Partial<IdentityRecord> & Pick<IdentityRecord, 'recordKey' | 'nativeId'>): IdentityRecord {
  return {
    connectorId: 'hubspot',
    objectType: 'contact',
    firstName: 'Alex',
    lastName: 'Chen',
    fullName: 'Alex Chen',
    email: '',
    company: 'Northstar Labs, Inc.',
    phone: '',
    jobTitle: '',
    website: 'https://northstar.example',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('explainable identity resolution', () => {
  it('finds corroborated duplicates and recommends the richer stable record', () => {
    const result = resolveDuplicateIdentities([
      person({ recordKey: 'salesforce:lead:1', nativeId: '1', connectorId: 'salesforce', objectType: 'lead', email: 'alex.old@northstar.example', phone: '(814) 555-0101' }),
      person({ recordKey: 'salesforce:contact:2', nativeId: '2', connectorId: 'salesforce', objectType: 'contact', email: 'alex@northstar.example', phone: '+1 814 555 0101', jobTitle: 'VP Revenue' }),
    ]);

    expect(result).toMatchObject({ recordsScanned: 2, clusterCount: 1, duplicateRecords: 1, highConfidenceClusters: 0, reviewClusters: 1 });
    expect(result.clusters[0].recommendedPrimaryKey).toBe('salesforce:contact:2');
    expect(result.clusters[0].members[1].evidence.map((item) => item.key)).toEqual(expect.arrayContaining(['phone', 'name', 'company', 'website_domain']));
    expect(result.clusters[0].fields.find((field) => field.field === 'jobTitle')).toMatchObject({ value: 'VP Revenue', sourceRecordKey: 'salesforce:contact:2' });
  });

  it('avoids an explicitly stale-looking email when choosing the survivor', () => {
    const result = resolveDuplicateIdentities([
      person({ recordKey: 'hubspot:contact:old', nativeId: 'old', email: 'alex.old@example.com', phone: '8145550101', jobTitle: 'Former revenue lead', createdAt: '2020-01-01T00:00:00.000Z' }),
      person({ recordKey: 'hubspot:contact:current', nativeId: 'current', email: 'alex@example.com', phone: '8145550101', jobTitle: 'VP Revenue', createdAt: '2025-01-01T00:00:00.000Z' }),
    ]);
    expect(result.clusters[0].recommendedPrimaryKey).toBe('hubspot:contact:current');
  });

  it('treats Gmail dots and plus tags as evidence only when identity is corroborated', () => {
    const result = resolveDuplicateIdentities([
      person({ recordKey: 'hubspot:contact:1', nativeId: '1', email: 'alex.chen+event@gmail.com' }),
      person({ recordKey: 'hubspot:contact:2', nativeId: '2', email: 'alexchen@gmail.com' }),
    ]);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].band).toBe('high_confidence');
    expect(result.clusters[0].members[1].evidence.map((item) => item.key)).toContain('email_alias');
  });

  it('does not match on a name and company alone', () => {
    const result = resolveDuplicateIdentities([
      person({ recordKey: 'hubspot:contact:1', nativeId: '1', email: 'alex@one.example', website: '' }),
      person({ recordKey: 'hubspot:contact:2', nativeId: '2', email: 'alex@two.example', website: '' }),
    ]);
    expect(result.clusterCount).toBe(0);
  });

  it('keeps same-name coworkers at one company in the possible-review lane', () => {
    const result = resolveDuplicateIdentities([
      person({ recordKey: 'hubspot:contact:1', nativeId: '1', email: 'alex.one@northstar.example' }),
      person({ recordKey: 'hubspot:contact:2', nativeId: '2', email: 'alex.two@northstar.example' }),
    ]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].band).toBe('possible');
  });

  it('does not bridge two anchored matches through weak organization evidence', () => {
    const result = resolveDuplicateIdentities([
      person({ recordKey: 'hubspot:contact:a', nativeId: 'a', email: 'shared@northstar.example', phone: '' }),
      person({ recordKey: 'hubspot:contact:b', nativeId: 'b', email: 'shared@northstar.example', phone: '8145550100' }),
      person({ recordKey: 'hubspot:contact:c', nativeId: 'c', email: 'other@northstar.example', phone: '8145550100' }),
    ]);
    expect(result.clusters.every((cluster) => cluster.members.length === 2)).toBe(true);
    expect(result.clusters.map((cluster) => cluster.members.map((member) => member.record.nativeId).sort()))
      .toEqual(expect.arrayContaining([['a', 'b'], ['b', 'c']]));
    expect(result.clusters.every((cluster) => cluster.ambiguousOverlap && cluster.band === 'review')).toBe(true);
    expect(result.clusters.every((cluster) => cluster.blockers.some((blocker) => blocker.includes('another candidate group')))).toBe(true);
  });

  it('does not strip plus tags for non-Gmail addresses', () => {
    const result = resolveDuplicateIdentities([
      person({ recordKey: 'hubspot:contact:1', nativeId: '1', email: 'alex+east@northstar.example', website: '' }),
      person({ recordKey: 'hubspot:contact:2', nativeId: '2', email: 'alex+west@northstar.example', website: '' }),
    ]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].band).toBe('possible');
    expect(result.clusters[0].members[1].evidence.map((item) => item.key)).not.toContain('email_alias');
  });

  it('rejects a shared generic inbox when the people conflict', () => {
    const result = resolveDuplicateIdentities([
      person({ recordKey: 'hubspot:contact:1', nativeId: '1', firstName: 'Alex', lastName: 'Chen', fullName: 'Alex Chen', email: 'sales@northstar.example', phone: '' }),
      person({ recordKey: 'hubspot:contact:2', nativeId: '2', firstName: 'Priya', lastName: 'Patel', fullName: 'Priya Patel', email: 'sales@northstar.example', phone: '' }),
    ]);
    expect(result.clusterCount).toBe(0);
  });

  it('down-weights a phone shared across many records', () => {
    const records = ['Alex Chen', 'Alex Chen', 'Alex Chen', 'Alex Chen'].map((name, index) => {
      const [firstName, lastName] = name.split(' ');
      return person({
        recordKey: `hubspot:contact:${index}`,
        nativeId: String(index),
        firstName,
        lastName,
        fullName: name,
        email: `alex${index}@northstar.example`,
        phone: '+1 814 555 0199',
        website: '',
      });
    });
    const result = resolveDuplicateIdentities(records);
    expect(result.highConfidenceClusters).toBe(0);
    expect(result.clusters.every((cluster) => cluster.members.some((member) => member.evidence.some((item) => item.key === 'phone' && item.tone === 'warning')))).toBe(true);
  });

  it('uses a uniquely shared mobile instead of a ubiquitous switchboard', () => {
    const records = [
      person({ recordKey: 'hubspot:contact:a', nativeId: 'a', phone: '8145550199', secondaryPhone: '8145550101' }),
      person({ recordKey: 'hubspot:contact:b', nativeId: 'b', phone: '8145550199', secondaryPhone: '8145550101' }),
      person({ recordKey: 'hubspot:contact:c', nativeId: 'c', firstName: 'Priya', lastName: 'Patel', fullName: 'Priya Patel', email: 'priya@example.com', phone: '8145550199' }),
      person({ recordKey: 'hubspot:contact:d', nativeId: 'd', firstName: 'Morgan', lastName: 'Lee', fullName: 'Morgan Lee', email: 'morgan@example.com', phone: '8145550199' }),
    ];
    const result = resolveDuplicateIdentities(records);
    const match = result.clusters.find((cluster) => cluster.members.some((member) => member.record.nativeId === 'a'));
    expect(match).toMatchObject({ band: 'high_confidence', ambiguousOverlap: false });
    expect(match?.members.find((member) => member.record.nativeId === 'b')?.evidence)
      .toContainEqual(expect.objectContaining({ key: 'phone', label: 'Exact normalized phone', tone: 'strong' }));
  });

  it('returns stable cluster signatures regardless of source order', () => {
    const records = [
      person({ recordKey: 'hubspot:contact:a', nativeId: 'a', email: 'a@northstar.example', phone: '8145550100' }),
      person({ recordKey: 'hubspot:contact:b', nativeId: 'b', email: 'b@northstar.example', phone: '8145550100' }),
    ];
    expect(resolveDuplicateIdentities(records).clusters[0].clusterId)
      .toBe(resolveDuplicateIdentities([...records].reverse()).clusters[0].clusterId);
  });

  it('uses a secondary phone and flags Salesforce Lead-to-Contact cleanup', () => {
    const result = resolveDuplicateIdentities([
      person({ recordKey: 'salesforce:lead:1', nativeId: '1', connectorId: 'salesforce', objectType: 'lead', phone: '8145550100' }),
      person({ recordKey: 'salesforce:contact:2', nativeId: '2', connectorId: 'salesforce', objectType: 'contact', phone: '8145550999', secondaryPhone: '+1 814 555 0100' }),
    ]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].members[1].evidence.map((item) => item.key)).toContain('phone');
    expect(result.clusters[0]).toMatchObject({ band: 'review', actionability: 'cross_object_review' });
    expect(result.clusters[0].fields.find((field) => field.field === 'secondaryPhone')).toMatchObject({ value: '+1 814 555 0100' });
  });

  it('always recommends a Salesforce Contact over a richer Lead in a cross-object group', () => {
    const result = resolveDuplicateIdentities([
      person({
        recordKey: 'salesforce:lead:rich', nativeId: 'rich', connectorId: 'salesforce', objectType: 'lead',
        email: 'alex@northstar.example', phone: '8145550100', jobTitle: 'VP Revenue', website: 'https://northstar.example',
      }),
      person({
        recordKey: 'salesforce:contact:sparse', nativeId: 'sparse', connectorId: 'salesforce', objectType: 'contact',
        email: 'alex@northstar.example', company: '', phone: '', jobTitle: '', website: '',
      }),
    ]);
    expect(result.clusters[0].recommendedPrimaryKey).toBe('salesforce:contact:sparse');
    expect(result.clusters[0].fields.find((field) => field.field === 'jobTitle')).toMatchObject({ value: 'VP Revenue', sourceRecordKey: 'salesforce:lead:rich' });
  });

  it('retains non-Latin names when generating identity candidates', () => {
    const result = resolveDuplicateIdentities([
      person({ recordKey: 'hubspot:contact:1', nativeId: '1', firstName: '小明', lastName: '王', fullName: '王 小明', email: 'ming.one@example.cn', company: '北星科技', website: 'https://example.cn' }),
      person({ recordKey: 'hubspot:contact:2', nativeId: '2', firstName: '小明', lastName: '王', fullName: '王 小明', email: 'ming.two@example.cn', company: '北星科技', website: 'https://example.cn' }),
    ]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].band).toBe('possible');
  });

  it('resolves a 25,000-record account without pairwise account scans', () => {
    const records = Array.from({ length: 25_000 }, (_, index) => {
      const group = Math.floor(index / 2);
      return person({
        recordKey: `hubspot:contact:scale-${index}`,
        nativeId: `scale-${index}`,
        firstName: `Person ${group}`,
        lastName: 'Scale',
        fullName: `Person ${group} Scale`,
        email: `person-${group}@scale.example`,
        company: `Account ${group}`,
        website: `https://account-${group}.example`,
      });
    });
    const result = resolveDuplicateIdentities(records);
    expect(result).toMatchObject({ recordsScanned: 25_000, clusterCount: 12_500, duplicateRecords: 12_500 });
  }, 15_000);

  it('does not generate a quadratic candidate set from shared switchboards', () => {
    const records = Array.from({ length: 5_000 }, (_, index) => person({
      recordKey: `hubspot:contact:switchboard-${index}`,
      nativeId: `switchboard-${index}`,
      firstName: `Person ${index}`,
      lastName: `Unique ${index}`,
      fullName: `Person ${index} Unique ${index}`,
      email: `person-${index}@company-${index}.example`,
      company: `Company ${index}`,
      phone: `814555${String(Math.floor(index / 100)).padStart(4, '0')}`,
      website: `https://company-${index}.example`,
    }));
    const result = resolveDuplicateIdentities(records);
    expect(result).toMatchObject({ recordsScanned: 5_000, candidatesCompared: 0, clusterCount: 0 });
    expect(result.analysisWarnings.some((warning) => warning.includes('used only as context'))).toBe(true);
  }, 15_000);

  it('does not silently drop an exact email repeated on more than 100 records', () => {
    const records = Array.from({ length: 101 }, (_, index) => person({
      recordKey: `hubspot:contact:shared-${index}`,
      nativeId: `shared-${index}`,
      email: 'one-person@northstar.example',
      firstName: 'Alex',
      lastName: 'Chen',
      fullName: 'Alex Chen',
    }));
    const result = resolveDuplicateIdentities(records);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].members).toHaveLength(101);
  });
});
