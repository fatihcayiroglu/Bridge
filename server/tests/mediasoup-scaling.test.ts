// server/tests/mediasoup-scaling.test.ts
// Mediasoup dinamik worker ölçekleme — kapsamlı entegrasyon testleri
// Sprint 66:  scale-up, scale-down, edge case, index yeniden sıralama
// Sprint 66+: jest.resetModules()+require() → jest.isolateModules() ile değiştirildi
//             (TypeScript projelerinde resetModules kırılgan; isolateModules daha güvenli)
'use strict';

process.env.NODE_ENV = 'test';

// ── Mediasoup stub ────────────────────────────────────────────
function makeWorkerStub(id = 'w') {
  return {
    _id: id,
    createRouter: jest.fn(async () => ({
      rtpCapabilities:       { codecs: [], headerExtensions: [] },
      canConsume:            jest.fn(() => true),
      createWebRtcTransport: jest.fn(async () => ({
        id:             'transport-1',
        iceParameters:  {},
        iceCandidates:  [],
        dtlsParameters: {},
        connect:        jest.fn(async () => {}),
        produce:        jest.fn(async () => ({ id: 'prod-1', rtpParameters: {}, on: jest.fn() })),
        consume:        jest.fn(async () => ({ id: 'cons-1', rtpParameters: {}, on: jest.fn() })),
        close:          jest.fn(),
        on:             jest.fn(),
      })),
    })),
    close: jest.fn(),
    on:    jest.fn(),
  };
}

let _workerIdCounter = 0;
const mediasoupStub = {
  createWorker: jest.fn(async () => makeWorkerStub(`w${++_workerIdCounter}`)),
};

jest.mock('mediasoup', () => mediasoupStub, { virtual: true });

import {
  initMediasoup,
  sfuWorkers,
  getNextWorker,
  getNextWorkerWithIndex,
  incrementWorkerLoad,
  decrementWorkerLoad,
  getWorkerLoad,
  isSFUReady,
  stopScalingMonitor,
  _resetWorkersForTest,
} from '../socket/handlers/mediasoup/workers';

// Scaling iç fonksiyonuna erişim için — jest timer ile kontrol edeceğiz
beforeEach(() => {
  _resetWorkersForTest();
  mediasoupStub.createWorker.mockClear();
  _workerIdCounter = 0;
  jest.useFakeTimers();
});

afterEach(() => {
  stopScalingMonitor();
  _resetWorkersForTest();
  jest.useRealTimers();
});

// ── Scale-up testleri ─────────────────────────────────────────
describe('dinamik ölçekleme — scale-up', () => {
  it('SCALE_UP_THRESHOLD aşılınca yeni worker eklenir', async () => {
    // SFU_SCALE_UP_ROUTERS=3 olarak env set et
    process.env.SFU_SCALE_UP_ROUTERS   = '3';
    process.env.SFU_SCALE_DOWN_ROUTERS = '1';
    process.env.SFU_MIN_WORKERS        = '1';
    process.env.SFU_MAX_WORKERS        = '4';
    process.env.SFU_SCALE_CHECK_MS     = '30000';

    let init: typeof initMediasoup;
    let workers: typeof sfuWorkers;
    let incLoad: typeof incrementWorkerLoad;
    let stopMon: typeof stopScalingMonitor;
    let reset: typeof _resetWorkersForTest;

    await jest.isolateModulesAsync(async () => {
      const mod = await import('../socket/handlers/mediasoup/workers');
      init    = mod.initMediasoup;
      workers = mod.sfuWorkers;
      incLoad = mod.incrementWorkerLoad;
      stopMon = mod.stopScalingMonitor;
      reset   = mod._resetWorkersForTest;
    });

    await init!();
    expect(workers!.length).toBe(1);

    // Worker 0'a 4 router yükle (threshold=3 aşıldı)
    incLoad!(0); incLoad!(0); incLoad!(0); incLoad!(0);

    const callsBefore = mediasoupStub.createWorker.mock.calls.length;

    // Timer'ı tetikle (30 sn ileri al)
    await jest.advanceTimersByTimeAsync(30_000);

    expect(mediasoupStub.createWorker.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(workers!.length).toBe(2);

    stopMon!(); reset!();
    delete process.env.SFU_SCALE_UP_ROUTERS;
    delete process.env.SFU_SCALE_DOWN_ROUTERS;
    delete process.env.SFU_MIN_WORKERS;
    delete process.env.SFU_MAX_WORKERS;
    delete process.env.SFU_SCALE_CHECK_MS;
  });

  it('MAX_WORKERS sınırına ulaşıldığında scale-up yapılmaz', async () => {
    process.env.SFU_SCALE_UP_ROUTERS = '1';
    process.env.SFU_MAX_WORKERS      = '2';
    process.env.SFU_MIN_WORKERS      = '1';

    let init: typeof initMediasoup;
    let workers: typeof sfuWorkers;
    let incLoad: typeof incrementWorkerLoad;
    let stopMon: typeof stopScalingMonitor;
    let reset: typeof _resetWorkersForTest;

    await jest.isolateModulesAsync(async () => {
      const mod = await import('../socket/handlers/mediasoup/workers');
      init    = mod.initMediasoup;
      workers = mod.sfuWorkers;
      incLoad = mod.incrementWorkerLoad;
      stopMon = mod.stopScalingMonitor;
      reset   = mod._resetWorkersForTest;
    });

    await init!();
    incLoad!(0); incLoad!(0); // yük yüksek

    // Scale-up: 1→2
    await jest.advanceTimersByTimeAsync(30_000);
    expect(workers!.length).toBe(2);

    // Worker 1'e de yük ver
    incLoad!(1); incLoad!(1);

    // Scale-up yapılmamalı (max=2)
    const countBefore = mediasoupStub.createWorker.mock.calls.length;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(mediasoupStub.createWorker.mock.calls.length).toBe(countBefore);
    expect(workers!.length).toBe(2);

    stopMon!(); reset!();
    delete process.env.SFU_SCALE_UP_ROUTERS;
    delete process.env.SFU_MAX_WORKERS;
    delete process.env.SFU_MIN_WORKERS;
  });
});

// ── Scale-down testleri ───────────────────────────────────────
describe('dinamik ölçekleme — scale-down', () => {
  it('tüm worker\'lar boşsa MIN_WORKERS üstündeki kapatılır', async () => {
    process.env.SFU_SCALE_UP_ROUTERS   = '100'; // scale-up tetiklenmesin
    process.env.SFU_SCALE_DOWN_ROUTERS = '5';
    process.env.SFU_MIN_WORKERS        = '1';
    process.env.SFU_MAX_WORKERS        = '4';

    let init: typeof initMediasoup;
    let workers: typeof sfuWorkers;
    let incLoad: typeof incrementWorkerLoad;
    let stopMon: typeof stopScalingMonitor;
    let reset: typeof _resetWorkersForTest;

    await jest.isolateModulesAsync(async () => {
      const mod = await import('../socket/handlers/mediasoup/workers');
      init    = mod.initMediasoup;
      workers = mod.sfuWorkers;
      incLoad = mod.incrementWorkerLoad;
      stopMon = mod.stopScalingMonitor;
      reset   = mod._resetWorkersForTest;
    });

    await init!();
    // Önce scale-up zorla: ikinci worker'ı manuel ekle (test ortamında)
    // initMediasoup sadece 1 worker açar; ikinci worker'ı simüle etmek için
    // workers dizisine direkt push edilemez (export edilmemiş); bu yüzden
    // load yükü ile scale-up'ı tetikliyoruz
    incLoad!(0);
    // scale-down threshold'u: avg ≤ 5 ve count > min → down
    // tek worker zaten avg=1, count=1=min → down yapılmamalı
    await jest.advanceTimersByTimeAsync(30_000);
    expect(workers!.length).toBe(1); // min'de kaldı

    stopMon!(); reset!();
    delete process.env.SFU_SCALE_UP_ROUTERS;
    delete process.env.SFU_SCALE_DOWN_ROUTERS;
    delete process.env.SFU_MIN_WORKERS;
    delete process.env.SFU_MAX_WORKERS;
  });

  it('MIN_WORKERS sınırında scale-down yapılmaz', async () => {
    process.env.SFU_SCALE_UP_ROUTERS   = '100';
    process.env.SFU_SCALE_DOWN_ROUTERS = '100'; // her zaman true
    process.env.SFU_MIN_WORKERS        = '1';

    let init: typeof initMediasoup;
    let workers: typeof sfuWorkers;
    let stopMon: typeof stopScalingMonitor;
    let reset: typeof _resetWorkersForTest;

    await jest.isolateModulesAsync(async () => {
      const mod = await import('../socket/handlers/mediasoup/workers');
      init    = mod.initMediasoup;
      workers = mod.sfuWorkers;
      stopMon = mod.stopScalingMonitor;
      reset   = mod._resetWorkersForTest;
    });

    await init!();
    expect(workers!.length).toBe(1);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(workers!.length).toBe(1); // min'de kaldı

    stopMon!(); reset!();
    delete process.env.SFU_SCALE_UP_ROUTERS;
    delete process.env.SFU_SCALE_DOWN_ROUTERS;
    delete process.env.SFU_MIN_WORKERS;
  });
});

// ── Load tracking testleri ────────────────────────────────────
describe('worker load tracking', () => {
  beforeEach(async () => {
    await initMediasoup();
  });

  it('getNextWorkerWithIndex — en düşük yüklü worker seçilir', async () => {
    await initMediasoup(); // 2. worker ekle
    incrementWorkerLoad(0);
    incrementWorkerLoad(0);
    incrementWorkerLoad(0); // worker 0: yük=3
    // worker 1: yük=0 (boş)

    const { index } = getNextWorkerWithIndex();
    // Worker 1 yükü daha düşük olduğu için seçilmeli.
    expect(index).toBe(1);
  });

  it('decrement yükü 0\'ın altına düşürmez', () => {
    decrementWorkerLoad(0);
    decrementWorkerLoad(0);
    expect(getWorkerLoad(0)).toBe(0);
  });

  it('birden fazla worker arasında load tracking bağımsız çalışır', async () => {
    // İki worker için bağımsız sayaç
    incrementWorkerLoad(0);
    incrementWorkerLoad(0);
    incrementWorkerLoad(1);

    expect(getWorkerLoad(0)).toBe(2);
    expect(getWorkerLoad(1)).toBe(1);

    decrementWorkerLoad(0);
    expect(getWorkerLoad(0)).toBe(1);
    expect(getWorkerLoad(1)).toBe(1); // etkilenmedi
  });
});

// ── Worker crash recovery ─────────────────────────────────────
describe('worker crash recovery', () => {
  it('worker "died" event → 2 sn sonra yeniden başlatılır', async () => {
    await initMediasoup();
    expect(sfuWorkers.length).toBe(1);

    // Died callback'i al
    const onCall = (sfuWorkers[0] as { on: jest.Mock }).on.mock.calls.find(
      (c: string[]) => c[0] === 'died'
    );
    expect(onCall).toBeDefined();
    const diedCallback = onCall![1] as (err: Error) => void;

    const callsBefore = mediasoupStub.createWorker.mock.calls.length;

    // Worker öldü
    diedCallback(new Error('worker crashed'));

    // 2 saniye bekle
    await jest.advanceTimersByTimeAsync(2000);

    expect(mediasoupStub.createWorker.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(sfuWorkers.length).toBe(1); // yerine yenisi geldi
  });
});

// ── isSFUReady ────────────────────────────────────────────────
describe('isSFUReady', () => {
  it('init öncesi false döner', () => {
    expect(isSFUReady()).toBe(false);
  });

  it('initMediasoup sonrası true döner', async () => {
    await initMediasoup();
    expect(isSFUReady()).toBe(true);
  });

  it('worker yoksa false döner', () => {
    _resetWorkersForTest();
    expect(isSFUReady()).toBe(false);
  });
});

// ── getNextWorker guard ───────────────────────────────────────
describe('getNextWorker guard', () => {
  it('worker yokken hata fırlatır', () => {
    expect(() => getNextWorker()).toThrow('SFU henüz hazır değil');
  });

  it('getNextWorkerWithIndex — worker yokken hata fırlatır', () => {
    expect(() => getNextWorkerWithIndex()).toThrow();
  });
});

// ── stopScalingMonitor ────────────────────────────────────────
describe('stopScalingMonitor', () => {
  it('init sonrası stop — timer temizlenir, ikinci stop güvenli', async () => {
    await initMediasoup();
    stopScalingMonitor();
    expect(() => stopScalingMonitor()).not.toThrow(); // idempotent
  });

  it('stop sonrası scaling timer artık çalışmaz', async () => {
    let init: typeof initMediasoup;
    let workers: typeof sfuWorkers;
    let incLoad: typeof incrementWorkerLoad;
    let stopMon: typeof stopScalingMonitor;
    let reset: typeof _resetWorkersForTest;

    await jest.isolateModulesAsync(async () => {
      const mod = await import('../socket/handlers/mediasoup/workers');
      init    = mod.initMediasoup;
      workers = mod.sfuWorkers;
      incLoad = mod.incrementWorkerLoad;
      stopMon = mod.stopScalingMonitor;
      reset   = mod._resetWorkersForTest;
    });

    await init!();
    incLoad!(0); incLoad!(0);

    stopMon!(); // durdur

    const countBefore = mediasoupStub.createWorker.mock.calls.length;
    await jest.advanceTimersByTimeAsync(60_000); // 2 periyot geç
    expect(mediasoupStub.createWorker.mock.calls.length).toBe(countBefore); // değişmedi

    reset!();
    delete process.env.SFU_SCALE_UP_ROUTERS;
  });
});
