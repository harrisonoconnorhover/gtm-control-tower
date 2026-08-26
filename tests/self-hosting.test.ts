import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isConnectorReceipt } from '../lib/connector-contract';
import {
  isGoogleSheetsPreviewRequest,
  isGoogleSheetsWriteRequest,
  tabularRowsToCsv,
} from '../lib/google-sheets';
import { emptyWorkspaceState, validateWorkspaceState } from '../lib/workspace';

describe('self-hosted connector foundation', () => {
  it('uses the same strict connector receipt shape for every adapter', () => {
    expect(isConnectorReceipt({
      id: 'run-1', connectorId: 'csv', phase: 'export', status: 'executed',
      summary: 'Exported 1 row.', createdAt: new Date().toISOString(), undoAvailable: false,
    })).toBe(true);
    expect(isConnectorReceipt({ connectorId: 'mystery' })).toBe(false);
  });

  it('validates Google Sheets preview and bounded write requests', () => {
    const spreadsheetId = '1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890';
    expect(isGoogleSheetsPreviewRequest({ action: 'preview', spreadsheetId, sourceSheet: 'Leads' })).toBe(true);
    expect(isGoogleSheetsPreviewRequest({ action: 'preview', spreadsheetId: 'short', sourceSheet: 'Leads' })).toBe(false);
    expect(isGoogleSheetsWriteRequest({
      action: 'execute', spreadsheetId, destinationSheet: 'GTM Clean', contacts: [{}],
    })).toBe(true);
    expect(isGoogleSheetsWriteRequest({
      action: 'execute', spreadsheetId, destinationSheet: 'Overwrite Source', contacts: [{}],
    })).toBe(false);
  });

  it('turns worksheet rows into quoted CSV for the shared mapping path', () => {
    expect(tabularRowsToCsv(['Name', 'Company'], [{ Name: 'Ada', Company: 'Engines, Inc.' }]))
      .toBe('Name,Company\nAda,"Engines, Inc."');
  });

  it('accepts an empty durable workspace and rejects oversized contact collections', () => {
    expect(validateWorkspaceState(emptyWorkspaceState())).toEqual(emptyWorkspaceState());
    const tooLarge = emptyWorkspaceState();
    tooLarge.contacts = Array.from({ length: 5_001 }, () => ({})) as never[];
    expect(() => validateWorkspaceState(tooLarge)).toThrow(/at most 5,000 contacts/);
  });

  it('ships inactive, credential-free n8n Google Sheets workflows', () => {
    for (const filename of ['google-sheets-read-workflow.json', 'google-sheets-write-workflow.json']) {
      const workflow = JSON.parse(readFileSync(new URL(`../integrations/n8n/${filename}`, import.meta.url), 'utf8'));
      expect(workflow.active).toBe(false);
      expect(workflow.nodes.every((node: { credentials?: unknown }) => !node.credentials)).toBe(true);
      expect(workflow.nodes.find((node: { type: string }) => node.type === 'n8n-nodes-base.webhook').webhookId).toBeTruthy();
    }
    const writeWorkflow = JSON.parse(readFileSync(new URL('../integrations/n8n/google-sheets-write-workflow.json', import.meta.url), 'utf8'));
    expect(writeWorkflow.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Ensure GTM Clean Worksheet', alwaysOutputData: true, onError: 'continueRegularOutput' }),
    ]));
    expect(writeWorkflow.nodes.find((node: { name: string }) => node.name === 'Prepare GTM Clean Rows').parameters.jsCode)
      .toContain('safeCell');
  });
});
