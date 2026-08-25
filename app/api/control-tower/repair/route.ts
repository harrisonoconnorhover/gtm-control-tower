import { NextResponse } from 'next/server';
import { isRepairReceipt, isScenarioKey } from '@/lib/live-control-tower';

const LOCAL_REPAIR_URL = 'http://localhost:5678/webhook/gtm-control-tower-repair';

export async function POST(request: Request) {
  const webhookUrl = process.env.N8N_REPAIR_WEBHOOK_URL
    ?? (process.env.NODE_ENV === 'development' ? LOCAL_REPAIR_URL : null);

  if (!webhookUrl) {
    return NextResponse.json(
      { error: 'The repair workflow is not configured.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'A JSON body is required.' }, { status: 400 });
  }

  const scenario = typeof body === 'object' && body !== null && 'scenario' in body
    ? body.scenario
    : null;
  if (!isScenarioKey(scenario)) {
    return NextResponse.json({ error: 'Unsupported repair scenario.' }, { status: 400 });
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ scenario, requestId: crypto.randomUUID() }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`n8n returned ${response.status}`);

    const receipt: unknown = await response.json();
    if (!isRepairReceipt(receipt)) throw new Error('n8n returned an invalid repair receipt');

    return NextResponse.json(receipt, {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('Control Tower repair failed', error);
    return NextResponse.json(
      { error: 'The repair could not be recorded. No dashboard state was changed.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
