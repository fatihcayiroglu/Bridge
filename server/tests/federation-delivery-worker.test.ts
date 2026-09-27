'use strict';
process.env.NODE_ENV = 'test';

jest.useFakeTimers();

const fetchT = jest.fn();
const warn = jest.fn();
const info = jest.fn();
const federation = {
  claimPendingDeliveries: jest.fn(),
  removeDeliveryEntry: jest.fn(async () => undefined),
  releaseDeliveryClaim: jest.fn(async () => undefined),
  upsertDeliveryEntry: jest.fn(async () => undefined),
};
const users = { getApPrivateKey: jest.fn(async () => null) };

jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { warn, info } }));
jest.mock('../db/repositories', () => ({ Federation: federation, Users: users }));
jest.mock('uuid', () => ({ v4: jest.fn(() => 'worker-uuid') }));

// Exercise the startup error arm as part of module lifecycle.
federation.claimPendingDeliveries.mockRejectedValueOnce(new Error('startup db unavailable'));
require('../routes/federation/delivery');

const validPayload = {
  inboxUrl: 'https://remote.example/inbox',
  activity: { type: 'Create', id: 'a1' },
  fromUser: null,
};

describe('federation durable retry worker', () => {
  beforeEach(() => {
    warn.mockClear();
    info.mockClear();
    fetchT.mockReset();
    federation.removeDeliveryEntry.mockClear();
    federation.releaseDeliveryClaim.mockClear();
    federation.upsertDeliveryEntry.mockClear();
  });

  afterAll(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('logs startup claim failure without dropping durable state', async () => {
    await jest.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.delivery.startup_recovery_failed' }),
      expect.any(String),
    );
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing inbox', { activity: { type: 'Create' } }],
    ['invalid activity', { inboxUrl: 'https://remote.example/inbox', activity: 'bad' }],
  ])('removes poison retry payload: %s', async (_label, payload) => {
    federation.claimPendingDeliveries.mockResolvedValueOnce([{ _id: 'poison', attempts: 0, payload }]);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('poison', 'federation:' + process.pid + ':worker-uuid');
  });

  it('releases a claimed retry with incremented attempt/backoff after transient failure', async () => {
    federation.claimPendingDeliveries.mockResolvedValueOnce([{ _id: 'retry-1', attempts: '1', payload: validPayload }]);
    fetchT.mockResolvedValueOnce({ ok: false, status: 503 });

    await jest.advanceTimersByTimeAsync(30_000);

    expect(federation.releaseDeliveryClaim).toHaveBeenCalledWith(
      'retry-1',
      'federation:' + process.pid + ':worker-uuid',
      expect.objectContaining({ attempts: 2, payload: validPayload, nextAt: expect.any(Number) }),
    );
    expect(federation.removeDeliveryEntry).not.toHaveBeenCalledWith('retry-1', expect.anything());
  });

  it('removes a delivery after the maximum retry attempt is exhausted', async () => {
    federation.claimPendingDeliveries.mockResolvedValueOnce([{ _id: 'retry-max', attempts: 2, payload: validPayload }]);
    fetchT.mockResolvedValueOnce({ ok: false, status: 503 });

    await jest.advanceTimersByTimeAsync(30_000);

    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('retry-max', 'federation:' + process.pid + ':worker-uuid');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'federation.delivery.max_retries' }), expect.any(String));
  });

  it('acknowledges a successful claimed delivery instead of requeueing it', async () => {
    federation.claimPendingDeliveries.mockResolvedValueOnce([{ _id: 'retry-ok', attempts: 0, payload: validPayload }]);
    fetchT.mockResolvedValueOnce({ ok: true, status: 202 });

    await jest.advanceTimersByTimeAsync(30_000);

    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('retry-ok', 'federation:' + process.pid + ':worker-uuid');
    expect(federation.releaseDeliveryClaim).not.toHaveBeenCalled();
  });

  it('logs periodic worker DB failure and leaves rows for a future retry', async () => {
    federation.claimPendingDeliveries.mockRejectedValueOnce(new Error('claim failed'));
    await jest.advanceTimersByTimeAsync(30_000);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.delivery.retry_worker_failed' }),
      expect.any(String),
    );
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
