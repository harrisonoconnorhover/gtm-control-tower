import { operatorAccessError } from '@/lib/operator-auth';
import { persistenceEnabled } from '@/lib/workspace-store';
import { getNextSafeImportJob } from '@/lib/safe-import-store';
import { continueSafeImportExecution } from '@/lib/safe-import-execution';

/** One durable approval per invocation. Incoming input cannot alter scope or create approval. */
export async function POST(request: Request) {
  const error = operatorAccessError(request);
  if (error) return error;
  const headers = { 'Cache-Control': 'no-store' };
  if (!persistenceEnabled()) return Response.json({ error: 'Safe Import requires persistent storage.' }, { status: 503, headers });
  try {
    const review = await getNextSafeImportJob();
    const execution = review ? await continueSafeImportExecution(review) : null;
    return Response.json({ execution, queued: execution?.status === 'running' }, { headers });
  } catch (failure) {
    return Response.json({ error: failure instanceof Error ? failure.message : 'The import worker could not complete. Saved sending or unknown records will not be resent.' }, { status: 409, headers });
  }
}
