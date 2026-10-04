'use strict';
process.env.NODE_ENV = 'test';
delete process.env.FEDERATION_DELIVERY_RETRY_DELAYS_MS;
process.env.INSTANCE_URL = 'https://bridge.test';

const fetchT = jest.fn();
const error = jest.fn();
const warn = jest.fn();
const info = jest.fn();
let queue: Record<string, any> | null = null;

const federation = {
  findBlacklist: jest.fn(async () => []),
  findWhitelist: jest.fn(async () => []),
  findApFollows: jest.fn(async () => []),
  upsertDeliveryEntry: jest.fn(async (id: string, doc: Record<string, unknown>) => {
    queue = { _id: id, ...doc };
  }),
  claimPendingDeliveries: jest.fn(async (before: number, owner: string) => {
    if (!queue || Number(queue.nextAt) > before) return [];
    return [{ ...queue, claimOwner: owner }];
  }),
  releaseDeliveryClaim: jest.fn(async (id: string, _owner: string, doc: Record<string, unknown>) => {
    queue = { _id: id, ...doc };
  }),
  removeDeliveryEntry: jest.fn(async () => { queue = null; }),
};
const users = { getApPrivateKey: jest.fn(async () => null) };

jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { error, warn, info } }));
jest.mock('../db/repositories', () => ({ Federation: federation, Users: users }));

const realSetInterval = global.setInterval;
let workerTick: (() => Promise<void>) | null = null;
jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms: any) => {
  if (ms === 30_000) workerTick = fn;
  return realSetInterval(() => undefined, 2 ** 30);
}) as never);

const delivery = require('../routes/federation/delivery');
delivery.startFederationDeliveryWorker();

const fail = () => ({ ok: false, status: 503, json: async () => ({}) });

afterAll(() => {
  delivery.stopFederationDeliveryWorker();
  jest.restoreAllMocks();
});

beforeEach(() => {
  queue = null;
  jest.clearAllMocks();
  fetchT.mockResolvedValue(fail());
  federation.findBlacklist.mockResolvedValue([]);
  federation.findWhitelist.mockResolvedValue([]);
});

describe('P6 default retry ceiling — exact attempt accounting', () => {
  it('uses 12 shipped delay slots and spans roughly 3.5 days', () => {
    const delays: number[] = delivery.DEFAULT_RETRY_DELAYS_MS;
    expect(delays).toHaveLength(12);
    expect(delays.reduce((sum, n) => sum + n, 0)).toBe(314_550_000);
    expect(delays[0]).toBe(30_000);
    expect(delays.at(-1)).toBe(86_400_000);
  });

  it('performs 1 initial + 12 retries = 13 network attempts, then dead-letters', async () => {
    expect(workerTick).toBeTruthy();
    const base = 1_800_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(base);
    try {
      await delivery.deliverApActivity(
        'https://remote.test/inbox',
        { type: 'Create', id: 'p6-retry-count', object: { type: 'Note', content: 'canary' } },
        null,
      );

      expect(fetchT).toHaveBeenCalledTimes(1); // initial attempt
      expect(queue).toEqual(expect.objectContaining({ attempts: 0 }));

      for (let retry = 1; retry <= 12; retry += 1) {
        expect(queue).not.toBeNull();
        const dueAt = Number(queue!.nextAt);
        clock.mockReturnValue(dueAt);
        await workerTick!();
        expect(fetchT).toHaveBeenCalledTimes(1 + retry);
        if (retry < 12) {
          expect(queue).toEqual(expect.objectContaining({ attempts: retry }));
        }
      }

      expect(fetchT).toHaveBeenCalledTimes(13);
      expect(queue).toBeNull();
      const dead = error.mock.calls.find(([fields]) => fields?.event === 'federation.delivery.max_retries');
      expect(dead).toBeTruthy();
      expect(dead![0]).toEqual(expect.objectContaining({
        attempts: 12,
        inboxHost: 'remote.test',
        activityType: 'Create',
        activityId: 'p6-retry-count',
      }));
      expect(JSON.stringify(dead![0])).not.toContain('canary');
    } finally {
      clock.mockRestore();
    }
  });
});
