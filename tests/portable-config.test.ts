import { describe, expect, it } from 'vitest';
import {
  renderPortableText,
  renderWorkflow,
  stripWorkflowCredentials,
  validateWarehouseConfig,
} from '../scripts/lib/portable-assets.mjs';

describe('portable release assets', () => {
  it('validates safe Google Cloud and BigQuery identifiers', () => {
    expect(validateWarehouseConfig('sample-project-123', 'revenue_ops')).toEqual({
      projectId: 'sample-project-123',
      datasetId: 'revenue_ops',
    });
    expect(() => validateWarehouseConfig('UPPER CASE', 'revenue_ops')).toThrow();
    expect(() => validateWarehouseConfig('sample-project-123', 'has-a-dash')).toThrow();
  });

  it('renders every portable warehouse token', () => {
    const rendered = renderPortableText(
      '`__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.raw_crm_events`',
      { projectId: 'sample-project-123', datasetId: 'revenue_ops' },
    );
    expect(rendered).toBe('`sample-project-123.revenue_ops.raw_crm_events`');
  });

  it('removes credential bindings from n8n templates', () => {
    const workflow = stripWorkflowCredentials({
      active: true,
      nodes: [{ name: 'Warehouse', credentials: { googleApi: { id: 'private' } } }],
    });
    expect(workflow.active).toBe(false);
    expect(workflow.nodes[0]).not.toHaveProperty('credentials');
  });

  it('renders credential-free n8n workflows', () => {
    const rendered = renderWorkflow(JSON.stringify({
      active: true,
      nodes: [{
        parameters: { projectId: '__GCP_PROJECT_ID__', datasetId: '__BIGQUERY_SOURCE_DATASET__' },
        credentials: { googleApi: { id: 'private' } },
      }],
    }), { projectId: 'sample-project-123', datasetId: 'revenue_ops' });
    expect(rendered.nodes[0].parameters).toEqual({
      projectId: 'sample-project-123',
      datasetId: 'revenue_ops',
    });
    expect(rendered.nodes[0]).not.toHaveProperty('credentials');
  });
});
