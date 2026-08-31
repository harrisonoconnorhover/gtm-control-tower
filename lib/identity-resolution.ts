export const IDENTITY_RULE_VERSION = 'identity-v3';

export type IdentityConnector = 'hubspot' | 'salesforce';
export type IdentityObjectType = 'contact' | 'lead';

export type IdentityRecord = {
  recordKey: string;
  connectorId: IdentityConnector;
  objectType: IdentityObjectType;
  nativeId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  company: string;
  phone: string;
  secondaryPhone?: string;
  jobTitle: string;
  website: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type MatchEvidence = {
  key: string;
  label: string;
  weight: number;
  tone: 'strong' | 'supporting' | 'conflict' | 'warning';
};

export type ClusterMember = {
  record: IdentityRecord;
  scoreToPrimary: number;
  evidence: MatchEvidence[];
};

export type FieldResolution = {
  field: 'firstName' | 'lastName' | 'email' | 'company' | 'phone' | 'secondaryPhone' | 'jobTitle' | 'website';
  value: string;
  sourceRecordKey: string;
  conflicting: boolean;
};

export type DuplicateCluster = {
  clusterId: string;
  confidence: number;
  band: 'high_confidence' | 'review' | 'possible';
  recommendedPrimaryKey: string;
  primaryReason: string;
  members: ClusterMember[];
  fields: FieldResolution[];
  actionability: 'same_object_review' | 'cross_object_review';
  ambiguousOverlap: boolean;
  blockers: string[];
};

export type DuplicateScanResult = {
  ruleVersion: typeof IDENTITY_RULE_VERSION;
  recordsScanned: number;
  candidatesCompared: number;
  clusterCount: number;
  duplicateRecords: number;
  highConfidenceClusters: number;
  reviewClusters: number;
  possibleClusters: number;
  analysisWarnings: string[];
  clusters: DuplicateCluster[];
};

type NormalizedIdentity = {
  email: string | null;
  emailAlias: string | null;
  emailDomain: string | null;
  genericInbox: boolean;
  phones: string[];
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  websiteDomain: string | null;
};

type PairMatch = {
  leftKey: string;
  rightKey: string;
  score: number;
  band: DuplicateCluster['band'];
  evidence: MatchEvidence[];
};

const genericInboxNames = new Set(['admin', 'billing', 'contact', 'hello', 'help', 'info', 'office', 'sales', 'support', 'team']);
const freeEmailDomains = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'icloud.com', 'live.com', 'outlook.com', 'yahoo.com']);
const companySuffixes = new Set(['co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'llc', 'llp', 'ltd', 'limited', 'plc']);
const namePrefixes = new Set(['dr', 'miss', 'mr', 'mrs', 'ms', 'prof']);
const nameSuffixes = new Set(['ii', 'iii', 'iv', 'jr', 'phd', 'sr']);
const fieldNames: FieldResolution['field'][] = ['firstName', 'lastName', 'email', 'company', 'phone', 'secondaryPhone', 'jobTitle', 'website'];

export function resolveDuplicateIdentities(records: IdentityRecord[]): DuplicateScanResult {
  const stableRecords = [...records].sort((left, right) => left.recordKey.localeCompare(right.recordKey));
  const recordsByKey = new Map(stableRecords.map((record) => [record.recordKey, record]));
  const normalized = new Map(stableRecords.map((record) => [record.recordKey, normalizeIdentity(record)]));
  const phoneFrequency = frequencyMany(normalized.values(), (identity) => identity.phones);
  const candidates = buildCandidatePairs(stableRecords, normalized, phoneFrequency);
  const candidateKeys = candidates.pairs;
  const pairMatches = candidateKeys.flatMap((pair): PairMatch[] => {
    const [leftKey, rightKey] = pair.split('\u0000');
    const left = recordsByKey.get(leftKey);
    const right = recordsByKey.get(rightKey);
    if (!left || !right) return [];
    const match = scorePair(left, right, normalized.get(leftKey)!, normalized.get(rightKey)!, phoneFrequency);
    return match && match.score >= 60 ? [match] : [];
  }).sort((left, right) => right.score - left.score || pairKey(left.leftKey, left.rightKey).localeCompare(pairKey(right.leftKey, right.rightKey)));

  const pairMap = new Map(pairMatches.flatMap((pair) => [
    [pairKey(pair.leftKey, pair.rightKey), pair],
    [pairKey(pair.rightKey, pair.leftKey), pair],
  ]));
  const rawClusters = clusterCliquePairs(stableRecords, pairMatches);
  const clusterMembershipCounts = frequencyMany(rawClusters, (members) => members.map((record) => record.recordKey));
  const clusters = rawClusters.map((members) => {
    const relevantPairs = memberPairs(members).flatMap(([left, right]) => {
      const pair = pairMap.get(pairKey(left.recordKey, right.recordKey));
      return pair ? [pair] : [];
    });
    const confidence = Math.min(...relevantPairs.map((pair) => pair.score));
    const crossesSalesforceObjects = members.some((record) => record.connectorId === 'salesforce' && record.objectType === 'lead')
      && members.some((record) => record.connectorId === 'salesforce' && record.objectType === 'contact');
    const ambiguousOverlap = members.some((record) => (clusterMembershipCounts.get(record.recordKey) ?? 0) > 1);
    const primary = [...members].sort((left, right) => compareCanonicalCandidates(left, right, crossesSalesforceObjects))[0];
    const rawBand = bandForCluster(confidence, relevantPairs);
    const band = (crossesSalesforceObjects || ambiguousOverlap) && rawBand === 'high_confidence' ? 'review' : rawBand;
    return {
      clusterId: stableHash(members.map((record) => record.recordKey).sort().join('|')),
      confidence,
      band,
      recommendedPrimaryKey: primary.recordKey,
      primaryReason: canonicalReason(primary),
      members: [primary, ...members.filter((record) => record.recordKey !== primary.recordKey)]
        .map((record): ClusterMember => {
          if (record.recordKey === primary.recordKey) return { record, scoreToPrimary: 100, evidence: [] };
          const pair = pairMap.get(pairKey(primary.recordKey, record.recordKey));
          return { record, scoreToPrimary: pair?.score ?? 0, evidence: pair?.evidence ?? [] };
        }),
      fields: resolveFields(primary, members),
      actionability: crossesSalesforceObjects ? 'cross_object_review' : 'same_object_review',
      ambiguousOverlap,
      blockers: [
        ...(ambiguousOverlap ? ['A record appears in another candidate group. Dismiss the competing group before approving this cleanup plan.'] : []),
        ...(crossesSalesforceObjects
          ? ['Salesforce Lead and Contact records need a conversion or manual cleanup plan; they are not a same-object merge.']
          : ['Native CRM merge is intentionally not automatic; approve the primary and field recovery plan first.']),
      ],
    } satisfies DuplicateCluster;
  }).sort((left, right) => bandRank(left.band) - bandRank(right.band) || right.confidence - left.confidence || left.clusterId.localeCompare(right.clusterId));

  return {
    ruleVersion: IDENTITY_RULE_VERSION,
    recordsScanned: stableRecords.length,
    candidatesCompared: candidateKeys.length,
    clusterCount: clusters.length,
    duplicateRecords: clusters.reduce((total, cluster) => total + cluster.members.length - 1, 0),
    highConfidenceClusters: clusters.filter((cluster) => cluster.band === 'high_confidence').length,
    reviewClusters: clusters.filter((cluster) => cluster.band === 'review').length,
    possibleClusters: clusters.filter((cluster) => cluster.band === 'possible').length,
    analysisWarnings: candidates.warnings,
    clusters,
  };
}

function buildCandidatePairs(
  records: IdentityRecord[],
  normalized: Map<string, NormalizedIdentity>,
  phoneFrequency: Map<string, number>,
): { pairs: string[]; warnings: string[] } {
  const buckets = new Map<string, string[]>();
  const add = (key: string | null, recordKey: string) => {
    if (!key) return;
    const values = buckets.get(key) ?? [];
    values.push(recordKey);
    buckets.set(key, values);
  };
  for (const record of records) {
    const identity = normalized.get(record.recordKey)!;
    add(identity.email && `email:${identity.email}`, record.recordKey);
    add(identity.emailAlias && `alias:${identity.emailAlias}`, record.recordKey);
    for (const phone of identity.phones) {
      if ((phoneFrequency.get(phone) ?? 0) <= 3) add(`phone:${phone}`, record.recordKey);
    }
    add(identity.name && identity.company && `name-company:${identity.name}:${identity.company}`, record.recordKey);
    add(identity.name && identity.websiteDomain && `name-domain:${identity.name}:${identity.websiteDomain}`, record.recordKey);
    add(identity.lastName && identity.emailDomain && `surname-domain:${identity.lastName}:${identity.emailDomain}`, record.recordKey);
    add(identity.company && identity.firstName && identity.lastName && `loose:${identity.company}:${identity.firstName[0]}:${identity.lastName[0]}`, record.recordKey);
  }
  const pairs = new Set<string>();
  let highFrequencyExactGroups = 0;
  let skippedBroadGroups = 0;
  const highFrequencyPhoneGroups = [...phoneFrequency.values()].filter((count) => count > 3).length;
  for (const [bucket, keys] of buckets) {
    const uniqueKeys = [...new Set(keys)].sort();
    if (uniqueKeys.length < 2) continue;
    const exactIdentifier = bucket.startsWith('email:') || bucket.startsWith('alias:');
    if (uniqueKeys.length > 100 && !exactIdentifier) {
      skippedBroadGroups += 1;
      continue;
    }
    if (uniqueKeys.length > 500) {
      highFrequencyExactGroups += 1;
      for (let index = 1; index < uniqueKeys.length; index += 1) pairs.add(pairKey(uniqueKeys[0], uniqueKeys[index]));
      continue;
    }
    for (let left = 0; left < uniqueKeys.length; left += 1) {
      for (let right = left + 1; right < uniqueKeys.length; right += 1) pairs.add(pairKey(uniqueKeys[left], uniqueKeys[right]));
    }
  }
  const warnings = [
    ...(highFrequencyPhoneGroups
      ? [`${highFrequencyPhoneGroups} phone value${highFrequencyPhoneGroups === 1 ? '' : 's'} appeared on more than 3 records and was used only as context, not as a candidate generator.`]
      : []),
    ...(highFrequencyExactGroups ? [`${highFrequencyExactGroups} exact identifier group${highFrequencyExactGroups === 1 ? '' : 's'} exceeded 500 records and was split into pairwise review candidates instead of one automatic merge.`] : []),
    ...(skippedBroadGroups ? [`${skippedBroadGroups} broad fuzzy or shared-phone group${skippedBroadGroups === 1 ? '' : 's'} exceeded 100 records and was excluded from matching to prevent false positives.`] : []),
  ];
  return { pairs: [...pairs].sort(), warnings };
}

function scorePair(
  left: IdentityRecord,
  right: IdentityRecord,
  a: NormalizedIdentity,
  b: NormalizedIdentity,
  phoneFrequency: Map<string, number>,
): PairMatch | null {
  const evidence: MatchEvidence[] = [];
  const add = (key: string, label: string, weight: number, tone: MatchEvidence['tone']) => evidence.push({ key, label, weight, tone });

  if (a.email && a.email === b.email) add('exact_email', a.genericInbox || b.genericInbox ? 'Same generic inbox' : 'Exact normalized email', a.genericInbox || b.genericInbox ? 40 : 96, a.genericInbox || b.genericInbox ? 'warning' : 'strong');
  else if (a.emailAlias && a.emailAlias === b.emailAlias) add('email_alias', 'Same email alias family', a.emailAlias.endsWith('@gmail.com') ? 72 : 55, 'supporting');
  const sharedPhone = a.phones.filter((phone) => b.phones.includes(phone))
    .sort((leftPhone, rightPhone) => (phoneFrequency.get(leftPhone) ?? 0) - (phoneFrequency.get(rightPhone) ?? 0)
      || leftPhone.localeCompare(rightPhone))[0];
  if (sharedPhone) {
    const uses = phoneFrequency.get(sharedPhone) ?? 0;
    add('phone', uses > 3 ? `Shared phone appears on ${uses} records` : 'Exact normalized phone', uses > 3 ? 16 : 54, uses > 3 ? 'warning' : 'strong');
  }
  if (a.name && a.name === b.name) add('name', 'Exact normalized name', 34, 'strong');
  else if (compatibleNames(a, b)) add('name_compatible', 'Compatible first and last name', 22, 'supporting');
  if (a.company && a.company === b.company) add('company', 'Same normalized company', 18, 'supporting');
  if (a.websiteDomain && a.websiteDomain === b.websiteDomain) add('website_domain', 'Same company website domain', 20, 'supporting');
  if (a.emailDomain && a.emailDomain === b.emailDomain && !freeEmailDomains.has(a.emailDomain)) add('email_domain', 'Same business email domain', 8, 'supporting');

  if (a.lastName && b.lastName && nameSimilarity(a.lastName, b.lastName) < 0.55) add('last_name_conflict', 'Conflicting last names', -38, 'conflict');
  if (a.firstName && b.firstName && !firstNamesCompatible(a.firstName, b.firstName)) add('first_name_conflict', 'Conflicting first names', -22, 'conflict');
  if (a.phones.length && b.phones.length && !sharedPhone) add('phone_conflict', 'Different phone numbers', -12, 'conflict');
  if (a.websiteDomain && b.websiteDomain && a.websiteDomain !== b.websiteDomain) add('domain_conflict', 'Different company domains', -20, 'conflict');
  if (a.emailDomain && b.emailDomain && a.emailDomain !== b.emailDomain && !a.phones.length && !b.phones.length) add('email_domain_conflict', 'Different email domains without a phone anchor', -18, 'conflict');

  const rawScore = Math.max(0, Math.min(100, evidence.reduce((total, item) => total + item.weight, 0)));
  if (!evidence.some((item) => item.weight > 0)) return null;
  const hasIdentityAnchor = evidence.some((item) =>
    item.key === 'email_alias'
    || item.key === 'exact_email' && item.tone === 'strong'
    || item.key === 'phone' && item.tone === 'strong');
  const score = hasIdentityAnchor ? rawScore : Math.min(rawScore, 69);
  const strongSignals = evidence.filter((item) => item.tone === 'strong' && item.weight > 0).length;
  const hasConflict = evidence.some((item) => item.tone === 'conflict');
  const band: DuplicateCluster['band'] = score >= 95 && strongSignals >= 1 && !hasConflict
    ? 'high_confidence'
    : score >= 75 ? 'review' : 'possible';
  return { leftKey: left.recordKey, rightKey: right.recordKey, score, band, evidence };
}

function clusterCliquePairs(records: IdentityRecord[], pairs: PairMatch[]): IdentityRecord[][] {
  const recordsByKey = new Map(records.map((record) => [record.recordKey, record]));
  const pairScores = new Map(pairs.flatMap((pair) => [
    [pairKey(pair.leftKey, pair.rightKey), pair.score],
    [pairKey(pair.rightKey, pair.leftKey), pair.score],
  ]));
  const clusters = new Set<Set<string>>();
  const membership = new Map<string, Set<Set<string>>>();
  const membershipsFor = (key: string) => membership.get(key) ?? new Set<Set<string>>();
  const attach = (key: string, cluster: Set<string>) => {
    const memberships = membershipsFor(key);
    memberships.add(cluster);
    membership.set(key, memberships);
  };
  const createCluster = (keys: string[]) => {
    const cluster = new Set(keys);
    clusters.add(cluster);
    for (const key of cluster) attach(key, cluster);
  };

  for (const pair of pairs) {
    const leftClusters = membershipsFor(pair.leftKey);
    const rightClusters = membershipsFor(pair.rightKey);
    if ([...leftClusters].some((cluster) => cluster.has(pair.rightKey))) continue;
    const containingOne = [...new Set([...leftClusters, ...rightClusters])];
    const target = containingOne.find((cluster) => {
      const missingKey = cluster.has(pair.leftKey) ? pair.rightKey : pair.leftKey;
      return pair.band !== 'possible'
        && [...cluster].every((key) => (pairScores.get(pairKey(key, missingKey)) ?? 0) >= 75);
    });
    if (target) {
      const missingKey = target.has(pair.leftKey) ? pair.rightKey : pair.leftKey;
      target.add(missingKey);
      attach(missingKey, target);
      continue;
    }
    if (pair.band === 'possible' && leftClusters.size && rightClusters.size) continue;
    createCluster([pair.leftKey, pair.rightKey]);
  }
  return [...clusters].map((keys) => [...keys].sort().map((key) => recordsByKey.get(key)!).filter(Boolean));
}

function normalizeIdentity(record: IdentityRecord): NormalizedIdentity {
  const email = normalizeEmail(record.email);
  const emailAlias = email ? aliasEmail(email) : null;
  const emailDomain = email?.split('@')[1] ?? null;
  const local = email?.split('@')[0] ?? '';
  return {
    email,
    emailAlias,
    emailDomain,
    genericInbox: genericInboxNames.has(local.split('+')[0].replaceAll('.', '')),
    phones: [...new Set([
      normalizePhone(record.phone),
      normalizePhone(record.secondaryPhone ?? ''),
    ].filter((phone): phone is string => Boolean(phone)))],
    name: normalizeName(record.fullName || `${record.firstName} ${record.lastName}`),
    firstName: normalizeName(record.firstName),
    lastName: normalizeName(record.lastName),
    company: normalizeCompany(record.company),
    websiteDomain: normalizeDomain(record.website),
  };
}

function normalizeEmail(value: string): string | null {
  const cleaned = value.trim().toLowerCase();
  const match = /^([^@\s]+)@([^@\s]+)$/u.exec(cleaned);
  if (!match || !match[2].includes('.')) return null;
  const domain = normalizeDomain(match[2]);
  return domain ? `${match[1]}@${domain}` : null;
}

function aliasEmail(email: string): string {
  let [local, domain] = email.split('@');
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0];
    local = local.replaceAll('.', '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

function memberPairs(records: IdentityRecord[]): Array<[IdentityRecord, IdentityRecord]> {
  const pairs: Array<[IdentityRecord, IdentityRecord]> = [];
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) pairs.push([records[left], records[right]]);
  }
  return pairs;
}

function normalizePhone(value: string): string | null {
  const withoutExtension = value.toLowerCase().replace(/(?:ext\.?|extension|x)\s*\d+\s*$/u, '');
  let digits = withoutExtension.replace(/\D/gu, '');
  if (digits.length === 10) digits = `1${digits}`;
  if (digits.length < 7 || digits.length > 15 || /^0+$/u.test(digits)) return null;
  return digits;
}

function normalizeName(value: string): string | null {
  const tokens = asciiWords(value).filter((token) => !namePrefixes.has(token) && !nameSuffixes.has(token));
  return tokens.length ? tokens.join(' ') : null;
}

function normalizeCompany(value: string): string | null {
  const tokens = asciiWords(value).filter((token) => !companySuffixes.has(token));
  return tokens.length ? tokens.join(' ') : null;
}

function normalizeDomain(value: string): string | null {
  const cleaned = value.trim();
  if (!cleaned) return null;
  try {
    const url = new URL(cleaned.includes('://') ? cleaned : `https://${cleaned}`);
    return url.hostname.toLowerCase().replace(/^www\./u, '') || null;
  } catch {
    return null;
  }
}

function asciiWords(value: string): string[] {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
}

function compatibleNames(left: NormalizedIdentity, right: NormalizedIdentity): boolean {
  if (!left.lastName || !right.lastName || nameSimilarity(left.lastName, right.lastName) < 0.82) return false;
  if (!left.firstName || !right.firstName) return true;
  return firstNamesCompatible(left.firstName, right.firstName);
}

function firstNamesCompatible(left: string, right: string): boolean {
  return left === right || left[0] === right[0] && nameSimilarity(left, right) >= 0.55;
}

function nameSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.length || !b.length) return left[0] === right[0] ? 0.6 : 0;
  const counts = new Map<string, number>();
  for (const value of a) counts.set(value, (counts.get(value) ?? 0) + 1);
  let overlap = 0;
  for (const value of b) {
    const available = counts.get(value) ?? 0;
    if (available > 0) {
      overlap += 1;
      counts.set(value, available - 1);
    }
  }
  return (2 * overlap) / (a.length + b.length);
}

function bigrams(value: string): string[] {
  const compact = value.replaceAll(' ', '');
  return Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2));
}

function compareCanonicalCandidates(left: IdentityRecord, right: IdentityRecord, preferSalesforceContact = false): number {
  if (preferSalesforceContact && left.connectorId === 'salesforce' && right.connectorId === 'salesforce'
    && left.objectType !== right.objectType) return left.objectType === 'contact' ? -1 : 1;
  const scoreDifference = canonicalScore(right) - canonicalScore(left);
  if (scoreDifference) return scoreDifference;
  const leftCreated = Date.parse(left.createdAt ?? '') || Number.MAX_SAFE_INTEGER;
  const rightCreated = Date.parse(right.createdAt ?? '') || Number.MAX_SAFE_INTEGER;
  return leftCreated - rightCreated || left.recordKey.localeCompare(right.recordKey);
}

function canonicalScore(record: IdentityRecord): number {
  const populated = identityFieldValues(record).filter(Boolean).length;
  const normalizedEmail = normalizeEmail(record.email);
  const emailLocal = normalizedEmail?.split('@')[0] ?? '';
  const staleMarkers = /(?:^|[.+_-])(archive|former|inactive|old|previous)(?:$|[.+_-])/u.test(emailLocal)
    || /\b(?:archive|former|inactive|old|previous)\b/iu.test(record.jobTitle);
  return populated * 5
    + (record.objectType === 'contact' ? 8 : 0)
    + (normalizedEmail ? 8 : 0)
    + (normalizedEmail && !emailLocal.includes('+') ? 3 : 0)
    - (staleMarkers ? 14 : 0);
}

function canonicalReason(record: IdentityRecord): string {
  const populated = identityFieldValues(record).filter(Boolean).length;
  const objectReason = record.connectorId === 'salesforce' && record.objectType === 'contact' ? 'stable Contact object, ' : '';
  const emailReason = normalizeEmail(record.email) && !record.email.split('@')[0].includes('+') ? 'clean non-alias email, ' : '';
  return `Recommended for ${objectReason}${emailReason}${populated}/8 identity fields populated${record.createdAt ? ', then oldest provider history as the final tie-breaker' : ''}.`;
}

function resolveFields(primary: IdentityRecord, members: IdentityRecord[]): FieldResolution[] {
  return fieldNames.map((field) => {
    const distinct = [...new Set(members.map((record) => fieldValue(record, field)).filter(Boolean))];
    const source = fieldValue(primary, field) ? primary : members.find((record) => fieldValue(record, field)) ?? primary;
    return { field, value: fieldValue(source, field), sourceRecordKey: source.recordKey, conflicting: distinct.length > 1 };
  });
}

function identityFieldValues(record: IdentityRecord): string[] {
  return fieldNames.map((field) => fieldValue(record, field));
}

function fieldValue(record: IdentityRecord, field: FieldResolution['field']): string {
  return (record[field] ?? '').trim();
}

function frequencyMany<T>(values: Iterable<T>, select: (value: T) => string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) {
    for (const key of select(value)) result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function bandForCluster(confidence: number, pairs: PairMatch[]): DuplicateCluster['band'] {
  if (confidence >= 95 && pairs.every((pair) => pair.band === 'high_confidence')) return 'high_confidence';
  return confidence >= 75 ? 'review' : 'possible';
}

function bandRank(band: DuplicateCluster['band']): number {
  return band === 'high_confidence' ? 0 : band === 'review' ? 1 : 2;
}

function pairKey(left: string, right: string): string {
  return `${left}\u0000${right}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `cluster-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
