import { CRM_EVIDENCE_FIELDS, type CrmCohortAssessments, type CrmEvidenceContact, type CrmEvidenceCoverage, type CrmEvidenceField, type CrmEvidenceItem, type CrmPortableValues } from './crm-evidence-request';

export type CrmCohortDefinition = {
  schemaVersion: 1; name: string; portalId: string; evaluatedAt: string;
  pipelineId: string; lostStageIds: string[]; closeDateProperty: string; dateFrom: string; dateTo: string;
  inactivity: { property: string; meaning: string; confirmed: boolean; days: number };
  lossReasonProperty: string | null;
  exclusions: { property: string; label: string; blockedValues: string[]; missing: 'hold' | 'allow' }[];
  fitRules: { property: string; label: string; allowedValues?: string[]; minimum?: number; maximum?: number }[];
  followUpProperty: string | null; activeStageIds: string[]; wonStageIds: string[];
  verification: { statusProperty: string; addressProperty: string; dateProperty: string; acceptedValues: string[]; maxAgeDays: number } | null;
  fieldProperties: Record<CrmEvidenceField, string>;
  evidenceProperties: { contact: string[]; company: string[]; deal: string[] }; includeNotes: boolean;
  requestedFields: CrmEvidenceField[];
};
export type CrmCohortDeal = { dealId: string; properties: Record<string, string | null> };
export type CrmCohortContact = {
  contactId: string; properties: Record<string, string | null>; existingValues: CrmPortableValues;
  dealIds: string[]; companyIds: string[]; deals: CrmCohortDeal[];
  evidence: CrmEvidenceItem[]; coverage: CrmEvidenceCoverage;
};
export type CrmCohortEvaluation = { definition: CrmCohortDefinition; contacts: CrmEvidenceContact[]; counts: { ready_for_review: number; held: number; excluded: number } };

const DAY = 86_400_000;

/** Fixed CRM rules only. No model, provider calls, permission decisions or approvals. */
export function evaluateCrmCohort(input: CrmCohortDefinition, snapshots: CrmCohortContact[]): CrmCohortEvaluation {
  const definition = parseCrmCohortDefinition(input);
  const byId = new Map<string, CrmCohortContact>();
  const inconsistent = new Set<string>();
  for (const snapshot of snapshots) {
    const previous = byId.get(snapshot.contactId);
    if (!previous) { byId.set(snapshot.contactId, structuredClone(snapshot)); continue; }
    if (!sameValues(previous.properties, snapshot.properties) || !sameValues(previous.existingValues, snapshot.existingValues)
      || snapshot.evidence.some((source) => previous.evidence.some((old) => old.id === source.id && old.text !== source.text))
      || snapshot.deals.some((deal) => previous.deals.some((old) => old.dealId === deal.dealId && !sameValues(old.properties, deal.properties)))) inconsistent.add(snapshot.contactId);
    previous.dealIds = unique([...previous.dealIds, ...snapshot.dealIds]);
    previous.companyIds = unique([...previous.companyIds, ...snapshot.companyIds]);
    previous.deals = [...new Map([...previous.deals, ...snapshot.deals].map((deal) => [deal.dealId, deal])).values()];
    previous.evidence = [...new Map([...previous.evidence, ...snapshot.evidence].map((source) => [source.id, source])).values()];
    previous.coverage = { complete: previous.coverage.complete && snapshot.coverage.complete,
      missing: unique([...previous.coverage.missing, ...snapshot.coverage.missing]), omittedSourceIds: unique([...previous.coverage.omittedSourceIds, ...snapshot.coverage.omittedSourceIds]) };
  }
  const emailCounts = new Map<string, number>();
  for (const row of byId.values()) {
    const email = normalized(row.existingValues.email);
    if (email) emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
  }
  const contacts = [...byId.values()].map((row): CrmEvidenceContact => {
    const reasons: string[] = [];
    let hold = false;
    let exclude = false;
    const holdFor = (reason: string) => { hold = true; reasons.push(reason); };
    const excludeFor = (reason: string) => { exclude = true; reasons.push(reason); };
    const now = Date.parse(definition.evaluatedAt);
    const start = Date.parse(`${definition.dateFrom}T00:00:00.000Z`);
    const end = Date.parse(`${definition.dateTo}T23:59:59.999Z`);
    const originDeals = row.deals.filter((deal) => row.dealIds.includes(deal.dealId));
    const selected = originDeals.filter((deal) => deal.properties.pipeline === definition.pipelineId && definition.lostStageIds.includes(deal.properties.dealstage ?? ''));
    const matching = selected.filter((deal) => {
      const closedAt = crmDate(deal.properties[definition.closeDateProperty]);
      return closedAt !== null && closedAt >= start && closedAt <= end;
    });
    if (!row.dealIds.length || row.dealIds.some((id) => !originDeals.some((deal) => deal.dealId === id))) holdFor('An originating deal could not be read.');
    if (originDeals.some((deal) => !deal.properties.pipeline || !deal.properties.dealstage)) holdFor('An originating deal has an unknown pipeline or stage.');
    if (!selected.length && originDeals.length && !hold) excludeFor('No originating deal is in the selected pipeline and lost stages.');
    if (selected.some((deal) => crmDate(deal.properties[definition.closeDateProperty]) === null)) holdFor(`A selected deal has no valid ${definition.closeDateProperty} date.`);
    if (selected.length && !matching.length && selected.every((deal) => crmDate(deal.properties[definition.closeDateProperty]) !== null)) excludeFor('No selected lost deal is within the configured date range.');
    if (matching.length) reasons.push(`${matching.length} originating lost deal${matching.length === 1 ? '' : 's'} match the selected pipeline, stages and date range.`);
    for (const deal of row.deals) {
      const stage = deal.properties.dealstage;
      if (!stage || !deal.properties.pipeline) holdFor(`Associated deal ${deal.dealId} has an unknown pipeline or stage.`);
      else if (definition.activeStageIds.includes(stage)) excludeFor(`Associated deal ${deal.dealId} is in a configured active stage.`);
      else if (definition.wonStageIds.includes(stage)) excludeFor(`Associated deal ${deal.dealId} is in a configured won stage.`);
    }
    if (!definition.exclusions.length) holdFor('Configure the CRM suppression/exclusion properties before considering eligibility.');
    for (const rule of definition.exclusions) {
      const current = normalized(row.properties[rule.property]);
      if (!current && rule.missing === 'hold') holdFor(`${rule.label}: ${rule.property} is unknown.`);
      else if (rule.blockedValues.map(normalized).includes(current)) excludeFor(`${rule.label}: ${rule.property} is ${row.properties[rule.property]}.`);
    }
    let fit: CrmCohortAssessments['fit'] = 'meets';
    for (const rule of definition.fitRules) {
      const current = row.properties[rule.property];
      if (!current?.trim()) { if (fit !== 'does_not_meet') fit = 'unknown'; holdFor(`${rule.label}: ${rule.property} is unknown.`); continue; }
      let matches = true;
      if (rule.allowedValues && !rule.allowedValues.map(normalized).includes(normalized(current))) matches = false;
      if (rule.minimum !== undefined || rule.maximum !== undefined) {
        const number = Number(current);
        if (!Number.isFinite(number)) { if (fit !== 'does_not_meet') fit = 'unknown'; holdFor(`${rule.label}: ${rule.property} is not a valid number.`); continue; }
        if ((rule.minimum !== undefined && number < rule.minimum) || (rule.maximum !== undefined && number > rule.maximum)) matches = false;
      }
      if (!matches) { fit = 'does_not_meet'; excludeFor(`${rule.label}: ${rule.property} (${current}) does not meet the configured fit rule.`); }
      else reasons.push(`${rule.label}: ${rule.property} (${current}) meets the configured fit rule.`);
    }
    let timing: CrmCohortAssessments['timing'] = 'unknown';
    const lastContact = crmDate(row.properties[definition.inactivity.property]);
    if (!definition.inactivity.confirmed || !definition.inactivity.meaning.trim()) holdFor('The meaning of the inactivity property has not been confirmed.');
    else if (lastContact === null || lastContact > now) holdFor(`${definition.inactivity.property} is missing, invalid or in the future; inactivity is unknown.`);
    else if (now - lastContact < definition.inactivity.days * DAY) {
      timing = 'not_yet'; excludeFor(`Fewer than ${definition.inactivity.days} elapsed days since the configured meaningful contact date.`);
    } else { timing = 'eligible'; reasons.push(`At least ${definition.inactivity.days} elapsed days since the configured meaningful contact date.`); }
    if (definition.followUpProperty) {
      const rawFollowUp = row.properties[definition.followUpProperty];
      const followUp = crmDate(rawFollowUp);
      if (rawFollowUp?.trim() && followUp === null) { timing = 'unknown'; holdFor('The promised follow-up date is invalid.'); }
      else if (followUp !== null && followUp > now) { timing = 'not_yet'; holdFor(`A promised follow-up is scheduled for ${new Date(followUp).toISOString()}.`); }
    }
    if (inconsistent.has(row.contactId)) holdFor('Repeated native contact snapshots disagree; refresh the contact.');
    if ((emailCounts.get(normalized(row.existingValues.email)) ?? 0) > 1) holdFor('Different native contact IDs share this email; review possible duplicates without merging.');
    if (!row.coverage.complete || row.coverage.missing.length || row.coverage.omittedSourceIds.length) holdFor(`Required CRM source coverage is incomplete${row.coverage.missing.length ? `: ${row.coverage.missing.join('; ')}` : '.'}`);
    if (definition.lossReasonProperty && matching.some((deal) => !deal.properties[definition.lossReasonProperty!]?.trim())) reasons.push('A mapped loss reason is missing; the reason remains unknown.');
    const emailVerification = verifiedEmail(row, definition, now) ? 'verified' : 'unverified';
    if (emailVerification === 'unverified') reasons.push('Email is unverified: no applicable, matching, fresh CRM verification result.');
    return { contactId: row.contactId, dealIds: unique(row.dealIds), companyIds: unique(row.companyIds), existingValues: structuredClone(row.existingValues),
      requestedFields: definition.requestedFields.filter((field) => !row.existingValues[field]?.trim()), evidence: structuredClone(row.evidence),
      assessments: { state: exclude ? 'excluded' : hold ? 'held' : 'ready_for_review', fit, timing, emailVerification, reasons: unique(reasons) }, coverage: structuredClone(row.coverage) };
  });
  const counts = { ready_for_review: 0, held: 0, excluded: 0 };
  for (const row of contacts) counts[row.assessments.state] += 1;
  return { definition, contacts, counts };
}

export function parseCrmCohortDefinition(input: unknown): CrmCohortDefinition {
  if (!isRecord(input)) throw new Error('A CRM cohort definition is required.');
  const d = input as unknown as CrmCohortDefinition;
  if (d.schemaVersion !== 1 || !nonempty(d.name) || !nonempty(d.portalId) || !isoTimestamp(d.evaluatedAt)
    || !nonempty(d.pipelineId) || !strings(d.lostStageIds, true) || !nonempty(d.closeDateProperty)
    || !dateOnly(d.dateFrom) || !dateOnly(d.dateTo) || d.dateFrom > d.dateTo) throw new Error('Select a portal, pipeline, lost stages, valid UTC evaluation time and deal date range.');
  if (!isRecord(d.inactivity) || !nonempty(d.inactivity.property) || typeof d.inactivity.meaning !== 'string'
    || typeof d.inactivity.confirmed !== 'boolean' || !Number.isInteger(d.inactivity.days) || d.inactivity.days < 1 || d.inactivity.days > 3650) throw new Error('Define the inactivity property, its meaning and a threshold from 1–3650 days.');
  if (!nullableProperty(d.lossReasonProperty) || !nullableProperty(d.followUpProperty) || !strings(d.activeStageIds) || !strings(d.wonStageIds)
    || d.activeStageIds.some((stage) => d.lostStageIds.includes(stage) || d.wonStageIds.includes(stage)) || d.wonStageIds.some((stage) => d.lostStageIds.includes(stage))) throw new Error('Lost, active and won stage IDs must be distinct; property mappings must be valid.');
  if (!Array.isArray(d.exclusions) || d.exclusions.length > 20 || d.exclusions.some((rule) => !isRecord(rule) || !nonempty(rule.property)
    || !nonempty(rule.label) || !strings(rule.blockedValues, true) || !['hold', 'allow'].includes(rule.missing))) throw new Error('Configure explicit exclusion properties, blocked values and missing-value handling.');
  if (!Array.isArray(d.fitRules) || d.fitRules.length > 20 || d.fitRules.some((rule) => !isRecord(rule) || !nonempty(rule.property) || !nonempty(rule.label)
    || (rule.allowedValues !== undefined && !strings(rule.allowedValues, true)) || (rule.minimum !== undefined && !Number.isFinite(rule.minimum))
    || (rule.maximum !== undefined && !Number.isFinite(rule.maximum)) || (rule.minimum !== undefined && rule.maximum !== undefined && rule.minimum > rule.maximum)
    || (rule.allowedValues === undefined && rule.minimum === undefined && rule.maximum === undefined))) throw new Error('Fit rules require allowed values or a valid numeric range.');
  if (d.verification !== null && (!isRecord(d.verification) || !nonempty(d.verification.statusProperty) || !nonempty(d.verification.addressProperty)
    || !nonempty(d.verification.dateProperty) || !strings(d.verification.acceptedValues, true) || !Number.isInteger(d.verification.maxAgeDays)
    || d.verification.maxAgeDays < 1 || d.verification.maxAgeDays > 3650)) throw new Error('Email verification requires result/address/date properties and a freshness window.');
  if (!isRecord(d.fieldProperties) || !CRM_EVIDENCE_FIELDS.every((field) => nonempty(d.fieldProperties[field])) || Object.keys(d.fieldProperties).length !== 4
    || !isRecord(d.evidenceProperties) || !['contact', 'company', 'deal'].every((object) => strings(d.evidenceProperties[object as keyof typeof d.evidenceProperties]))
    || typeof d.includeNotes !== 'boolean' || !strings(d.requestedFields) || !d.requestedFields.every((field) => CRM_EVIDENCE_FIELDS.includes(field))) throw new Error('Select CRM evidence sources and supported missing-field mappings.');
  return structuredClone(d);
}

function verifiedEmail(row: CrmCohortContact, definition: CrmCohortDefinition, now: number): boolean {
  const rule = definition.verification;
  if (!rule) return false;
  const date = crmDate(row.properties[rule.dateProperty]);
  const address = normalized(row.properties[rule.addressProperty]);
  return Boolean(address && address === normalized(row.existingValues.email) && rule.acceptedValues.map(normalized).includes(normalized(row.properties[rule.statusProperty]))
    && date !== null && date <= now && now - date <= rule.maxAgeDays * DAY);
}
function crmDate(value: string | null | undefined): number | null {
  if (!value?.trim()) return null;
  // HubSpot date properties may be ISO strings or millisecond epoch strings.
  if (!/^\d{13}$/.test(value) && (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || !dateOnly(value.slice(0, 10)))) return null;
  const parsed = /^\d{13}$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function normalized(value: string | null | undefined): string { return value?.trim().toLowerCase() ?? ''; }
function sameValues(a: Record<string, string | null>, b: Record<string, string | null>): boolean { return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key]); }
function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200; }
function strings(value: unknown, required = false): value is string[] { return Array.isArray(value) && value.length <= 100 && (!required || value.length > 0) && value.every(nonempty) && new Set(value).size === value.length; }
function nullableProperty(value: unknown): boolean { return value === null || nonempty(value); }
function isoTimestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function dateOnly(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value; }
