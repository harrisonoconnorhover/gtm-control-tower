/** Observed website reachability only; never company, ICP or email qualification. */
export type WebsiteCheckResult = {
  url: string;
  finalUrl: string | null;
  status: 'reachable' | 'blocked' | 'timed_out' | 'failed' | 'needs_review' | 'invalid';
  method: 'http' | 'browser';
  httpStatus: number | null;
  title: string | null;
  detail: string;
  checkedAt: string;
};

export const WEBSITE_CHECK_BATCH_SIZE = 3;

/** Shared display/cache key. Public-network enforcement belongs to the server. */
export function normalizeWebsiteUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}
