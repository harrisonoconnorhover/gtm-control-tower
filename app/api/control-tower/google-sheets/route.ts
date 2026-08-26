import { NextResponse } from 'next/server';
import {
  isGoogleSheetsPreviewRequest,
  isGoogleSheetsWriteRequest,
  parseGoogleSheetsN8nWriteReceipt,
  type GoogleSheetsPreview,
  type GoogleSheetsWriteResult,
} from '@/lib/google-sheets';
import type { ConnectorReceipt } from '@/lib/connector-contract';

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'A JSON body is required.' }, { status: 400 });
  }
  if (isGoogleSheetsPreviewRequest(payload)) return previewSheet(payload);
  if (isGoogleSheetsWriteRequest(payload)) return writeSheet(payload);
  return NextResponse.json({ error: 'The Google Sheets request is invalid.' }, { status: 400 });
}

async function previewSheet(payload: { spreadsheetId: string; sourceSheet: string }) {
  const webhookUrl = process.env.N8N_GOOGLE_SHEETS_READ_WEBHOOK_URL;
  if (!webhookUrl) return notConfigured();
  try {
    const response = await callN8n(webhookUrl, payload);
    const rows = rowsFromResponse(response);
    const headers = unique(rows.flatMap((row) => Object.keys(row)));
    if (!rows.length || !headers.length) throw new Error('The worksheet did not return any tabular rows.');
    const result: GoogleSheetsPreview = {
      headers,
      rows,
      receipt: connectorReceipt('preview', `Read ${rows.length} rows from ${payload.sourceSheet}.`, rows.length),
    };
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Google Sheets preview failed', error);
    return NextResponse.json({ error: 'n8n could not read that Google worksheet.' }, { status: 502 });
  }
}

async function writeSheet(payload: { spreadsheetId: string; destinationSheet: 'GTM Clean'; contacts: unknown[] }) {
  const webhookUrl = process.env.N8N_GOOGLE_SHEETS_WRITE_WEBHOOK_URL;
  if (!webhookUrl) return notConfigured();
  try {
    const response = await callN8n(webhookUrl, payload);
    const nativeReceipt = parseGoogleSheetsN8nWriteReceipt(response);
    if (!nativeReceipt) throw new Error('n8n did not confirm an idempotent email-keyed upsert.');
    const written = nativeReceipt.recordsWritten;
    const result: GoogleSheetsWriteResult = {
      receipt: {
        ...connectorReceipt('execute', `Upserted ${written} clean rows to GTM Clean by normalized email; repeat runs update in place.`, undefined, written),
        nativeReceiptId: nativeReceipt.runId,
      },
    };
    return NextResponse.json(result, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Google Sheets write failed', error);
    return NextResponse.json({ error: 'n8n did not return a valid Google Sheets write receipt.' }, { status: 502 });
  }
}

async function callN8n(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`n8n returned ${response.status}`);
  return response.json();
}

function rowsFromResponse(value: unknown): Record<string, string>[] {
  const candidate = isRecord(value) && Array.isArray(value.rows) ? value.rows : value;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(isRecord).map((row) => Object.fromEntries(
    Object.entries(row).map(([key, cell]) => [key, cell === null || cell === undefined ? '' : String(cell)]),
  ));
}

function connectorReceipt(
  phase: 'preview' | 'execute',
  summary: string,
  recordsRead?: number,
  recordsWritten?: number,
): ConnectorReceipt {
  return {
    id: crypto.randomUUID(),
    connectorId: 'google-sheets',
    phase,
    status: 'executed',
    summary,
    recordsRead,
    recordsWritten,
    createdAt: new Date().toISOString(),
    undoAvailable: false,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function notConfigured() {
  return NextResponse.json({ error: 'Google Sheets through n8n is not configured.' }, { status: 503 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
