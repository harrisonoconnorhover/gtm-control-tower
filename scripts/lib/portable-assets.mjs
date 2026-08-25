import { readFile } from 'node:fs/promises';

export const PROJECT_TOKEN = '__GCP_PROJECT_ID__';
export const DATASET_TOKEN = '__BIGQUERY_SOURCE_DATASET__';

const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const datasetPattern = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;

export function validateWarehouseConfig(projectId, datasetId = 'gtm_control_tower') {
  if (!projectPattern.test(projectId)) {
    throw new Error('Google Cloud project IDs must be 6-30 lowercase letters, digits, or hyphens.');
  }
  if (!datasetPattern.test(datasetId)) {
    throw new Error('BigQuery dataset IDs must start with a letter or underscore and contain only letters, digits, or underscores.');
  }
  return { projectId, datasetId };
}

export function renderPortableText(source, config) {
  const { projectId, datasetId } = validateWarehouseConfig(config.projectId, config.datasetId);
  const rendered = source
    .replaceAll(PROJECT_TOKEN, projectId)
    .replaceAll(DATASET_TOKEN, datasetId);

  if (rendered.includes(PROJECT_TOKEN) || rendered.includes(DATASET_TOKEN)) {
    throw new Error('A portable configuration token was left unresolved.');
  }
  return rendered;
}

export function stripWorkflowCredentials(workflow) {
  const portable = structuredClone(workflow);
  for (const node of portable.nodes ?? []) delete node.credentials;
  portable.active = false;
  portable.meta = { ...(portable.meta ?? {}), templateCredsSetupCompleted: false };
  return portable;
}

export function renderWorkflow(source, config) {
  const workflow = JSON.parse(renderPortableText(source, config));
  return stripWorkflowCredentials(workflow);
}

export async function readSimpleEnv(paths) {
  const values = {};
  for (const path of paths) {
    try {
      const source = await readFile(path, 'utf8');
      for (const line of source.split(/\r?\n/u)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
        if (!match) continue;
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        values[match[1]] = value;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return values;
}
