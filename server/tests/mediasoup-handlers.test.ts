// server/tests/mediasoup-handlers.test.ts
// registerSFUHandlers — producer/consumer akışı, transport kurulumu,
// join/leave döngüsü, state-update, voice:activity ve hata yolları
//
// Kapsam: server/socket/handlers/mediasoup/index.ts
//
// NOT: mediasoup opsiyonel bağımlılık olduğundan virtual mock kullanılır.
// sfuRegistry ve turnConfig da stub'lanır — test ortamında Redis/ICE gerekmez.
import { present } from './helpers/narrow';
import { findEmitted } from './helpers/socketDoubles';

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
    rtpCapabilities:       { codecs: [{ kind: 'audio' as const, mimeType: 'audio/opus', clockRate: 48000, channels: 2 }], headerExtensions: [] },
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
  ROOM_LEASE_TTL_SECONDS: 3600,
  NODE_LEASE_MS: 30_000,
  NODE_HEARTBEAT_MS: 10_000,
  isLocalRoom:   jest.fn(async () => true),
  getRoomOwner:  jest.fn(async () => null),
  // `claimRoom` ARTIK bir sonuç döndürür: `{ owned, owner }`. Eskiden
  // `undefined` döndürüyordu; `getOrCreateRoom` atomik talebi beklemeye
  // başlayınca (yarış düzeltmesi) bu stub sessizce "sahiplik kaybedildi"
  // anlamına gelirdi ve TÜM SFU süiti düşerdi.
  claimRoom:     jest.fn(async () => ({ owned: true, owner: 'test-node' })),
  releaseRoom:   jest.fn(async () => {}),
  refreshRoom:   jest.fn(async () => true),
}));


// ── Stub: repositories ──────────────────────────────────────────────────────

jest.mock('../db/repositories', () => ({
  Channels: {
    findById: jest.fn(async (channelId: string) =>
      channelId.startsWith('gdm-') ? null : { _id: channelId, serverId: 'srv-1', type: 'voice' }
    ),
  },
  GroupDms: {
    findMember: jest.fn(async () => ({ userId: 'user-1' })),
  },
  Members: {
    findOne: jest.fn(async () => ({ timeoutUntil: null })),
  },
}));

jest.mock('../lib/permissions', () => ({
  PERMS: { VIEW_CHANNELS: 1, CONNECT: 2, SPEAK: 4 },
  hasPermission: jest.fn((permissions: number, permission: number) => (permissions & permission) === permission),
  resolvePermissions: jest.fn(async () => 1 | 2 | 4),
}));

// ── Stub: turnConfig ────────────────────────────────────────────────────────

jest.mock('../lib/turnConfig', () => ({
  getRtcIceConfig: jest.fn(() => ({ iceServers: [], iceTransportPolicy: 'all' })),
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
const repositories = require('../db/repositories');

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
  codecs: [{ kind: 'audio' as const, mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
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
function makeSocket(id: string = 'socket-1') {
  const emitted: { event: string; data: unknown }[] = [];
  const joined: string[] = [];
  const left: string[] = [];
  const activeRooms = new Set<string>();
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};

  const socket = {
    id,
    emit: jest.fn((event: string, data: unknown) => { emitted.push({ event, data }); }),
    join: jest.fn((room: string) => { joined.push(room); activeRooms.add(room); }),
    leave: jest.fn(async (room: string) => { left.push(room); activeRooms.delete(room); }),
    to:   jest.fn((room: string) => ({
      emit: jest.fn((event: string, data: unknown) => { emitted.push({ event: `to:${room}:${event}`, data }); }),
    })),
    on:   jest.fn((event: string, handler: (...args: unknown[]) => unknown) => { handlers[event] = handler; }),
    currentVoiceChannel: null as string | null,
    currentVoiceServer:  null as string | null,

    // Test helpers
    _emitted:  emitted,
    _joined:   joined,
    _left:     left,
    _activeRooms: activeRooms,
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
    _left:       typeof left;
    _activeRooms: Set<string>;
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
  it('rejects an unbounded room id before repository lookup', async () => {
    const socket = makeSocket('sock-unbounded-capabilities');
    registerSFUHandlers(socket, makeIo(), makeUser());
    repositories.Channels.findById.mockClear();
    await socket._fire('sfu:get-rtp-capabilities', { channelId: 'x'.repeat(129) });
    expect(socket._getEmit('sfu:error')).toBeDefined();
    expect(repositories.Channels.findById).not.toHaveBeenCalled();
  });

  it('mevcut bir oda için rtpCapabilities emit eder', async () => {
    const socket = makeSocket();
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await socket._fire('sfu:get-rtp-capabilities', { channelId: 'ch-1' });

    const ev = socket._getEmit('sfu:rtp-capabilities');
    expect(ev).toBeDefined();
    expect((ev!.data as RtpCapabilitiesPayload).rtpCapabilities).toBeDefined();
  });

  it('oda başka node tarafından sahiplenilmişse capability isteğinde de redirect eder', async () => {
    const registry = require('../lib/sfuRegistry');
    registry.claimRoom.mockImplementationOnce(async () => ({ owned: false, owner: 'bridge-2' }));

    const socket = makeSocket('sock-caps-redirect');
    registerSFUHandlers(socket, makeIo(), makeUser());
    await socket._fire('sfu:get-rtp-capabilities', { channelId: 'ch-caps-remote' });

    const redirect = socket._getEmit('sfu:redirect');
    expect(redirect).toBeDefined();
    expect((redirect!.data as { channelId: string; ownerNodeId: string })).toMatchObject({
      channelId: 'ch-caps-remote', ownerNodeId: 'bridge-2',
    });
    expect(socket._getEmit('sfu:error')).toBeUndefined();
    expect(sfuRooms.has('ch-caps-remote')).toBe(false);
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
    expect(require('../lib/sfuRegistry').releaseRoom).toHaveBeenCalledWith('ch-error');
  });

  it('capability isteğinden sonra katılım gelmezse boş router ve lease temizlenir', async () => {
    jest.useFakeTimers();
    try {
      const socket = makeSocket('sock-caps-abandoned');
      registerSFUHandlers(socket, makeIo(), makeUser());
      await socket._fire('sfu:get-rtp-capabilities', { channelId: 'ch-caps-abandoned' });
      expect(sfuRooms.has('ch-caps-abandoned')).toBe(true);

      jest.advanceTimersByTime(5_001);

      expect(sfuRooms.has('ch-caps-abandoned')).toBe(false);
      expect(require('../lib/sfuRegistry').releaseRoom).toHaveBeenCalledWith('ch-caps-abandoned');
    } finally {
      jest.useRealTimers();
    }
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

  it('Redis lease artık bu nodea ait değilse yerel router ve peerleri kapatır', async () => {
    jest.useFakeTimers();
    try {
      const registry = require('../lib/sfuRegistry');
      registry.refreshRoom.mockResolvedValueOnce(false);
      const socket = makeSocket('sock-lost-lease');
      registerSFUHandlers(socket, makeIo(), makeUser());
      await socket._fire('sfu:join', {
        channelId: 'ch-lost-lease', serverId: 'srv-1', rtpCapabilities: DEFAULT_RTP_CAPS,
      });
      const router = sfuRooms.get('ch-lost-lease')!.router;

      await jest.advanceTimersByTimeAsync(10 * 60 * 1_000);

      expect(sfuRooms.has('ch-lost-lease')).toBe(false);
      expect(sfuPeers.has('sock-lost-lease')).toBe(false);
      expect(router.close).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  // P1 çok-düğüm: devralma artık sahibin 30 sn'lik canlılık kirasına bağlı.
  // Kirasını doğrulayamayan düğüm (Redis'ten kopuk) kira dolmadan yerel
  // router'ı kapatmalı; aksi halde devralan düğümle İKİ router olur.
  it('kalp atışı doğrulanamazsa yerel router düğüm kirası dolmadan kapanır; doğrulanan oda açık kalır', async () => {
    jest.useFakeTimers();
    try {
      const registry = require('../lib/sfuRegistry');
      registry.refreshRoom.mockRejectedValue(new Error('redis unreachable'));
      const lost = makeSocket('sock-fenced');
      registerSFUHandlers(lost, makeIo(), makeUser());
      await lost._fire('sfu:join', { channelId: 'ch-fenced', serverId: 'srv-1', rtpCapabilities: DEFAULT_RTP_CAPS });
      expect(sfuRooms.has('ch-fenced')).toBe(true);

      await jest.advanceTimersByTimeAsync(registry.NODE_LEASE_MS - 5_000 + 1);
      expect(sfuRooms.has('ch-fenced')).toBe(false);
      expect(sfuPeers.has('sock-fenced')).toBe(false);

      // Negatif kontrol: kalp atışı doğrulanıyorsa oda aynı süre sonra açıktır.
      registry.refreshRoom.mockReset();
      registry.refreshRoom.mockResolvedValue(true);
      const ok = makeSocket('sock-confirmed');
      registerSFUHandlers(ok, makeIo(), makeUser());
      await ok._fire('sfu:join', { channelId: 'ch-confirmed', serverId: 'srv-1', rtpCapabilities: DEFAULT_RTP_CAPS });
      await jest.advanceTimersByTimeAsync(registry.NODE_LEASE_MS * 3);
      expect(sfuRooms.has('ch-confirmed')).toBe(true);
    } finally {
      const registry = require('../lib/sfuRegistry');
      registry.refreshRoom.mockReset();
      registry.refreshRoom.mockResolvedValue(true);
      jest.useRealTimers();
    }
  });

  it('daha yeni join eski yavaş authorization sonucunu geçersiz kılar', async () => {
    const repositories = jest.requireMock('../db/repositories');
    let resolveSlow!: (value: unknown) => void;
    (repositories.Channels.findById as jest.Mock).mockImplementation((channelId: string) => {
      if (channelId === 'ch-slow') {
        return new Promise(resolve => { resolveSlow = resolve; });
      }
      return Promise.resolve({ _id: channelId, serverId: 'srv-1', type: 'voice' });
    });

    const socket = makeSocket('sock-stale-join');
    const io = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    const slowJoin = socket._fire('sfu:join', {
      channelId: 'ch-slow', serverId: 'srv-1', rtpCapabilities: DEFAULT_RTP_CAPS,
    });
    const fastJoin = socket._fire('sfu:join', {
      channelId: 'ch-fast', serverId: 'srv-1', rtpCapabilities: DEFAULT_RTP_CAPS,
    });

    await fastJoin;
    resolveSlow({ _id: 'ch-slow', serverId: 'srv-1', type: 'voice' });
    await slowJoin;

    expect(sfuPeers.get('sock-stale-join')?.channelId).toBe('ch-fast');
    expect(socket._activeRooms.has('voice:ch-slow')).toBe(false);
    expect(socket._activeRooms.has('voice:ch-fast')).toBe(true);
  });

  it('join sırasında mevcut peer temizlenerek yeniden kaydolur', async () => {
    const socket = makeSocket('sock-rejoin');
    const io     = makeIo();

    // İlk join
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join', { channelId: 'ch-rejoin', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });

    // İkinci join — aynı socket farklı kanala
    await socket._fire('sfu:join', { channelId: 'ch-rejoin2', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });

    // Yeni oda oluştu ve eski Socket.IO voice room gerçekten bırakıldı.
    expect(sfuRooms.has('ch-rejoin2')).toBe(true);
    expect(socket._left).toContain('voice:ch-rejoin');
    expect(socket._activeRooms.has('voice:ch-rejoin')).toBe(false);
    expect(socket._activeRooms.has('voice:ch-rejoin2')).toBe(true);
    expect(sfuPeers.get('sock-rejoin')?.channelId).toBe('ch-rejoin2');
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
      channelId:       'gdm-group',
      rtpCapabilities: DEFAULT_RTP_CAPS,
    });

    expect(socket._getEmit('_sfu:join-routed')).toBeDefined();
    expect(sfuPeers.has('sock-group')).toBe(true);
  });

  it('GDM room için client-supplied serverId claim fail-closed olur', async () => {
    const socket = makeSocket('sock-group-claim');
    const io = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await socket._fire('sfu:group-join', {
      channelId: 'gdm-group',
      serverId: 'srv-forged',
      rtpCapabilities: DEFAULT_RTP_CAPS,
    });

    expect(sfuPeers.has('sock-group-claim')).toBe(false);
    expect(socket._getEmit('sfu:error')).toBeDefined();
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

  it('aynı yönde ikinci transport oluşturarak worker kaynağı sızdıramaz', async () => {
    const { socket } = await setupPeer('sock-duplicate-transport', 'ch-duplicate-transport');
    await socket._fire('sfu:create-transport', { channelId: 'ch-duplicate-transport', direction: 'send' });
    await socket._fire('sfu:create-transport', { channelId: 'ch-duplicate-transport', direction: 'send' });

    const room = sfuRooms.get('ch-duplicate-transport')!;
    expect(room.router.createWebRtcTransport).toHaveBeenCalledTimes(1);
    expect(socket._getEmit('sfu:error')).toBeDefined();
  });

  it('bilinmeyen direction değerini recv olarak yorumlamaz', async () => {
    const { socket } = await setupPeer('sock-invalid-direction', 'ch-invalid-direction');
    await socket._fire('sfu:create-transport', { channelId: 'ch-invalid-direction', direction: 'sideways' });

    expect(sfuPeers.get('sock-invalid-direction')?.recvTransport).toBeNull();
    expect(socket._getEmit('sfu:error')).toBeDefined();
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

  it('transport provider failure leaves no half-attached transport', async () => {
    const { socket } = await setupPeer('sock-transport-provider-failure', 'ch-transport-provider-failure');
    const room = sfuRooms.get('ch-transport-provider-failure')!;
    (room.router.createWebRtcTransport as jest.Mock).mockRejectedValueOnce(new Error('worker transport failure'));
    await socket._fire('sfu:create-transport', { channelId: 'ch-transport-provider-failure', direction: 'send' });
    expect(sfuPeers.get('sock-transport-provider-failure')?.sendTransport).toBeNull();
    // KANONIK: istemciye SABIT, sinirli bir mesaj doner. Saglayicinin ic hata
    // metni ('worker transport failure') sokete SIZDIRILMAZ; teshis yalnizca
    // sunucu loguna gider.
    const emitted = socket._getEmit('sfu:error')?.data as { code?: string; message?: string };
    expect(emitted).toMatchObject({ code: 'TRANSPORT_FAILED', message: 'Medya bağlantısı oluşturulamadı.' });
    expect(JSON.stringify(emitted)).not.toContain('worker transport failure');
  });

  it('failed DTLS state closes and detaches the canonical transport', async () => {
    const { socket } = await setupPeer('sock-dtls-failure', 'ch-dtls-failure');
    await socket._fire('sfu:create-transport', { channelId: 'ch-dtls-failure', direction: 'send' });
    const peer = sfuPeers.get('sock-dtls-failure')!;
    const transport = peer.sendTransport as any;
    transport._trigger('dtlsstatechange', 'failed');
    expect(transport.close).toHaveBeenCalled();
    expect(peer.sendTransport).toBeNull();
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

  it('membership revoked after allocation prevents transport connection', async () => {
    const socket = makeSocket('sock-connect-revoked');
    registerSFUHandlers(socket, makeIo(), makeUser());
    await socket._fire('sfu:join', { channelId: 'ch-connect-revoked', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId: 'ch-connect-revoked', direction: 'send' });
    const transport = sfuPeers.get('sock-connect-revoked')!.sendTransport!;
    repositories.Members.findOne.mockResolvedValueOnce(null);
    await socket._fire('sfu:connect-transport', { channelId: 'ch-connect-revoked', direction: 'send', dtlsParameters: DTLS });
    expect(transport.connect).not.toHaveBeenCalled();
    expect(socket._getEmit('sfu:error')).toBeDefined();
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
    const sendTransport = present(peer?.sendTransport, 'gonderim tasiyicisi');

    const produceCall = jest.mocked(sendTransport.produce).mock.calls[0]?.[0];
    expect(produceCall).toBeDefined();
    expect(produceCall.kind).toBe('video');

    // `encodings` ISTEGE BAGLIdir (`RtpEncodingParameters[] | undefined`);
    // varligi bu testin IDDIASININ parcasi oldugu icin dogrulanir.
    const encodings = present(produceCall.rtpParameters.encodings, 'encodings');
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

  it('aynı track kind için ikinci producer oluşturarak kaynak sızdıramaz', async () => {
    const { socket } = await setupWithTransport('sock-duplicate-producer', 'ch-duplicate-producer');
    const payload = { channelId: 'ch-duplicate-producer', kind: 'audio', rtpParameters: AUDIO_RTP };
    await socket._fire('sfu:produce', payload);
    await socket._fire('sfu:produce', payload);

    const transport = sfuPeers.get('sock-duplicate-producer')!.sendTransport!;
    expect(transport.produce).toHaveBeenCalledTimes(1);
    expect(socket._getEmit('sfu:error')).toBeDefined();
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

  it('producer lifecycle events are scoped to its canonical room and clean the peer map', async () => {
    const { socket } = await setupWithTransport('sock-producer-lifecycle', 'ch-producer-lifecycle');
    await socket._fire('sfu:produce', { channelId: 'ch-producer-lifecycle', kind: 'audio', rtpParameters: AUDIO_RTP });
    const peer = sfuPeers.get('sock-producer-lifecycle')!;
    const producer = peer.producers.get('audio') as any;
    producer._trigger('score', [{ score: 10 }]);
    producer._trigger('videoorientationchange', { rotation: 90 });
    expect(socket._getEmit('sfu:producer-score')).toBeDefined();
    expect(findEmitted(socket._emitted, 'to:voice:ch-producer-lifecycle:sfu:video-orientation')).toBeDefined();
    producer._trigger('transportclose');
    expect(peer.producers.has('audio')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. sfu:consume — consumer akışı
// ═══════════════════════════════════════════════════════════════════════════

describe('sfu:consume', () => {
  const CONSUME_AUDIO_RTP: import('../socket/handlers/mediasoup/types').RtpParameters = {
    codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }],
  };

  /**
   * ── KANONİK SAHİPLİK: producer ODAYA AİT OLMALI ─────────────────────────
   * `sfu:consume` artık istemcinin bildirdiği `producerId`e GÜVENMİYOR;
   * producer'ın GERÇEKTEN o medya odasında bulunduğunu doğruluyor
   * (mediasoup/index.ts:332-337). Aksi hâlde bir istemci BAŞKA bir odadaki
   * producer'ı consume edebilirdi — doğrudan bir ses/görüntü sızıntısı.
   *
   * Bu yardımcı eskiden uydurma bir `'remote-producer-1'` kimliği kullanıyordu;
   * koruma eklendikten sonra istek doğru şekilde reddediliyor ve testler
   * düşüyordu. Artık odada GERÇEK bir producer üretilir ve consume o kimlikle
   * yapılır — yani mutlu yol gerçekten yürütülür.
   */
  async function setupConsumer(socketId: string, channelId: string) {
    // Odada yayın yapan bir akran oluştur.
    const producerSocket = makeSocket(socketId + '-producer');
    const producerIo     = makeIo();
    registerSFUHandlers(producerSocket, producerIo, makeUser());
    await producerSocket._fire('sfu:join',             { channelId, serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await producerSocket._fire('sfu:create-transport', { channelId, direction: 'send' });
    await producerSocket._fire('sfu:produce',          { channelId, kind: 'audio', rtpParameters: CONSUME_AUDIO_RTP });
    const producedEvent = producerSocket._getEmit('sfu:produced');
    const producerId = String((producedEvent!.data as ProducerPayload).producerId);

    const socket = makeSocket(socketId);
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await socket._fire('sfu:join',             { channelId, serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId, direction: 'recv' });
    return { socket, io, producerId, producerSocket };
  }

  it('consumer oluşturur ve sfu:consumed emit eder', async () => {
    const { socket, producerId } = await setupConsumer('sock-consume', 'ch-consume');

    await socket._fire('sfu:consume', {
      channelId:       'ch-consume',
      producerId,
      rtpCapabilities: DEFAULT_RTP_CAPS,
    });

    const ev = socket._getEmit('sfu:consumed');
    expect(ev).toBeDefined();
    expect((ev!.data as ProducerPayload).producerId).toBe(producerId);
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

  it('consumer transport/producer closure callbacks retire canonical state and notify the socket', async () => {
    const { socket, producerId } = await setupConsumer('sock-consumer-lifecycle', 'ch-consumer-lifecycle');
    await socket._fire('sfu:consume', { channelId: 'ch-consumer-lifecycle', producerId, rtpCapabilities: DEFAULT_RTP_CAPS });
    const peer = sfuPeers.get('sock-consumer-lifecycle')!;
    const consumer = peer.consumers.get(producerId) as any;
    consumer._trigger('transportclose');
    expect(peer.consumers.has(producerId)).toBe(false);
    peer.consumers.set(producerId, consumer);
    consumer._trigger('producerclose');
    expect(peer.consumers.has(producerId)).toBe(false);
    expect(socket._getEmit('sfu:producer-closed')?.data).toEqual({ producerId });
  });
});


/**
 * Odada GERÇEK bir producer üretip kimliğini döndürür.
 *
 * `sfu:consume` artık producer'ın o medya odasına AİT olduğunu doğruluyor
 * (mediasoup/index.ts:332-337); uydurma kimlikler doğru şekilde reddediliyor.
 * Consumer gerektiren süitler bu yüzden önce gerçek bir yayın kurmalı.
 */
async function seedRoomProducer(channelId: string, tag: string): Promise<string> {
  const AUDIO: import('../socket/handlers/mediasoup/types').RtpParameters = {
    codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }],
  };
  const s = makeSocket(`producer-${tag}`);
  registerSFUHandlers(s, makeIo(), makeUser());
  await s._fire('sfu:join',             { channelId, serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
  await s._fire('sfu:create-transport', { channelId, direction: 'send' });
  await s._fire('sfu:produce',          { channelId, kind: 'audio', rtpParameters: AUDIO });
  return String((s._getEmit('sfu:produced')!.data as ProducerPayload).producerId);
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. sfu:resume-consumer
// ═══════════════════════════════════════════════════════════════════════════

describe('sfu:resume-consumer', () => {
  it('consumer resume eder', async () => {
    const socket = makeSocket('sock-resume');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    const producerId = await seedRoomProducer('ch-resume', 'resume');
    await socket._fire('sfu:join',             { channelId: 'ch-resume', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId: 'ch-resume', direction: 'recv' });
    await socket._fire('sfu:consume',          { channelId: 'ch-resume', producerId, rtpCapabilities: DEFAULT_RTP_CAPS });

    const peer = sfuPeers.get('sock-resume');
    const consumerMock = peer?.consumers.get(producerId);
    expect(consumerMock).toBeDefined();

    await socket._fire('sfu:resume-consumer', { producerId });

    expect(consumerMock!.resume).toHaveBeenCalled();
  });

  it('peer yoksa hata fırlatmaz', async () => {
    const socket = makeSocket('sock-no-resume');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());

    await expect(
      socket._fire('sfu:resume-consumer', { producerId: 'x' })
    ).resolves.not.toThrow();
  });

  it('membership revoked after consume prevents the paused consumer from resuming', async () => {
    const socket = makeSocket('sock-resume-revoked');
    registerSFUHandlers(socket, makeIo(), makeUser());
    const producerId = await seedRoomProducer('ch-resume-revoked', 'resume-revoked');
    await socket._fire('sfu:join', { channelId: 'ch-resume-revoked', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId: 'ch-resume-revoked', direction: 'recv' });
    await socket._fire('sfu:consume', { channelId: 'ch-resume-revoked', producerId, rtpCapabilities: DEFAULT_RTP_CAPS });
    const consumer = sfuPeers.get('sock-resume-revoked')!.consumers.get(producerId)!;
    repositories.Members.findOne.mockResolvedValueOnce(null);
    await socket._fire('sfu:resume-consumer', { producerId });
    expect(consumer.resume).not.toHaveBeenCalled();
    expect(socket._getEmit('sfu:error')).toBeDefined();
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
    const producerId = await seedRoomProducer('ch-layer', 'layer');
    await socket._fire('sfu:join',             { channelId: 'ch-layer', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId: 'ch-layer', direction: 'recv' });
    await socket._fire('sfu:consume',          { channelId: 'ch-layer', producerId, rtpCapabilities: DEFAULT_RTP_CAPS });

    const peer = sfuPeers.get('sock-layer');
    const consumer = peer?.consumers.get(producerId);
    expect(consumer).toBeDefined();
    // type'ı simulcast yap
    Object.defineProperty(consumer!, 'type', { value: 'simulcast' });

    await socket._fire('sfu:set-preferred-layer', { producerId, spatialLayer: 2, temporalLayer: 2 });
    expect(consumer!.setPreferredLayers).toHaveBeenCalledWith({ spatialLayer: 2, temporalLayer: 2 });
  });

  it('consumer simple type ise setPreferredLayers çağrılmaz', async () => {
    const socket = makeSocket('sock-simple-layer');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    const producerId = await seedRoomProducer('ch-simple-layer', 'simple');
    await socket._fire('sfu:join',             { channelId: 'ch-simple-layer', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId: 'ch-simple-layer', direction: 'recv' });
    await socket._fire('sfu:consume',          { channelId: 'ch-simple-layer', producerId, rtpCapabilities: DEFAULT_RTP_CAPS });

    const peer = sfuPeers.get('sock-simple-layer');
    const consumer = peer?.consumers.get(producerId);
    expect(consumer).toBeDefined();

    await socket._fire('sfu:set-preferred-layer', { producerId, spatialLayer: 1, temporalLayer: 1 });
    expect(consumer!.setPreferredLayers).not.toHaveBeenCalled();
  });

  it('peer yoksa hata fırlatmaz', async () => {
    const socket = makeSocket('sock-no-peer-layer');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser());
    await expect(
      socket._fire('sfu:set-preferred-layer', { producerId: 'x', spatialLayer: 0, temporalLayer: 0 })
    ).resolves.not.toThrow();
  });

  it('revoked membership cannot keep changing consumer layers', async () => {
    const socket = makeSocket('sock-layer-revoked');
    registerSFUHandlers(socket, makeIo(), makeUser());
    const producerId = await seedRoomProducer('ch-layer-revoked', 'layer-revoked');
    await socket._fire('sfu:join', { channelId: 'ch-layer-revoked', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('sfu:create-transport', { channelId: 'ch-layer-revoked', direction: 'recv' });
    await socket._fire('sfu:consume', { channelId: 'ch-layer-revoked', producerId, rtpCapabilities: DEFAULT_RTP_CAPS });
    const consumer = sfuPeers.get('sock-layer-revoked')!.consumers.get(producerId)!;
    Object.defineProperty(consumer, 'type', { value: 'simulcast' });
    repositories.Members.findOne.mockResolvedValueOnce(null);
    await socket._fire('sfu:set-preferred-layer', { producerId, spatialLayer: 1, temporalLayer: 1 });
    expect(consumer.setPreferredLayers).not.toHaveBeenCalled();
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

    await flushAsyncAuth();

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

  it('rejects non-boolean state before mutating or broadcasting peer state', async () => {
    const socket = makeSocket('sock-state-malformed');
    registerSFUHandlers(socket, makeIo(), makeUser());
    await socket._fire('sfu:join', { channelId: 'ch-state-malformed', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    const peer = sfuPeers.get('sock-state-malformed')!;
    await socket._fire('voice:state-update', {
      channelId: 'ch-state-malformed', muted: 'yes', deafened: false, screensharing: false, video: false,
    });
    expect(peer.muted).toBe(false);
    expect(socket._emitted.find(e => e.event.includes('voice:peer-state'))).toBeUndefined();
  });
});


/**
 * `voice:state-update` ve `voice:activity` dinleyicileri SENKRONdur ama içeride
 * `void authorizeMediaRoom(...).then(...)` çalıştırır: yetki çözümü bir sonraki
 * mikrogörev turunda tamamlanır. `_fire()` döndüğünde etki HENÜZ uygulanmamıştır.
 *
 * Bu, yetkilendirmenin asenkron hâle getirilmesinin bir sonucudur ve testlerin
 * "hiç yayın yapılmadı" gibi YANLIŞ bir sonuç görmesine yol açıyordu.
 */
const flushAsyncAuth = () => new Promise<void>((resolve) => setImmediate(resolve));

// ═══════════════════════════════════════════════════════════════════════════
// 12. voice:activity
// ═══════════════════════════════════════════════════════════════════════════

describe('voice:activity', () => {
  it('konuşma durumunu odaya broadcast eder', async () => {
    const socket = makeSocket('sock-activity');
    const io     = makeIo();
    registerSFUHandlers(socket, io, makeUser({ _id: 'user-activity' }));
    // ── ÖN KOŞUL: ODADA OLMAK ────────────────────────────────────────────
    // `voice:activity` artık `requireOwnPeerChannel(channelId)` ile başlıyor:
    // katılmamış bir soket, üyesi olmadığı kanala "konuşuyor" sinyali
    // YAYINLAYAMAZ. Test önce gerçekten katılır.
    await socket._fire('sfu:join', { channelId: 'ch-activity', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });

    await socket._fire('voice:activity', { channelId: 'ch-activity', speaking: true });
    await flushAsyncAuth();

    const broadcast = socket._emitted.find(e => e.event.includes('voice:activity'));
    expect(broadcast).toBeDefined();
    expect((broadcast!.data as ActivityPayload).speaking).toBe(true);
    expect((broadcast!.data as ActivityPayload).userId).toBe('user-activity');
  });

  it('GÜVENLİK: odada OLMAYAN soket aktivite yayınlayamaz', async () => {
    // Aksi hâlde herhangi bir istemci, üyesi olmadığı bir sesli kanala sahte
    // "konuşuyor" göstergesi enjekte edebilirdi.
    const socket = makeSocket('sock-activity-outsider');
    registerSFUHandlers(socket, makeIo(), makeUser({ _id: 'user-outsider' }));

    await socket._fire('voice:activity', { channelId: 'ch-activity', speaking: true });
    await flushAsyncAuth();

    expect(socket._emitted.find(e => e.event.includes('voice:activity'))).toBeUndefined();
  });

  it('malformed non-boolean speaking state is not broadcast', async () => {
    const socket = makeSocket('sock-activity-malformed');
    registerSFUHandlers(socket, makeIo(), makeUser());
    await socket._fire('sfu:join', { channelId: 'ch-activity-malformed', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS });
    await socket._fire('voice:activity', { channelId: 'ch-activity-malformed', speaking: 'true' });
    expect(socket._emitted.find(e => e.event.includes('voice:activity'))).toBeUndefined();
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

// ═══════════════════════════════════════════════════════════════════════════
// ÇOK-NODE SAHİPLİK YARIŞI — KAYBEDEN YÖNLENDİRİR, İKİNCİ ODA AÇMAZ
// ═══════════════════════════════════════════════════════════════════════════
// `isLocalRoom()` kontrolü ile oda oluşturma arasında BAŞKA bir node odayı
// sahiplenebilir (kontrol-et-sonra-davran). Eskiden kayıt koşulsuz `SETEX`
// kullandığı için iki node aynı kanal için AYRI odalar açıyor ve
// katılımcılar birbirini duyamıyordu.
//
// Artık talep atomiktir; kaybeden node yerel oda AÇMAZ ve istemciyi kanonik
// node'a yönlendirir. Bu davranış ölçülmezse düzeltme sessizce geri alınabilir.
describe('sfu:join — oda başka node tarafından sahiplenilmişse', () => {
  const registry = require('../lib/sfuRegistry');

  afterEach(() => {
    registry.claimRoom.mockImplementation(async () => ({ owned: true, owner: 'test-node' }));
    registry.isLocalRoom.mockImplementation(async () => true);
  });

  it('YEREL ODA AÇMAZ ve sfu:redirect emit eder', async () => {
    // Kayıt "boş" göründü (isLocalRoom true) ama talep anında başka node kazandı.
    registry.isLocalRoom.mockImplementation(async () => true);
    registry.claimRoom.mockImplementation(async () => ({ owned: false, owner: 'other-node' }));

    const socket = makeSocket('sock-claim-lost');
    registerSFUHandlers(socket, makeIo(), makeUser());

    await socket._fire('sfu:join', {
      channelId: 'ch-claim-lost', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS,
    });

    const redirect = socket._getEmit('sfu:redirect');
    expect(redirect).toBeDefined();
    expect((redirect!.data as { ownerNodeId: string }).ownerNodeId).toBe('other-node');

    // EN ÖNEMLİ İDDİA: ikinci bir yerel oda OLUŞMAMALI.
    expect(sfuRooms.has('ch-claim-lost')).toBe(false);
    expect(socket._getEmit('sfu:joined')).toBeUndefined();
  });

  it('YANLIŞ POZİTİF KONTROLÜ: talep kazanılırsa normal katılım sürer', async () => {
    registry.claimRoom.mockImplementation(async () => ({ owned: true, owner: 'test-node' }));

    const socket = makeSocket('sock-claim-won');
    registerSFUHandlers(socket, makeIo(), makeUser());

    await socket._fire('sfu:join', {
      channelId: 'ch-claim-won', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS,
    });

    expect(socket._getEmit('sfu:redirect')).toBeUndefined();
    expect(socket._getEmit('sfu:joined')).toBeDefined();
    expect(sfuRooms.has('ch-claim-won')).toBe(true);
  });

  it('registry claim hatasında yerel oda açmaz ve SFU katılımını fail-closed reddeder', async () => {
    registry.claimRoom.mockRejectedValueOnce(new Error('redis ownership unavailable'));

    const socket = makeSocket('sock-claim-error');
    registerSFUHandlers(socket, makeIo(), makeUser());

    await socket._fire('sfu:join', {
      channelId: 'ch-claim-error', serverId: null, rtpCapabilities: DEFAULT_RTP_CAPS,
    });

    expect(sfuRooms.has('ch-claim-error')).toBe(false);
    expect(socket._getEmit('sfu:joined')).toBeUndefined();
    expect(socket._getEmit('sfu:error')).toBeDefined();
  });
});
