process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/urlSafety', () => ({
  checkOutboundUrl: jest.fn(async () => ({ ok: true })),
}));
const mockFetchT = jest.fn();
jest.mock('../lib/fetch', () => ({
  fetchT: (...args: unknown[]) => mockFetchT(...args),
}));

import db from '../db/loader';
import OutgoingWebhooks from '../db/repositories/OutgoingWebhookRepository';
import { processOutgoingWebhookDeliveries } from '../routes/outgoingWebhooks';
import { requireDoc } from './helpers/mockDb';

describe('outgoing webhook durable delivery', () => {
  beforeEach(() => {
    (db as any)._reset?.();
    mockFetchT.mockReset();
    mockFetchT.mockResolvedValue({ ok: true, status: 204 });
  });

  async function seedWebhook(overrides: Record<string, unknown> = {}) {
    return db.outgoingWebhooks.insert({
      _id: 'wh-1', serverId: 's1', name: 'hook', url: 'https://example.com/hook',
      events: ['message:new'], secret: 'secret', enabled: true, createdBy: 'u1',
      createdAt: Date.now(), consecutiveFailures: 0, ...overrides,
    } as never);
  }

  it('bounds pending rows per webhook instead of growing without limit', async () => {
    await seedWebhook();
    expect(await OutgoingWebhooks.enqueueDeliveryBounded('wh-1', 's1', 'message:new', { n: 1 }, 2)).toBeTruthy();
    expect(await OutgoingWebhooks.enqueueDeliveryBounded('wh-1', 's1', 'message:new', { n: 2 }, 2)).toBeTruthy();
    expect(await OutgoingWebhooks.enqueueDeliveryBounded('wh-1', 's1', 'message:new', { n: 3 }, 2)).toBeNull();
    expect(await db.outgoingWebhookDeliveries.find({ webhookId: 'wh-1' } as never)).toHaveLength(2);
  });

  it('two concurrent workers cannot claim the same durable row', async () => {
    await seedWebhook();
    await OutgoingWebhooks.enqueueDeliveryBounded('wh-1', 's1', 'message:new', { ok: true });
    const now = Date.now() + 10;
    const [a, b] = await Promise.all([
      OutgoingWebhooks.claimDueDeliveries(now, 'worker-a', 120_000, 10),
      OutgoingWebhooks.claimDueDeliveries(now, 'worker-b', 120_000, 10),
    ]);
    expect([a.length, b.length].sort()).toEqual([0, 1]);
  });

  it('uses the durable row id as a stable delivery id and ACKs only after success', async () => {
    await seedWebhook();
    const deliveryId = await OutgoingWebhooks.enqueueDeliveryBounded('wh-1', 's1', 'message:new', { messageId: 'm1' });
    expect(deliveryId).toBeTruthy();
    await processOutgoingWebhookDeliveries();

    expect(mockFetchT).toHaveBeenCalledTimes(1);
    const options = mockFetchT.mock.calls[0][1] as { headers: Record<string, string> };
    expect(options.headers['X-Bridge-Delivery']).toBe(deliveryId);
    expect(await db.outgoingWebhookDeliveries.find({} as never)).toHaveLength(0);
    const wh = await db.outgoingWebhooks.findOne({ _id: 'wh-1' } as never);
    expect(wh?.consecutiveFailures).toBe(0);
    expect(wh?.lastStatus).toBe(204);
  });

  it('HTTP 5xx counts as a failure and remains retryable', async () => {
    await seedWebhook();
    mockFetchT.mockResolvedValue({ ok: false, status: 503 });
    await OutgoingWebhooks.enqueueDeliveryBounded('wh-1', 's1', 'message:new', { messageId: 'm2' });
    await processOutgoingWebhookDeliveries();

    const wh = await db.outgoingWebhooks.findOne({ _id: 'wh-1' } as never);
    expect(wh?.consecutiveFailures).toBe(1);
    expect(wh?.lastStatus).toBe(503);
    const rows = await db.outgoingWebhookDeliveries.find({ webhookId: 'wh-1' } as never);
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].claimOwner).toBeNull();
    expect(rows[0].nextAt).toBeGreaterThan(Date.now());
  });

  it('fallback claim rejects a non-canonical durable lease instead of treating it as due', async () => {
    await seedWebhook();
    const id = await OutgoingWebhooks.enqueueDeliveryBounded('wh-1', 's1', 'message:new', {});
    await db.outgoingWebhookDeliveries.update({ _id: id } as never, { $set: { claimUntil: '1e3' } } as never);
    await expect(OutgoingWebhooks.claimDueDeliveries(Date.now() + 10, 'worker-a')).rejects.toThrow(/persisted epoch timestamp/);
  });

  it.each(['01','1e3',' 9'])('fallback failure counter rejects non-canonical persisted state %p', async (consecutiveFailures) => {
    await seedWebhook({ consecutiveFailures });
    await expect(OutgoingWebhooks.recordDeliveryFailure('wh-1', 500, 'upstream failed')).rejects.toThrow(/failure count/);
  });

  it('atomically disables a webhook after the failure threshold', async () => {
    await seedWebhook({ consecutiveFailures: 9 });
    const state = await OutgoingWebhooks.recordDeliveryFailure('wh-1', 500, 'upstream failed');
    expect(state?.consecutiveFailures).toBe(10);
    expect(state?.enabled).toBe(false);
  });


  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects malformed pending cap %p before enqueue', async (cap) => {
    await seedWebhook();
    await expect(OutgoingWebhooks.enqueueDeliveryBounded('wh-1', 's1', 'message:new', {}, cap)).rejects.toThrow(/pending cap/);
    expect(await db.outgoingWebhookDeliveries.find({ webhookId: 'wh-1' } as never)).toHaveLength(0);
  });

  it.each([
    [-1, 'worker', 120000, 10],
    [Date.now(), '', 120000, 10],
    [Date.now(), 'worker', 1.5, 10],
    [Date.now(), 'worker', 120000, 0],
  ])('rejects malformed durable claim parameters', async (now, owner, lease, limit) => {
    await expect(OutgoingWebhooks.claimDueDeliveries(now as number, owner as string, lease as number, limit as number)).rejects.toThrow(/Invalid outgoing webhook/);
  });

  it('malformed retry state cannot corrupt the durable queue', async () => {
    await seedWebhook();
    const id = String(await OutgoingWebhooks.enqueueDeliveryBounded('wh-1', 's1', 'message:new', {}));
    await OutgoingWebhooks.claimDueDeliveries(Date.now() + 1, 'worker-a');
    await expect(OutgoingWebhooks.retryDelivery(id, 'worker-a', -1, Date.now(), 'bad')).rejects.toThrow(/retry attempts/);
    await expect(OutgoingWebhooks.completeDelivery(id, '')).rejects.toThrow(/claim owner/);
    expect(await db.outgoingWebhookDeliveries.findOne({ _id: id } as never)).not.toBeNull();
  });

  it.each([[-1], [600], [1.5]])('rejects impossible delivery status %p', async (status) => {
    await seedWebhook();
    await expect(OutgoingWebhooks.recordDeliveryFailure('wh-1', status as number, 'bad')).rejects.toThrow(/status/);
  });
});
