import { present, recordOf } from './helpers/narrow';
// server/tests/federation-delivery-queue-worker.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// FEDERASYON TESLİM KUYRUĞU — YENİDEN DENEME İŞÇİSİ VE AÇILIŞ KURTARMASI
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/federation-delivery-inbox-resolution.test.ts` tek bir teslimin
// çözümünü ve imzasını ölçer. Bu tamamlayıcı takım KUYRUĞU ölçer — bir mesajın
// sessizce kaybolabileceği ya da sonsuza dek dönebileceği yer:
//
//   · ZEHİRLİ SATIR. Ayrıştırılamayan bir yük ya da bozuk bir deneme sayacı
//     "sıfır deneme" DEĞİLDİR; böyle bir satır kuyruktan ÇIKARILIR, aksi hâlde
//     her 30 saniyede bir sonsuza kadar yeniden denenir.
//   · ÜST SINIR. Deneme sayısı tavana ulaşmışsa satır silinir; ağ isteği
//     yapılmaz.
//   · AÇILIŞ KURTARMASI bir yeniden denemedir: sayaç ARTAR. Artmasaydı,
//     tekrarlanan yeniden başlatmalar aynı teslimi aynı kuşakta sonsuza dek
//     tutardı.
//   · İŞÇİ ARIZASI kuyruğu boşaltmaz: satırlar kalıcıdır ve bir sonraki tur
//     yeniden dener.

'use strict';
process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'https://bridge.test';

const fetchT = jest.fn();
const warn = jest.fn();
const info = jest.fn();
const federation = {
  claimPendingDeliveries: jest.fn(async () => [] as Array<Record<string, unknown>>),
  removeDeliveryEntry: jest.fn(async () => undefined),
  // Urun `releaseDeliveryClaim(id, owner, doc)` cagirir; imza eksikti ve
  // cagri kaydindan `doc` OKUNAMIYORDU.
  releaseDeliveryClaim: jest.fn<Promise<unknown>, [id: string, claimOwner: string, doc: Record<string, unknown>]>(async () => undefined),
  upsertDeliveryEntry: jest.fn(async () => undefined),
  findApFollows: jest.fn(async () => [] as unknown),
};
const users = { getApPrivateKey: jest.fn(async () => null) };

jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { warn, info } }));
jest.mock('../db/repositories', () => ({ Federation: federation, Users: users }));

// startFederationDeliveryWorker() registers a 30s interval and a setImmediate
// recovery pass. Capture both so they can be driven deliberately instead of by wall
// clock, and so nothing keeps running between cases.
const realSetInterval = global.setInterval;
const realSetImmediate = global.setImmediate;
let workerTick: (() => unknown) | null = null;
let startupRecovery: (() => unknown) | null = null;

jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms: any) => {
  if (ms === 30_000) workerTick = fn;
  const handle = realSetInterval(() => undefined, 2 ** 30);
  return handle;
}) as never);
jest.spyOn(global, 'setImmediate').mockImplementation(((fn: any) => {
  startupRecovery = fn;
  return realSetImmediate(() => undefined);
}) as never);

const delivery = require('../routes/federation/delivery');
// P5 SH-01b: the worker starts explicitly (runtime.ts, after initSchema), not on import.
delivery.startFederationDeliveryWorker();

const ok = () => ({ ok: true, status: 200, json: async () => ({}) });
const fail = (status: number) => ({ ok: false, status, json: async () => ({}) });

const payload = (inboxUrl = 'https://remote.test/inbox') => ({
  inboxUrl, activity: { type: 'Create', id: 'act-1' }, fromUser: null,
});

function queueEntry(overrides: Record<string, unknown> = {}) {
  return { _id: 'q1', payload: payload(), attempts: 0, nextAt: 0, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchT.mockResolvedValue(ok());
  federation.claimPendingDeliveries.mockResolvedValue([]);
  federation.findApFollows.mockResolvedValue([]);
  users.getApPrivateKey.mockResolvedValue(null);
});

describe('the retry worker drains only rows it can act on', () => {
  it('is registered at the documented interval and unref\'d', () => {
    expect(workerTick).toBeInstanceOf(Function);
  });

  it('delivers a claimed row and removes it on success', async () => {
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ attempts: 1 })]);
    await workerTick!();

    expect(fetchT).toHaveBeenCalledTimes(1);
    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('q1', expect.any(String));
  });

  it('removes a row whose payload cannot be understood', async () => {
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ payload: { nope: true } })]);
    await workerTick!();

    expect(fetchT).not.toHaveBeenCalled();
    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('q1', expect.any(String));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.delivery.invalid_queue_payload' }), expect.any(String));
  });

  it('removes a row whose attempt counter is unusable', async () => {
    // A corrupt counter is poison, not "zero retries": treating it as zero
    // would loop the same row for ever.
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ attempts: 'lots' })]);
    await workerTick!();

    expect(fetchT).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.delivery.invalid_attempts' }), expect.any(String));
  });

  it('removes a row that already exhausted its attempts, without a network call', async () => {
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ attempts: 3 })]);
    await workerTick!();

    expect(fetchT).not.toHaveBeenCalled();
    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('q1', expect.any(String));
  });

  it('processes each claimed row independently', async () => {
    federation.claimPendingDeliveries.mockResolvedValue([
      queueEntry({ _id: 'poison', payload: 'not an object' }),
      queueEntry({ _id: 'good', attempts: 0 }),
    ]);
    await workerTick!();

    expect(fetchT).toHaveBeenCalledTimes(1);
    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('poison', expect.any(String));
    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('good', expect.any(String));
  });

  it('a claim query failure leaves the queue intact', async () => {
    federation.claimPendingDeliveries.mockRejectedValue(new Error('queue table offline'));
    await expect(workerTick!()).resolves.toBeUndefined();

    expect(federation.removeDeliveryEntry).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.delivery.retry_worker_failed' }), expect.any(String));
  });

  it('an empty claim does no further work', async () => {
    federation.claimPendingDeliveries.mockResolvedValue([]);
    await workerTick!();
    expect(fetchT).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});

describe('startup recovery re-enters the queue as a real retry', () => {
  it('announces what it recovered and advances the attempt counter', async () => {
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ attempts: 0 })]);
    fetchT.mockResolvedValue(fail(500));

    await startupRecovery!();

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.delivery.startup_recovery', count: 1 }), expect.any(String));
    // The stored attempt was 0 and the recovery retried it as 1, so repeated
    // restarts cannot pin a delivery at the same retry generation.
    expect(federation.releaseDeliveryClaim).toHaveBeenCalledWith(
      'q1', expect.any(String), expect.objectContaining({ attempts: 1 }));
  });

  it('removes a startup row with an unreadable payload', async () => {
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ payload: 42 })]);
    await startupRecovery!();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.delivery.invalid_startup_payload' }), expect.any(String));
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('removes a startup row with an unreadable attempt counter', async () => {
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ attempts: {} })]);
    await startupRecovery!();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.delivery.invalid_startup_attempts' }), expect.any(String));
  });

  it('removes a startup row that already exhausted its attempts', async () => {
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ attempts: 5 })]);
    await startupRecovery!();
    expect(fetchT).not.toHaveBeenCalled();
    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('q1', expect.any(String));
  });

  it('says nothing when there is nothing to recover', async () => {
    federation.claimPendingDeliveries.mockResolvedValue([]);
    await startupRecovery!();
    expect(info).not.toHaveBeenCalled();
  });

  it('a failing recovery leaves the rows for the retry worker', async () => {
    federation.claimPendingDeliveries.mockRejectedValue(new Error('queue table offline'));
    await expect(startupRecovery!()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.delivery.startup_recovery_failed' }), expect.any(String));
  });
});

describe('retry scheduling', () => {
  it('an unresolvable inbox re-queues rather than dropping the activity', async () => {
    fetchT.mockResolvedValue({ ok: true, status: 200, json: async () => ({ type: 'Note' }) });
    federation.claimPendingDeliveries.mockResolvedValue([
      queueEntry({ payload: payload('https://remote.test/notes/1'), attempts: 0 }),
    ]);

    await workerTick!();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.delivery.no_inbox' }), expect.any(String));
    expect(federation.releaseDeliveryClaim).toHaveBeenCalledWith(
      'q1', expect.any(String), expect.objectContaining({ attempts: 1 }));
  });

  it('a re-queued retry carries a bounded future schedule', async () => {
    fetchT.mockResolvedValue(fail(500));
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ attempts: 1 })]);

    // Final21 Faz 22 (19-38): saat SABİTLENİR. Ürün `nextAt = Date.now() + gecikme` yazar ve bu
    // denemenin gecikmesi TAM 600 000 ms'dir; eski iddia `before + 600_000` üst sınırını testin kendi
    // `Date.now()`una bağlıyordu — arada 1 ms geçince (kapsam enstrümantasyonu altında ölçüldü:
    // "Expected <= …419, Received …420") test düşüyordu. Final20'den devralınan bir yarış.
    const now = 1_800_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await workerTick!();
    } finally {
      clock.mockRestore();
    }

    const entry = recordOf(present(federation.releaseDeliveryClaim.mock.calls.at(-1), 'son cagri')[2], 'kuyruk kaydi');
    expect(entry.attempts).toBe(2);
    expect(entry.nextAt).toBeGreaterThan(now);
    expect(entry.nextAt).toBeLessThanOrEqual(now + 600_000);
  });

  it('the retry that reaches the ceiling deletes the row instead of re-queueing', async () => {
    fetchT.mockResolvedValue(fail(500));
    // Well below the ceiling: the failure is re-queued.
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ attempts: 1 })]);
    await workerTick!();
    expect(federation.releaseDeliveryClaim).toHaveBeenCalledTimes(1);

    federation.releaseDeliveryClaim.mockClear();
    federation.removeDeliveryEntry.mockClear();
    // One below the ceiling: this failure pushes it over and the row is dropped.
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ attempts: 2 })]);
    await workerTick!();

    expect(federation.releaseDeliveryClaim).not.toHaveBeenCalled();
    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('q1', expect.any(String));
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'federation.delivery.max_retries' }), expect.any(String));
  });

  it('a 410 Gone is permanent and is never retried', async () => {
    fetchT.mockResolvedValue(fail(410));
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ attempts: 1 })]);
    await workerTick!();

    expect(federation.releaseDeliveryClaim).not.toHaveBeenCalled();
    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('q1', expect.any(String));
  });

  it('a network failure re-queues with an advanced counter', async () => {
    fetchT.mockRejectedValue(new Error('connection reset'));
    federation.claimPendingDeliveries.mockResolvedValue([queueEntry({ attempts: 1 })]);
    await workerTick!();

    expect(federation.releaseDeliveryClaim).toHaveBeenCalledWith(
      'q1', expect.any(String), expect.objectContaining({ attempts: 2 }));
  });
});

describe('follower fan-out', () => {
  it('an actor with no followers does no work at all', async () => {
    federation.findApFollows.mockResolvedValue([]);
    await expect(delivery.fanOutActivityToFollowers({ _id: 'u1', username: 'ada' }, { type: 'Create' }))
      .resolves.toEqual({ followers: 0, failed: 0 });
    expect(federation.upsertDeliveryEntry).not.toHaveBeenCalled();
  });

  it('a repository that returns nothing is read as no followers', async () => {
    federation.findApFollows.mockResolvedValue(null as never);
    await expect(delivery.fanOutActivityToFollowers({ _id: 'u1', username: 'ada' }, { type: 'Create' }))
      .resolves.toEqual({ followers: 0, failed: 0 });
  });

  it('a thenable follower result is awaited before it is counted', async () => {
    federation.findApFollows.mockResolvedValue({
      then: (resolve: (v: unknown) => void) => resolve([{ actorInbox: 'https://remote.test/inbox' }]),
    } as never);
    fetchT.mockResolvedValue(ok());

    const result = await delivery.fanOutActivityToFollowers({ _id: 'u1', username: 'ada' }, { type: 'Create' });

    expect(result.followers).toBe(1);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
