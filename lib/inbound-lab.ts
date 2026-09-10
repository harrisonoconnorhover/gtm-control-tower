/** Browser-local practice system. No vendor API calls or customer data. */
export type Region = 'East' | 'Central' | 'West';
export type Segment = 'Growth' | 'Enterprise';
export type FormInput = { firstName: string; lastName: string; email: string; phone: string; company: string };
export type LeadContext = { source: string; campaign: string; region: Region | ''; monthlySpend: number };
export type LabSettings = { emailMapping: 'correct' | 'broken'; crmFault: 'none' | 'before-write' | 'after-write'; notificationFault: boolean };
export type LabRep = { id: string; name: string; region: Region; segment: Segment; active: boolean; capacity: number; assigned: number };
export type LabAccount = { id: string; name: string; domain: string; ownerId: string; region: Region; monthlySpend: number };
export type LabLead = FormInput & { id: string; accountId: string | null; ownerId: string | null; source: string; campaign: string; notified: boolean };
export type TraceStep = { stage: string; status: 'passed' | 'held' | 'failed'; detail: string };
export type LabAttempt = { at: string; payload: Record<string, string>; context: LeadContext; steps: TraceStep[] };
export type LabRun = { id: string; label: string; input: FormInput; context: LeadContext; payload: Record<string, string>; status: 'routed' | 'held' | 'failed'; reason: string; leadId: string | null; ownerId: string | null; accountId: string | null; attempts: LabAttempt[] };
export type InboundLabState = { version: 1; reps: LabRep[]; accounts: LabAccount[]; leads: LabLead[]; runs: LabRun[]; settings: LabSettings };
export type LabScenario = { id: string; label: string; description: string; input: FormInput; context: LeadContext };

export const defaultLabSettings: LabSettings = { emailMapping: 'correct', crmFault: 'none', notificationFault: false };
export const traceStages = ['Receive', 'Map & validate', 'Match account', 'Choose owner', 'CRM upsert', 'Assign', 'Notify'];

const seedReps: LabRep[] = [
  { id: 'rep-ava', name: 'Ava Chen', region: 'East', segment: 'Growth', active: true, capacity: 12, assigned: 3 },
  { id: 'rep-jordan', name: 'Jordan Ellis', region: 'East', segment: 'Growth', active: true, capacity: 12, assigned: 5 },
  { id: 'rep-maya', name: 'Maya Brooks', region: 'Central', segment: 'Growth', active: true, capacity: 12, assigned: 4 },
  { id: 'rep-theo', name: 'Theo Park', region: 'West', segment: 'Growth', active: true, capacity: 12, assigned: 4 },
  { id: 'rep-noor', name: 'Noor Patel', region: 'East', segment: 'Enterprise', active: true, capacity: 10, assigned: 2 },
  { id: 'rep-luca', name: 'Luca Reed', region: 'West', segment: 'Enterprise', active: true, capacity: 10, assigned: 3 },
  { id: 'rep-riley', name: 'Riley Morgan', region: 'Central', segment: 'Enterprise', active: true, capacity: 10, assigned: 3 },
  { id: 'rep-sam', name: 'Sam Rivera', region: 'West', segment: 'Growth', active: false, capacity: 12, assigned: 6 },
];

const seedAccounts: LabAccount[] = [
  { id: 'acct-cedar', name: 'Cedar & Loom', domain: 'cedarloom.example', ownerId: 'rep-ava', region: 'East', monthlySpend: 18000 },
  { id: 'acct-trail', name: 'Trailwell Outdoors', domain: 'trailwell.example', ownerId: 'rep-luca', region: 'West', monthlySpend: 65000 },
  { id: 'acct-harbor', name: 'Harborlight Home', domain: 'harborlight.example', ownerId: 'rep-maya', region: 'Central', monthlySpend: 24000 },
  { id: 'acct-petal', name: 'Petal & Pine', domain: 'petalpine.example', ownerId: 'rep-theo', region: 'West', monthlySpend: 14000 },
  { id: 'acct-beacon', name: 'Beacon Learning', domain: 'beaconlearning.example', ownerId: 'rep-noor', region: 'East', monthlySpend: 52000 },
  { id: 'acct-summit', name: 'Summit Table', domain: 'summittable.example', ownerId: 'rep-riley', region: 'Central', monthlySpend: 41000 },
  { id: 'acct-river', name: 'Riverbend Goods', domain: 'riverbendgoods.example', ownerId: 'rep-sam', region: 'West', monthlySpend: 19000 },
];

function scenario(id: string, label: string, description: string, firstName: string, lastName: string, email: string, company: string, region: Region | '', monthlySpend: number, source = 'paid-search'): LabScenario {
  return { id, label, description, input: { firstName, lastName, email, company, phone: '+1 202-555-0148' }, context: { source, campaign: source === 'paid-search' ? 'ctv-demo-nonbrand' : 'fall-growth-guide', region, monthlySpend } };
}

export const labScenarios: LabScenario[] = [
  scenario('existing', 'Existing account', 'Cedar & Loom belongs to Ava. Keep the account relationship.', 'Elena', 'Foster', 'elena.foster@cedarloom.example', 'Cedar & Loom', 'East', 18000),
  scenario('new', 'New growth brand', 'No account match. Choose an available East growth rep with room.', 'Marcus', 'Bell', 'marcus@northstarfitness.example', 'Northstar Fitness', 'East', 22000),
  scenario('enterprise', 'Enterprise prospect', 'A $72k monthly budget qualifies for the West enterprise pool.', 'Priya', 'Shah', 'priya@solsticeaudio.example', 'Solstice Audio', 'West', 72000),
  scenario('unavailable', 'Owner unavailable', 'Riverbend has an owner who is away. Hold rather than silently move it.', 'Nolan', 'Price', 'nolan@riverbendgoods.example', 'Riverbend Goods', 'West', 19000),
  scenario('conflict', 'Conflicting identity', 'The email belongs to Cedar & Loom, but the company names another account.', 'Elena', 'Foster', 'elena.foster@cedarloom.example', 'Trailwell Outdoors', 'East', 18000),
  scenario('missing', 'Missing enrichment', 'The five form fields look fine. No region is available for routing.', 'Isabel', 'Cruz', 'isabel@willowwellness.example', 'Willow Wellness', '', 16000),
  scenario('invalid', 'Bad source email', 'A malformed address arrives from an upstream import; validation must hold it.', 'Devon', 'Lee', 'devon@@brightline.example', 'Brightline Kitchens', 'Central', 30000, 'partner'),
  scenario('repeat', 'Repeat submission', 'The same contact requests a demo twice. Reuse its record and assignment.', 'Elena', 'Foster', 'elena.foster@cedarloom.example', 'Cedar & Loom', 'East', 18000),
];

export function createInboundLab(): InboundLabState {
  return { version: 1, reps: seedReps.map(r => ({ ...r })), accounts: seedAccounts.map(a => ({ ...a })), leads: [], runs: [], settings: { ...defaultLabSettings } };
}

/** The five numeric keys are observed WPForms fields; enrichment is separate. */
export function toWpFormsPayload(input: FormInput): Record<string, string> {
  return { 'wpforms[fields][10]': input.firstName, 'wpforms[fields][11]': input.lastName, 'wpforms[fields][3]': input.email, 'wpforms[fields][4]': input.phone, 'wpforms[fields][5]': input.company };
}

function normalize(payload: Record<string, string>, settings: LabSettings): FormInput {
  return {
    firstName: (payload['wpforms[fields][10]'] ?? '').trim(),
    lastName: (payload['wpforms[fields][11]'] ?? '').trim(),
    email: (payload[settings.emailMapping === 'correct' ? 'wpforms[fields][3]' : 'wpforms[fields][8]'] ?? '').trim().toLowerCase(),
    phone: (payload['wpforms[fields][4]'] ?? '').trim(),
    company: (payload['wpforms[fields][5]'] ?? '').trim(),
  };
}

const companyKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function execute(state: InboundLabState, run: LabRun, at: string): void {
  const steps: TraceStep[] = [];
  const add = (stage: string, detail: string) => steps.push({ stage, status: 'passed', detail });
  const stop = (stage: string, status: 'held' | 'failed', reason: string) => {
    steps.push({ stage, status, detail: reason });
    run.status = status;
    run.reason = reason;
    run.attempts.push({ at, payload: { ...run.payload }, context: { ...run.context }, steps });
  };
  add('Receive', `Captured ${run.id}. The request is saved before downstream work.`);
  const input = normalize(run.payload, state.settings);
  if (!input.firstName || !input.lastName || !input.company || !validEmail(input.email)) {
    return stop('Map & validate', 'held', state.settings.emailMapping === 'broken'
      ? 'Email mapping points to field 8, but the source email is in field 3. Fix the mapping and retry this request.'
      : 'First name, last name, company, and a valid email are required. Correct the source fields and retry.');
  }
  add('Map & validate', 'Mapped fields 10 / 11 / 3 / 4 / 5. Trimmed names and normalized email; phone is optional.');
  const existing = state.leads.find(lead => lead.email === input.email);
  const domain = input.email.split('@')[1];
  const domainAccount = state.accounts.find(account => account.domain === domain);
  const namedAccount = state.accounts.find(account => companyKey(account.name) === companyKey(input.company));
  if ((domainAccount && namedAccount && domainAccount.id !== namedAccount.id) || (!domainAccount && namedAccount)) {
    return stop('Match account', 'held', 'Company and business-domain evidence do not agree. Review the identity before creating or changing a CRM record.');
  }
  const account = domainAccount;
  if (existing && existing.accountId !== (account?.id ?? null)) {
    return stop('Match account', 'held', 'This contact already has a different account relationship. Review it before changing ownership.');
  }
  run.accountId = account?.id ?? null;
  add('Match account', existing ? `Matched existing contact ${existing.id} by normalized email.` : account ? `Exact domain match to ${account.name}.` : 'No existing account match. Use the synthetic enrichment context for a new prospect.');
  const region = account?.region ?? run.context.region;
  const spend = account?.monthlySpend ?? run.context.monthlySpend;
  const fixedOwner = existing?.ownerId ?? account?.ownerId;
  let owner: LabRep | undefined;
  if (fixedOwner) {
    owner = state.reps.find(rep => rep.id === fixedOwner);
    if (!owner?.active) return stop('Choose owner', 'held', `Existing owner ${owner?.name ?? fixedOwner} is unavailable. Restore availability after review and retry; ownership is preserved.`);
    add('Choose owner', `Preserve ${existing?.ownerId ? 'contact' : 'account'} owner ${owner.name}. Existing relationships take precedence over pool balancing.`);
  } else {
    if (!region) return stop('Choose owner', 'held', 'Region is missing from enrichment. Add the region to this request and retry.');
    if (!Number.isFinite(spend) || spend < 0) return stop('Choose owner', 'held', 'Monthly media budget must be a nonnegative number. Correct enrichment and retry.');
    const segment: Segment = spend >= 35000 ? 'Enterprise' : 'Growth';
    owner = state.reps.filter(rep => rep.active && rep.region === region && rep.segment === segment && rep.assigned < rep.capacity)
      .sort((a, b) => a.assigned / a.capacity - b.assigned / b.capacity || a.id.localeCompare(b.id))[0];
    if (!owner) return stop('Choose owner', 'held', `No available ${region} ${segment} rep has capacity. Adjust the pool after review and retry.`);
    add('Choose owner', `${region} / ${segment}: ${owner.name} has ${owner.assigned} of ${owner.capacity} slots assigned. Lowest utilization wins; ID breaks ties.`);
  }
  if (state.settings.crmFault === 'before-write') return stop('CRM upsert', 'failed', 'Simulated CRM outage before the write. No record was created. Restore CRM responses and retry.');
  let lead = existing;
  if (!lead) {
    lead = { ...input, id: `lead-${String(state.leads.length + 1).padStart(3, '0')}`, accountId: account?.id ?? null, ownerId: null, source: run.context.source, campaign: run.context.campaign, notified: false };
    state.leads.push(lead);
  }
  run.leadId = lead.id;
  if (state.settings.crmFault === 'after-write') return stop('CRM upsert', 'failed', `Simulated response lost after the write. ${lead.id} exists${lead.ownerId ? ' with its previous assignment' : ' but is unassigned'}. Retry reconciles the existing record by email.`);
  add('CRM upsert', existing ? `Reused ${lead.id}; no second contact was created. Original source attribution is preserved.` : `Created ${lead.id} in the simulated CRM.`);
  if (!lead.ownerId) {
    lead.ownerId = owner.id;
    owner.assigned += 1;
    add('Assign', `Assigned ${lead.id} to ${owner.name}. Capacity increased once.`);
  } else add('Assign', `Kept ${owner.name}; no extra capacity was consumed.`);
  run.ownerId = lead.ownerId;
  if (state.settings.notificationFault && !lead.notified) return stop('Notify', 'failed', 'Simulated rep-notification failure. CRM assignment succeeded. Restore notifications and retry only the unfinished work.');
  add('Notify', lead.notified ? 'Rep already notified. Suppressed the duplicate notification.' : `Created one simulated handoff notification for ${owner.name}.`);
  lead.notified = true;
  run.status = 'routed';
  run.reason = `${lead.id} is assigned to ${owner.name}; the handoff is complete.`;
  run.attempts.push({ at, payload: { ...run.payload }, context: { ...run.context }, steps });
}

export function submitInbound(state: InboundLabState, input: FormInput, context: LeadContext, label = 'Manual request', at = new Date().toISOString()): InboundLabState {
  const next = structuredClone(state);
  const run: LabRun = { id: `req-${String(next.runs.length + 1).padStart(3, '0')}`, label, input: { ...input }, context: { ...context }, payload: toWpFormsPayload(input), status: 'held', reason: '', leadId: null, ownerId: null, accountId: null, attempts: [] };
  next.runs.push(run);
  execute(next, run, at);
  return next;
}

export function retryInbound(state: InboundLabState, runId: string, correction?: { input: FormInput; context: LeadContext }, at = new Date().toISOString()): InboundLabState {
  const next = structuredClone(state);
  const run = next.runs.find(item => item.id === runId);
  if (!run || run.status === 'routed') return next;
  // Keep prior attempts and raw payloads visible instead of silently rewriting evidence.
  if (correction) {
    if (run.leadId && normalize(toWpFormsPayload(correction.input), defaultLabSettings).email !== normalize(run.payload, defaultLabSettings).email) {
      run.reason = 'A CRM record already exists. Retry with its original email to avoid creating a second identity.';
      return next;
    }
    run.input = { ...correction.input };
    run.context = { ...correction.context };
    run.payload = toWpFormsPayload(correction.input);
  }
  execute(next, run, at);
  return next;
}

/** A reproducible fictional advertiser funnel, including repeat and malformed requests. */
export function syntheticInboundBatch(): LabScenario[] {
  const names = [['Amelia', 'Stone'], ['Ethan', 'Nguyen'], ['Sofia', 'Bennett'], ['Owen', 'Clark'], ['Leah', 'Wilson'], ['Adrian', 'Reed'], ['Chloe', 'Ross'], ['Miles', 'Santos'], ['Nina', 'Flores'], ['Caleb', 'Young'], ['Grace', 'Patel'], ['Julian', 'Hayes'], ['Tessa', 'Grant'], ['Felix', 'Kim'], ['Naomi', 'Parker'], ['Leo', 'Davis'], ['Mila', 'Torres'], ['Rowan', 'Blake'], ['Avery', 'Cole'], ['Cameron', 'Reyes'], ['Zoe', 'Martin'], ['Elliot', 'Wells'], ['Mara', 'Quinn'], ['Simon', 'Hart'], ['Aisha', 'Lewis'], ['Gabriel', 'Chen']];
  const brands = [['Juniper Sleep', 'junipersleep.example'], ['Morrow Running', 'morrowrunning.example'], ['Copperlane Kitchen', 'copperlanekitchen.example'], ['Oakline Studio', 'oaklinestudio.example'], ['Fieldnote Travel', 'fieldnotetravel.example'], ['Larkspur Pets', 'larkspurpets.example'], ['Woven Orchard', 'wovenorchard.example'], ['Silverfern Shoes', 'silverfernshoes.example'], ['Daybreak Pantry', 'daybreakpantry.example'], ['Cove & Current', 'covecurrent.example'], ['Stillwater Lamps', 'stillwaterlamps.example'], ['Amberline Tea', 'amberlinetea.example'], ['Meadowcraft Home', 'meadowcrafthome.example']];
  const rows = names.map(([first, last], index) => {
    const brandIndex = index % brands.length;
    const [company, domain] = brands[brandIndex];
    const region = (['East', 'Central', 'West'] as const)[brandIndex % 3];
    const row = scenario(`batch-${index}`, `Inbound ${index + 1}`, 'Fictional advertiser demo request.', first, last, `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`, company, region, [12000, 28000, 55000, 8500, 46000][brandIndex % 5], ['paid-search', 'organic', 'webinar', 'partner'][index % 4]);
    row.input.phone = `+1 202-555-${String(110 + index).padStart(4, '0')}`;
    return row;
  });
  // Leave the two new-prospect form presets unused so they start with fresh contacts.
  return [...labScenarios.filter(row => !['new', 'enterprise'].includes(row.id)).map(row => structuredClone(row)), ...rows];
}

export function runSyntheticBatch(state: InboundLabState): InboundLabState {
  return syntheticInboundBatch().reduce((next, row, index) => submitInbound(next, row.input, row.context, row.label, new Date(Date.UTC(2026, 8, 10, 9, index * 7)).toISOString()), state);
}

export function labMetrics(state: InboundLabState) {
  return { requests: state.runs.length, routed: state.runs.filter(r => r.status === 'routed').length, held: state.runs.filter(r => r.status === 'held').length, failed: state.runs.filter(r => r.status === 'failed').length, leads: state.leads.length, notifications: state.leads.filter(l => l.notified).length };
}
