import type { ConnectorReceipt } from './connector-contract';
import type { LiveContactState } from './live-control-tower';

export type GoogleSheetsPreviewRequest = {
  action: 'preview';
  spreadsheetId: string;
  sourceSheet: string;
};

export type GoogleSheetsWriteRequest = {
  action: 'execute';
  spreadsheetId: string;
  destinationSheet: 'GTM Clean';
  contacts: LiveContactState[];
};

export type GoogleSheetsPreview = {
  headers: string[];
  rows: Record<string, string>[];
  receipt: ConnectorReceipt;
};

export type GoogleSheetsWriteResult = {
  receipt: ConnectorReceipt;
};

export function isGoogleSheetsPreviewRequest(value: unknown): value is GoogleSheetsPreviewRequest {
  return isRecord(value)
    && value.action === 'preview'
    && validSpreadsheetId(value.spreadsheetId)
    && validSheetName(value.sourceSheet);
}

export function isGoogleSheetsWriteRequest(value: unknown): value is GoogleSheetsWriteRequest {
  return isRecord(value)
    && value.action === 'execute'
    && validSpreadsheetId(value.spreadsheetId)
    && value.destinationSheet === 'GTM Clean'
    && Array.isArray(value.contacts)
    && value.contacts.length > 0
    && value.contacts.length <= 1_000;
}

export function tabularRowsToCsv(headers: string[], rows: Record<string, string>[]): string {
  return [headers, ...rows.map((row) => headers.map((header) => String(row[header] ?? '')))]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\n');
}

function validSpreadsheetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{20,200}$/u.test(value);
}

function validSheetName(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 100
    && !/[\\/?*\[\]:]/u.test(value);
}

function escapeCsvCell(value: string): string {
  if (!/[",\n\r]/u.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
