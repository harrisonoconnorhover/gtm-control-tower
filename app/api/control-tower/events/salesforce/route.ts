import { MonitorIntakeError, receiveSalesforceMonitorEvents } from '@/lib/monitor-events';

export async function POST(request: Request): Promise<Response> {
  try { return Response.json(await receiveSalesforceMonitorEvents(request), { status: 202, headers: { 'cache-control': 'no-store' } }); }
  catch (error) { return Response.json({ error: error instanceof MonitorIntakeError ? error.message : 'Native event persistence failed; retry delivery.' }, { status: error instanceof MonitorIntakeError ? error.status : 503, headers: { 'cache-control': 'no-store' } }); }
}
