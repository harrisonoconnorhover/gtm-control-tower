import { readFile, writeFile } from 'node:fs/promises';
import { DATASET_TOKEN, PROJECT_TOKEN, stripWorkflowCredentials } from './lib/portable-assets.mjs';

const workflowPath = new URL('../integrations/n8n/control-tower-ops-workflow.json', import.meta.url);
const seedSqlPath = new URL('../warehouse/bigquery/funky-crm-lab.sql', import.meta.url);
const repairSqlPath = new URL('../warehouse/bigquery/repair-worker.sql', import.meta.url);
const stateSqlPath = new URL('../warehouse/bigquery/state.sql', import.meta.url);

const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
const seedSql = await readFile(seedSqlPath, 'utf8');
const repairSql = await readFile(repairSqlPath, 'utf8');
const stateSql = await readFile(stateSqlPath, 'utf8');

const shapeStateCode = `const row = $json;
const number = (value) => Number(value ?? 0);
const parse = (value) => {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};
const contacts = parse(row.contacts_json).map((contact) => ({
  contactId: contact.contact_id,
  fullName: contact.full_name,
  rawEmail: contact.raw_email,
  normalizedEmail: contact.normalized_email,
  company: contact.company,
  region: contact.region,
  segment: contact.segment,
  lifecycleStage: contact.lifecycle_stage,
  expectedLifecycleStage: contact.expected_lifecycle_stage,
  ownerId: contact.owner_id,
  canonicalContactId: contact.canonical_contact_id,
  recordStatus: contact.record_status,
  lastAction: contact.last_action,
  qualityFlags: contact.quality_flags ?? [],
  updatedAt: contact.updated_at,
}));
const repairHistory = parse(row.repair_history_json).map((repair) => ({
  runId: repair.run_id,
  scenario: repair.scenario,
  action: repair.action,
  status: repair.status,
  affectedRecords: number(repair.affected_records),
  finishedAt: repair.finished_at,
}));
return [{ json: {
  source: 'bigquery',
  generatedAt: row.generated_at,
  latestEventAt: row.latest_event_at,
  metrics: {
    totalEvents: number(row.total_events),
    routedLeads: number(row.routed_leads),
    duplicateEvents: number(row.duplicate_events),
    missingOwnerEvents: number(row.missing_owner_events),
    medianRouteSeconds: number(row.median_route_seconds),
    qualityRate: number(row.quality_rate),
  },
  funnel: [
    { label: 'Leads', count: number(row.leads) },
    { label: 'MQL', count: number(row.mqls) },
    { label: 'SQL', count: number(row.sqls) },
    { label: 'Open opp', count: number(row.opportunities) },
    { label: 'Won', count: number(row.closed_won) },
  ],
  contacts,
  repairHistory,
  latestRepair: row.latest_repair_scenario ? { scenario: row.latest_repair_scenario, approvedAt: row.latest_repair_at } : null,
} }];`;

const validateRepairCode = `const body = $json.body ?? $json;
const actions = {
  'duplicate-surge': 'merge_duplicate_identity_clusters',
  'routing-overload': 'reroute_northeast_enterprise_overflow',
  'stage-regression': 'replay_expected_lifecycle_state',
};
const scenario = String(body.scenario ?? '');
if (!actions[scenario]) throw new Error('Unsupported repair scenario');
const requestId = String(body.requestId ?? \`request-\${Date.now()}\`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
return [{ json: { scenario, action: actions[scenario], request_id: requestId } }];`;

function node(name) {
  const match = workflow.nodes.find((item) => item.name === name);
  if (!match) throw new Error(`Workflow node not found: ${name}`);
  return match;
}

node('Query Live Warehouse').parameters.sqlQuery = stateSql;
node('Shape Dashboard State').parameters.jsCode = shapeStateCode;
node('Validate Repair').parameters.jsCode = validateRepairCode;

const repairNode = workflow.nodes.find((item) => [
  'Record Repair in BigQuery',
  'Execute Repair Worker',
].includes(item.name));
if (!repairNode) throw new Error('Repair worker node not found');
repairNode.name = 'Execute Repair Worker';
repairNode.parameters = {
  authentication: 'serviceAccount',
  operation: 'executeQuery',
  projectId: { mode: 'id', value: PROJECT_TOKEN },
  sqlQuery: repairSql,
  options: {
    location: 'US',
    maximumBytesBilled: '100000000',
    returnAsNumbers: true,
    timeoutMs: 30000,
    queryParameters: {
      namedParameters: [
        { name: 'scenario', value: '={{ $json.scenario }}' },
        { name: 'action', value: '={{ $json.action }}' },
        { name: 'request_id', value: '={{ $json.request_id }}' },
      ],
    },
  },
};

node('Return Repair Receipt').parameters.responseBody = "={{ { accepted: String($json.accepted) === 'true', status: $json.status, scenario: $json.scenario, action: $json.action, requestId: $json.request_id, eventId: $json.event_id, affectedRecords: Number($json.affected_records), approvedAt: $json.approved_at } }}";

workflow.nodes = workflow.nodes.filter((item) => ![
  'Seed Funky CRM',
  'Reset Funky CRM State',
  'Return Seed Receipt',
].includes(item.name));

workflow.nodes.push(
  {
    parameters: {
      httpMethod: 'POST',
      path: 'gtm-control-tower-seed-funky',
      responseMode: 'responseNode',
      options: {},
    },
    id: 'e7c74dcf-f38a-49c1-87ef-d9ac94d7ac82',
    name: 'Seed Funky CRM',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [-660, 520],
    webhookId: 'gtm-control-tower-seed-funky',
  },
  {
    parameters: {
      authentication: 'serviceAccount',
      operation: 'executeQuery',
      projectId: { mode: 'id', value: PROJECT_TOKEN },
      sqlQuery: seedSql,
      options: {
        location: 'US',
        maximumBytesBilled: '100000000',
        returnAsNumbers: true,
        timeoutMs: 30000,
      },
    },
    id: '38b780d8-f280-42da-86bf-d750b3d34f58',
    name: 'Reset Funky CRM State',
    type: 'n8n-nodes-base.googleBigQuery',
    typeVersion: 2.1,
    position: [-400, 520],
  },
  {
    parameters: {
      respondWith: 'json',
      responseBody: "={{ { accepted: true, status: 'seeded', batch: $json.seed_batch, contacts: Number($json.contact_count), dirtyRecords: Number($json.dirty_records) } }}",
      options: { responseCode: 201 },
    },
    id: 'a654635f-1d92-4e97-a893-3810483e1046',
    name: 'Return Seed Receipt',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.4,
    position: [-140, 520],
  },
);

workflow.connections['Validate Repair'] = {
  main: [[{ node: 'Execute Repair Worker', type: 'main', index: 0 }]],
};
delete workflow.connections['Record Repair in BigQuery'];
workflow.connections['Execute Repair Worker'] = {
  main: [[{ node: 'Return Repair Receipt', type: 'main', index: 0 }]],
};
workflow.connections['Seed Funky CRM'] = {
  main: [[{ node: 'Reset Funky CRM State', type: 'main', index: 0 }]],
};
workflow.connections['Reset Funky CRM State'] = {
  main: [[{ node: 'Return Seed Receipt', type: 'main', index: 0 }]],
};

for (const workflowNode of workflow.nodes) {
  if (workflowNode.type !== 'n8n-nodes-base.googleBigQuery') continue;
  if (workflowNode.parameters.projectId) workflowNode.parameters.projectId.value = PROJECT_TOKEN;
  if (workflowNode.parameters.datasetId) workflowNode.parameters.datasetId.value = DATASET_TOKEN;
}

await writeFile(workflowPath, `${JSON.stringify(stripWorkflowCredentials(workflow), null, 2)}\n`);
