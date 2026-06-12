// server/tests/mediasoup-handlers.test.ts
// registerSFUHandlers — producer/consumer akışı, transport kurulumu,
// join/leave döngüsü, state-update, voice:activity ve hata yolları
//
// Kapsam: server/socket/handlers/mediasoup/index.ts
//
// NOT: mediasoup opsiyonel bağımlılık olduğundan virtual mock kullanılır.
// sfuRegistry ve turnConfig da stub'lanır — test ortamında Redis/ICE gerekmez.

'use strict';
process.env.NODE_ENV = 'test';

// ── Stub: mediasoup ─────────────────────────────────────────────────────────

function makeProducerStub(id = 'producer-1', kind: 'audio' | 'video' = 'audio') {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    id,
    kind,
    type: 'simple' as const,
    close: jest.fn(),
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
    }),
    _trigger: (event: string, ...args: unknown[]) => listeners[event]?.(...args),
  };
}

function makeConsumerStub(id = 'consumer-1', producerId = 'producer-1') {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    id,
    producerId,
    kind: 'audio' as const,
    rtpParameters: { codecs: [], encodings: [] },
    type: 'simple' as const,
    resume: jest.fn(async () => {}),
    setPreferredLayers: jest.fn(async () => {}),
    close: jest.fn(),
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
    }),
    _trigger: (event: string, ...args: unknown[]) => listeners[event]?.(...args),
  };
}

function makeTransportStub(id = 'transport-1') {
  const producerStub = makeProducerStub();
  const consumerStub = makeConsumerStub();
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  return {
    id,
    iceParameters:  { usernameFragment: 'uf', password: 'pw', iceLite: false },
    iceCandidates:  [{ foundation: 'f', priority: 1, address: '127.0.0.1', protocol: 'udp', port: 40000, type: 'host' }],
    dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB' }], role: 'auto' },
    connect:  jest.fn(async () => {}),
    produce:  jest.fn(async () => producerStub),
    consume:  jest.fn(async () => consumerStub),
    close:    jest.fn(),
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = cb;
    }),
    _trigger: (event: string, ...args: unknown[]) => listeners[event]?.(...args),
    _producer: producerStub,
    _consumer: consumerStub,
  };
}

function makeRouterStub() {
  const transport = makeTransportStub();
  return {
    rtpCapabilities:       { codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2 }], headerExtensions: [] },
    canConsume:            jest.fn(() => true),
    createWebRtcTransport: jest.fn(async () => transport),
    close:                 jest.fn(),
    on:                    jest.fn(),
    _transport:            transport,
  };
}

function makeWorkerStub() {
  const router = makeRouterStub();
  return {
    _id:          'w1',
    createRouter: jest.fn(async () => router),
    close:        jest.fn(),
    on:           jest.fn(),
    _router:      router,
  };
}

const mediasoupStub = { createWorker: jest.fn(async () => makeWorkerStub()) };
jest.mock('mediasoup', () => mediasoupStub, { virtual: true });

// ── Stub: sfuRegistry ───────────────────────────────────────────────────────

jest.mock('../lib/sfuRegistry', () => ({
  INSTANCE_ID:   'test-node',
  isLocalRoom:   jest.fn(async () => true),
  getRoomOwner:  jest.fn(async () => null),
  claimRoom:     jest.fn(async () => {}),
  releaseRoom:   jest.fn(async () => {}),
  refreshRoom:   jest.fn(async () => {}),
}));


// ── Stub: repositories ──────────────────────────────────────────────────────

jest.mock('../db/repositories', () => ({
  Members: {
    findOne: jest.fn(async () => ({ timeoutUntil: null })),
  },
}));

// ── Stub: turnConfig ────────────────────────────────────────────────────────

jest.mock('../lib/turnConfig', () => ({
  getIceServers:          jest.fn(() => []),
  getIceTransportPolicy:  jest.fn(() => 'all'),
}));

// ── Stub: logger ─────────────────────────────────────────────────────────────

jest.mock('../lib/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// ── Import'lar (mock'lardan sonra) ───────────────────────────────────────────

import {
  initMediasoup,
  isSFUReady,
  _resetWorkersForTest,
  _setMediasoupForTest,
} from '../socket/handlers/mediasoup/workers';

import {
  sfuRooms,
  sfuPeers,
  _resetRoomsForTest,
} from '../socket/handlers/mediasoup/rooms';

import { registerSFUHandlers } from '../socket/handlers/mediasoup/index';

import type { RtpCapabilities, BridgeSocket, BridgeIO, BridgeUser, MediasoupModule, RtpParameters, DtlsParameters } from '../socket/handlers/mediasoup/types';

// ── Socket event payload tipleri ─────────────────────────────────────────────

interface RtpCapabilitiesPayload  { rtpCapabilities: RtpCapabilities }
interface TransportPayload        { direction: 'send' | 'recv'; id: string; iceParameters: unknown; iceCandidates: unknown[]; dtlsParameters: DtlsParameters }
interface ProducerPayload         { kind: 'audio' | 'video' | 'screen'; producerId: string }
interface ConsumerPayload         { producerId: string; consumerId: string; rtpParameters: RtpParameters }
interface JoinPayload             { existingPeers: { userId: string }[]; iceServers: unknown[] }
interface RedirectPayload         { ownerNodeId: string }
interface ActivityPayload         { speaking: boolean; userId: string }

// ── Test yardımcıları ────────────────────────────────────────────────────────

const DEFAULT_RTP_CAPS: RtpCapabilities = {
  codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
  headerExtensions: [],
};

function makeUser(overrides: Partial<BridgeUser> = {}): BridgeUser {
  return {
    _id:         'user-1',
    displayName: 'Test Kullanıcı',
    avatarColor: '#2d9cdb',
    ...overrides,
  };
}

/** Basit bir Socket.IO socket stub'ı döner. */
function makeSocket(id = 'socket-1') {
  const emitted: { event: string; data: unknown }[] = [];
  const joined: string[] = [];
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};

  const socket = {
    id,
    emit: jest.fn((event: string, data: unknown) => { emitted.push({ event, data }); }),
    join: jest.fn((room: string) => { joined.push(room); }),
    to:   jest.fn((room: string) => ({
      emit: jest.fn((event: string, data: unknown) => { emitted.push({ event: `to:${room}:${event}`, data }); }),
    })),
    on:   jest.fn((event: string, handler: (...args: unknown[]) => unknown) => { handlers[event] = handler; }),
    currentVoiceChannel: null as string | null,
    currentVoiceServer:  null as string | null,

    // Test helpers
    _emitted:  emitted,
    _joined:   joined,
    _handlers: handlers,
    /** Kayıtlı bir handler'ı elle tetikler */
    _fire: async (event: string, data: unknown) => {
      const h = handlers[event];
      if (!h) throw new Error(`Handler bulunamadı: ${event}`);
      return h(data);
    },
    _getEmit:    (event: string) => emitted.find(e => e.event === event),
    _getAllEmits: (event: string) => emitted.filter(e => e.event === event),
  } as unknown as BridgeSocket & {
    _emitted:    typeof emitted;
    _joined:     typeof joined;
    _handlers:   typeof handlers;
    _fire:       (event: string, data: unknown) => Promise<unknown>;
    _getEmit:    (event: string) => { event: string; data: unknown } | undefined;
    _getAllEmits: (event: string) => { event: string; data: unknown }[];
  };

  return socket;
}

/** BridgeIO stub'ı: io.to(room).emit() çağrılarını kaydeder */
function makeIo() {
  const emitted: { target: string; event: string; data: unknown }[] = [];
  const io = {
    to: jest.fn((target: string) => ({
      emit: jest.fn((event: string, data: unknown) => { emitted.push({ target, event, data }); }),
    })),
    _emitted:   emitted,
    _find:      (event: string) => emitted.find(e => e.event === event),
    _findAll:   (event: string) => emitted.filter(e => e.event === event),
  } as unknown as BridgeIO & {
    _emitted:  typeof emitted;
    _find:     (event: string) => { target: string; event: string; data: unknown } | undefined;
    _findAll:  (event: string) => { target: string; event: string; data: unknown }[];
  };
  return io;
}

// ── Kurulum / temizlik ───────────────────────────────────────────────────────

beforeEach(async () => {
  jest.clearAllMocks();
  _resetWorkersForTest();
  _resetRoomsForTest();
  mediasoupStub.createWorker.mockImplementation(async () => makeWorkerStub());
  _setMediasoupForTest(mediasoupStub as unknown as MediasoupModule);
  await initMediasoup();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. sfu:get-rtp-capabilities
// ═══════════════════════════════════════════════════════════════════════════

describe('sfu:get-rtp-capabilities', () => {
  it('mevcut bir oda için rtpCapabilities emit eder', async () => {
    const socket = makeSocket();
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await socket._fire('sfu:get-rtp-capabilities', { channelId: 'ch-1' });

    const ev = socket._getEmit('sfu:rtp-capabilities');
    expect(ev).toBeDefined();
    expect((ev!.data as RtpCapabilitiesPayload).rtpCapabilities).toBeDefined();
  });

  it('oda oluşturulamazsa sfu:error emit eder', async () => {
    // Worker yok → getOrCreateRoom hata fırlatır
    _resetWorkersForTest();

    const socket = makeSocket();
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await socket._fire('sfu:get-rtp-capabilities', { channelId: 'ch-error' });

    const ev = socket._getEmit('sfu:error');
    expect(ev).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. sfu:join / sfu:group-join
// ═══════════════════════════════════════════════════════════════════════════

describe('sfu:join', () => {
  it('peer kaydolur ve sfu:joined emit edilir', async () => {
    const socket = makeSocket('sock-join');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await socket._fire('sfu:join', {
      channelId:       'ch-join',
      serverId:        'srv-1',
      rtpCapabilities: DEFAULT_RTP_CAPS,
    });

    // Peer map'e eklendi mi?
    expect(sfuPeers.has('sock-join')).toBe(true);
    expect(sfuRooms.has('ch-join')).toBe(true);

    // Socket odaya katıldı mı?
    expect(socket._joined).toContain('voice:ch-join');

    // sfu:joined emit edildi mi?
    const joined = socket._getEmit('sfu:joined');
    expect(joined).toBeDefined();
    expect((joined!.data as JoinPayload)).toHaveProperty('existingPeers');
    expect((joined!.data as JoinPayload)).toHaveProperty('iceServers');
  });

  it('join sırasında mevcut peer temizlenerek yeniden kaydolur', async () => {
    const socket = makeSocket('sock-rejoin');
    const io     = makeIo();

    // İlk join
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join', { channelId: 'ch-rejoin', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });

    // İkinci join — aynı socket farklı kanala
    await socket._fire('sfu:join', { channelId: 'ch-rejoin2', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });

    // Yeni oda oluştu
    expect(sfuRooms.has('ch-rejoin2')).toBe(true);
  });

  it('oda başka node\'da ise sfu:redirect emit edilir', async () => {
    const sfuRegistry = jest.requireMock('../lib/sfuRegistry');
    (sfuRegistry.isLocalRoom as jest.Mock).mockResolvedValueOnce(false);
    (sfuRegistry.getRoomOwner as jest.Mock).mockResolvedValueOnce('node-remote');

    const socket = makeSocket('sock-redirect');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await socket._fire('sfu:join', {
      channelId:       'ch-remote',
      serverId:        'srv-1',
      rtpCapabilities: DEFAULT_RTP_CAPS,
    });

    const redirect = socket._getEmit('sfu:redirect');
    expect(redirect).toBeDefined();
    expect((redirect!.data as RedirectPayload).ownerNodeId).toBe('node-remote');
  });

  it('mevcut peer listesi yeni katılımcıya gönderilir', async () => {
    // Önce bir peer oluştur
    const socket1 = makeSocket('sock-existing');
    const io      = makeIo();
    registerSFUHandlers(socket1, io, makeUser({ _id: 'user-existing' }));
    await socket1._fire('sfu:join', { channelId: 'ch-peers', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });

    // Yeni peer katıl
    const socket2 = makeSocket('sock-new');
    registerSFUHandlers(socket2, io, makeUser({ _id: 'user-new' }));
    await socket2._fire('sfu:join', { channelId: 'ch-peers', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });

    const joined = socket2._getEmit('sfu:joined');
    expect((joined!.data as JoinPayload).existingPeers).toHaveLength(1);
    expect((joined!.data as JoinPayload).existingPeers[0].userId).toBe('user-existing');
  });
});

describe('sfu:group-join', () => {
  it('_sfu:join-routed emit eder ve peer kaydolur', async () => {
    const socket = makeSocket('sock-group');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await socket._fire('sfu:group-join', {
      channelId:       'ch-group',
      serverId:        'srv-g',
      rtpCapabilities: DEFAULT_RTP_CAPS,
    });

    expect(socket._getEmit('_sfu:join-routed')).toBeDefined();
    expect(sfuPeers.has('sock-group')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. sfu:create-transport
// ═══════════════════════════════════════════════════════════════════════════

describe('sfu:create-transport', () => {
  async function setupPeer(socketId = 'sock-transport', channelId = 'ch-transport') {
    const socket = makeSocket(socketId);
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join', { channelId, serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    return { socket, io };
  }

  it('send transport oluşturur ve sfu:transport-created emit eder', async () => {
    const { socket } = await setupPeer();

    await socket._fire('sfu:create-transport', { channelId: 'ch-transport', direction: 'send' });

    const ev = socket._getEmit('sfu:transport-created');
    expect(ev).toBeDefined();
    expect((ev!.data as TransportPayload).direction).toBe('send');
    expect((ev!.data as TransportPayload).id).toBeDefined();
    expect((ev!.data as TransportPayload).iceParameters).toBeDefined();
    expect((ev!.data as TransportPayload).iceCandidates).toBeDefined();
    expect((ev!.data as TransportPayload).dtlsParameters).toBeDefined();
  });

  it('recv transport oluşturur', async () => {
    const { socket } = await setupPeer('sock-recv', 'ch-recv');

    await socket._fire('sfu:create-transport', { channelId: 'ch-recv', direction: 'recv' });

    const ev = socket._getEmit('sfu:transport-created');
    expect((ev!.data as TransportPayload).direction).toBe('recv');
  });

  it('oda yoksa sfu:error emit eder', async () => {
    const socket = makeSocket('sock-noroom');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    // join yapılmadan transport isteniyor
    await socket._fire('sfu:create-transport', { channelId: 'ch-ghost', direction: 'send' });

    expect(socket._getEmit('sfu:error')).toBeDefined();
  });

  it('peer yoksa sfu:error emit eder', async () => {
    // join yapılmadan create-transport → oda yok → sfu:error
    const socket = makeSocket('sock-nopeer');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await socket._fire('sfu:create-transport', { channelId: 'ch-nopeer', direction: 'send' });
    expect(socket._getEmit('sfu:error')).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. sfu:connect-transport
// ═══════════════════════════════════════════════════════════════════════════

describe('sfu:connect-transport', () => {
  const DTLS = { role: 'client', fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB' }] };

  it('send transport bağlar ve sfu:transport-connected emit eder', async () => {
    const socket = makeSocket('sock-connect');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join', { channelId: 'ch-connect', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId: 'ch-connect', direction: 'send' });

    await socket._fire('sfu:connect-transport', { channelId: 'ch-connect', direction: 'send', dtlsParameters: DTLS });

    const ev = socket._getEmit('sfu:transport-connected');
    expect(ev).toBeDefined();
    expect((ev!.data as TransportPayload).direction).toBe('send');
  });

  it('recv transport bağlar', async () => {
    const socket = makeSocket('sock-connect-recv');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join', { channelId: 'ch-conn-recv', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId: 'ch-conn-recv', direction: 'recv' });

    await socket._fire('sfu:connect-transport', { channelId: 'ch-conn-recv', direction: 'recv', dtlsParameters: DTLS });

    const ev = socket._getEmit('sfu:transport-connected');
    expect((ev!.data as TransportPayload).direction).toBe('recv');
  });

  it('peer yoksa sessizce dönüş yapar (hata fırlatmaz)', async () => {
    const socket = makeSocket('sock-no-peer-connect');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await expect(
      socket._fire('sfu:connect-transport', { direction: 'send', dtlsParameters: DTLS })
    ).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. sfu:produce — ana producer akışı
// ═══════════════════════════════════════════════════════════════════════════

describe('sfu:produce', () => {
  const AUDIO_RTP: import('../socket/handlers/mediasoup/types').RtpParameters = {
    codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }],
  };

  async function setupWithTransport(socketId: string, channelId: string) {
    const socket = makeSocket(socketId);
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join',             { channelId, serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId, direction: 'send' });
    return { socket, io };
  }

  it('audio producer oluşturur ve sfu:produced emit eder', async () => {
    const { socket } = await setupWithTransport('sock-produce', 'ch-produce');

    await socket._fire('sfu:produce', {
      channelId:     'ch-produce',
      kind:          'audio',
      rtpParameters: AUDIO_RTP,
    });

    const ev = socket._getEmit('sfu:produced');
    expect(ev).toBeDefined();
    expect((ev!.data as ProducerPayload).kind).toBe('audio');
    expect((ev!.data as ProducerPayload).producerId).toBeDefined();
  });

  it('sfu:new-producer broadcast edilir', async () => {
    const { socket } = await setupWithTransport('sock-broadcast', 'ch-broadcast');

    await socket._fire('sfu:produce', {
      channelId:     'ch-broadcast',
      kind:          'audio',
      rtpParameters: AUDIO_RTP,
    });

    const broadcast = socket._emitted.find(e => e.event.includes('sfu:new-producer'));
    expect(broadcast).toBeDefined();
  });

  it('video producer simulcast için normalised encodings alır', async () => {
    const { socket } = await setupWithTransport('sock-video', 'ch-video');

    const VIDEO_RTP: import('../socket/handlers/mediasoup/types').RtpParameters = {
      codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 }],
      encodings: [{ rid: 'low' }, { rid: 'mid' }, { rid: 'high' }],
    };

    await socket._fire('sfu:produce', {
      channelId:     'ch-video',
      kind:          'video',
      rtpParameters: VIDEO_RTP,
    });

    const ev = socket._getEmit('sfu:produced');
    expect(ev).toBeDefined();
    expect((ev!.data as ProducerPayload).kind).toBe('video');

    // Asıl doğrulama: transport.produce()'a geçilen normalizedRtp içinde
    // her encoding'e maxBitrate ve scalabilityMode inject edilmiş olmalı.
    const peer = sfuPeers.get('sock-video');
    const sendTransport = peer?.sendTransport;
    expect(sendTransport).not.toBeNull();

    const produceCall = (sendTransport.produce as jest.Mock).mock.calls[0]?.[0];
    expect(produceCall).toBeDefined();
    expect(produceCall.kind).toBe('video');

    const encodings: Array<Record<string, unknown>> = produceCall.rtpParameters.encodings;
    expect(encodings).toHaveLength(3);

    // rid korunsun, maxBitrate ve scalabilityMode eklensin
    expect(encodings[0]).toHaveProperty('rid', 'low');
    expect(encodings[1]).toHaveProperty('rid', 'mid');
    expect(encodings[2]).toHaveProperty('rid', 'high');
    encodings.forEach(enc => {
      expect(enc).toHaveProperty('maxBitrate');
      expect(typeof enc.maxBitrate).toBe('number');
      expect(enc.scalabilityMode).toBe('S1T3');
    });
  });

  it('screenshare appData ile track kind "screen" olarak kaydedilir', async () => {
    const { socket } = await setupWithTransport('sock-screen', 'ch-screen');

    await socket._fire('sfu:produce', {
      channelId:     'ch-screen',
      kind:          'video',
      rtpParameters: { codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 }] },
      appData:       { screen: true },
    });

    const ev = socket._getEmit('sfu:produced');
    expect((ev!.data as ProducerPayload).kind).toBe('screen');
  });

  it('peer veya sendTransport yoksa sessizce dönüş yapar', async () => {
    const socket = makeSocket('sock-no-send');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await expect(
      socket._fire('sfu:produce', { channelId: 'ch-x', kind: 'audio', rtpParameters: AUDIO_RTP })
    ).resolves.not.toThrow();

    expect(socket._getEmit('sfu:produced')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. sfu:consume — consumer akışı
// ═══════════════════════════════════════════════════════════════════════════

describe('sfu:consume', () => {
  async function setupConsumer(socketId: string, channelId: string) {
    const socket = makeSocket(socketId);
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join',             { channelId, serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId, direction: 'recv' });
    return { socket, io };
  }

  it('consumer oluşturur ve sfu:consumed emit eder', async () => {
    const { socket } = await setupConsumer('sock-consume', 'ch-consume');

    await socket._fire('sfu:consume', {
      channelId:       'ch-consume',
      producerId:      'remote-producer-1',
      rtpCapabilities: DEFAULT_RTP_CAPS,
    });

    const ev = socket._getEmit('sfu:consumed');
    expect(ev).toBeDefined();
    expect((ev!.data as ProducerPayload).producerId).toBe('remote-producer-1');
    expect((ev!.data as ConsumerPayload).consumerId).toBeDefined();
    expect((ev!.data as ConsumerPayload).rtpParameters).toBeDefined();
  });

  it('router canConsume false dönerse sfu:error emit eder', async () => {
    const { socket } = await setupConsumer('sock-cant-consume', 'ch-cant');

    // canConsume → false
    const room = sfuRooms.get('ch-cant');
    if (room) (room.router.canConsume as jest.Mock).mockReturnValueOnce(false);

    await socket._fire('sfu:consume', {
      channelId:       'ch-cant',
      producerId:      'remote-x',
      rtpCapabilities: DEFAULT_RTP_CAPS,
    });

    expect(socket._getEmit('sfu:error')).toBeDefined();
  });

  it('oda veya peer yoksa sessizce dönüş yapar', async () => {
    const socket = makeSocket('sock-no-room-consume');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await expect(
      socket._fire('sfu:consume', { channelId: 'ch-ghost', producerId: 'p1', rtpCapabilities: DEFAULT_RTP_CAPS })
    ).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. sfu:resume-consumer
// ═══════════════════════════════════════════════════════════════════════════

describe('sfu:resume-consumer', () => {
  it('consumer resume eder', async () => {
    const socket = makeSocket('sock-resume');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join',             { channelId: 'ch-resume', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId: 'ch-resume', direction: 'recv' });
    await socket._fire('sfu:consume',          { channelId: 'ch-resume', producerId: 'prod-r', rtpCapabilities: DEFAULT_RTP_CAPS });

    const peer = sfuPeers.get('sock-resume');
    const consumerMock = peer?.consumers.get('prod-r');

    await socket._fire('sfu:resume-consumer', { producerId: 'prod-r' });

    expect(consumerMock?.resume).toHaveBeenCalled();
  });

  it('peer yoksa hata fırlatmaz', async () => {
    const socket = makeSocket('sock-no-resume');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await expect(
      socket._fire('sfu:resume-consumer', { producerId: 'x' })
    ).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. sfu:close-producer
// ═══════════════════════════════════════════════════════════════════════════

describe('sfu:close-producer', () => {
  it('producer kapatılır ve map\'ten silinir', async () => {
    const socket = makeSocket('sock-close-prod');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join',             { channelId: 'ch-close-prod', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId: 'ch-close-prod', direction: 'send' });
    await socket._fire('sfu:produce',          { channelId: 'ch-close-prod', kind: 'audio', rtpParameters: { codecs: [] } });

    const peer = sfuPeers.get('sock-close-prod');
    expect(peer?.producers.size).toBeGreaterThan(0);

    await socket._fire('sfu:close-producer', { kind: 'audio' });
    expect(peer?.producers.has('audio')).toBe(false);
  });

  it('peer yoksa sessizce dönüş yapar', async () => {
    const socket = makeSocket('sock-no-close');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await expect(
      socket._fire('sfu:close-producer', { kind: 'audio' })
    ).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. sfu:set-preferred-layer
// ═══════════════════════════════════════════════════════════════════════════

describe('sfu:set-preferred-layer', () => {
  it('consumer simulcast ise setPreferredLayers çağrılır', async () => {
    const socket = makeSocket('sock-layer');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join',             { channelId: 'ch-layer', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId: 'ch-layer', direction: 'recv' });
    await socket._fire('sfu:consume',          { channelId: 'ch-layer', producerId: 'prod-layer', rtpCapabilities: DEFAULT_RTP_CAPS });

    const peer = sfuPeers.get('sock-layer');
    const consumer = peer?.consumers.get('prod-layer');
    // type'ı simulcast yap
    if (consumer) Object.defineProperty(consumer, 'type', { value: 'simulcast' });

    await socket._fire('sfu:set-preferred-layer', { producerId: 'prod-layer', spatialLayer: 2, temporalLayer: 2 });
    expect(consumer?.setPreferredLayers).toHaveBeenCalledWith({ spatialLayer: 2, temporalLayer: 2 });
  });

  it('consumer simple type ise setPreferredLayers çağrılmaz', async () => {
    const socket = makeSocket('sock-simple-layer');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join',             { channelId: 'ch-simple-layer', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId: 'ch-simple-layer', direction: 'recv' });
    await socket._fire('sfu:consume',          { channelId: 'ch-simple-layer', producerId: 'prod-simple', rtpCapabilities: DEFAULT_RTP_CAPS });

    const peer = sfuPeers.get('sock-simple-layer');
    const consumer = peer?.consumers.get('prod-simple');

    await socket._fire('sfu:set-preferred-layer', { producerId: 'prod-simple', spatialLayer: 1, temporalLayer: 1 });
    expect(consumer?.setPreferredLayers).not.toHaveBeenCalled();
  });

  it('peer yoksa hata fırlatmaz', async () => {
    const socket = makeSocket('sock-no-peer-layer');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await expect(
      socket._fire('sfu:set-preferred-layer', { producerId: 'x', spatialLayer: 0, temporalLayer: 0 })
    ).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. sfu:leave
// ═══════════════════════════════════════════════════════════════════════════

describe('sfu:leave', () => {
  it('peer temizlenir', async () => {
    const socket = makeSocket('sock-leave');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join', { channelId: 'ch-leave', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });

    expect(sfuPeers.has('sock-leave')).toBe(true);

    await socket._fire('sfu:leave', { channelId: 'ch-leave', serverId: null });

    expect(sfuPeers.has('sock-leave')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. voice:state-update
// ═══════════════════════════════════════════════════════════════════════════

describe('voice:state-update', () => {
  it('peer durumu güncellenir ve diğer katılımcılara broadcast edilir', async () => {
    const socket = makeSocket('sock-state');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join', { channelId: 'ch-state', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });

    await socket._fire('voice:state-update', {
      channelId:    'ch-state',
      muted:        true,
      deafened:     false,
      screensharing: false,
      video:        false,
    });

    const peer = sfuPeers.get('sock-state');
    expect(peer?.muted).toBe(true);

    const broadcast = socket._emitted.find(e => e.event.includes('voice:peer-state'));
    expect(broadcast).toBeDefined();
  });

  it('peer yoksa broadcast yapılmaz ama hata fırlatmaz', async () => {
    const socket = makeSocket('sock-state-nopeer');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await expect(
      socket._fire('voice:state-update', { channelId: 'ch-x', muted: false, deafened: false, screensharing: false, video: false })
    ).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. voice:activity
// ═══════════════════════════════════════════════════════════════════════════

describe('voice:activity', () => {
  it('konuşma durumunu odaya broadcast eder', async () => {
    const socket = makeSocket('sock-activity');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser({ _id: 'user-activity' }));

    await socket._fire('voice:activity', { channelId: 'ch-activity', speaking: true });

    const broadcast = socket._emitted.find(e => e.event.includes('voice:activity'));
    expect(broadcast).toBeDefined();
    expect((broadcast!.data as ActivityPayload).speaking).toBe(true);
    expect((broadcast!.data as ActivityPayload).userId).toBe('user-activity');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. disconnect
// ═══════════════════════════════════════════════════════════════════════════

describe('disconnect', () => {
  it('peer temizlenir ve map\'ten silinir', async () => {
    const socket = makeSocket('sock-disconnect');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join', { channelId: 'ch-disconnect', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });

    expect(sfuPeers.has('sock-disconnect')).toBe(true);

    await socket._fire('disconnect', undefined);

    expect(sfuPeers.has('sock-disconnect')).toBe(false);
  });

  it('peer yoksa hata fırlatmaz', async () => {
    const socket = makeSocket('sock-no-peer-disconnect');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await expect(
      socket._fire('disconnect', undefined)
    ).resolves.not.toThrow();
  });
});
