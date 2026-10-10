import { operatorAccessError } from './operator-auth';

/** Investigators can read evidence and save explanations, never alter rules, approve, or run repairs. */
export function incidentAccess(request: Request): { role: 'operator' | 'investigator' } | Response {
  const supplied = request.headers.get('x-control-tower-investigator-key');
  if (supplied !== null) {
    const expected = process.env.CONTROL_TOWER_INVESTIGATOR_KEY;
    if (!expected || expected === process.env.CONTROL_TOWER_SYNC_KEY || !equal(supplied, expected)) {
      return Response.json({ error: 'The investigator access key is invalid or not separately configured.' }, { status: 401 });
    }
    return { role: 'investigator' };
  }
  return operatorAccessError(request) ?? { role: 'operator' };
}

function equal(left: string, right: string) {
  let different = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) different |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return different === 0;
}
