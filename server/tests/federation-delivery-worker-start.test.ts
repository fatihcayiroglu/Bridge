// server/tests/federation-delivery-worker-start.test.ts
//
// P5 SH-01b — the durable delivery worker must not start on import.
//
// Measured on a fresh install (self-host harness, SH-FRESH-04): the startup
// recovery pass ran when routes were imported — before initSchema applied the
// migration chain — and logged `relation "ap_delivery_queue" does not exist`.
// On an upgrade it left queued deliveries to the next 30 s tick. runtime.ts now
// starts the worker after the schema is ready.

const federation = { claimPendingDeliveries: jest.fn(async () => [] as unknown[]) };
jest.mock('../lib/fetch', () => ({ fetchT: jest.fn() }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn() } }));
jest.mock('../db/repositories', () => ({ Federation: federation, Users: {} }));

describe('federation delivery worker lifecycle (P5 SH-01b)', () => {
  it('importing the module schedules nothing and touches no table', async () => {
    const intervals = jest.spyOn(global, 'setInterval');
    const immediates = jest.spyOn(global, 'setImmediate');
    try {
      jest.isolateModules(() => { require('../routes/federation/delivery'); });
      await new Promise((r) => setTimeout(r, 20));
      expect(intervals.mock.calls.filter(c => c[1] === 30_000)).toHaveLength(0);
      expect(immediates).not.toHaveBeenCalled();
      expect(federation.claimPendingDeliveries).not.toHaveBeenCalled();
    } finally {
      intervals.mockRestore();
      immediates.mockRestore();
    }
  });

  it('start runs one recovery pass and registers one worker, however often it is called; stop clears it', async () => {
    let mod!: { startFederationDeliveryWorker(): void; stopFederationDeliveryWorker(): void };
    jest.isolateModules(() => { mod = require('../routes/federation/delivery'); });
    const intervals = jest.spyOn(global, 'setInterval');
    const cleared = jest.spyOn(global, 'clearInterval');
    try {
      mod.startFederationDeliveryWorker();
      mod.startFederationDeliveryWorker();
      await new Promise((r) => setImmediate(r));
      expect(intervals.mock.calls.filter(c => c[1] === 30_000)).toHaveLength(1);
      expect(federation.claimPendingDeliveries).toHaveBeenCalledTimes(1);
      mod.stopFederationDeliveryWorker();
      expect(cleared).toHaveBeenCalledTimes(1);
    } finally {
      mod.stopFederationDeliveryWorker();
      intervals.mockRestore();
      cleared.mockRestore();
    }
  });
});
