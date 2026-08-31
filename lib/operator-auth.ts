export function operatorAccessError(request: Request): Response | null {
  const requiredKey = process.env.CONTROL_TOWER_SYNC_KEY;
  if (process.env.NODE_ENV === 'production' && !requiredKey) {
    return Response.json({ error: 'Private CRM operations require CONTROL_TOWER_SYNC_KEY in production.' }, { status: 503 });
  }
  if (requiredKey && !safeEqual(request.headers.get('x-control-tower-key') ?? '', requiredKey)) {
    return Response.json({ error: 'The operator access key is invalid.' }, { status: 401 });
  }
  return null;
}

function safeEqual(left: string, right: string) {
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
