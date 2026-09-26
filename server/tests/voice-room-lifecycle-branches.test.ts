// server/tests/voice-room-lifecycle-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SES ODASI YAŞAM DÖNGÜSÜ — KAPASİTE, YARIŞLAR, AYRILMA VE DEPO OTORİTESİ
// ════════════════════════════════════════════════════════════════════════════
//
// `voice-authorization.test.ts` katılım YETKİSİNİ ölçer. Bu dosya, yetki
// verildikten SONRAKİ durum yönetimini kapatır; her biri gerçek bir üretim
import { findEmitted, requireEmitted } from './helpers/socketDoubles';
// arızası üretir:
//
//   · KAPASİTE — oda dolduğunda istemci "katıldım" sanıp mikrofon açmamalı;
//     ret, isteğe bağlanmış (requestId) açık bir kodla gelmelidir.
//   · YARIŞ — kullanıcı hızlıca kanal değiştirirse ESKİ katılım tamamlanınca
//     kendini odaya YAZMAMALIDIR; aksi hâlde hayalet katılımcı kalır.
//   · ODA DEĞİŞTİRME — yeni odaya katılım, eskisinden ayrılmayı içerir.
//   · DEPO OTORİTESİ — paylaşılan koordinasyon ilan edilmişken erişilemezse
//     ses üyeliği süreç-yerel bir kopyaya ÇATALLANMAMALIDIR (fail-closed).
//   · GERİ UYUMLULUK — `voiceRooms` hem Map hem nesne gibi kullanılır; her iki
//     erişim biçimi de AYNI kanonik depoyu görmelidir.

'use strict';
process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

jest.mock('../music', () => ({ readMusicQueue: jest.fn(async () => ({ current: null, queue: [] })) }));

// eslint-disable-next-line no-var
var vdb: ReturnType<typeof import('./helpers/mockDb').createMockDb>;
jest.mock('../db/loader', () => {
  const { createMockDb } = require('./helpers/mockDb');
  vdb = createMockDb();
  return vdb;
});
jest.mock('../db/index', () => require('../db/loader'));

// Imza ACIKCA yazilir: @types/jest'te `Mock<T, Y>` icin Y varsayilani
// `any`dir (`any[]` DEGIL), yani bare `jest.fn()` REST parametresi
// tasimaz ve `mock(...args)` TS2556 verir.
const redisAvailable = jest.fn<boolean, unknown[]>(() => false);
const authoritative = new Map<string, unknown>();
jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: (...a: unknown[]) => redisAvailable(...a),
  cache: {
    getAuthoritative: jest.fn(async (key: string) => authoritative.get(key) ?? null),
    setAuthoritative: jest.fn(async (key: string, value: unknown) => { authoritative.set(key, value); }),
    delAuthoritative: jest.fn(async (key: string) => { authoritative.delete(key); }),
    withKeyLock: jest.fn(async <T>(_key: string, fn: () => Promise<T>) => fn()),
  },
}));

import {
  __getVoiceRoomForTest,
  __setVoiceRoomForTest,
  getVoiceRoomPeers,
  leaveVoice,
  registerVoiceHandlers,
  voiceRooms,
} from '../socket/handlers/voice';

const SRV = 'sv-life';
const CH_A = 'vch-a';
const CH_B = 'vch-b';
const VIEW_CHANNELS = 1 << 0;

type Emission = { event: string; data: unknown };
type TargetedEmission = Emission & { target: string | string[] };

function makeSocket(id: string) {
  const handlers: Record<string, (d?: unknown) => unknown> = {};
  const rooms = new Set<string>([id]);
  const emitted: Emission[] = [];
  const broadcast: Array<Emission & { room: string }> = [];
  return {
    id, rooms,
    on(e: string, f: (d?: unknown) => unknown) { handlers[e] = f; },
    emit(event: string, data: unknown) { emitted.push({ event, data }); },
    join(r: string) { rooms.add(r); },
    leave(r: string) { rooms.delete(r); },
    to(room: string) { return { emit(event: string, data: unknown) { broadcast.push({ event, data, room }); } }; },
    _rooms: rooms, _emitted: emitted, _broadcast: broadcast,
    async _trigger(e: string, d?: unknown) { if (handlers[e]) await handlers[e](d); },
  };
}

function makeIo() {
  const emitted: TargetedEmission[] = [];
  return {
    _emitted: emitted,
    to(target: string | string[]) { return { emit(event: string, data: unknown) { emitted.push({ event, data, target }); } }; },
  };
}

const user = (id: string) => ({ _id: id, displayName: id, avatarColor: '#fff' });

function register(socket: ReturnType<typeof makeSocket>, io: ReturnType<typeof makeIo>, id = 'uye', caps = {}) {
  registerVoiceHandlers(socket as never, io as never, user(id) as never, caps);
}

beforeEach(async () => {
  jest.clearAllMocks();
  authoritative.clear();
  redisAvailable.mockReturnValue(false);
  for (const key of [...(voiceRooms as unknown as Map<string, unknown>).keys()]) {
    (voiceRooms as unknown as Map<string, unknown>).delete(key);
  }

  await vdb.servers.insert({ _id: SRV, name: 'S', ownerId: 'o1', createdAt: 1 });
  await vdb.channels.insert({ _id: CH_A, serverId: SRV, name: 'a', type: 'voice', createdAt: 1 });
  await vdb.channels.insert({ _id: CH_B, serverId: SRV, name: 'b', type: 'voice', createdAt: 1 });
  await vdb.members.insert({ userId: 'uye', serverId: SRV, roles: [], joinedAt: 1 });
  await vdb.members.insert({ userId: 'uye2', serverId: SRV, roles: [], joinedAt: 1 });
  void VIEW_CHANNELS;
});

describe('yetenek bildirimi', () => {
  it('SFU yalnız açıkça hazır bildirildiğinde duyurulur', async () => {
    const withoutSfu = makeSocket('s1');
    register(withoutSfu, makeIo());
    await withoutSfu._trigger('voice:get-capabilities');
    expect(withoutSfu._emitted[0]).toEqual({ event: 'voice:capabilities', data: { p2p: true, sfu: false } });

    const withSfu = makeSocket('s2');
    register(withSfu, makeIo(), 'uye', { sfuReady: true });
    await withSfu._trigger('voice:get-capabilities');
    expect(withSfu._emitted[0]).toEqual({ event: 'voice:capabilities', data: { p2p: true, sfu: true } });
  });
});

describe('oda kapasitesi ve tekrar katılım', () => {
  it('oda dolduğunda katılım isteğe bağlanmış bir ret ile reddedilir', async () => {
    // Uretim tavani `MAX_VOICE_PEERS` (varsayilan 25); oda TAM DOLU kurulur.
    const full = Array.from({ length: 25 }, (_, i) => ({
      socketId: `dolu-${i}`, userId: `u${i}`, displayName: `U${i}`, avatarColor: '#000',
    }));
    await __setVoiceRoomForTest(CH_A, full);
    const socket = makeSocket('s-yeni');
    register(socket, makeIo());

    await socket._trigger('voice:join', { channelId: CH_A, serverId: SRV, requestId: 'req-1' });

    expect(socket._rooms.has(`voice:${CH_A}`)).toBe(false);
    expect(socket._emitted.map(e => e.event)).toEqual(['voice:full', 'voice:join-rejected']);
    expect(socket._emitted[1]!.data).toMatchObject({ channelId: CH_A, requestId: 'req-1', code: 'FULL' });
    expect(await __getVoiceRoomForTest(CH_A)).toHaveLength(25);
  });

  it('aynı soket ikinci kez katılınca çiftlenmez ve kendi kaydını listede görmez', async () => {
    const socket = makeSocket('s-tekrar');
    register(socket, makeIo());

    await socket._trigger('voice:join', { channelId: CH_A, serverId: SRV });
    socket._emitted.length = 0;
    await socket._trigger('voice:join', { channelId: CH_A, serverId: SRV });

    expect(await __getVoiceRoomForTest(CH_A)).toHaveLength(1);
    const existing = requireEmitted(socket._emitted, 'voice:existing-peers');
    expect(existing!.data).toEqual([]);
  });

  it('reddedilen katılım kanonik odaya hiç yazmaz', async () => {
    const socket = makeSocket('s-yabanci');
    register(socket, makeIo(), 'yabanci');

    await socket._trigger('voice:join', { channelId: CH_A, serverId: SRV, requestId: 'req-2' });

    expect(socket._emitted[0]).toEqual({
      event: 'voice:join-rejected', data: { channelId: CH_A, requestId: 'req-2', code: 'FORBIDDEN' },
    });
    expect(await __getVoiceRoomForTest(CH_A)).toEqual([]);
  });

  it('şema dışı katılım/ayrılma yükü depoya dokunmaz', async () => {
    const socket = makeSocket('s-bozuk');
    register(socket, makeIo());

    await socket._trigger('voice:join', { channelId: CH_A });
    await socket._trigger('voice:join', undefined);
    await socket._trigger('voice:leave', { channelId: 42, serverId: SRV });

    expect(socket._emitted).toEqual([]);
    expect(await __getVoiceRoomForTest(CH_A)).toEqual([]);
  });
});

describe('oda değiştirme ve ayrılma', () => {
  it('yeni odaya katılım eskisinden ayrılmayı içerir', async () => {
    const io = makeIo();
    const socket = makeSocket('s-gezgin');
    register(socket, io);

    await socket._trigger('voice:join', { channelId: CH_A, serverId: SRV });
    await socket._trigger('voice:join', { channelId: CH_B, serverId: SRV });

    expect(socket._rooms.has(`voice:${CH_A}`)).toBe(false);
    expect(socket._rooms.has(`voice:${CH_B}`)).toBe(true);
    expect(await __getVoiceRoomForTest(CH_A)).toEqual([]);
    expect(await __getVoiceRoomForTest(CH_B)).toHaveLength(1);
    expect(io._emitted.some(e => e.event === 'voice:room-update'
      && (e.data as { channelId: string }).channelId === CH_A)).toBe(true);
  });

  it('hiçbir odada değilken ayrılma isteği hiçbir şey yapmaz', async () => {
    const io = makeIo();
    const socket = makeSocket('s-bos');
    register(socket, io);

    await socket._trigger('voice:leave', { channelId: CH_A, serverId: SRV });

    expect(io._emitted).toEqual([]);
    expect(socket._broadcast).toEqual([]);
  });

  it('ayrılma yalnız soketin GERÇEK odasını kullanır; istemcinin iddiası yok sayılır', async () => {
    await __setVoiceRoomForTest(CH_B, [{ socketId: 'kurban', userId: 'u9', displayName: 'Kurban', avatarColor: '#000' }]);
    const io = makeIo();
    const socket = makeSocket('s-saldirgan');
    register(socket, io);
    await socket._trigger('voice:join', { channelId: CH_A, serverId: SRV });
    io._emitted.length = 0;

    await socket._trigger('voice:leave', { channelId: CH_B, serverId: 'baska-sunucu' });

    // Kurban odasinin katilimci listesi HICBIR yere yayilmaz.
    expect(await __getVoiceRoomForTest(CH_B)).toHaveLength(1);
    expect(JSON.stringify(io._emitted)).not.toContain('Kurban');
    expect(io._emitted.every(e => (e.data as { channelId?: string }).channelId === CH_A)).toBe(true);
  });

  it('sunucu bağlamı bilinmiyorsa oda güncellemesi yayınlanmaz', async () => {
    await __setVoiceRoomForTest(CH_A, [{ socketId: 's-x', userId: 'uye', displayName: 'Üye', avatarColor: '#000' }]);
    const io = makeIo();
    const socket = makeSocket('s-x');

    await leaveVoice(socket as never, CH_A, undefined, io as never);

    expect(io._emitted).toEqual([]);
    expect(socket._broadcast).toEqual([{
      event: 'voice:peer-left', room: `voice:${CH_A}`, data: { socketId: 's-x', userId: undefined },
    }]);
    expect(await __getVoiceRoomForTest(CH_A)).toEqual([]);
  });
});

describe('katılım yarışı', () => {
  it('katılım sürerken ayrılma gelirse hayalet katılımcı kalmaz', async () => {
    const io = makeIo();
    const socket = makeSocket('s-yaris');
    register(socket, io);

    // Ayrilma olayi katilim tamamlanmadan once nesli ilerletir.
    const joining = socket._trigger('voice:join', { channelId: CH_A, serverId: SRV });
    await socket._trigger('voice:leave', { channelId: CH_A, serverId: SRV });
    await joining;

    expect(await __getVoiceRoomForTest(CH_A)).toEqual([]);
    expect(socket._emitted.some(e => e.event === 'voice:joined')).toBe(false);
  });

  it('eski katılım yeni katılımın odasını bozmaz', async () => {
    const io = makeIo();
    const socket = makeSocket('s-cift');
    register(socket, io);

    const first = socket._trigger('voice:join', { channelId: CH_A, serverId: SRV });
    const second = socket._trigger('voice:join', { channelId: CH_B, serverId: SRV });
    await Promise.all([first, second]);

    expect(await __getVoiceRoomForTest(CH_A)).toEqual([]);
    expect((await __getVoiceRoomForTest(CH_B)).map(p => p.socketId)).toEqual(['s-cift']);
  });
});

describe('paylaşılan koordinasyon otoritesi', () => {
  it('Redis kullanılabilirken oda kanonik depodan okunur ve boşalınca silinir', async () => {
    redisAvailable.mockReturnValue(true);
    const socket = makeSocket('s-redis');
    register(socket, makeIo());

    await socket._trigger('voice:join', { channelId: CH_A, serverId: SRV });
    expect(authoritative.get(`voice:room:${CH_A}`)).toHaveLength(1);
    expect(await getVoiceRoomPeers(CH_A)).toHaveLength(1);

    await socket._trigger('voice:leave', { channelId: CH_A, serverId: SRV });
    expect(authoritative.has(`voice:room:${CH_A}`)).toBe(false);
    expect(await getVoiceRoomPeers(CH_A)).toEqual([]);
  });

  it('kanonik depoda kayıt yoksa boş liste döner', async () => {
    redisAvailable.mockReturnValue(true);

    expect(await getVoiceRoomPeers('hic-kimse-yok')).toEqual([]);
  });

  it('paylaşılan otorite ilan edilmişken erişilemezse üyelik süreç belleğine çatallanmaz', async () => {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    try {
      redisAvailable.mockReturnValue(false);

      await expect(getVoiceRoomPeers(CH_A)).rejects.toThrow(/Voice Redis coordination unavailable/);
      await expect(__setVoiceRoomForTest(CH_A, [])).rejects.toThrow(/Voice Redis coordination unavailable/);
      expect((voiceRooms as unknown as Map<string, unknown>).has(CH_A)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = previous;
    }
  });
});

describe('geriye dönük `voiceRooms` yüzeyi', () => {
  it('nesne ve Map erişimi aynı kanonik depoyu görür', async () => {
    const peers = [{ socketId: 's1', userId: 'u1', displayName: 'U1', avatarColor: '#000' }];
    await __setVoiceRoomForTest(CH_A, peers);

    const compat = voiceRooms as unknown as Map<string, unknown> & Record<string, unknown>;
    expect(compat.get(CH_A)).toEqual(peers);
    expect(compat[CH_A]).toEqual(peers);
    expect(Object.keys(compat)).toContain(CH_A);
    expect(Object.getOwnPropertyDescriptor(compat, CH_A)).toMatchObject({ enumerable: true, configurable: true });
    expect(Object.getOwnPropertyDescriptor(compat, 'olmayan-kanal')).toBeUndefined();
  });

  it('nesne biçiminde yazma ve silme kanonik depoya işler', async () => {
    const compat = voiceRooms as unknown as Map<string, unknown> & Record<string, unknown>;
    const peers = [{ socketId: 's2', userId: 'u2', displayName: 'U2', avatarColor: '#000' }];

    compat[CH_B] = peers;
    expect(await __getVoiceRoomForTest(CH_B)).toEqual(peers);

    delete compat[CH_B];
    expect(await __getVoiceRoomForTest(CH_B)).toEqual([]);
  });

  it('sembol anahtarlarla yazma/silme reddedilir', () => {
    const compat = voiceRooms as unknown as Record<string | symbol, unknown>;
    const key = Symbol('gizli');

    expect(() => { compat[key] = []; }).toThrow(TypeError);
    expect(Reflect.set(compat, key, [])).toBe(false);
    expect(Reflect.deleteProperty(compat, key)).toBe(false);
  });
});

describe('E2E anahtar değişimi', () => {
  it('odada olmayan gönderen anahtar enjekte edemez', async () => {
    await __setVoiceRoomForTest(CH_A, [{ socketId: 'baska', userId: 'uye2', displayName: 'U2', avatarColor: '#000' }]);
    const io = makeIo();
    const socket = makeSocket('s-disarda');
    register(socket, io);

    await socket._trigger('voice:e2e-key', { channelId: CH_A, targetUserId: 'uye2', encryptedKey: 'k' });

    expect(io._emitted).toEqual([]);
  });

  it('odadaki gönderen yalnız odadaki hedefe anahtar yollar', async () => {
    const io = makeIo();
    const socket = makeSocket('s-icerde');
    register(socket, io);
    await socket._trigger('voice:join', { channelId: CH_A, serverId: SRV });
    await __setVoiceRoomForTest(CH_A, [
      { socketId: 's-icerde', userId: 'uye', displayName: 'Üye', avatarColor: '#fff' },
      { socketId: 's-hedef', userId: 'uye2', displayName: 'U2', avatarColor: '#000' },
    ]);
    io._emitted.length = 0;

    await socket._trigger('voice:e2e-key', { channelId: CH_A, targetUserId: 'uye2', encryptedKey: 'k' });
    await socket._trigger('voice:e2e-key', { channelId: CH_A, targetUserId: 'odada-olmayan', encryptedKey: 'k' });

    expect(io._emitted).toEqual([
      { event: 'voice:e2e-key', target: 's-hedef', data: { fromUserId: 'uye', encryptedKey: 'k' } },
    ]);
  });

  it('soketin bulunduğu odadan başka bir kanal için anahtar yollanamaz', async () => {
    const io = makeIo();
    const socket = makeSocket('s-yanlis-kanal');
    register(socket, io);
    await socket._trigger('voice:join', { channelId: CH_A, serverId: SRV });
    io._emitted.length = 0;

    await socket._trigger('voice:e2e-key', { channelId: CH_B, targetUserId: 'uye2', encryptedKey: 'k' });

    expect(io._emitted).toEqual([]);
  });
});
