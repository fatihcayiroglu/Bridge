// server/tests/mediasoup-worker-selection-guards.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// WORKER SEÇİMİ — KİLİTLİ SLOT VE BOZUK HAVUZ DAVRANIŞI
// ════════════════════════════════════════════════════════════════════════════
//
// `getNextWorkerWithIndex()` üretimde HER ses/video odası için çalışır ve
// üç ayrı arıza biçimine karşı fail-closed olmalıdır:
//
//   1. Havuz henüz kurulmadı            → anlamlı hata (P2P'ye düşülür)
//   2. TÜM slotlar yeniden başlıyor     → anlamlı hata (yarım kurulmuş bir
//                                          worker'a yönlendirme YAPILMAZ)
//   3. Seçilen slot artık boş           → anlamlı hata
//
// Üçüncü dal, dizi indekslemesinin `undefined` verebildiği yerdi:
// `{ worker: sfuWorkers[i] }` sessizce `undefined` döndürüp çağıranı
// "worker aldım" sanmaya bırakıyordu; hata ancak çok sonra, alakasız bir
// yerde `worker.createRouter` üzerinde patlıyordu.

process.env.NODE_ENV = 'test';

function makeWorkerStub(id: string) {
  return {
    _id: id,
    createRouter: jest.fn(async () => ({ rtpCapabilities: { codecs: [], headerExtensions: [] } })),
    close: jest.fn(),
    on: jest.fn(),
  };
}

let workerIdCounter = 0;
const mediasoupStub = { createWorker: jest.fn(async () => makeWorkerStub(`w${++workerIdCounter}`)) };
jest.mock('mediasoup', () => mediasoupStub, { virtual: true });

import {
  initMediasoup,
  sfuWorkers,
  getNextWorker,
  getNextWorkerWithIndex,
  incrementWorkerLoad,
  getWorkerLoad,
  isSFUReady,
  stopScalingMonitor,
  _resetWorkersForTest,
} from '../socket/handlers/mediasoup/workers';

beforeEach(() => {
  _resetWorkersForTest();
  mediasoupStub.createWorker.mockClear();
  workerIdCounter = 0;
});

afterEach(() => {
  stopScalingMonitor();
  _resetWorkersForTest();
});

describe('worker havuzu kurulmadan seçim', () => {
  it('boş havuzda anlamlı bir hata fırlatır', () => {
    expect(() => getNextWorkerWithIndex()).toThrow(/SFU henüz hazır değil/);
    expect(() => getNextWorker()).toThrow(/SFU henüz hazır değil/);
  });

  it('boş havuzda SFU hazır SAYILMAZ', () => {
    expect(isSFUReady()).toBe(false);
  });
});

describe('worker seçimi — yük dağıtımı', () => {
  it('en az yüklü worker seçilir', async () => {
    process.env.SFU_MIN_WORKERS = '1';
    await initMediasoup(mediasoupStub as never, undefined, 2);
    expect(sfuWorkers.length).toBe(2);

    // 0. worker'ı yükle; sonraki seçim 1. worker olmalı.
    incrementWorkerLoad(0);
    incrementWorkerLoad(0);
    const { index } = getNextWorkerWithIndex();
    expect(index).toBe(1);
    expect(getWorkerLoad(0)).toBe(2);
  });

  it('seçilen slot boşaltılmışsa SESSİZCE undefined döndürmez', async () => {
    await initMediasoup(mediasoupStub as never, undefined, 1);
    expect(sfuWorkers.length).toBe(1);

    // Havuzdaki nesne silinir ama uzunluk korunur: dizi indekslemesinin
    // `undefined` verdiği tam durum. Eskiden bu, `worker: undefined` olarak
    // çağırana DÖNÜYORDU.
    (sfuWorkers as unknown as Array<unknown>)[0] = undefined;

    expect(() => getNextWorkerWithIndex()).toThrow(/worker/i);
  });

  it('sağlıklı havuzda gerçek bir worker döner', async () => {
    await initMediasoup(mediasoupStub as never, undefined, 1);
    const { worker, index } = getNextWorkerWithIndex();
    expect(index).toBe(0);
    expect(worker).toBeDefined();
    expect(typeof (worker as unknown as { createRouter: unknown }).createRouter).toBe('function');
  });
});
