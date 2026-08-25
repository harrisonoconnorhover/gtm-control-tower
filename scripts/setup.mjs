import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  readSimpleEnv,
  renderPortableText,
  renderWorkflow,
  validateWarehouseConfig,
} from './lib/portable-assets.mjs';

const root = resolve(import.meta.dirname, '..');
const defaultOutput = resolve(root, '.runtime/generated');
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value.`);
  return args[index + 1];
}

if (args.includes('--help')) {
  console.log(`GTM Control Tower setup

Usage:
  npm run setup
  npm run setup -- --project your-gcp-project [--dataset gtm_control_tower] [--dbt-dataset gtm_control_tower_dbt]

Without a project, the CSV-only dashboard is ready immediately. With a project,
portable BigQuery SQL and n8n workflows are rendered under .runtime/generated.`);
  process.exit(0);
}

const fileEnv = await readSimpleEnv([
  resolve(root, '.env'),
  resolve(root, '.env.local'),
]);
const projectId = option('--project') ?? process.env.GOOGLE_CLOUD_PROJECT ?? fileEnv.GOOGLE_CLOUD_PROJECT;
const datasetId = option('--dataset') ?? process.env.BIGQUERY_SOURCE_DATASET ?? fileEnv.BIGQUERY_SOURCE_DATASET ?? 'gtm_control_tower';
const dbtDatasetId = option('--dbt-dataset') ?? process.env.DBT_BIGQUERY_DATASET ?? fileEnv.DBT_BIGQUERY_DATASET ?? 'gtm_control_tower_dbt';
const output = resolve(option('--output') ?? defaultOutput);

await mkdir(resolve(output, 'n8n'), { recursive: true });
const csvWorkflowSource = await readFile(resolve(root, 'integrations/n8n/csv-hubspot-sync-workflow.json'), 'utf8');
const csvWorkflow = JSON.parse(csvWorkflowSource);
for (const node of csvWorkflow.nodes ?? []) delete node.credentials;
csvWorkflow.active = false;
csvWorkflow.meta = { ...(csvWorkflow.meta ?? {}), templateCredsSetupCompleted: false };
await writeFile(
  resolve(output, 'n8n/csv-hubspot-sync-workflow.json'),
  `${JSON.stringify(csvWorkflow, null, 2)}\n`,
);

if (!projectId) {
  console.log('CSV-only mode is ready. Run `npm run dev`, then import a CSV in the contact lab.');
  console.log(`A credential-free HubSpot workflow was copied to ${resolve(output, 'n8n')}.`);
  console.log('Add --project YOUR_GCP_PROJECT later to render the BigQuery and n8n warehouse assets.');
  process.exit(0);
}

const config = { projectId, datasetId };
validateWarehouseConfig(projectId, dbtDatasetId);
await mkdir(resolve(output, 'bigquery'), { recursive: true });
await mkdir(resolve(output, 'dbt'), { recursive: true });

for (const filename of ['setup.sql', 'funky-crm-lab.sql', 'repair-worker.sql', 'state.sql']) {
  const source = await readFile(resolve(root, 'warehouse/bigquery', filename), 'utf8');
  await writeFile(resolve(output, 'bigquery', filename), renderPortableText(source, config));
}

for (const filename of ['lead-routing-workflow.json', 'control-tower-ops-workflow.json']) {
  const source = await readFile(resolve(root, 'integrations/n8n', filename), 'utf8');
  const workflow = renderWorkflow(source, config);
  await writeFile(resolve(output, 'n8n', filename), `${JSON.stringify(workflow, null, 2)}\n`);
}

await writeFile(
  resolve(output, 'dbt/profiles.yml'),
  await readFile(resolve(root, 'analytics/profiles.yml.example'), 'utf8'),
);

await writeFile(
  resolve(output, 'connection.env'),
  `GOOGLE_CLOUD_PROJECT=${projectId}\nBIGQUERY_SOURCE_DATASET=${datasetId}\nDBT_BIGQUERY_DATASET=${dbtDatasetId}\n`,
  { mode: 0o600 },
);

console.log(`Rendered BigQuery SQL and credential-free n8n workflows in ${output}.`);
console.log('Next: run bigquery/setup.sql, import the workflows, and bind your own credentials in n8n.');
