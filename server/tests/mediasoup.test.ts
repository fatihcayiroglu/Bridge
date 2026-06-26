// server/tests/mediasoup.test.ts
// mediasoup worker/transport/room/peer unit testleri
//
// Test kapsamı:
//   workers.ts  — initMediasoup, getNextWorker (guard + round-robin), isSFUReady
//   rooms.ts    — getOrCreateRoom, getRoomPeerList, cleanupPeer, createWebRtcTransport
//   types.ts    — WorkerOptions, WebRtcTransportConfig, RtpCapabilities şema doğrulaması

'use strict';
process.env.NODE_ENV = 'test';

// ── Stub: mediasoup modülü ────────────────────────────────────────────────────

let workerDiedCallback: ((err: Error) => void) | null = null;

function makeWorkerStub(id = 'w1') {
  const routers: ReturnType<typeof makeRouterStub>[] = [];
  return {
    _id: id,
    _routers: routers,
    createRouter: jest.fn(async () => {
      const r = makeRouterStub();
      routers.push(r);
      return r;
    }),
    close: jest.fn(),
    on: jest.fn((event: string, cb: (err: Error) => void) => {
      if (event === 'died') workerDiedCallback = cb;
    }),
  };
}

function makeTransportStub() {
  return {
    id:             'transport-1',
    iceParameters:  { usernameFragment: 'uf', password: 'pw', iceLite: false },
    iceCandidates:  [],
    dtlsParameters: { fingerprints: [], role: 'auto' },
    connect:        jest.fn(async () => {}),
    produce:        jest.fn(async () => ({ id: 'producer-1', rtpParameters: {}, on: jest.fn() })),
    consume:        jest.fn(async () => ({ id: 'consumer-1', rtpParameters: {}, on: jest.fn() })),
    close:          jest.fn(),
    on:             jest.fn(),
  };
}

function makeRouterStub() {
  return {
    rtpCapabilities:      { codecs: [], headerExtensions: [] },
    canConsume:           jest.fn(() => true),
    createWebRtcTransport: jest.fn(async () => makeTransportStub()),
  };
}

// mediasoupStub structurally MediasoupModule'ü karşılar; _id/_routers test-only alanlardır.
const mediasoupStub = {
  createWorker: jest.fn(async () => makeWorkerStub()),
};
// initMediasoup'a geçerken kullanılacak typed alias — as any zincirine gerek yok
const mediasoupModule = mediasoupStub as unknown as MediasoupModule;

jest.mock('mediasoup', () => mediasoupStub, { virtual: true });

// ── Import'lar (mock sonrası) ─────────────────────────────────────────────────

import {
  initMediasoup,
  getNextWorker,
  getNextWorkerWithIndex,
  incrementWorkerLoad,
  decrementWorkerLoad,
  getWorkerLoad,
  stopScalingMonitor,
  isSFUReady,
  sfuWorkers,
  _resetWorkersForTest,
} from '../socket/handlers/mediasoup/workers';

import {
  sfuRooms,
  sfuPeers,
  getOrCreateRoom,
  getRoomPeerList,
  cleanupPeer,
  createWebRtcTransport,
  _resetRoomsForTest,
} from '../socket/handlers/mediasoup/rooms';

import type {
  WorkerOptions,
  WorkerLogLevel,
  WorkerLogTag,
  WebRtcTransportConfig,
  RtpCapabilities,
  DtlsParameters,
  RtpParameters,
  MediasoupModule,
  MediasoupWorker,
  SfuPeer,
  BridgeIO,
} from '../socket/handlers/mediasoup/types';

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function makePeer(overrides: Partial<SfuPeer> = {}): SfuPeer {
  return {
    channelId:       'ch-1',
    serverId:        null,
    userId:          `u-${Math.random().toString(36).slice(2)}`,
    displayName:     'Test Kullanıcı',
    avatarColor:     '#abc',
    rtpCapabilities: { codecs: [], headerExtensions: [] } as RtpCapabilities,
    sendTransport:   null,
    recvTransport:   null,
    producers:       new Map(),
    consumers:       new Map(),
    muted:           false,
    deafened:        false,
    screensharing:   false,
    video:           false,
    ...overrides,
  };
}

function makeIo(): BridgeIO & { _emitted: { event: string; data: unknown; _target?: string }[] } {
  const emitted: { event: string; data: unknown; _target?: string }[] = [];
  return {
    _emitted: emitted,
    to(target: string) {
      return {
        emit(event: string, data: unknown) {
          emitted.push({ event, data, _target: target });
        },
      };
    },
  };
}

// ── Temizlik ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mediasoupStub.createWorker.mockImplementation(async () => makeWorkerStub());
  workerDiedCallback = null;
  _resetWorkersForTest();
  _resetRoomsForTest();
});

// ═════════════════════════════════════════════════════════════════════════════
// workers.ts
// ═════════════════════════════════════════════════════════════════════════════

describe('workers — isSFUReady', () => {
  it('başlangıçta false döner', () => {
    expect(isSFUReady()).toBe(false);
  });

  it('initMediasoup sonrası true döner', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] });
    expect(isSFUReady()).toBe(true);
  });
});

describe('workers — getNextWorker', () => {
  it('SFU hazır değilken hata fırlatır', () => {
    expect(() => getNextWorker()).toThrow('SFU henüz hazır değil');
  });

  it('tek worker varsa hep onu döner', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    const w1 = getNextWorker();
    const w2 = getNextWorker();
    expect(w1).toBe(w2);
  });

  it('birden fazla worker arasında round-robin yapar', async () => {
    mediasoupStub.createWorker
      .mockImplementationOnce(async () => makeWorkerStub('w1'))
      .mockImplementationOnce(async () => makeWorkerStub('w2'));

    await initMediasoup(mediasoupModule, { codecs: [] }, 2);

    const first  = getNextWorker();
    const second = getNextWorker();
    const third  = getNextWorker();

    expect(first._id).toBe('w1');
    expect(second._id).toBe('w2');
    expect(third._id).toBe('w1');   // wrap-around
  });
});

describe('workers — WorkerOptions tip doğrulaması', () => {
  it('geçerli WorkerOptions nesnesi derleme zamanında kabul edilir', () => {
    const opts: WorkerOptions = {
      logLevel:   'warn',
      logTags:    ['ice', 'dtls', 'rtp'],
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
    };
    expect(opts.logLevel).toBe('warn');
    expect(opts.logTags).toContain('ice');
  });

  it('tüm WorkerLogLevel değerleri geçerlidir', () => {
    const levels: WorkerLogLevel[] = ['debug', 'warn', 'error', 'none'];
    levels.forEach(level => {
      const opts: WorkerOptions = { logLevel: level };
      expect(opts.logLevel).toBe(level);
    });
  });

  it('tüm WorkerLogTag değerleri geçerlidir', () => {
    const tags: WorkerLogTag[] = ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp',
                                   'rtx', 'bwe', 'score', 'simulcast', 'svc', 'sctp', 'message'];
    const opts: WorkerOptions = { logTags: tags };
    expect(opts.logTags).toHaveLength(13);
  });
});

describe('workers — WebRtcTransportConfig tip doğrulaması', () => {
  it('geçerli WebRtcTransportConfig derleme zamanında kabul edilir', () => {
    const cfg: WebRtcTransportConfig = {
      listenIps: [{ ip: '0.0.0.0', announcedIp: '1.2.3.4' }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      maxIncomingBitrate: 1_500_000,
    };
    expect(cfg.enableUdp).toBe(true);
    expect(cfg.listenIps[0].ip).toBe('0.0.0.0');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// rooms.ts
// ═════════════════════════════════════════════════════════════════════════════

describe('rooms — getOrCreateRoom', () => {
  it('yeni bir oda oluşturur ve map\'e ekler', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    const room = await getOrCreateRoom('ch-test');
    expect(sfuRooms.has('ch-test')).toBe(true);
    expect(room.peers).toBeDefined();
  });

  it('aynı channelId için var olan odayı döner', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    const r1 = await getOrCreateRoom('ch-same');
    const r2 = await getOrCreateRoom('ch-same');
    expect(r1).toBe(r2);
  });
});

describe('rooms — getRoomPeerList', () => {
  it('oda yoksa boş dizi döner', () => {
    const list = getRoomPeerList('ch-ghost');
    expect(list).toEqual([]);
  });

  it('odadaki peer\'leri doğru şekilde listeler', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    const room = await getOrCreateRoom('ch-list');
    const peer = makePeer({ channelId: 'ch-list', userId: 'user-42', displayName: 'Ali' });
    room.peers.set('socket-1', peer);
    sfuPeers.set('socket-1', peer);

    const list = getRoomPeerList('ch-list');
    expect(list).toHaveLength(1);
    expect(list[0].userId).toBe('user-42');
    expect(list[0].displayName).toBe('Ali');
    expect(list[0].socketId).toBe('socket-1');
  });

  it('birden fazla peer\'i listeler', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    const room = await getOrCreateRoom('ch-multi');

    ['s1', 's2', 's3'].forEach((sid, i) => {
      const p = makePeer({ channelId: 'ch-multi', userId: `u${i}` });
      room.peers.set(sid, p);
    });

    const list = getRoomPeerList('ch-multi');
    expect(list).toHaveLength(3);
  });
});

describe('rooms — createWebRtcTransport', () => {
  it('router\'dan transport oluşturur', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    const room = await getOrCreateRoom('ch-transport');
    const transport = await createWebRtcTransport(room.router);

    expect(transport).toBeDefined();
    expect(transport.id).toBe('transport-1');
    expect(room.router.createWebRtcTransport).toHaveBeenCalledTimes(1);

    // WebRtcTransportConfig alanları doğru geçilmiş mi?
    const callArg = (room.router.createWebRtcTransport as jest.Mock).mock.calls[0][0];
    expect(callArg).toHaveProperty('enableUdp', true);
    expect(callArg).toHaveProperty('enableTcp', true);
    expect(callArg).toHaveProperty('preferUdp', true);
  });
});

describe('rooms — cleanupPeer', () => {
  it('ayrılan peer\'i maps\'ten siler', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    const room = await getOrCreateRoom('ch-cleanup');
    const peer = makePeer({ channelId: 'ch-cleanup' });
    room.peers.set('socket-x', peer);
    sfuPeers.set('socket-x', peer);

    const io = makeIo();
    await cleanupPeer('socket-x', io, 'ch-cleanup', null);

    expect(sfuPeers.has('socket-x')).toBe(false);
    expect(room.peers.has('socket-x')).toBe(false);
  });

  it('oda yoksa hata fırlatmaz', async () => {
    const io = makeIo();
    await expect(
      cleanupPeer('socket-none', io, 'ch-nonexistent', null)
    ).resolves.not.toThrow();
  });

  it('peer çıkışında diğer katılımcılara sfu:peer-left emit eder', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    const room = await getOrCreateRoom('ch-left');
    const peer = makePeer({ channelId: 'ch-left', userId: 'user-out' });
    room.peers.set('socket-out', peer);
    sfuPeers.set('socket-out', peer);

    const io = makeIo();
    await cleanupPeer('socket-out', io, 'ch-left', null);

    const leftEvent = io._emitted.find(e => e.event === 'sfu:peer-left');
    expect(leftEvent).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Tip güvenliği — runtime şema kontrolleri
// ═════════════════════════════════════════════════════════════════════════════

describe('tip güvenliği — RtpCapabilities', () => {
  it('codecs ve headerExtensions içeren geçerli RtpCapabilities', () => {
    const caps: RtpCapabilities = {
      codecs: [{
        mimeType:    'audio/opus',
        clockRate:   48000,
        channels:    2,
        payloadType: 111,
      }],
      headerExtensions: [],
    };
    expect(caps.codecs[0].mimeType).toBe('audio/opus');
  });
});

describe('tip güvenliği — DtlsParameters', () => {
  it('geçerli DtlsParameters nesnesi kabul edilir', () => {
    const dtls: DtlsParameters = {
      role:         'client',
      fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB:CC' }],
    };
    expect(dtls.role).toBe('client');
    expect(dtls.fingerprints).toHaveLength(1);
  });
});

describe('tip güvenliği — RtpParameters', () => {
  it('geçerli RtpParameters nesnesi kabul edilir', () => {
    const rtp: RtpParameters = {
      codecs: [{
        mimeType:    'video/VP8',
        payloadType: 96,
        clockRate:   90000,
      }],
      encodings: [{ maxBitrate: 500_000, scalabilityMode: 'S3T3' }],
    };
    expect(rtp.codecs[0].mimeType).toBe('video/VP8');
    expect(rtp.encodings?.[0].maxBitrate).toBe(500_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// workers.ts — YENİ FONKSİYONLAR
// ═════════════════════════════════════════════════════════════════════════════

// ── getNextWorkerWithIndex ────────────────────────────────────────────────────

describe('workers — getNextWorkerWithIndex', () => {
  it('SFU hazır değilken hata fırlatır', () => {
    expect(() => getNextWorkerWithIndex()).toThrow('SFU henüz hazır değil');
  });

  it('worker ve doğru index\'i birlikte döner', async () => {
    mediasoupStub.createWorker.mockImplementationOnce(async () => makeWorkerStub('w0'));
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);

    const result = getNextWorkerWithIndex();
    expect(result).toHaveProperty('worker');
    expect(result).toHaveProperty('index');
    expect(result.index).toBe(0);
    expect(result.worker).toBe(sfuWorkers[0]);
  });

  it('2 worker varken en az yüklü olanı seçer ve doğru index döner', async () => {
    mediasoupStub.createWorker
      .mockImplementationOnce(async () => makeWorkerStub('w0'))
      .mockImplementationOnce(async () => makeWorkerStub('w1'));

    await initMediasoup(mediasoupModule, { codecs: [] }, 2);

    // w0'a 3 router yükü ver, w1 boş kalsın
    incrementWorkerLoad(0);
    incrementWorkerLoad(0);
    incrementWorkerLoad(0);

    const { worker, index } = getNextWorkerWithIndex();
    expect(index).toBe(1);             // en az yüklü w1
    expect(worker).toBe(sfuWorkers[1]);
  });

  it('getNextWorker ile aynı worker\'ı seçer', async () => {
    mediasoupStub.createWorker
      .mockImplementationOnce(async () => makeWorkerStub('w0'))
      .mockImplementationOnce(async () => makeWorkerStub('w1'));

    await initMediasoup(mediasoupModule, { codecs: [] }, 2);

    incrementWorkerLoad(0); // w0 yüklü, w1 tercih edilmeli

    const fromIndex  = getNextWorkerWithIndex().worker;
    const fromSimple = getNextWorker();
    expect(fromIndex).toBe(fromSimple);
  });
});

// ── incrementWorkerLoad / decrementWorkerLoad ─────────────────────────────────

describe('workers — incrementWorkerLoad', () => {
  it('başlangıçta yük 0\'dır', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    expect(getWorkerLoad(0)).toBe(0);
  });

  it('her çağrıda yük 1 artar', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    incrementWorkerLoad(0);
    incrementWorkerLoad(0);
    incrementWorkerLoad(0);
    expect(getWorkerLoad(0)).toBe(3);
  });

  it('birden fazla worker için bağımsız sayaç tutar', async () => {
    mediasoupStub.createWorker
      .mockImplementationOnce(async () => makeWorkerStub('w0'))
      .mockImplementationOnce(async () => makeWorkerStub('w1'));

    await initMediasoup(mediasoupModule, { codecs: [] }, 2);

    incrementWorkerLoad(0);
    incrementWorkerLoad(0);
    incrementWorkerLoad(1);

    expect(getWorkerLoad(0)).toBe(2);
    expect(getWorkerLoad(1)).toBe(1);
  });

  it('hiç init edilmemiş index için de çalışır (sparse map)', () => {
    incrementWorkerLoad(99);
    expect(getWorkerLoad(99)).toBe(1);
  });
});

describe('workers — decrementWorkerLoad', () => {
  it('yükü 1 azaltır', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    incrementWorkerLoad(0);
    incrementWorkerLoad(0);
    decrementWorkerLoad(0);
    expect(getWorkerLoad(0)).toBe(1);
  });

  it('0\'ın altına düşmez', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    decrementWorkerLoad(0); // yük zaten 0
    decrementWorkerLoad(0);
    expect(getWorkerLoad(0)).toBe(0);
  });

  it('increment/decrement simetrik çalışır', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    for (let i = 0; i < 5; i++) incrementWorkerLoad(0);
    for (let i = 0; i < 5; i++) decrementWorkerLoad(0);
    expect(getWorkerLoad(0)).toBe(0);
  });

  it('belirtilen index\'e özgü çalışır, diğer worker\'ı etkilemez', async () => {
    mediasoupStub.createWorker
      .mockImplementationOnce(async () => makeWorkerStub('w0'))
      .mockImplementationOnce(async () => makeWorkerStub('w1'));

    await initMediasoup(mediasoupModule, { codecs: [] }, 2);
    incrementWorkerLoad(0);
    incrementWorkerLoad(1);
    incrementWorkerLoad(1);
    decrementWorkerLoad(1);

    expect(getWorkerLoad(0)).toBe(1);
    expect(getWorkerLoad(1)).toBe(1);
  });
});

// ── stopScalingMonitor ────────────────────────────────────────────────────────

describe('workers — stopScalingMonitor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    stopScalingMonitor(); // her testten sonra temizle
  });

  it('_resetWorkersForTest çağrısı timer\'ı temizler — ikinci stopScalingMonitor güvenli', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    _resetWorkersForTest(); // timer clearInterval ile durdurulur
    expect(() => stopScalingMonitor()).not.toThrow();
  });

  it('initMediasoup sonrası interval aktiftir', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    expect(setIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('stopScalingMonitor interval\'ı durdurur', async () => {
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    stopScalingMonitor();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('stop sonrası tekrar stop çağrısı hata fırlatmaz (idempotent)', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    stopScalingMonitor();
    expect(() => stopScalingMonitor()).not.toThrow();
  });
});

// ── _checkScaling (dolaylı — interval tetikleme yoluyla) ──────────────────────

describe('workers — _checkScaling (scale-up / scale-down davranışı)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Her test için SFU_SCALE_CHECK_MS sıfırlanmış olur (_resetWorkersForTest beforeEach'te çalışır)
  });

  afterEach(() => {
    stopScalingMonitor();
    jest.useRealTimers();
  });

  it('mediasoup yoksa _checkScaling sessizce döner — worker sayısı değişmez', async () => {
    // mediasoup olmadan init (false döner, worker eklenmez, ama sfuWorkers sahte doldurulabilir)
    // Direkt olarak: timer aktifse ve sfuWorkers boşsa hiçbir şey yapılmaz
    // _checkScaling'i dolaylı test etmek için: 1 worker init, sonra sfuWorkers.length kontrolü
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    const countBefore = sfuWorkers.length;

    jest.advanceTimersByTime(30_000); // scaling interval tetiklenir
    await Promise.resolve();          // async _checkScaling'i flush et

    // Yük 0 ve min workers (1) = scale-down için idleIdx 0 ama minLoad !== 0 değil —
    // worker yük 0 ve count > MIN bekleniyor; bu senaryo ise count === MIN → değişmez
    expect(sfuWorkers.length).toBe(countBefore);
  });

  it('ortalama yük SCALE_UP_THRESHOLD üzerinde ve MAX altındaysa yeni worker eklenir', async () => {
    mediasoupStub.createWorker
      .mockImplementationOnce(async () => makeWorkerStub('w0'))
      .mockImplementationOnce(async () => makeWorkerStub('w1')); // scale-up için

    process.env.SFU_SCALE_UP_ROUTERS = '5';
    process.env.SFU_MAX_WORKERS      = '3';
    process.env.SFU_MIN_WORKERS      = '1';
    process.env.SFU_SCALE_CHECK_MS   = '30000';

    await initMediasoup(mediasoupModule, { codecs: [] }, 1);

    // 1 worker'a 6 router yükü: avgLoad = 6 >= threshold 5
    for (let i = 0; i < 6; i++) incrementWorkerLoad(0);

    jest.advanceTimersByTime(30_000);
    await Promise.resolve();
    await Promise.resolve(); // birden fazla microtask sırası için

    expect(sfuWorkers.length).toBe(2); // scale-up: 1 → 2

    delete process.env.SFU_SCALE_UP_ROUTERS;
    delete process.env.SFU_MAX_WORKERS;
    delete process.env.SFU_MIN_WORKERS;
    delete process.env.SFU_SCALE_CHECK_MS;
  });

  it('tüm worker\'lar boşsa (load=0) ve MIN\'in üstündeyse scale-down yapar', async () => {
    mediasoupStub.createWorker
      .mockImplementationOnce(async () => makeWorkerStub('w0'))
      .mockImplementationOnce(async () => makeWorkerStub('w1'));

    process.env.SFU_SCALE_DOWN_ROUTERS = '5';
    process.env.SFU_MIN_WORKERS        = '1';
    process.env.SFU_MAX_WORKERS        = '4';
    process.env.SFU_SCALE_CHECK_MS     = '30000';

    await initMediasoup(mediasoupModule, { codecs: [] }, 2);
    // Her iki worker da yüksüz (0 router) → avgLoad = 0 ≤ threshold 5, count(2) > min(1)

    jest.advanceTimersByTime(30_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(sfuWorkers.length).toBe(1); // scale-down: 2 → 1

    delete process.env.SFU_SCALE_DOWN_ROUTERS;
    delete process.env.SFU_MIN_WORKERS;
    delete process.env.SFU_MAX_WORKERS;
    delete process.env.SFU_SCALE_CHECK_MS;
  });

  it('MAX worker sayısına ulaşıldığında scale-up yapılmaz', async () => {
    process.env.SFU_SCALE_UP_ROUTERS = '1';
    process.env.SFU_MAX_WORKERS      = '1'; // zaten max
    process.env.SFU_SCALE_CHECK_MS   = '30000';

    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    incrementWorkerLoad(0); // avgLoad = 1 >= threshold 1, ama max'a ulaşıldı

    jest.advanceTimersByTime(30_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(sfuWorkers.length).toBe(1); // değişmemeli

    delete process.env.SFU_SCALE_UP_ROUTERS;
    delete process.env.SFU_MAX_WORKERS;
    delete process.env.SFU_SCALE_CHECK_MS;
  });

  it('MIN worker sayısında scale-down yapılmaz', async () => {
    process.env.SFU_SCALE_DOWN_ROUTERS = '99';
    process.env.SFU_MIN_WORKERS        = '1';
    process.env.SFU_SCALE_CHECK_MS     = '30000';

    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    // yük 0, ama zaten min worker sayısında

    jest.advanceTimersByTime(30_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(sfuWorkers.length).toBe(1); // değişmemeli

    delete process.env.SFU_SCALE_DOWN_ROUTERS;
    delete process.env.SFU_MIN_WORKERS;
    delete process.env.SFU_SCALE_CHECK_MS;
  });
});


describe('rooms — test cleanup lifecycle', () => {
  it('rooms_reset_cleans_pending_cleanup_timer', async () => {
    await initMediasoup(mediasoupModule, { codecs: [] }, 1);
    const room = await getOrCreateRoom('ch-pending-cleanup');
    const peer = makePeer({ channelId: 'ch-pending-cleanup', userId: 'u-pending-cleanup' });
    room.peers.set('socket-pending-cleanup', peer);
    sfuPeers.set('socket-pending-cleanup', peer);

    await cleanupPeer('socket-pending-cleanup', makeIo(), 'ch-pending-cleanup', undefined);

    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    _resetRoomsForTest();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
