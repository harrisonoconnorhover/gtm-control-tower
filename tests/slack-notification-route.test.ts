import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const service = vi.hoisted(() => ({ getSlackNotificationStatus: vi.fn(), deliverSlackNotifications: vi.fn(), enqueueSlackNotification: vi.fn(), getSlackNotificationEventState: vi.fn() }));
vi.mock('@/lib/slack-notifications', () => service);
import { GET, POST } from '@/app/api/control-tower/notifications/slack/route';

const status = { configured: true, enabled: true, error: null, pending: 0, sending: 0, delivered: 3, failed: 0, unknown: 0, nextAttemptAt: null, lastDelivery: null };
function request(body?: unknown, key = 'fixture-key') { return new Request('http://localhost/api/control-tower/notifications/slack', { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-control-tower-key': key }, body: body ? JSON.stringify(body) : undefined }); }
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('CONTROL_TOWER_SYNC_KEY', 'fixture-key'); vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'true');
  service.getSlackNotificationStatus.mockResolvedValue(status); service.deliverSlackNotifications.mockResolvedValue(status); service.getSlackNotificationEventState.mockResolvedValue('pending');
});
afterEach(() => vi.unstubAllEnvs());

describe('private Slack notification endpoint', () => {
  it('protects status and sends, and polling never sends a message', async () => {
    expect((await GET(request(undefined, 'wrong'))).status).toBe(401);
    expect((await POST(request({ action: 'test' }, 'wrong'))).status).toBe(401);
    expect(service.getSlackNotificationStatus).not.toHaveBeenCalled();
    const response = await GET(request()); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(service.deliverSlackNotifications).not.toHaveBeenCalled(); expect(service.enqueueSlackNotification).not.toHaveBeenCalled();
  });
  it('never accepts client-provided recipients, content, or approval actions', async () => {
    for (const body of [{ action: 'test', webhook: 'https://hostile.example' }, { action: 'deliver', text: 'unexpected' }, { action: 'approve' }]) expect((await POST(request(body))).status).toBe(400);
    expect(service.deliverSlackNotifications).not.toHaveBeenCalled();
  });
  it('reports exact test delivery rather than a previous successful digest', async () => {
    let response = await POST(request({ action: 'test' }));
    expect(await response.json()).toMatchObject({ outcome: 'queued' });
    expect(service.enqueueSlackNotification).toHaveBeenCalledWith(expect.objectContaining({ provider: 'system', path: '/app/work', title: 'Slack connection test' }));
    service.getSlackNotificationEventState.mockResolvedValue('unknown');
    response = await POST(request({ action: 'test' })); expect(await response.json()).toMatchObject({ outcome: 'unknown' });
    service.getSlackNotificationEventState.mockResolvedValue('delivered');
    response = await POST(request({ action: 'test' })); expect(await response.json()).toMatchObject({ outcome: 'delivered' });
  });
  it('shows disabled configuration and rate limits without claiming sent', async () => {
    service.getSlackNotificationStatus.mockResolvedValue({ ...status, configured: false, enabled: false });
    expect((await POST(request({ action: 'test' }))).status).toBe(503); expect(service.enqueueSlackNotification).not.toHaveBeenCalled();
    service.getSlackNotificationStatus.mockResolvedValue(status);
    service.deliverSlackNotifications.mockResolvedValue({ ...status, pending: 1, nextAttemptAt: new Date(Date.now() + 60000).toISOString(), lastDelivery: { state: 'rate_limited' } });
    expect(await (await POST(request({ action: 'test' }))).json()).toMatchObject({ outcome: 'rate_limited' });
    vi.stubEnv('CONTROL_TOWER_PERSISTENCE_ENABLED', 'false'); expect((await GET(request())).status).toBe(503);
  });
});
