import { NextResponse } from 'next/server';
import { isSeedReceipt } from '@/lib/live-control-tower';

const LOCAL_FUNKY_URL = 'http://localhost:5678/webhook/gtm-control-tower-seed-funky';

export async function POST() {
  const webhookUrl = process.env.N8N_FUNKY_WEBHOOK_URL
    ?? (process.env.NODE_ENV === 'development' ? LOCAL_FUNKY_URL : null);

  if (!webhookUrl) {
    return NextResponse.json(
      { error: 'The funky CRM lab is not configured.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`n8n returned ${response.status}`);

    const receipt: unknown = await response.json();
    if (!isSeedReceipt(receipt)) throw new Error('n8n returned an invalid seed receipt');

    return NextResponse.json(receipt, {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('Control Tower funky batch reset failed', error);
    return NextResponse.json(
      { error: 'The synthetic CRM batch could not be reset.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
