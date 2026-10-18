import { operatorAccessError } from '@/lib/operator-auth';
import { getWorkspace, persistenceEnabled } from '@/lib/workspace-store';
import { validateHubSpotImportBinding } from '@/lib/hubspot-import';
import { readHubSpotImportSchema, readHubSpotImportLookups } from '@/lib/hubspot-import-read';
import { buildHubSpotImportDryRun } from '@/lib/hubspot-import-preview';
import { hubspotImportFingerprint, readHubSpotImportReview, saveHubSpotImportReview } from '@/lib/hubspot-import-store';
import { previewNormalization, validateNormalizationSettings } from '@/lib/import-normalization';
import { isCrmReadDeferredError } from '@/lib/crm-read-transport';

const headers = { 'Cache-Control': 'no-store' };
const token = () => process.env.HUBSPOT_IMPORT_READ_TOKEN?.trim() || process.env.HUBSPOT_ACCESS_TOKEN?.trim();

export async function GET(request: Request) {
  const denied = operatorAccessError(request);
  if (denied) return denied;
  if (!persistenceEnabled()) return failure(new Error('Persistent workspaces are required.'), 503);
  try {
    const query = new URL(request.url).searchParams;
    if (query.get('action') === 'schema') {
      const credential = token();
      if (!credential) return failure(new Error('Connect HubSpot using HUBSPOT_IMPORT_READ_TOKEN or the existing HUBSPOT_ACCESS_TOKEN on the self-hosted server.'), 503);
      return Response.json({ schema: await readHubSpotImportSchema(credential, request.signal) }, { headers });
    }
    const id = query.get('workspaceId');
    if (!id) return failure(new Error('Workspace ID is required.'));
    const workspace = await getWorkspace(id);
    if (!workspace) return failure(new Error('Workspace not found.'), 404);
    const review = await readHubSpotImportReview(id);
    return Response.json({ review, stale: Boolean(review && (review.workspaceRevision !== workspace.revision
      || review.fingerprint !== hubspotImportFingerprint(workspace.state, workspace.state.hubspotBinding, validateNormalizationSettings(workspace.state.normalizationSettings), review.policy))) }, { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const denied = operatorAccessError(request);
  if (denied) return denied;
  if (!persistenceEnabled()) return failure(new Error('Persistent workspaces are required.'), 503);
  const credential = token();
  if (!credential) return failure(new Error('Connect HubSpot before preparing a dry run.'), 503);
  try {
    const input = await request.json() as Record<string, unknown>;
    if (!input || typeof input.workspaceId !== 'string') throw new Error('Choose a saved workspace.');
    const workspace = await getWorkspace(input.workspaceId);
    if (!workspace) return failure(new Error('Workspace not found.'), 404);
    if (input.workspaceRevision !== workspace.revision) return failure(new Error('The workspace changed. Reload it before preparing a dry run.'), 409);
    if (!workspace.state.contacts.length || workspace.state.contacts.length > 500) throw new Error('A HubSpot dry run supports 1–500 source rows. Split larger imports into smaller saved workspaces.');
    const binding = validateHubSpotImportBinding(input.binding, workspace.state.importObject ?? 'contact', workspace.state.customFields ?? []);
    if (!binding || !Object.keys(binding.fields).length) throw new Error('Load HubSpot fields and map at least one property.');
    const settings = validateNormalizationSettings(input.normalizationSettings ?? workspace.state.normalizationSettings);
    const policy = input.policy ?? 'fill-empty';
    if (policy !== 'fill-empty' && policy !== 'overwrite') throw new Error('Choose fill-empty or overwrite for the dry run.');
    const schema = await readHubSpotImportSchema(credential, request.signal);
    if (schema.portalId !== binding.portalId) return failure(new Error('This template belongs to a different HubSpot portal. Review and save mappings for the connected portal.'), 409);
    const normalized = previewNormalization(workspace.state.contacts, settings, workspace.state.customFields ?? []);
    const lookups = await readHubSpotImportLookups(credential, normalized.contacts, binding, request.signal);
    const fingerprint = hubspotImportFingerprint(workspace.state, binding, settings, policy);
    const review = buildHubSpotImportDryRun({ workspaceId: workspace.id, workspaceRevision: workspace.revision, fingerprint,
      originalContacts: workspace.state.originalContacts, contacts: normalized.contacts, customFields: workspace.state.customFields ?? [], binding, schema, lookups, normalizedChanges: normalized.changes.length, policy });
    review.warnings.push(...[...new Set(normalized.warnings.map((warning) => warning.reason))]);
    const latest = await getWorkspace(workspace.id);
    if (!latest || latest.revision !== workspace.revision || hubspotImportFingerprint(latest.state, binding, settings, policy) !== fingerprint) return failure(new Error('The workspace changed during the dry run. Prepare a new review.'), 409);
    await saveHubSpotImportReview(review);
    return Response.json({ review }, { headers });
  } catch (error) { return failure(error); }
}

function failure(error: unknown, status = 400) {
  if (isCrmReadDeferredError(error)) return Response.json({ error: error.message, retryAt: error.retryAt }, { status: 429, headers });
  return Response.json({ error: error instanceof Error ? error.message : 'HubSpot import review failed.' }, { status, headers });
}
