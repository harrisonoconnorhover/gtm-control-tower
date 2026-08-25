import { NextResponse } from 'next/server';
import { isLiveControlTowerState } from '@/lib/live-control-tower';

const LOCAL_STATE_URL = 'http://localhost:5678/webhook/gtm-control-tower-state';

export async function GET() {
  const webhookUrl = process.env.N8N_STATE_WEBHOOK_URL
    ?? (process.env.NODE_ENV === 'development' ? LOCAL_STATE_URL : null);

  if (!webhookUrl) {
    return NextResponse.json(
      { error: 'The live warehouse connector is not configured.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const response = await fetch(webhookUrl, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`n8n returned ${response.status}`);

    const state: unknown = await response.json();
    if (!isLiveControlTowerState(state)) throw new Error('n8n returned an invalid state contract');

    return NextResponse.json(state, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('Control Tower state refresh failed', error);
    return NextResponse.json(
      { error: 'The live warehouse is temporarily unavailable.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
