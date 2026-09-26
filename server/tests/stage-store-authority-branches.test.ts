// server/tests/stage-store-authority-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// STAGE — DEPO OTORİTESİ, ROL SINIRI VE MEDYA İPTALİ
// ════════════════════════════════════════════════════════════════════════════
//
// Stage'in kontrol düzlemi (kim konuşmacı) SFU'nun yayın yetkisini belirler.
// Ölçülmemiş 61 dalın taşıdığı riskler:
import { findEmitted, requireEmitted } from './helpers/socketDoubles';
//
//   · SAHTE OTORİTE — `REDIS_URL` tanımlıyken Redis erişilemezse süreç-içi
//     belleğe DÜŞÜLMEZ. Aksi hâlde her düğüm kendi "sahnesini" uydurur ve
//     "cluster-safe" etiketi yalanlanır.
//   · BAYAT DURUM — Redis'teki sahne kaydı, üyelik/izin değişiminden sonra
//     kısa süre yaşayabilir. Medya yetkisi soran kardeş özellikler bu bayat
//     kaydı OTORİTE saymamalıdır: erişim HER SEFERİNDE yeniden çözülür.
//   · SEKME YARIŞI — aynı hesabın ESKİ sekmesi, YENİ sekmesini sahneden
//     düşürmemelidir (socketId eşleşmesi).
//   · YÜKSELTME — host yetkisi, hedefte OLMAYAN bir SPEAK iznini üretemez.
//   · MEDYA İPTALİ — dinleyiciye düşürülen veya ayrılan hesabın yayıncılığı
//     hem yerel düğümde hem küme genelinde iptal edilmelidir.

process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

const repos = {
  Channels: { findById: jest.fn() },
  Members: { findOne: jest.fn() },
  Servers: { findById: jest.fn() },
};
const resolvePerms = jest.fn();
const revokeStagePublishers = jest.fn();
const redisAvailable = jest.fn(() => false);
const cacheStore = new Map<string, unknown>();
const cacheMock = {
  getAuthoritative: jest.fn(async (key: string) => (cacheStore.has(key) ? cacheStore.get(key) : null)),
  setAuthoritative: jest.fn(async (key: string, value: unknown) => { cacheStore.set(key, value); }),
  delAuthoritative: jest.fn(async (key: string) => { cacheStore.delete(key); }),
  withKeyLock: jest.fn(async <T>(_key: string, fn: () => Promise<T>) => fn()),
};

jest.mock('../db/repositories', () => repos);
jest.mock('../lib/permissions', () => {
  const actual = jest.requireActual('../lib/permissions');
  return { ...actual, resolvePermissions: (...args: unknown[]) => resolvePerms(...args) };
});
jest.mock('../lib/redisAdapter', () => ({
  cache: cacheMock,
  isRedisAvailable: () => redisAvailable(),
}));
jest.mock('../socket/handlers/mediasoup/rooms', () => ({
  revokeStagePublishers: (...args: unknown[]) => revokeStagePublishers(...args),
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { Server as IoServer, Socket } from 'socket.io';
import { PERMS } from '../lib/permissions';
import {
  bindStageMediaClusterControl,
  canManageStage,
  isStageParticipant,
  isStageSpeaker,
  registerStageHandlers,
  stageRooms,
} from '../socket/handlers/stage';

// ── Test ikizleri ───────────────────────────────────────────────────────────
type Emission = { room: string; event: string; payload: unknown };
type AckResult = { ok: boolean; code?: string; canManage?: boolean };

interface FakeSocket {
  id: string;
  rooms: Set<string>;
  self: Emission[];
  trigger(event: string, payload?: unknown, ack?: (result: AckResult) => void): Promise<void>;
  asSocket: Socket;
}

interface FakeIo {
  emitted: Emission[];
  serverSide: Array<{ event: string; payload: unknown }>;
  serverSideThrows: boolean;
  clusterHandlers: Map<string, Array<(payload: unknown) => void>>;
  asServer: IoServer;
}

function makeSocket(id: string = 'sock-1'): FakeSocket {
  const handlers = new Map<string, (payload?: unknown, ack?: (result: AckResult) => void) => Promise<void>>();
  const self: Emission[] = [];
  const rooms = new Set<string>([id]);
  const shape = {
    id,
    rooms,
    on(event: string, fn: (payload?: unknown, ack?: (result: AckResult) => void) => Promise<void>) { handlers.set(event, fn); },
    emit(event: string, payload?: unknown) { self.push({ room: id, event, payload }); return true; },
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    to(room: string) { return { emit() { return true; } }; },
  };
  return {
    id, rooms, self,
    async trigger(event, payload, ack) { await handlers.get(event)?.(payload, ack); },
    // `Socket` yüzlerce üye taşır; handler yalnız bu dar yüzeyi kullanır.
    asSocket: shape as unknown as Socket,
  };
}

function makeIo(): FakeIo {
  const emitted: Emission[] = [];
  const serverSide: Array<{ event: string; payload: unknown }> = [];
  const clusterHandlers = new Map<string, Array<(payload: unknown) => void>>();
  const io: FakeIo = {
    emitted, serverSide, serverSideThrows: false, clusterHandlers,
    asServer: undefined as unknown as IoServer,
  };
  const shape = {
    to(room: string) {
      return { emit(event: string, payload?: unknown) { emitted.push({ room, event, payload }); return true; } };
    },
    on(event: string, handler: (payload: unknown) => void) {
      const list = clusterHandlers.get(event) ?? [];
      list.push(handler);
      clusterHandlers.set(event, list);
    },
    serverSideEmit(event: string, payload: unknown) {
      if (io.serverSideThrows) throw new Error('adapter down');
      serverSide.push({ event, payload });
      return true;
    },
  };
  io.asServer = shape as unknown as IoServer;
  return io;
}

const CH = 'stage-1';
const SRV = 'srv-1';
const ME = 'user-me';
const OTHER = 'user-other';
const me = { _id: ME, displayName: 'Ben', avatarColor: '#111' };

const stageUser = (over: Record<string, unknown> = {}) => ({
  userId: ME, displayName: 'Ben', avatarColor: '#111',
  muted: false, handRaised: false, speaking: false, socketId: 'sock-1', ...over,
});

const room = (over: Record<string, unknown> = {}) => ({
  speakers: [], listeners: [], topic: '', live: false, ...over,
});

function seedRoom(value: Record<string, unknown>): void {
  stageRooms.set(CH, value as never);
}

const ack = () => {
  const calls: AckResult[] = [];
  const fn = (result: AckResult) => { calls.push(result); };
  return { fn, calls };
};

async function joinStage(socket: FakeSocket, io: FakeIo): Promise<void> {
  await socket.trigger('stage:join', { channelId: CH });
}

beforeEach(() => {
  jest.clearAllMocks();
  stageRooms.clear();
  cacheStore.clear();
  delete process.env.REDIS_URL;
  redisAvailable.mockReturnValue(false);
  repos.Channels.findById.mockResolvedValue({ _id: CH, serverId: SRV, type: 'stage' });
  repos.Members.findOne.mockResolvedValue({ userId: ME, serverId: SRV, timeoutUntil: null });
  repos.Servers.findById.mockResolvedValue({ _id: SRV, ownerId: 'baskasi' });
  resolvePerms.mockResolvedValue(PERMS.VIEW_CHANNELS | PERMS.CONNECT | PERMS.SPEAK);
});

// ════════════════════════════════════════════════════════════════════════════
describe('depo otoritesi', () => {
  it('Redis bağlıyken sahne durumu REDIS’ten okunur ve oraya yazılır', async () => {
    redisAvailable.mockReturnValue(true);
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);

    await joinStage(socket, io);

    expect(cacheMock.getAuthoritative).toHaveBeenCalledWith(`stage:room:${CH}`);
    expect(cacheMock.setAuthoritative).toHaveBeenCalledWith(`stage:room:${CH}`, expect.any(Object), expect.any(Number));
    expect(stageRooms.size).toBe(0);
  });

  it('REDIS_URL tanımlıyken Redis erişilemezse BELLEĞE düşülmez', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    redisAvailable.mockReturnValue(false);
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    const result = ack();

    await socket.trigger('stage:join', { channelId: CH }, result.fn);

    expect(stageRooms.size).toBe(0);
    expect(socket.self.some(e => e.event === 'stage:state')).toBe(false);
    // Yalıtım sınırı hatayı yakalar; sessiz bir "başarılı" ack üretilmez.
    expect(result.calls).toHaveLength(0);
  });

  it('REDIS_URL yokken tek düğüm belleği kullanılır', async () => {
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);

    await joinStage(socket, io);

    expect(stageRooms.has(CH)).toBe(true);
    expect(cacheMock.getAuthoritative).not.toHaveBeenCalled();
  });

  it('son katılımcı ayrılınca oda SİLİNİR', async () => {
    redisAvailable.mockReturnValue(true);
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    await joinStage(socket, io);
    await socket.trigger('stage:setRole', { channelId: CH, role: 'listener' });

    await socket.trigger('stage:leave', { channelId: CH });

    expect(cacheMock.delAuthoritative).toHaveBeenCalledWith(`stage:room:${CH}`);
  });

  it('REDIS_URL tanımlıyken silme yolu da belleğe düşmez', async () => {
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    await joinStage(socket, io);
    await socket.trigger('stage:setRole', { channelId: CH, role: 'listener' });

    process.env.REDIS_URL = 'redis://localhost:6379';
    await socket.trigger('stage:leave', { channelId: CH });

    // Oda bellekte KALIR: silme yetkisi paylaşılan depoya aittir.
    expect(stageRooms.has(CH)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('erişim ve yetki çözümü', () => {
  it.each([
    ['kanal yoksa', () => repos.Channels.findById.mockResolvedValue(null)],
    ['kanal STAGE değilse', () => repos.Channels.findById.mockResolvedValue({ _id: CH, serverId: SRV, type: 'voice' })],
    ['kanalın sunucusu yoksa', () => repos.Channels.findById.mockResolvedValue({ _id: CH, type: 'stage' })],
    ['üyelik yoksa', () => repos.Members.findOne.mockResolvedValue(null)],
    ['üye TIMEOUT’taysa', () => repos.Members.findOne.mockResolvedValue({ userId: ME, timeoutUntil: Date.now() + 60_000 })],
    ['VIEW_CHANNELS yoksa', () => resolvePerms.mockResolvedValue(PERMS.CONNECT)],
    ['CONNECT yoksa', () => resolvePerms.mockResolvedValue(PERMS.VIEW_CHANNELS)],
    ['izin çözümü patlarsa', () => resolvePerms.mockRejectedValue(new Error('perm store down'))],
  ])('%s sahneye katılım REDDEDİLİR', async (_label, arrange) => {
    arrange();
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    const result = ack();

    await socket.trigger('stage:join', { channelId: CH }, result.fn);

    expect(result.calls).toEqual([{ ok: false, code: 'STAGE_UNAVAILABLE' }]);
    expect(socket.rooms.has(`stage:${CH}`)).toBe(false);
  });

  it('şema dışı yük sahneye katılım üretmez', async () => {
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    const result = ack();

    await socket.trigger('stage:join', {}, result.fn);

    expect(result.calls).toEqual([{ ok: false, code: 'STAGE_UNAVAILABLE' }]);
    expect(repos.Channels.findById).not.toHaveBeenCalled();
  });

  it('SUNUCU SAHİBİ host olmasa da yönetebilir', async () => {
    repos.Servers.findById.mockResolvedValue({ _id: SRV, ownerId: ME });
    seedRoom(room({ speakers: [stageUser({ userId: OTHER, socketId: 'sock-x' })] }));
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    const result = ack();

    await socket.trigger('stage:join', { channelId: CH }, result.fn);

    expect(result.calls[0]).toEqual({ ok: true, canManage: true });
  });

  it.each([
    ['ADMINISTRATOR', PERMS.ADMINISTRATOR],
    ['MANAGE_CHANNELS', PERMS.MANAGE_CHANNELS],
    ['MANAGE_SERVER', PERMS.MANAGE_SERVER],
  ])('%s yetkisi sahne yönetimi açar', async (_label, bits) => {
    resolvePerms.mockResolvedValue(PERMS.VIEW_CHANNELS | PERMS.CONNECT | PERMS.SPEAK | bits);
    seedRoom(room({ speakers: [stageUser({ userId: OTHER, socketId: 'sock-x' })] }));
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    const result = ack();

    await socket.trigger('stage:join', { channelId: CH }, result.fn);

    expect(result.calls[0]?.canManage).toBe(true);
  });

  it('sıradan katılımcı yönetici DEĞİLDİR', async () => {
    seedRoom(room({ speakers: [stageUser({ userId: OTHER, socketId: 'sock-x' })] }));
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    const result = ack();

    await socket.trigger('stage:join', { channelId: CH }, result.fn);

    expect(result.calls[0]?.canManage).toBe(false);
  });

  it('kanal kaydı yoksa yetki çözümü FAIL-CLOSED davranır', async () => {
    seedRoom(room({ speakers: [stageUser({ userId: OTHER, socketId: 'sock-x' })] }));
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    // Katılım geçtikten SONRA kanal kaybolursa yetki üretilmemelidir.
    repos.Channels.findById.mockResolvedValueOnce({ _id: CH, serverId: SRV, type: 'stage' })
      .mockResolvedValue(null);
    const result = ack();

    await socket.trigger('stage:join', { channelId: CH }, result.fn);

    expect(result.calls[0]?.canManage).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kardeş özellikler için kanonik sorgular', () => {
  it('sahne kaydı OLSA BİLE erişim yoksa katılımcı sayılmaz', async () => {
    seedRoom(room({ speakers: [stageUser()] }));
    repos.Members.findOne.mockResolvedValue(null);

    expect(await isStageParticipant(CH, ME)).toBe(false);
    expect(await isStageSpeaker(CH, ME)).toBe(false);
    expect(await canManageStage(CH, ME)).toBe(false);
  });

  it('oda yoksa hiçbir kanonik sorgu doğru dönmez', async () => {
    expect(await isStageParticipant(CH, ME)).toBe(false);
    expect(await isStageSpeaker(CH, ME)).toBe(false);
    expect(await canManageStage(CH, ME)).toBe(false);
  });

  it('SOKET kimliği verilirse yalnız O sekme katılımcı sayılır', async () => {
    seedRoom(room({ speakers: [stageUser({ socketId: 'sock-yeni' })] }));

    expect(await isStageParticipant(CH, ME, 'sock-yeni')).toBe(true);
    expect(await isStageParticipant(CH, ME, 'sock-eski')).toBe(false);
    expect(await isStageSpeaker(CH, ME, 'sock-yeni')).toBe(true);
    expect(await isStageSpeaker(CH, ME, 'sock-eski')).toBe(false);
  });

  it('DİNLEYİCİ katılımcıdır ama konuşmacı DEĞİLDİR', async () => {
    seedRoom(room({ listeners: [stageUser()] }));

    expect(await isStageParticipant(CH, ME)).toBe(true);
    expect(await isStageSpeaker(CH, ME)).toBe(false);
  });

  it('SPEAK izni olmayan hesap konuşmacı sorgusunu geçemez', async () => {
    seedRoom(room({ speakers: [stageUser()] }));
    resolvePerms.mockResolvedValue(PERMS.VIEW_CHANNELS | PERMS.CONNECT);

    expect(await isStageSpeaker(CH, ME)).toBe(false);
    expect(await isStageParticipant(CH, ME)).toBe(true);
  });

  it('depo okunamazsa kanonik sorgular FAIL-CLOSED döner', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    redisAvailable.mockReturnValue(false);

    expect(await isStageParticipant(CH, ME)).toBe(false);
    expect(await isStageSpeaker(CH, ME)).toBe(false);
    expect(await canManageStage(CH, ME)).toBe(false);
  });

  it('host sahne yöneticisidir', async () => {
    seedRoom(room({ speakers: [stageUser()] }));
    expect(await canManageStage(CH, ME)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('rol, susturma ve el kaldırma', () => {
  const ready = async () => {
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    await joinStage(socket, io);
    io.emitted.length = 0;
    return { socket, io };
  };

  it('ODAYA KATILMADAN rol değiştirilemez', async () => {
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    const result = ack();

    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' }, result.fn);

    expect(result.calls).toEqual([{ ok: false, code: 'STAGE_ROLE_REJECTED' }]);
  });

  it('SPEAK izni olmayan konuşmacı olamaz ama dinleyici olabilir', async () => {
    const { socket } = await ready();
    resolvePerms.mockResolvedValue(PERMS.VIEW_CHANNELS | PERMS.CONNECT);
    const rejected = ack();

    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' }, rejected.fn);
    expect(rejected.calls).toEqual([{ ok: false, code: 'STAGE_ROLE_REJECTED' }]);

    const accepted = ack();
    await socket.trigger('stage:setRole', { channelId: CH, role: 'listener' }, accepted.fn);
    expect(accepted.calls).toEqual([{ ok: true }]);
  });

  it('DİNLEYİCİYE geçiş medya yayıncılığını İPTAL eder', async () => {
    const { socket } = await ready();
    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });
    revokeStagePublishers.mockClear();

    await socket.trigger('stage:setRole', { channelId: CH, role: 'listener' });

    expect(revokeStagePublishers).toHaveBeenCalledWith(CH, ME);
  });

  it('KONUŞMACIYA geçiş medya iptali üretmez ve susturulmuş başlar', async () => {
    const { socket, io } = await ready();

    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });

    expect(revokeStagePublishers).not.toHaveBeenCalled();
    const joined = requireEmitted(io.emitted, 'stage:userJoined');
    expect(joined?.payload).toMatchObject({ role: 'speaker', user: { muted: true } });
  });

  it('rol değişimi ODA KAYDI YOKKEN de yeni oda kurar', async () => {
    const { socket, io } = await ready();
    stageRooms.delete(CH);

    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });

    expect(io.emitted.some(e => e.event === 'stage:state')).toBe(true);
    expect(stageRooms.get(CH)?.speakers).toHaveLength(1);
  });

  it('susturma yalnız KONUŞMACI için yayılır', async () => {
    const { socket, io } = await ready();
    await socket.trigger('stage:setRole', { channelId: CH, role: 'listener' });
    io.emitted.length = 0;

    await socket.trigger('stage:updateMute', { channelId: CH, muted: true });
    expect(io.emitted).toHaveLength(0);

    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });
    io.emitted.length = 0;
    await socket.trigger('stage:updateMute', { channelId: CH, muted: false });

    expect(io.emitted[0]).toMatchObject({ event: 'stage:muteUpdate', payload: { muted: false } });
  });

  it('şema dışı susturma yükü yok sayılır', async () => {
    const { socket, io } = await ready();
    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });
    io.emitted.length = 0;

    await socket.trigger('stage:updateMute', { channelId: CH });
    await socket.trigger('stage:updateMute', { channelId: CH, muted: 'evet' });

    expect(io.emitted).toHaveLength(0);
  });

  it('oda kaydı yoksa susturma yayılmaz', async () => {
    const { socket, io } = await ready();
    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });
    stageRooms.delete(CH);
    io.emitted.length = 0;

    await socket.trigger('stage:updateMute', { channelId: CH, muted: true });

    expect(io.emitted).toHaveLength(0);
  });

  it('SUSTURULMUŞ konuşmacı "konuşuyor" sinyali yayamaz', async () => {
    const { socket, io } = await ready();
    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });   // susturulmuş başlar
    io.emitted.length = 0;

    await socket.trigger('stage:speaking', { channelId: CH, speaking: true });
    expect(io.emitted).toHaveLength(0);

    await socket.trigger('stage:updateMute', { channelId: CH, muted: false });
    io.emitted.length = 0;
    await socket.trigger('stage:speaking', { channelId: CH, speaking: true });

    expect(io.emitted[0]).toMatchObject({ event: 'stage:speaking', payload: { speaking: true } });
  });

  it('oda kaydı yoksa konuşma sinyali yayılmaz', async () => {
    const { socket, io } = await ready();
    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });
    stageRooms.delete(CH);
    io.emitted.length = 0;

    await socket.trigger('stage:speaking', { channelId: CH, speaking: true });

    expect(io.emitted).toHaveLength(0);
  });

  it('el kaldırma şema dışı yükte REDDEDİLİR', async () => {
    const { socket } = await ready();
    const result = ack();

    await socket.trigger('stage:handRaise', { channelId: CH }, result.fn);

    expect(result.calls).toEqual([{ ok: false, code: 'STAGE_ACTION_REJECTED' }]);
  });

  it('sahnede OLMAYAN hesap el kaldıramaz', async () => {
    const { socket } = await ready();
    const result = ack();

    await socket.trigger('stage:handRaise', { channelId: CH, raised: true }, result.fn);

    expect(result.calls).toEqual([{ ok: false, code: 'STAGE_ACTION_REJECTED' }]);
  });

  it('oda kaydı yoksa el kaldırma reddedilir', async () => {
    const { socket } = await ready();
    await socket.trigger('stage:setRole', { channelId: CH, role: 'listener' });
    stageRooms.delete(CH);
    const result = ack();

    await socket.trigger('stage:handRaise', { channelId: CH, raised: true }, result.fn);

    expect(result.calls).toEqual([{ ok: false, code: 'STAGE_ACTION_REJECTED' }]);
  });

  it('dinleyici el kaldırabilir ve yayılır', async () => {
    const { socket, io } = await ready();
    await socket.trigger('stage:setRole', { channelId: CH, role: 'listener' });
    io.emitted.length = 0;
    const result = ack();

    await socket.trigger('stage:handRaise', { channelId: CH, raised: true }, result.fn);

    expect(result.calls).toEqual([{ ok: true }]);
    expect(io.emitted[0]).toMatchObject({ event: 'stage:handRaise', payload: { raised: true } });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('yükseltme ve düşürme', () => {
  const hostReady = async () => {
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    await joinStage(socket, io);
    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });   // host olur
    io.emitted.length = 0;
    return { socket, io };
  };

  const addListener = (userId = OTHER) => {
    const current = stageRooms.get(CH)!;
    current.listeners.push(stageUser({ userId, socketId: 'sock-other' }) as never);
  };

  it('şema dışı yük reddedilir', async () => {
    const { socket } = await hostReady();
    const result = ack();

    await socket.trigger('stage:promote', { channelId: CH }, result.fn);
    await socket.trigger('stage:demote', { channelId: CH }, result.fn);

    expect(result.calls).toEqual([
      { ok: false, code: 'STAGE_ACTION_REJECTED' },
      { ok: false, code: 'STAGE_ACTION_REJECTED' },
    ]);
  });

  it('HEDEFTE SPEAK izni yoksa yükseltme yapılamaz', async () => {
    const { socket } = await hostReady();
    addListener();
    resolvePerms.mockImplementation(async (userId: string) =>
      (userId === OTHER ? PERMS.VIEW_CHANNELS | PERMS.CONNECT : PERMS.VIEW_CHANNELS | PERMS.CONNECT | PERMS.SPEAK));
    const result = ack();

    await socket.trigger('stage:promote', { channelId: CH, targetUserId: OTHER }, result.fn);

    expect(result.calls).toEqual([{ ok: false, code: 'STAGE_ACTION_REJECTED' }]);
    expect(stageRooms.get(CH)?.speakers).toHaveLength(1);
  });

  it('YETKİSİZ kullanıcı yükseltemez', async () => {
    const { socket, io } = await hostReady();
    addListener();
    // Host artık başka biri: bu soketin yetkisi kalmaz.
    const current = stageRooms.get(CH)!;
    current.speakers = [stageUser({ userId: 'baska-host', socketId: 'sock-h' }) as never, ...current.speakers];
    const result = ack();

    await socket.trigger('stage:promote', { channelId: CH, targetUserId: OTHER }, result.fn);

    expect(result.calls).toEqual([{ ok: false, code: 'STAGE_ACTION_REJECTED' }]);
    expect(io.emitted).toHaveLength(0);
  });

  it('DİNLEYİCİ olmayan hedef yükseltilemez', async () => {
    const { socket } = await hostReady();
    const result = ack();

    await socket.trigger('stage:promote', { channelId: CH, targetUserId: OTHER }, result.fn);

    expect(result.calls).toEqual([{ ok: false, code: 'STAGE_ACTION_REJECTED' }]);
  });

  it('yükseltilen hesap SUSTURULMUŞ ve eli inik başlar', async () => {
    const { socket, io } = await hostReady();
    addListener();
    stageRooms.get(CH)!.listeners[0]!.handRaised = true;
    const result = ack();

    await socket.trigger('stage:promote', { channelId: CH, targetUserId: OTHER }, result.fn);

    expect(result.calls).toEqual([{ ok: true }]);
    const promoted = stageRooms.get(CH)!.speakers.find(u => u.userId === OTHER)!;
    expect(promoted).toMatchObject({ muted: true, handRaised: false, speaking: false });
    expect(io.emitted.some(e => e.event === 'stage:promoted')).toBe(true);
  });

  it('KONUŞMACI olmayan hedef düşürülemez', async () => {
    const { socket } = await hostReady();
    const result = ack();

    await socket.trigger('stage:demote', { channelId: CH, targetUserId: OTHER }, result.fn);

    expect(result.calls).toEqual([{ ok: false, code: 'STAGE_ACTION_REJECTED' }]);
  });

  it('düşürme medya yayıncılığını İPTAL eder', async () => {
    const { socket, io } = await hostReady();
    addListener();
    await socket.trigger('stage:promote', { channelId: CH, targetUserId: OTHER });
    revokeStagePublishers.mockClear();
    io.emitted.length = 0;
    const result = ack();

    await socket.trigger('stage:demote', { channelId: CH, targetUserId: OTHER }, result.fn);

    expect(result.calls).toEqual([{ ok: true }]);
    expect(revokeStagePublishers).toHaveBeenCalledWith(CH, OTHER);
    expect(io.emitted.some(e => e.event === 'stage:demoted')).toBe(true);
    expect(stageRooms.get(CH)?.listeners.find(u => u.userId === OTHER)).toMatchObject({ muted: false });
  });

  it('oda kaydı yoksa yükseltme/düşürme reddedilir', async () => {
    const { socket } = await hostReady();
    addListener();
    stageRooms.delete(CH);
    const result = ack();

    await socket.trigger('stage:promote', { channelId: CH, targetUserId: OTHER }, result.fn);
    await socket.trigger('stage:demote', { channelId: CH, targetUserId: OTHER }, result.fn);

    expect(result.calls).toEqual([
      { ok: false, code: 'STAGE_ACTION_REJECTED' },
      { ok: false, code: 'STAGE_ACTION_REJECTED' },
    ]);
  });

  it('konu ve canlı durumu yalnız YETKİLİ tarafından değiştirilebilir', async () => {
    const { socket, io } = await hostReady();

    // Şema 200 karakterle sınırlar; sınırdaki değer kabul edilir ve kırpma
    // ikinci bir savunma katmanı olarak korunur.
    const topicOk = ack();
    await socket.trigger('stage:setTopic', { channelId: CH, topic: 'x'.repeat(200) }, topicOk.fn);
    expect(topicOk.calls).toEqual([{ ok: true }]);
    expect(stageRooms.get(CH)?.topic).toHaveLength(200);

    const topicTooLong = ack();
    await socket.trigger('stage:setTopic', { channelId: CH, topic: 'y'.repeat(201) }, topicTooLong.fn);
    expect(topicTooLong.calls).toEqual([{ ok: false, code: 'STAGE_ACTION_REJECTED' }]);
    expect(stageRooms.get(CH)?.topic).toBe('x'.repeat(200));

    const topicCleared = ack();
    await socket.trigger('stage:setTopic', { channelId: CH }, topicCleared.fn);
    expect(topicCleared.calls).toEqual([{ ok: true }]);
    expect(stageRooms.get(CH)?.topic).toBe('');

    const liveOk = ack();
    await socket.trigger('stage:setLive', { channelId: CH, live: true }, liveOk.fn);
    expect(liveOk.calls).toEqual([{ ok: true }]);
    expect(io.emitted.some(e => e.event === 'stage:liveUpdate')).toBe(true);

    // Host değişince yetki kalmaz.
    const current = stageRooms.get(CH)!;
    current.speakers = [stageUser({ userId: 'baska-host', socketId: 'sock-h' }) as never];
    const topicDenied = ack();
    await socket.trigger('stage:setTopic', { channelId: CH, topic: 'yeni' }, topicDenied.fn);
    expect(topicDenied.calls).toEqual([{ ok: false, code: 'STAGE_ACTION_REJECTED' }]);

    const liveDenied = ack();
    await socket.trigger('stage:setLive', { channelId: CH, live: false }, liveDenied.fn);
    expect(liveDenied.calls).toEqual([{ ok: false, code: 'STAGE_ACTION_REJECTED' }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ayrılma, bağlantı kopması ve küme denetimi', () => {
  it('KATILMAMIŞ soket ayrılırken durum yaymaz', async () => {
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    const result = ack();

    await socket.trigger('stage:leave', { channelId: CH }, result.fn);

    expect(result.calls).toEqual([{ ok: true }]);
    expect(io.emitted).toHaveLength(0);
  });

  it('ESKİ sekme YENİ sekmeyi sahneden düşüremez', async () => {
    const socket = makeSocket('sock-yeni'); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    await joinStage(socket, io);
    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });

    const stale = makeSocket('sock-eski');
    stale.rooms.add(`stage:${CH}`);
    registerStageHandlers(stale.asSocket, io.asServer, me);
    io.emitted.length = 0;

    await stale.trigger('stage:leave', { channelId: CH });

    expect(stageRooms.get(CH)?.speakers).toHaveLength(1);
    expect(io.emitted.some(e => e.event === 'stage:userLeft')).toBe(false);
  });

  it('ayrılan konuşmacının medyası iptal edilir ve durum yayılır', async () => {
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    await joinStage(socket, io);
    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });
    // İkinci bir katılımcı odayı ayakta tutar; böylece durum yayını da ölçülür.
    stageRooms.get(CH)!.listeners.push(stageUser({ userId: OTHER, socketId: 'sock-o' }) as never);
    revokeStagePublishers.mockClear();
    io.emitted.length = 0;

    await socket.trigger('stage:leave', { channelId: CH });

    expect(revokeStagePublishers).toHaveBeenCalledWith(CH, ME);
    expect(io.emitted.some(e => e.event === 'stage:userLeft')).toBe(true);
    expect(io.emitted.some(e => e.event === 'stage:state')).toBe(true);
    expect(socket.rooms.has(`stage:${CH}`)).toBe(false);
  });

  it('bağlantı kopunca SOKET ODALARINDAN da sahne çıkarılır', async () => {
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    await joinStage(socket, io);
    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });
    stageRooms.get(CH)!.listeners.push(stageUser({ userId: OTHER, socketId: 'sock-o' }) as never);
    io.emitted.length = 0;
    revokeStagePublishers.mockClear();

    await socket.trigger('disconnect');

    expect(revokeStagePublishers).toHaveBeenCalledWith(CH, ME);
    expect(io.emitted.some(e => e.event === 'stage:userLeft')).toBe(true);
    expect(stageRooms.get(CH)?.speakers).toHaveLength(0);
  });

  it('sahnede olmayan soketin kopması olay üretmez', async () => {
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);

    await socket.trigger('disconnect');

    expect(io.emitted).toHaveLength(0);
  });

  it('KÜME iptali yalnız bir kez bağlanır ve şekilsiz yükleri düşürür', async () => {
    const io = makeIo();

    bindStageMediaClusterControl(io.asServer);
    bindStageMediaClusterControl(io.asServer);
    expect(io.clusterHandlers.get('stage:media-revoke')).toHaveLength(1);

    const handler = io.clusterHandlers.get('stage:media-revoke')![0]!;
    for (const payload of [
      null, 'metin', [], {},
      { channelId: 42, userId: ME },
      { channelId: '', userId: ME },
      { channelId: 'c'.repeat(200), userId: ME },
      { channelId: CH, userId: 42 },
      { channelId: CH, userId: '' },
      { channelId: CH, userId: 'u'.repeat(200) },
    ]) handler(payload);
    expect(revokeStagePublishers).not.toHaveBeenCalled();

    handler({ channelId: CH, userId: ME });
    expect(revokeStagePublishers).toHaveBeenCalledWith(CH, ME);
  });

  it('REDIS_URL tanımlıyken iptal KÜMEYE de yayılır', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    redisAvailable.mockReturnValue(true);
    const socket = makeSocket(); const io = makeIo();
    registerStageHandlers(socket.asSocket, io.asServer, me);
    await joinStage(socket, io);
    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });

    await socket.trigger('stage:setRole', { channelId: CH, role: 'listener' });

    expect(io.serverSide).toContainEqual({ event: 'stage:media-revoke', payload: { channelId: CH, userId: ME } });
  });

  it('küme yayını PATLARSA yerel iptal geçerli kalır', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    redisAvailable.mockReturnValue(true);
    const socket = makeSocket(); const io = makeIo();
    io.serverSideThrows = true;
    registerStageHandlers(socket.asSocket, io.asServer, me);
    await joinStage(socket, io);
    await socket.trigger('stage:setRole', { channelId: CH, role: 'speaker' });
    revokeStagePublishers.mockClear();

    await socket.trigger('stage:setRole', { channelId: CH, role: 'listener' });

    expect(revokeStagePublishers).toHaveBeenCalledWith(CH, ME);
  });
});
