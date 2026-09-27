// server/tests/dm-socket-gdm-call-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GRUP-DM SESLİ GÖRÜŞMESİ VE DM HIZ SINIRI — KALAN YETKİ/AYIKLAMA DALLARI
// ════════════════════════════════════════════════════════════════════════════
//
// `dm-socket-authorization-branches.test.ts` DM görüşmesi ve mesaj yolunu
// ölçer. Burada tamamlayıcı üç sınıf kapatılır:
import { findEmitted, requireEmitted } from './helpers/socketDoubles';
//
//   · ODA ≠ ÜYELİK (GRUP) — grup üyesi olmak, o an süren sesli görüşmenin
//     KATILIMCISI olmak değildir. Odaya hiç girmemiş bir üye görüşmeyi
//     bitiremez, sahte "peer:left"/mute durumu enjekte edemez ve sinyal
//     yönlendiremez.
//   · SUNUCU YETENEĞİ — kümelenmiş dağıtımda `io.in(...)` adaptöre bağlıdır ve
//     `fetchSockets` olmayabilir. O durumda katılımcı listesi BOŞ dönmeli,
//     handler çökmemelidir.
//   · HIZ SINIRI YEDEĞİ — paylaşılan sayaç okunamadığında süreç-yerel pencere
//     devreye girer; ilan edilmiş bir otorite VARSA ise fail-closed olunur.

process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

const dms = {
  buildDmId: jest.fn((a: string, b: string) => [a, b].sort().join(':')),
  findByClientNonce: jest.fn(),
  findOrCreateConversation: jest.fn(),
  insertMessage: jest.fn(),
  markRead: jest.fn(),
  findConversation: jest.fn(),
  findMessage: jest.fn(),
  updateMessage: jest.fn(),
};
const groupDms = {
  findMember: jest.fn(),
  findGroupsByUser: jest.fn(),
  findByClientNonce: jest.fn(),
  insertMessage: jest.fn(),
  update: jest.fn(),
  markRead: jest.fn(),
};
const users = { findById: jest.fn() };
const dmAccess = { evaluateDmAccess: jest.fn(), isDmBlocked: jest.fn() };
const slidingWindowCount = jest.fn();

jest.mock('../db/repositories', () => ({ Dms: dms, GroupDms: groupDms, Users: users }));
jest.mock('../lib/dmAccessPolicy', () => dmAccess);
jest.mock('../lib/redisAdapter', () => ({
  cache: { slidingWindowCount: (...args: unknown[]) => slidingWindowCount(...args) },
}));
jest.mock('../socket/handlers/dm-call-store', () => ({
  dmCallStore: {
    get: jest.fn(async () => null), set: jest.fn(), del: jest.fn(),
    withLock: jest.fn(async <T>(_id: string, fn: () => Promise<T>) => fn()),
  },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { Server, Socket } from 'socket.io';
import { registerDmHandlers, registerGroupDmHandlers } from '../socket/handlers/dm';

type Emission = { event: string; payload?: unknown; room?: string };
type RoomSocket = { id: string; data?: Record<string, unknown>; leave?: (room: string) => void };

interface FakeSocket {
  id: string;
  rooms: Set<string>;
  self: Emission[];
  broadcast: Emission[];
  trigger(event: string, payload?: unknown): Promise<void>;
  asSocket: Socket;
}

function makeSocket(id: string = 'sock-1'): FakeSocket {
  const handlers = new Map<string, (payload?: unknown) => Promise<void>>();
  const self: Emission[] = [];
  const broadcast: Emission[] = [];
  const rooms = new Set<string>([id]);
  const shape = {
    id,
    data: {} as Record<string, unknown>,
    rooms,
    on(event: string, fn: (payload?: unknown) => Promise<void>) { handlers.set(event, fn); },
    emit(event: string, payload?: unknown) { self.push({ event, payload }); return true; },
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    to(room: string) {
      return { emit(event: string, payload?: unknown) { broadcast.push({ event, payload, room }); return true; } };
    },
  };
  return {
    id, rooms, self, broadcast,
    async trigger(event, payload) { await handlers.get(event)?.(payload); },
    asSocket: shape as unknown as Socket,
  };
}

interface FakeIo {
  targeted: Emission[];
  roomSockets: Map<string, RoomSocket[]>;
  hasIn: boolean;
  scopeHasFetch: boolean;
  asServer: Server;
}

function makeIo(): FakeIo {
  const targeted: Emission[] = [];
  const roomSockets = new Map<string, RoomSocket[]>();
  const io: FakeIo = { targeted, roomSockets, hasIn: true, scopeHasFetch: true, asServer: undefined as unknown as Server };
  const shape: Record<string, unknown> = {
    to(room: string) {
      return { emit(event: string, payload?: unknown) { targeted.push({ event, payload, room }); return true; } };
    },
  };
  Object.defineProperty(shape, 'in', {
    configurable: true,
    get() {
      if (!io.hasIn) return undefined;
      return (room: string) => (io.scopeHasFetch ? { fetchSockets: async () => roomSockets.get(room) ?? [] } : {});
    },
  });
  io.asServer = shape as unknown as Server;
  return io;
}

const ME = 'user-me';
const GROUP = 'g1';
const me = { _id: ME, username: 'me', displayName: 'Ben', avatarColor: '#111' };

function registerGroup(socket: FakeSocket, io: FakeIo): void {
  registerGroupDmHandlers(socket.asSocket, io.asServer, me, new Map());
}

beforeEach(() => {
  jest.clearAllMocks();
  slidingWindowCount.mockResolvedValue(1);
  users.findById.mockResolvedValue({ _id: 'peer', username: 'peer' });
  dmAccess.evaluateDmAccess.mockResolvedValue({ allowed: true });
  dmAccess.isDmBlocked.mockResolvedValue(false);
  dms.findByClientNonce.mockResolvedValue(null);
  dms.findOrCreateConversation.mockResolvedValue({ _id: 'dm' });
  dms.insertMessage.mockImplementation(async (row: Record<string, unknown>) => ({ _id: 'm1', ...row }));
  dms.findConversation.mockResolvedValue({ _id: 'dm', participants: [ME, 'peer'] });
  dms.findMessage.mockResolvedValue({ _id: 'm1', reactions: {} });
  groupDms.findMember.mockResolvedValue({ userId: ME, groupId: GROUP });
  groupDms.findGroupsByUser.mockResolvedValue([]);
  groupDms.findByClientNonce.mockResolvedValue(null);
  groupDms.insertMessage.mockImplementation(async (row: Record<string, unknown>) => ({ _id: 'gm1', ...row }));
  groupDms.update.mockResolvedValue(undefined);
});

describe('grup sesli görüşmesi — başlatma ve katılma', () => {
  it('geçersiz görüşme türü sessizce düşürülür', async () => {
    const socket = makeSocket();
    registerGroup(socket, makeIo());

    await socket.trigger('gdm:call:start', { groupId: GROUP, type: 'holografik' });

    expect(socket.rooms.has(`gdm:voice:${GROUP}`)).toBe(false);
    expect(socket.self).toEqual([]);
    expect(groupDms.findMember).not.toHaveBeenCalled();
  });

  it('tür verilmezse sesli görüşme varsayılır', async () => {
    const socket = makeSocket();
    registerGroup(socket, makeIo());

    await socket.trigger('gdm:call:start', { groupId: GROUP });

    expect(socket.rooms.has(`gdm:voice:${GROUP}`)).toBe(true);
    expect(socket.self).toContainEqual({ event: 'gdm:call:started', payload: { groupId: GROUP, type: 'voice' } });
    expect(socket.broadcast[0]).toMatchObject({ event: 'gdm:call:incoming', room: `gdm:${GROUP}` });
  });

  it('üye olmayan görüşme başlatamaz ve odaya giremez', async () => {
    groupDms.findMember.mockResolvedValue(null);
    const socket = makeSocket();
    registerGroup(socket, makeIo());

    await socket.trigger('gdm:call:start', { groupId: GROUP, type: 'video' });
    await socket.trigger('gdm:call:join', { groupId: GROUP });

    expect(socket.rooms.has(`gdm:voice:${GROUP}`)).toBe(false);
    expect(socket.self).toEqual([]);
  });

  it('şema dışı yük depoya hiç sorulmaz', async () => {
    const socket = makeSocket();
    registerGroup(socket, makeIo());

    for (const event of ['gdm:call:start', 'gdm:call:join', 'gdm:call:leave', 'gdm:call:end']) {
      await socket.trigger(event, undefined);
      await socket.trigger(event, { groupId: 42 });
    }

    expect(groupDms.findMember).not.toHaveBeenCalled();
    expect(socket.self).toEqual([]);
  });

  it('katılan üye mevcut katılımcı listesini alır', async () => {
    const io = makeIo();
    io.roomSockets.set(`gdm:voice:${GROUP}`, [
      { id: 'sock-1' },
      { id: 'sock-2', data: { userId: 'u2', displayName: 'İkinci' } },
    ]);
    const socket = makeSocket('sock-1');
    registerGroup(socket, io);

    await socket.trigger('gdm:call:join', { groupId: GROUP });

    const peers = requireEmitted(socket.self, 'gdm:call:existing:peers');
    expect(peers!.payload).toEqual({
      groupId: GROUP,
      peers: [{ socketId: 'sock-2', userId: 'u2', displayName: 'İkinci' }],
    });
    expect(socket.self).toContainEqual({ event: 'gdm:call:joined', payload: { groupId: GROUP, type: 'voice' } });
  });

  it('sunucu adaptörü katılımcı listesi veremiyorsa liste boş döner, handler çökmez', async () => {
    const io = makeIo();
    io.scopeHasFetch = false;
    const socket = makeSocket();
    registerGroup(socket, io);

    await socket.trigger('gdm:call:join', { groupId: GROUP });

    expect(findEmitted(socket.self, 'gdm:call:existing:peers')!.payload)
      .toEqual({ groupId: GROUP, peers: [] });
  });

  it('sunucuda oda kapsamı hiç yoksa da katılım tamamlanır', async () => {
    const io = makeIo();
    io.hasIn = false;
    const socket = makeSocket();
    registerGroup(socket, io);

    await socket.trigger('gdm:call:join', { groupId: GROUP });

    expect(findEmitted(socket.self, 'gdm:call:existing:peers')!.payload)
      .toEqual({ groupId: GROUP, peers: [] });
  });
});

describe('grup sesli görüşmesi — oda kapsamlı yetki', () => {
  it('odaya girmemiş üye görüşmeyi bitiremez', async () => {
    const io = makeIo();
    const socket = makeSocket();
    registerGroup(socket, io);

    await socket.trigger('gdm:call:end', { groupId: GROUP });

    expect(io.targeted).toEqual([]);
  });

  it('odadaki üye görüşmeyi bitirir ve herkes odadan çıkarılır', async () => {
    const io = makeIo();
    const leave = jest.fn();
    io.roomSockets.set(`gdm:voice:${GROUP}`, [{ id: 'sock-2', leave }, { id: 'sock-3' }]);
    const socket = makeSocket();
    registerGroup(socket, io);
    await socket.trigger('gdm:call:join', { groupId: GROUP });

    await socket.trigger('gdm:call:end', { groupId: GROUP });

    expect(io.targeted).toContainEqual({
      event: 'gdm:call:ended', room: `gdm:voice:${GROUP}`, payload: { groupId: GROUP, byUserId: ME },
    });
    expect(leave).toHaveBeenCalledWith(`gdm:voice:${GROUP}`);
  });

  it('üyeliği düşmüş biri odadayken bile görüşmeyi bitiremez', async () => {
    const io = makeIo();
    const socket = makeSocket();
    registerGroup(socket, io);
    await socket.trigger('gdm:call:join', { groupId: GROUP });
    groupDms.findMember.mockResolvedValue(null);

    await socket.trigger('gdm:call:end', { groupId: GROUP });

    expect(io.targeted).toEqual([]);
  });

  it('odaya girmemiş üye sahte "ayrıldı" olayı üretemez', async () => {
    const socket = makeSocket();
    registerGroup(socket, makeIo());

    await socket.trigger('gdm:call:leave', { groupId: GROUP });

    expect(socket.broadcast).toEqual([]);
  });

  it('odadaki üye ayrıldığında olay yalnız ses odasına gider', async () => {
    const socket = makeSocket();
    registerGroup(socket, makeIo());
    await socket.trigger('gdm:call:join', { groupId: GROUP });
    socket.broadcast.length = 0;

    await socket.trigger('gdm:call:leave', { groupId: GROUP });

    expect(socket.rooms.has(`gdm:voice:${GROUP}`)).toBe(false);
    expect(socket.broadcast).toEqual([{
      event: 'gdm:call:peer:left', room: `gdm:voice:${GROUP}`,
      payload: { groupId: GROUP, userId: ME, socketId: 'sock-1' },
    }]);
  });

  it('odaya girmemiş üye sahte mute/video durumu enjekte edemez', async () => {
    const socket = makeSocket();
    registerGroup(socket, makeIo());

    await socket.trigger('gdm:call:state', { groupId: GROUP, muted: true });

    expect(socket.broadcast).toEqual([]);
  });

  it('odadaki üyenin durum yayını görüşme odasına gider', async () => {
    const socket = makeSocket();
    registerGroup(socket, makeIo());
    await socket.trigger('gdm:call:join', { groupId: GROUP });
    socket.broadcast.length = 0;

    await socket.trigger('gdm:call:state', { groupId: GROUP, muted: true, video: false });

    expect(socket.broadcast).toEqual([{
      event: 'gdm:call:peer:state', room: `gdm:voice:${GROUP}`,
      payload: { groupId: GROUP, socketId: 'sock-1', userId: ME, muted: true, video: false },
    }]);
  });
});

describe('grup sinyalleşmesi', () => {
  const OFFER = { groupId: GROUP, targetSocketId: 'sock-2', offer: { sdp: 'v=0' } };

  it('şema dışı sinyal depoya sorulmadan düşer', async () => {
    const socket = makeSocket();
    registerGroup(socket, makeIo());

    await socket.trigger('gdm:call:offer', { groupId: GROUP });
    await socket.trigger('gdm:call:answer', undefined);
    await socket.trigger('gdm:call:ice', { targetSocketId: 'sock-2' });

    expect(groupDms.findMember).not.toHaveBeenCalled();
  });

  it('üye olmayan sinyal yönlendiremez', async () => {
    groupDms.findMember.mockResolvedValue(null);
    const io = makeIo();
    const socket = makeSocket();
    registerGroup(socket, io);

    await socket.trigger('gdm:call:offer', OFFER);

    expect(io.targeted).toEqual([]);
  });

  it('odaya girmemiş üye sinyal yönlendiremez', async () => {
    const io = makeIo();
    const socket = makeSocket();
    registerGroup(socket, io);

    await socket.trigger('gdm:call:offer', OFFER);

    expect(io.targeted).toEqual([]);
  });

  it('hedef soket o görüşmenin odasında değilse sinyal iletilmez', async () => {
    const io = makeIo();
    io.roomSockets.set(`gdm:voice:${GROUP}`, [{ id: 'sock-1' }]);
    const socket = makeSocket();
    registerGroup(socket, io);
    await socket.trigger('gdm:call:join', { groupId: GROUP });

    await socket.trigger('gdm:call:offer', OFFER);

    expect(io.targeted).toEqual([]);
  });

  it('meşru teklif/yanıt/aday yalnız hedef sokete ve kaynak kimliğiyle gider', async () => {
    const io = makeIo();
    io.roomSockets.set(`gdm:voice:${GROUP}`, [{ id: 'sock-1' }, { id: 'sock-2' }]);
    const socket = makeSocket();
    registerGroup(socket, io);
    await socket.trigger('gdm:call:join', { groupId: GROUP });
    io.targeted.length = 0;

    await socket.trigger('gdm:call:offer', OFFER);
    await socket.trigger('gdm:call:answer', { groupId: GROUP, targetSocketId: 'sock-2', answer: { sdp: 'a=1' } });
    await socket.trigger('gdm:call:ice', { groupId: GROUP, targetSocketId: 'sock-2', candidate: { candidate: 'c' } });

    expect(io.targeted).toEqual([
      { event: 'gdm:call:offer', room: 'sock-2', payload: { groupId: GROUP, fromSocketId: 'sock-1', offer: { sdp: 'v=0' } } },
      { event: 'gdm:call:answer', room: 'sock-2', payload: { groupId: GROUP, fromSocketId: 'sock-1', answer: { sdp: 'a=1' } } },
      { event: 'gdm:call:ice', room: 'sock-2', payload: { groupId: GROUP, fromSocketId: 'sock-1', candidate: { candidate: 'c' } } },
    ]);
  });
});

describe('grup mesajı nonce çakışması', () => {
  it('başka gruba ait nonce yeniden kullanılamaz', async () => {
    groupDms.findByClientNonce.mockResolvedValue({ _id: 'gm-eski', groupId: 'baska-grup', content: 'eski' });
    const socket = makeSocket();
    registerGroup(socket, makeIo());

    await socket.trigger('gdm:send', { groupId: GROUP, content: 'merhaba', clientNonce: 'nonce-1234' });

    expect(socket.self[0]).toMatchObject({ event: 'error:message', payload: { code: 'NONCE_CONFLICT', clientNonce: 'nonce-1234' } });
    expect(groupDms.insertMessage).not.toHaveBeenCalled();
  });

  it('aynı gruba ait nonce ikinci mesaj yazmaz, mevcut satırı yankılar', async () => {
    groupDms.findByClientNonce.mockResolvedValue({ _id: 'gm-var', groupId: GROUP, content: 'merhaba' });
    const socket = makeSocket();
    registerGroup(socket, makeIo());

    await socket.trigger('gdm:send', { groupId: GROUP, content: 'merhaba', clientNonce: 'nonce-1234' });

    expect(groupDms.insertMessage).not.toHaveBeenCalled();
    expect(socket.self[0]).toMatchObject({ event: 'gdm:message', payload: { _id: 'gm-var', clientNonce: 'nonce-1234' } });
  });

  it('yazma yarışında kaybeden, kazananın satırını döndürür', async () => {
    groupDms.insertMessage.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
    groupDms.findByClientNonce
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'gm-kazanan', groupId: GROUP, content: 'merhaba' });
    const socket = makeSocket();
    registerGroup(socket, makeIo());

    await socket.trigger('gdm:send', { groupId: GROUP, content: 'merhaba', clientNonce: 'nonce-1234' });

    expect(socket.self[0]).toMatchObject({ event: 'gdm:message', payload: { _id: 'gm-kazanan' } });
  });

  it('yarışan satır BAŞKA gruba aitse hata yutulmaz', async () => {
    groupDms.insertMessage.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
    groupDms.findByClientNonce
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'gm-baska', groupId: 'baska-grup' });
    const socket = makeSocket();
    registerGroup(socket, makeIo());

    await socket.trigger('gdm:send', { groupId: GROUP, content: 'merhaba', clientNonce: 'nonce-1234' });

    // Yutulsaydi istemci kaydedilmemis bir mesaji kaydedilmis sanardi.
    expect(socket.self.some(e => e.event === 'gdm:message')).toBe(false);
  });

  it('nonce yokken hata mesajı nonce alanı taşımaz', async () => {
    const socket = makeSocket();
    registerGroup(socket, makeIo());

    await socket.trigger('gdm:send', { groupId: GROUP, content: '   ' });

    expect(socket.self[0]!.payload).toEqual({
      event: 'gdm:send', code: 'EMPTY_MESSAGE', message: 'Boş mesaj gönderilemez.',
    });
  });
});

describe('DM tepkileri ve hız sınırı yedeği', () => {
  it('eksik alan ya da aşırı uzun emoji depoya gitmeden düşer', async () => {
    const socket = makeSocket();
    registerDmHandlers(socket.asSocket, makeIo().asServer, me, new Map());

    await socket.trigger('dm:react', { messageId: 'm1', dmId: 'dm', emoji: '👍'.repeat(20) });

    expect(dms.findMessage).not.toHaveBeenCalled();
  });

  it('paylaşılan sayaç okunamazsa süreç-yerel pencereye düşülür', async () => {
    slidingWindowCount.mockRejectedValue('rate authority exploded');
    const socket = makeSocket();
    registerDmHandlers(socket.asSocket, makeIo().asServer, me, new Map());

    await socket.trigger('dm:send', { toUserId: 'peer', content: 'merhaba' });

    // Tek dugum modunda ilan edilmis otorite yoktur: mesaj YAZILIR.
    expect(dms.insertMessage).toHaveBeenCalledTimes(1);
  });

  it('paylaşılan sayaç null döndürürse yine süreç-yerel pencere kullanılır', async () => {
    slidingWindowCount.mockResolvedValue(null);
    const socket = makeSocket();
    registerDmHandlers(socket.asSocket, makeIo().asServer, me, new Map());

    await socket.trigger('dm:send', { toUserId: 'peer', content: 'merhaba' });

    expect(dms.insertMessage).toHaveBeenCalledTimes(1);
  });
});
