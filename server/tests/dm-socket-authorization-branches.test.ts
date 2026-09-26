// server/tests/dm-socket-authorization-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// DM / GRUP-DM SOKET YÜZEYİ — YETKİ VE AYIKLAMA DALLARI
// ════════════════════════════════════════════════════════════════════════════
//
// Soket olayları HTTP gibi bir yönlendirici yetkisinden geçmez: her olay
// kendi sınırını kendisi kurmak zorundadır. Ölçülmemiş dallar tam da bu
import { findEmitted, requireEmitted } from './helpers/socketDoubles';
// sınırlardı ve her biri gerçek bir saldırı yüzeyidir:
//
//   · SİNYAL ENJEKSİYONU — `dm:call:offer/answer/ice`, yalnız görüşmenin
//     KARŞI ucuna gidebilir. Rastgele bir `targetUserId` ile istenmeyen
//     WebRTC teklifi gönderilememelidir.
//   · GÖRÜŞME ELE GEÇİRME — `callId` bilen üçüncü bir kişi başkasının
//     görüşmesini bitirememeli/reddedememelidir.
//   · ODA ≠ YETKİ — grup sesli görüşmesinde üyelik TEK BAŞINA yetmez;
//     olay ancak görüşme odasında olan biri tarafından üretilebilir.
//   · YİNELENEN GÖNDERİM — `clientNonce` ile gelen tekrar, İKİNCİ bir mesaj
//     yazmamalı; ama başka bir konuşmaya ait nonce da KABUL EDİLMEMELİDİR.
//   · ENGEL — engel, eski bir konuşmadaki tepki gibi mutasyonlarda da geçerli.
//   · Bozuk kalıcı JSON (`reactions`) çökme değil, sadeleştirme üretmelidir.

process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

import type { ActiveDmCall } from '../socket/handlers/dm-call-store';

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

const callRows = new Map<string, ActiveDmCall>();
const callStore = {
  get: jest.fn(async (callId: string) => callRows.get(callId) ?? null),
  set: jest.fn(async (call: ActiveDmCall) => { callRows.set(call.callId, call); }),
  del: jest.fn(async (callId: string) => { callRows.delete(callId); }),
  withLock: jest.fn(async <T>(_callId: string, fn: () => Promise<T>) => fn()),
};

jest.mock('../db/repositories', () => ({ Dms: dms, GroupDms: groupDms, Users: users }));
jest.mock('../lib/dmAccessPolicy', () => dmAccess);
jest.mock('../lib/redisAdapter', () => ({
  cache: { slidingWindowCount: (...args: unknown[]) => slidingWindowCount(...args) },
}));
jest.mock('../socket/handlers/dm-call-store', () => ({ dmCallStore: callStore }));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { Server, Socket } from 'socket.io';
import { registerDmHandlers, registerGroupDmHandlers } from '../socket/handlers/dm';

// ── Test ikizleri ───────────────────────────────────────────────────────────
// `socket.io`'nun `Socket`/`Server` arayüzleri yüzlerce üye taşır; handler
// yalnız aşağıdaki dar yüzeyi kullanır. Dönüşüm TEK bir yerde, açıkça yapılır.
type Emission = { event: string; payload?: unknown; room?: string };
type RoomSocket = { id: string; data?: Record<string, unknown>; leave?: (room: string) => void };

interface FakeSocket {
  id: string;
  data: Record<string, unknown>;
  rooms: Set<string>;
  handlers: Map<string, (payload?: unknown) => Promise<void>>;
  self: Emission[];
  broadcast: Emission[];
  trigger(event: string, payload?: unknown): Promise<void>;
  asSocket: Socket;
}

interface FakeIo {
  targeted: Emission[];
  roomSockets: Map<string, RoomSocket[]>;
  inIsFunction: boolean;
  scopeHasFetch: boolean;
  asServer: Server;
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
    id, data: shape.data, rooms, handlers, self, broadcast,
    async trigger(event, payload) { await handlers.get(event)?.(payload); },
    asSocket: shape as unknown as Socket,
  };
}

function makeIo(): FakeIo {
  const targeted: Emission[] = [];
  const roomSockets = new Map<string, RoomSocket[]>();
  const io: FakeIo = {
    targeted, roomSockets, inIsFunction: true, scopeHasFetch: true,
    asServer: undefined as unknown as Server,
  };
  const shape = {
    to(room: string) {
      return { emit(event: string, payload?: unknown) { targeted.push({ event, payload, room }); return true; } };
    },
    in(room: string) {
      if (!io.scopeHasFetch) return {};
      return { fetchSockets: async () => roomSockets.get(room) ?? [] };
    },
  };
  io.asServer = shape as unknown as Server;
  return io;
}

const ME = 'user-me';
const PEER = 'user-peer';
const me = { _id: ME, username: 'me', displayName: 'Ben', avatarColor: '#111' };

function register(socket: FakeSocket, io: FakeIo, user = me): void {
  registerDmHandlers(socket.asSocket, io.asServer, user, new Map());
}

function registerGroup(socket: FakeSocket, io: FakeIo, user = me): void {
  registerGroupDmHandlers(socket.asSocket, io.asServer, user, new Map());
}

const call = (over: Partial<ActiveDmCall> = {}): ActiveDmCall => ({
  callId: 'call-1', callerId: ME, calleeId: PEER,
  type: 'voice', startedAt: 1000, status: 'ringing', ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  callRows.clear();
  slidingWindowCount.mockResolvedValue(1);
  users.findById.mockResolvedValue({ _id: PEER, username: 'peer', displayName: 'Karşı' });
  dmAccess.evaluateDmAccess.mockResolvedValue({ allowed: true });
  dmAccess.isDmBlocked.mockResolvedValue(false);
  dms.findByClientNonce.mockResolvedValue(null);
  dms.findOrCreateConversation.mockResolvedValue({ _id: 'dm' });
  dms.insertMessage.mockImplementation(async (row: Record<string, unknown>) => ({ _id: 'm1', ...row }));
  dms.markRead.mockResolvedValue(undefined);
  dms.findConversation.mockResolvedValue({ _id: 'dm', participants: [ME, PEER] });
  dms.findMessage.mockResolvedValue({ _id: 'm1', reactions: {} });
  dms.updateMessage.mockResolvedValue(undefined);
  groupDms.findMember.mockResolvedValue({ userId: ME, groupId: 'g1' });
  groupDms.findGroupsByUser.mockResolvedValue([]);
  groupDms.findByClientNonce.mockResolvedValue(null);
  groupDms.insertMessage.mockImplementation(async (row: Record<string, unknown>) => ({ _id: 'gm1', ...row }));
  groupDms.update.mockResolvedValue(undefined);
  groupDms.markRead.mockResolvedValue(true);
});

// ════════════════════════════════════════════════════════════════════════════
describe('dm:call — katılımcı sınırı', () => {
  it('şema dışı yükler sessizce düşürülür ve DEPOYA dokunulmaz', async () => {
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    for (const event of ['dm:call:accept', 'dm:call:decline', 'dm:call:end']) {
      await socket.trigger(event, { callId: '' });
      await socket.trigger(event, {});
      await socket.trigger(event, 'metin');
    }
    for (const event of ['dm:call:offer', 'dm:call:answer', 'dm:call:ice']) {
      await socket.trigger(event, { callId: 'call-1' });
      await socket.trigger(event, { targetUserId: PEER });
    }

    expect(callStore.get).not.toHaveBeenCalled();
    expect(io.targeted).toHaveLength(0);
  });

  it('başkasının görüşmesi ÜÇÜNCÜ kişi tarafından bitirilemez', async () => {
    callRows.set('call-1', call({ callerId: 'baska-1', calleeId: 'baska-2' }));
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:end', { callId: 'call-1' });
    await socket.trigger('dm:call:decline', { callId: 'call-1' });

    expect(callRows.has('call-1')).toBe(true);
    expect(io.targeted).toHaveLength(0);
  });

  it('bilinmeyen görüşme kimliği hiçbir şey yapmaz', async () => {
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:end', { callId: 'yok' });

    expect(io.targeted).toHaveLength(0);
  });

  it('128 karakterden uzun görüşme kimliği depoya SORULMAZ', async () => {
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);
    // Şema 64 ile sınırlar; iç denetim ayrıca kendi sınırını korur.
    await socket.trigger('dm:call:end', { callId: 'c'.repeat(200) });

    expect(callStore.get).not.toHaveBeenCalled();
  });

  it('ARAYAN bitirdiğinde ARANAN bilgilendirilir', async () => {
    callRows.set('call-1', call({ status: 'active' }));
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:end', { callId: 'call-1' });

    expect(io.targeted).toEqual([{ event: 'dm:call:ended', payload: { callId: 'call-1' }, room: `user:${PEER}` }]);
    expect(socket.self).toContainEqual({ event: 'dm:call:ended', payload: { callId: 'call-1' } });
    expect(callRows.has('call-1')).toBe(false);
  });

  it('ARANAN bitirdiğinde ARAYAN bilgilendirilir', async () => {
    callRows.set('call-1', call({ callerId: PEER, calleeId: ME, status: 'active' }));
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:end', { callId: 'call-1' });

    expect(io.targeted[0]?.room).toBe(`user:${PEER}`);
  });

  it('zil çalmayan görüşme REDDEDİLEMEZ', async () => {
    callRows.set('call-1', call({ status: 'active' }));
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:decline', { callId: 'call-1' });

    expect(callRows.has('call-1')).toBe(true);
    expect(io.targeted).toHaveLength(0);
  });

  it('ENGELLENMİŞ arayanın çağrısı KABUL EDİLEMEZ', async () => {
    callRows.set('call-1', call({ callerId: PEER, calleeId: ME }));
    dmAccess.isDmBlocked.mockResolvedValue(true);
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:accept', { callId: 'call-1' });

    expect(io.targeted).toHaveLength(0);
    expect(callRows.get('call-1')?.status).toBe('ringing');
  });

  it('ARAYAN kendi çağrısını KABUL EDEMEZ', async () => {
    callRows.set('call-1', call());
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:accept', { callId: 'call-1' });

    expect(callRows.get('call-1')?.status).toBe('ringing');
    expect(io.targeted).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('dm:call — sinyal yönlendirme', () => {
  it('hedef görüşmenin KARŞI UCU değilse sinyal iletilmez', async () => {
    callRows.set('call-1', call());
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:offer', { callId: 'call-1', targetUserId: 'yabanci', offer: { sdp: 'x' } });

    expect(io.targeted).toHaveLength(0);
  });

  it('katılımcı olmayan sinyal gönderemez', async () => {
    callRows.set('call-1', call({ callerId: 'a', calleeId: 'b' }));
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:ice', { callId: 'call-1', targetUserId: 'b', candidate: {} });

    expect(io.targeted).toHaveLength(0);
  });

  it('ENGEL varsa sinyal iletilmez', async () => {
    callRows.set('call-1', call());
    dmAccess.isDmBlocked.mockResolvedValue(true);
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:answer', { callId: 'call-1', targetUserId: PEER, answer: {} });

    expect(io.targeted).toHaveLength(0);
  });

  it('meşru sinyaller yalnız karşı uca ve KAYNAK SOKET kimliğiyle gider', async () => {
    callRows.set('call-1', call());
    const socket = makeSocket('sock-A'); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:offer', { callId: 'call-1', targetUserId: PEER, offer: { sdp: 'o' } });
    await socket.trigger('dm:call:answer', { callId: 'call-1', targetUserId: PEER, answer: { sdp: 'a' } });
    await socket.trigger('dm:call:ice', { callId: 'call-1', targetUserId: PEER, candidate: { c: 1 } });

    expect(io.targeted.map(e => e.event)).toEqual(['dm:call:offer', 'dm:call:answer', 'dm:call:ice']);
    for (const emission of io.targeted) {
      expect(emission.room).toBe(`user:${PEER}`);
      expect(emission.payload).toMatchObject({ callId: 'call-1', fromSocketId: 'sock-A' });
    }
  });

  it('ARANAN taraf sinyali ARAYANA yollar', async () => {
    callRows.set('call-1', call({ callerId: PEER, calleeId: ME }));
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:ice', { callId: 'call-1', targetUserId: PEER, candidate: {} });

    expect(io.targeted[0]?.room).toBe(`user:${PEER}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('dm:call:start ve zaman aşımı', () => {
  it('tür verilmezse SESLİ görüşme varsayılır', async () => {
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:start', { toUserId: PEER });

    expect([...callRows.values()][0]?.type).toBe('voice');
    expect(io.targeted[0]?.event).toBe('dm:call:incoming');
  });

  it('alıcı yoksa görüşme OLUŞTURULMAZ', async () => {
    users.findById.mockResolvedValue(null);
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:start', { toUserId: 'yok' });

    expect(callRows.size).toBe(0);
  });

  it('DM erişim politikası reddederse görüşme başlamaz', async () => {
    dmAccess.evaluateDmAccess.mockResolvedValue({ allowed: false, reason: 'blocked' });
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);

    await socket.trigger('dm:call:start', { toUserId: PEER, type: 'video' });

    expect(callRows.size).toBe(0);
    expect(io.targeted).toHaveLength(0);
  });

  it('30 saniyede yanıtlanmayan çağrı KAÇIRILDI sayılır', async () => {
    jest.useFakeTimers();
    try {
      const socket = makeSocket(); const io = makeIo();
      register(socket, io);
      await socket.trigger('dm:call:start', { toUserId: PEER });
      io.targeted.length = 0;

      jest.advanceTimersByTime(30_000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      expect(socket.self.some(e => e.event === 'dm:call:missed')).toBe(true);
      expect(callRows.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('YANITLANMIŞ çağrı zaman aşımıyla düşürülmez', async () => {
    jest.useFakeTimers();
    try {
      const socket = makeSocket(); const io = makeIo();
      register(socket, io);
      await socket.trigger('dm:call:start', { toUserId: PEER });
      const started = [...callRows.values()][0]!;
      callRows.set(started.callId, { ...started, status: 'active' });

      jest.advanceTimersByTime(30_000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      expect(callRows.has(started.callId)).toBe(true);
      expect(socket.self.some(e => e.event === 'dm:call:missed')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bağlantı koparsa YALNIZ bu soketin görüşmeleri kapanır', async () => {
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);
    await socket.trigger('dm:call:start', { toUserId: PEER });
    const started = [...callRows.values()][0]!;
    // Görüşme bu soketin başlattığı kayıt olmaktan çıkarsa temizlik atlanır.
    callRows.set(started.callId, { ...started, callerId: 'baskasi', calleeId: 'digeri' });
    io.targeted.length = 0;

    await socket.trigger('disconnect');

    expect(io.targeted).toHaveLength(0);
    expect(callRows.has(started.callId)).toBe(true);
  });

  it('bağlantı koparsa karşı taraf NEDENİYLE bilgilendirilir', async () => {
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);
    await socket.trigger('dm:call:start', { toUserId: PEER });
    io.targeted.length = 0;

    await socket.trigger('disconnect');

    expect(io.targeted[0]).toMatchObject({
      event: 'dm:call:ended', room: `user:${PEER}`, payload: { reason: 'disconnect' },
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('dm:send — yeniden gönderim ve yarış', () => {
  const send = async (payload: unknown) => {
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);
    await socket.trigger('dm:send', payload);
    return { socket, io };
  };

  it('yalnız boşluktan ibaret mesaj AÇIK bir kodla reddedilir', async () => {
    const { socket } = await send({ toUserId: PEER, content: '   ' });

    expect(socket.self[0]).toMatchObject({
      event: 'error:message', payload: { code: 'EMPTY_MESSAGE' },
    });
    expect(dms.insertMessage).not.toHaveBeenCalled();
  });

  it('şema dışı yük genel kodla reddedilir', async () => {
    const { socket } = await send({ content: 'merhaba' });

    expect(socket.self[0]).toMatchObject({ payload: { code: 'INVALID_PAYLOAD' } });
  });

  it('politika reddi NONCE ile birlikte geri bildirilir', async () => {
    dmAccess.evaluateDmAccess.mockResolvedValue({ allowed: false, reason: 'privacy_none' });

    const { socket } = await send({ toUserId: PEER, content: 'selam', clientNonce: 'n-1' });

    expect(socket.self[0]).toMatchObject({
      event: 'error:dm_privacy',
      payload: { code: 'DM_POLICY_DENIED', clientNonce: 'n-1' },
    });
  });

  it('BAŞKA konuşmaya ait nonce yeniden kullanılamaz', async () => {
    dms.findByClientNonce.mockResolvedValue({ _id: 'eski', dmId: 'baska-konusma' });

    const { socket } = await send({ toUserId: PEER, content: 'selam', clientNonce: 'n-1' });

    expect(socket.self[0]).toMatchObject({ payload: { code: 'NONCE_CONFLICT', clientNonce: 'n-1' } });
    expect(dms.findOrCreateConversation).not.toHaveBeenCalled();
    expect(dms.insertMessage).not.toHaveBeenCalled();
  });

  it('aynı konuşmaya ait nonce İKİNCİ mesaj yazmaz, mevcut satırı yankılar', async () => {
    const dmId = dms.buildDmId(ME, PEER) as unknown as string;
    dms.findByClientNonce.mockResolvedValue({ _id: 'm-eski', dmId, content: 'selam' });

    const { socket, io } = await send({ toUserId: PEER, content: 'selam', clientNonce: 'n-1' });

    expect(socket.self[0]).toMatchObject({ event: 'dm:message', payload: { _id: 'm-eski', clientNonce: 'n-1' } });
    expect(dms.insertMessage).not.toHaveBeenCalled();
    expect(slidingWindowCount).not.toHaveBeenCalled();
    expect(io.targeted).toHaveLength(0);
  });

  it('kimlik çakışması YARIŞTA kazananın satırıyla çözülür', async () => {
    const dmId = dms.buildDmId(ME, PEER) as unknown as string;
    dms.insertMessage.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));
    dms.findByClientNonce.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'kazanan', dmId });

    const { socket } = await send({ toUserId: PEER, content: 'selam', clientNonce: 'n-1' });

    expect(socket.self.at(-1)).toMatchObject({ event: 'dm:message', payload: { _id: 'kazanan' } });
    expect(socket.self.some(e => e.event === 'error:message')).toBe(false);
  });

  it('yazma hatası nonce YOKKEN yutulmaz', async () => {
    dms.insertMessage.mockRejectedValue(new Error('db down'));

    const { socket } = await send({ toUserId: PEER, content: 'selam' });

    expect(socket.self.at(-1)).toMatchObject({ event: 'error:message' });
  });

  it('yazma hatası nonce başka konuşmaya aitse yutulmaz', async () => {
    dms.insertMessage.mockRejectedValue(new Error('db down'));
    dms.findByClientNonce.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'x', dmId: 'baska' });

    const { socket } = await send({ toUserId: PEER, content: 'selam', clientNonce: 'n-1' });

    expect(socket.self.at(-1)).toMatchObject({ event: 'error:message', payload: { clientNonce: 'n-1' } });
  });

  it('nonce ALICIYA sızmaz', async () => {
    const { socket, io } = await send({ toUserId: PEER, content: 'selam', clientNonce: 'gizli-nonce' });

    expect(socket.self[0]?.payload).toMatchObject({ clientNonce: 'gizli-nonce' });
    const delivered = requireEmitted(io.targeted, 'dm:message');
    expect(delivered?.payload).not.toHaveProperty('clientNonce');
  });

  it('hız sınırı aşılırsa hiçbir YAZMA yapılmaz', async () => {
    slidingWindowCount.mockResolvedValue(9999);

    const { socket } = await send({ toUserId: PEER, content: 'selam' });

    expect(socket.self[0]).toMatchObject({ event: 'error:dm_rate', payload: { code: 'RATE_LIMITED' } });
    expect(dms.findOrCreateConversation).not.toHaveBeenCalled();
  });

  it('Redis kullanılamıyorsa (yapılandırılmamışken) bellek içi sayaca düşülür', async () => {
    slidingWindowCount.mockRejectedValue(new Error('redis down'));

    const { socket } = await send({ toUserId: PEER, content: 'selam' });

    expect(socket.self[0]?.event).toBe('dm:message');
  });

  it('Redis sayaç DÖNDÜREMEZSE bellek içi sayaç kullanılır', async () => {
    slidingWindowCount.mockResolvedValue(null);

    const { socket } = await send({ toUserId: PEER, content: 'selam' });

    expect(socket.self[0]?.event).toBe('dm:message');
  });

  it('alıcı bulunamazsa AÇIK bir kod döner', async () => {
    users.findById.mockResolvedValue(null);

    const { socket } = await send({ toUserId: 'yok', content: 'selam' });

    expect(socket.self[0]).toMatchObject({ payload: { code: 'USER_NOT_FOUND' } });
  });

  it('E2EE mesajlar için uzunluk sınırı daha geniştir, düz metin için değil', async () => {
    const plain = await send({ toUserId: PEER, content: 'a'.repeat(2001) });
    expect(plain.socket.self[0]).toMatchObject({ payload: { code: 'MESSAGE_TOO_LONG' } });

    dms.insertMessage.mockClear();
    const encrypted = await send({ toUserId: PEER, content: `🔒e2e:${'a'.repeat(2100)}` });
    expect(encrypted.socket.self[0]?.event).toBe('dm:message');
    expect(dms.insertMessage).toHaveBeenCalledWith(expect.objectContaining({ e2e: true }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('dm:read / dm:join / dm:react', () => {
  const fresh = () => {
    const socket = makeSocket(); const io = makeIo();
    register(socket, io);
    return { socket, io };
  };

  it.each([
    ['sayı', 42],
    ['boş dize', ''],
    ['çok uzun', 'd'.repeat(200)],
    ['nesne içinde eksik', {}],
  ])('dm:read %s ile depoya dokunmaz', async (_label, payload) => {
    const { socket } = fresh();
    await socket.trigger('dm:read', payload);
    expect(dms.markRead).not.toHaveBeenCalled();
  });

  it('dm:read metin ve nesne biçimini de kabul eder', async () => {
    const { socket, io } = fresh();
    await socket.trigger('dm:read', 'dm-1');
    await socket.trigger('dm:read', { dmId: 'dm-2' });

    expect(dms.markRead).toHaveBeenCalledTimes(2);
    expect(io.targeted.every(e => e.event === 'inbox:changed')).toBe(true);
  });

  it('dm:read başarısızlığı SESSİZCE yutulmaz', async () => {
    dms.markRead.mockRejectedValue(new Error('unknown column'));
    const { socket } = fresh();

    await socket.trigger('dm:read', 'dm-1');

    expect(socket.self[0]?.event).toBe('error:dm_read');
  });

  it.each([
    ['metin olmayan', 42],
    ['çok uzun', 'd'.repeat(200)],
  ])('dm:join %s kimlikle konuşma ARAMAZ', async (_label, payload) => {
    const { socket } = fresh();
    await socket.trigger('dm:join', payload);
    expect(dms.findConversation).not.toHaveBeenCalled();
  });

  it('dm:join katılımcı olmayanı odaya ALMAZ', async () => {
    dms.findConversation.mockResolvedValue({ participants: ['x', 'y'] });
    const { socket } = fresh();

    await socket.trigger('dm:join', 'dm-1');

    expect(socket.rooms.has('dm:dm-1')).toBe(false);
  });

  it('dm:join konuşma okunamazsa odaya ALMAZ', async () => {
    dms.findConversation.mockRejectedValue(new Error('db down'));
    const { socket } = fresh();

    await socket.trigger('dm:join', 'dm-1');

    expect(socket.rooms.has('dm:dm-1')).toBe(false);
  });

  it('dm:join ÖNCEKİ DM odasından çıkarır', async () => {
    const { socket } = fresh();
    socket.rooms.add('dm:eski');

    await socket.trigger('dm:join', 'dm-1');

    expect(socket.rooms.has('dm:eski')).toBe(false);
    expect(socket.rooms.has('dm:dm-1')).toBe(true);
  });

  it('dm:react şema dışı yükte mesaj ARAMAZ', async () => {
    const { socket } = fresh();

    await socket.trigger('dm:react', { messageId: 'm1', dmId: 'dm-1' });
    await socket.trigger('dm:react', { messageId: 'm1', dmId: 'dm-1', emoji: 'e'.repeat(20) });

    expect(dms.findMessage).not.toHaveBeenCalled();
  });

  it('dm:react silinmiş mesaja tepki YAZMAZ', async () => {
    dms.findMessage.mockResolvedValue(null);
    const { socket } = fresh();

    await socket.trigger('dm:react', { messageId: 'm1', dmId: 'dm-1', emoji: '👍' });

    expect(dms.updateMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['konuşma yoksa', null],
    ['katılımcı listesi bozuksa', { participants: 'bozuk' }],
    ['katılımcı değilsem', { participants: ['a', 'b'] }],
  ])('dm:react %s tepki yazmaz', async (_label, conversation) => {
    dms.findConversation.mockResolvedValue(conversation);
    const { socket } = fresh();

    await socket.trigger('dm:react', { messageId: 'm1', dmId: 'dm-1', emoji: '👍' });

    expect(dms.updateMessage).not.toHaveBeenCalled();
  });

  it('dm:react ENGEL varsa eski mesajda bile tepki yazmaz', async () => {
    dmAccess.isDmBlocked.mockResolvedValue(true);
    const { socket } = fresh();

    await socket.trigger('dm:react', { messageId: 'm1', dmId: 'dm-1', emoji: '👍' });

    expect(dms.updateMessage).not.toHaveBeenCalled();
  });

  it('dm:react bozuk kalıcı JSON’u ÇÖKMEDEN sadeleştirir', async () => {
    dms.findMessage.mockResolvedValue({
      _id: 'm1',
      reactions: JSON.stringify({
        '👍': ['a', 'a', 'b', 42, '', 'c'.repeat(200)],
        '👎': 'dizi-degil',
      }),
    });
    const { socket } = fresh();

    await socket.trigger('dm:react', { messageId: 'm1', dmId: 'dm-1', emoji: '👍' });

    const written = (dms.updateMessage.mock.calls[0]?.[1] as { reactions: Record<string, string[]> }).reactions;
    expect(written['👍']).toEqual(['a', 'b', ME]);
    expect(written).not.toHaveProperty('👎');
  });

  it('dm:react ÇÖZÜLEMEYEN JSON’u boş tepki olarak ele alır', async () => {
    dms.findMessage.mockResolvedValue({ _id: 'm1', reactions: '{bozuk' });
    const { socket } = fresh();

    await socket.trigger('dm:react', { messageId: 'm1', dmId: 'dm-1', emoji: '👍' });

    const written = (dms.updateMessage.mock.calls[0]?.[1] as { reactions: Record<string, string[]> }).reactions;
    expect(written).toEqual({ '👍': [ME] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('gdm:send — üyelik ve yeniden gönderim', () => {
  const send = async (payload: unknown, user = me) => {
    const socket = makeSocket(); const io = makeIo();
    registerGroup(socket, io, user);
    await socket.trigger('gdm:send', payload);
    return { socket, io };
  };

  it('üyeliği biten kullanıcı gruba yazamaz', async () => {
    groupDms.findMember.mockResolvedValue(null);

    const { socket } = await send({ groupId: 'g1', content: 'selam' });

    expect(socket.self[0]).toMatchObject({ payload: { code: 'NOT_A_MEMBER' } });
    expect(groupDms.insertMessage).not.toHaveBeenCalled();
  });

  it('yalnız boşluktan ibaret mesaj AÇIK kodla reddedilir', async () => {
    const { socket } = await send({ groupId: 'g1', content: '  \n ' });
    expect(socket.self[0]).toMatchObject({ payload: { code: 'EMPTY_MESSAGE' } });
  });

  it('şema dışı yük reddedilir', async () => {
    const { socket } = await send({ content: 'selam' });
    expect(socket.self[0]).toMatchObject({ payload: { code: 'INVALID_PAYLOAD' } });
  });

  it('kırpıldıktan sonra sınırda kalan ama HAM hâli aşan mesaj reddedilir', async () => {
    const { socket } = await send({ groupId: 'g1', content: `${'a'.repeat(2000)}     ` });

    expect(socket.self[0]).toMatchObject({ payload: { code: 'MESSAGE_TOO_LONG' } });
    expect(groupDms.insertMessage).not.toHaveBeenCalled();
  });

  it('BAŞKA gruba ait nonce yeniden kullanılamaz', async () => {
    groupDms.findByClientNonce.mockResolvedValue({ _id: 'eski', groupId: 'baska-grup' });

    const { socket } = await send({ groupId: 'g1', content: 'selam', clientNonce: 'n-1' });

    expect(socket.self[0]).toMatchObject({ payload: { code: 'NONCE_CONFLICT' } });
    expect(groupDms.insertMessage).not.toHaveBeenCalled();
  });

  it('aynı gruba ait nonce mevcut satırı yankılar', async () => {
    groupDms.findByClientNonce.mockResolvedValue({ _id: 'gm-eski', groupId: 'g1' });

    const { socket } = await send({ groupId: 'g1', content: 'selam', clientNonce: 'n-1' });

    expect(socket.self[0]).toMatchObject({ event: 'gdm:message', payload: { _id: 'gm-eski', clientNonce: 'n-1' } });
    expect(slidingWindowCount).not.toHaveBeenCalled();
  });

  it('yarışta kazananın satırı döner', async () => {
    groupDms.insertMessage.mockRejectedValue(new Error('duplicate'));
    groupDms.findByClientNonce.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'kazanan', groupId: 'g1' });

    const { socket } = await send({ groupId: 'g1', content: 'selam', clientNonce: 'n-1' });

    expect(socket.self.at(-1)).toMatchObject({ event: 'gdm:message', payload: { _id: 'kazanan' } });
  });

  it('yazma hatası başka gruba ait nonce ile yutulmaz', async () => {
    groupDms.insertMessage.mockRejectedValue(new Error('db down'));
    groupDms.findByClientNonce.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'x', groupId: 'baska' });

    const { socket } = await send({ groupId: 'g1', content: 'selam', clientNonce: 'n-1' });

    expect(socket.self.at(-1)).toMatchObject({ event: 'error:message' });
  });

  it('hız sınırı aşılırsa yazma yapılmaz', async () => {
    slidingWindowCount.mockResolvedValue(9999);

    const { socket } = await send({ groupId: 'g1', content: 'selam' });

    expect(socket.self[0]).toMatchObject({ event: 'error:gdm_rate' });
    expect(groupDms.insertMessage).not.toHaveBeenCalled();
  });

  it('rengi olmayan kullanıcı için varsayılan renk yazılır ve nonce sızmaz', async () => {
    const { socket } = await send(
      { groupId: 'g1', content: 'selam', clientNonce: 'n-1' },
      { _id: ME, username: 'me', displayName: 'Ben', avatarColor: '' },
    );

    expect(groupDms.insertMessage).toHaveBeenCalledWith(expect.objectContaining({ avatarColor: '#2d9cdb' }));
    const broadcasted = requireEmitted(socket.broadcast, 'gdm:message');
    expect(broadcasted?.payload).not.toHaveProperty('clientNonce');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('gdm — oda ve görüşme sınırları', () => {
  const fresh = (id = 'sock-1') => {
    const socket = makeSocket(id); const io = makeIo();
    registerGroup(socket, io);
    return { socket, io };
  };

  it('başlangıçtaki oda eşitlemesi ÇÖKMEZ', async () => {
    groupDms.findGroupsByUser.mockRejectedValue(new Error('db down'));
    const socket = makeSocket(); const io = makeIo();

    expect(() => registerGroup(socket, io)).not.toThrow();
    await Promise.resolve(); await Promise.resolve();
  });

  it('üyesi olunan gruplara açılışta katılınır', async () => {
    groupDms.findGroupsByUser.mockResolvedValue([{ groupId: 'g1' }, { groupId: 'g2' }]);
    const socket = makeSocket(); const io = makeIo();

    registerGroup(socket, io);
    await Promise.resolve(); await Promise.resolve();

    expect(socket.rooms.has('gdm:g1')).toBe(true);
    expect(socket.rooms.has('gdm:g2')).toBe(true);
  });

  it.each([
    ['metin olmayan', 42],
    ['boş', '   '],
    ['çok uzun', 'g'.repeat(200)],
  ])('gdm:read %s kimlikle okundu YAZMAZ', async (_label, payload) => {
    const { socket } = fresh();
    await socket.trigger('gdm:read', payload);
    expect(groupDms.markRead).not.toHaveBeenCalled();
  });

  it('gdm:read değişiklik yoksa gelen kutusunu tetiklemez', async () => {
    groupDms.markRead.mockResolvedValue(false);
    const { socket, io } = fresh();

    await socket.trigger('gdm:read', 'g1');

    expect(io.targeted).toHaveLength(0);
  });

  it('gdm:join üyeliği olmayanı odaya ALMAZ', async () => {
    groupDms.findMember.mockResolvedValue(null);
    const { socket } = fresh();

    await socket.trigger('gdm:join', 'g1');

    expect(socket.rooms.has('gdm:g1')).toBe(false);
  });

  it('gdm:join üyelik sorgusu patlarsa odaya ALMAZ', async () => {
    groupDms.findMember.mockRejectedValue(new Error('db down'));
    const { socket } = fresh();

    await socket.trigger('gdm:join', 'g1');

    expect(socket.rooms.has('gdm:g1')).toBe(false);
  });

  it('gdm:join geçersiz kimlikte üyelik SORMAZ', async () => {
    const { socket } = fresh();
    await socket.trigger('gdm:join', 42);
    await socket.trigger('gdm:join', 'g'.repeat(200));
    expect(groupDms.findMember).not.toHaveBeenCalled();
  });

  it('gdm:typing üyesi olunmayan gruba SAHTE varlık sinyali gönderemez', async () => {
    groupDms.findMember.mockResolvedValue(null);
    const { socket } = fresh();

    await socket.trigger('gdm:typing', { groupId: 'g1' });

    expect(socket.broadcast).toHaveLength(0);
  });

  it('gdm:typing şema dışı yükte üyelik SORMAZ', async () => {
    const { socket } = fresh();
    await socket.trigger('gdm:typing', {});
    expect(groupDms.findMember).not.toHaveBeenCalled();
  });

  it('gdm:call:start üyesi olunmayan grupta çağrı BAŞLATAMAZ', async () => {
    groupDms.findMember.mockResolvedValue(null);
    const { socket } = fresh();

    await socket.trigger('gdm:call:start', { groupId: 'g1', type: 'video' });

    expect(socket.rooms.has('gdm:voice:g1')).toBe(false);
    expect(socket.broadcast).toHaveLength(0);
  });

  it('gdm:call:start şema dışı yükte hiçbir şey yapmaz', async () => {
    const { socket } = fresh();
    await socket.trigger('gdm:call:start', { groupId: 'g1', type: 'ekran' });
    expect(groupDms.findMember).not.toHaveBeenCalled();
  });

  it('gdm:call:join katılana MEVCUT eşleri bildirir', async () => {
    const { socket, io } = fresh('sock-yeni');
    io.roomSockets.set('gdm:voice:g1', [
      { id: 'sock-eski', data: { userId: 'u2', displayName: 'Eski' } },
      { id: 'sock-yeni', data: { userId: ME } },
    ]);

    await socket.trigger('gdm:call:join', { groupId: 'g1' });

    const peers = requireEmitted(socket.self, 'gdm:call:existing:peers');
    expect(peers?.payload).toEqual({
      groupId: 'g1', peers: [{ socketId: 'sock-eski', userId: 'u2', displayName: 'Eski' }],
    });
    expect(socket.self.some(e => e.event === 'gdm:call:joined')).toBe(true);
  });

  it('gdm:call:join üyesi olmayanı sesli odaya almaz', async () => {
    groupDms.findMember.mockResolvedValue(null);
    const { socket } = fresh();

    await socket.trigger('gdm:call:join', { groupId: 'g1' });

    expect(socket.rooms.has('gdm:voice:g1')).toBe(false);
  });

  it('oda kapsamı çözülemezse eş listesi BOŞ döner', async () => {
    const { socket, io } = fresh();
    io.scopeHasFetch = false;

    await socket.trigger('gdm:call:join', { groupId: 'g1' });

    expect(findEmitted(socket.self, 'gdm:call:existing:peers')?.payload)
      .toEqual({ groupId: 'g1', peers: [] });
  });

  it('gdm:call:leave — görüşmeye katılmamış ÜYE sahte ayrılış yayamaz', async () => {
    const { socket } = fresh();

    await socket.trigger('gdm:call:leave', { groupId: 'g1' });

    expect(socket.broadcast).toHaveLength(0);
    expect(socket.self).toHaveLength(0);
  });

  it('gdm:call:leave — üyeliği bitmiş kullanıcı oda kontrolüne bile geçemez', async () => {
    groupDms.findMember.mockResolvedValue(null);
    const { socket } = fresh();
    socket.rooms.add('gdm:voice:g1');

    await socket.trigger('gdm:call:leave', { groupId: 'g1' });

    expect(socket.rooms.has('gdm:voice:g1')).toBe(true);
  });

  it('gdm:call:leave meşru katılımcıyı odadan çıkarır', async () => {
    const { socket } = fresh();
    socket.rooms.add('gdm:voice:g1');

    await socket.trigger('gdm:call:leave', { groupId: 'g1' });

    expect(socket.rooms.has('gdm:voice:g1')).toBe(false);
    expect(socket.broadcast[0]?.event).toBe('gdm:call:peer:left');
    expect(socket.self[0]?.event).toBe('gdm:call:left');
  });

  it('gdm:call:end — görüşmede olmayan üye herkesin görüşmesini BİTİREMEZ', async () => {
    const { socket, io } = fresh();

    await socket.trigger('gdm:call:end', { groupId: 'g1' });

    expect(io.targeted).toHaveLength(0);
  });

  it('gdm:call:end — üyesi olmayan hiç geçemez', async () => {
    groupDms.findMember.mockResolvedValue(null);
    const { socket, io } = fresh();
    socket.rooms.add('gdm:voice:g1');

    await socket.trigger('gdm:call:end', { groupId: 'g1' });

    expect(io.targeted).toHaveLength(0);
  });

  it('gdm:call:end katılımcıları odadan ZORLA çıkarır', async () => {
    const leave = jest.fn();
    const { socket, io } = fresh();
    socket.rooms.add('gdm:voice:g1');
    io.roomSockets.set('gdm:voice:g1', [
      { id: 'a', leave },
      { id: 'b' },  // `leave` sağlamayan eş çökme üretmemelidir
    ]);

    await socket.trigger('gdm:call:end', { groupId: 'g1' });

    expect(io.targeted[0]).toMatchObject({ event: 'gdm:call:ended', room: 'gdm:voice:g1' });
    expect(leave).toHaveBeenCalledWith('gdm:voice:g1');
  });

  it('bağlantı kopunca sesli odalara AYRILDI sinyali yayılır', async () => {
    const { socket } = fresh();
    socket.rooms.add('gdm:voice:g1');
    socket.rooms.add('gdm:g2');
    socket.rooms.add('gdm:voice:');

    await socket.trigger('disconnecting');

    expect(socket.broadcast).toHaveLength(1);
    expect(socket.broadcast[0]).toMatchObject({
      event: 'gdm:call:peer:left', room: 'gdm:voice:g1', payload: { reason: 'disconnect' },
    });
  });

  it.each(['gdm:call:offer', 'gdm:call:answer', 'gdm:call:ice'])('%s şema dışı yükte üyelik SORMAZ', async (event) => {
    const { socket } = fresh();
    await socket.trigger(event, { groupId: 'g1' });
    expect(groupDms.findMember).not.toHaveBeenCalled();
  });

  it('sinyal — grup üyesi olmayan iletemez', async () => {
    groupDms.findMember.mockResolvedValue(null);
    const { socket, io } = fresh();
    socket.rooms.add('gdm:voice:g1');

    await socket.trigger('gdm:call:offer', { groupId: 'g1', targetSocketId: 'sock-b', offer: {} });

    expect(io.targeted).toHaveLength(0);
  });

  it('sinyal — görüşme odasında olmayan üye iletemez', async () => {
    const { socket, io } = fresh();

    await socket.trigger('gdm:call:answer', { groupId: 'g1', targetSocketId: 'sock-b', answer: {} });

    expect(io.targeted).toHaveLength(0);
  });

  it('sinyal — hedef O GÖRÜŞMENİN odasında değilse iletilmez', async () => {
    const { socket, io } = fresh();
    socket.rooms.add('gdm:voice:g1');
    io.roomSockets.set('gdm:voice:g1', [{ id: 'sock-1' }]);

    await socket.trigger('gdm:call:ice', { groupId: 'g1', targetSocketId: 'yabanci', candidate: {} });

    expect(io.targeted).toHaveLength(0);
  });

  it('sinyal — meşru hedefe kaynak soket kimliğiyle iletilir', async () => {
    const { socket, io } = fresh('sock-1');
    socket.rooms.add('gdm:voice:g1');
    io.roomSockets.set('gdm:voice:g1', [{ id: 'sock-1' }, { id: 'sock-b' }]);

    await socket.trigger('gdm:call:offer', { groupId: 'g1', targetSocketId: 'sock-b', offer: { sdp: 'o' } });
    await socket.trigger('gdm:call:answer', { groupId: 'g1', targetSocketId: 'sock-b', answer: { sdp: 'a' } });
    await socket.trigger('gdm:call:ice', { groupId: 'g1', targetSocketId: 'sock-b', candidate: { c: 1 } });

    expect(io.targeted.map(e => e.event)).toEqual(['gdm:call:offer', 'gdm:call:answer', 'gdm:call:ice']);
    expect(io.targeted[0]?.payload).toEqual({ groupId: 'g1', fromSocketId: 'sock-1', offer: { sdp: 'o' } });
    expect(io.targeted[2]?.payload).toEqual({ groupId: 'g1', fromSocketId: 'sock-1', candidate: { c: 1 } });
  });

  it('gdm:call:state — şema dışı yük, üyelik ve oda sınırlarına takılır', async () => {
    const { socket } = fresh();
    await socket.trigger('gdm:call:state', { groupId: 'g1', muted: 'evet' });
    expect(groupDms.findMember).not.toHaveBeenCalled();

    await socket.trigger('gdm:call:state', { groupId: 'g1', muted: true });
    expect(socket.broadcast).toHaveLength(0);   // odada değil

    groupDms.findMember.mockResolvedValue(null);
    socket.rooms.add('gdm:voice:g1');
    await socket.trigger('gdm:call:state', { groupId: 'g1', muted: true });
    expect(socket.broadcast).toHaveLength(0);   // üye değil
  });

  it('gdm:call:state meşru katılımcının durumunu yayar', async () => {
    const { socket } = fresh();
    socket.rooms.add('gdm:voice:g1');

    await socket.trigger('gdm:call:state', { groupId: 'g1', muted: true, video: false });

    expect(socket.broadcast[0]).toMatchObject({
      event: 'gdm:call:peer:state', room: 'gdm:voice:g1',
      payload: { userId: ME, muted: true, video: false },
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('hız sınırı otoritesi — Redis YAPILANDIRILMIŞKEN', () => {
  it('Redis patlarsa bellek içi sayaca DÜŞÜLMEZ (fail-closed)', async () => {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = 'redis://localhost:6379';
    try {
      let handlers: typeof import('../socket/handlers/dm') | null = null;
      jest.isolateModules(() => {
        handlers = require('../socket/handlers/dm') as typeof import('../socket/handlers/dm');
      });
      const socket = makeSocket(); const io = makeIo();
      slidingWindowCount.mockRejectedValue(new Error('redis down'));
      handlers!.registerDmHandlers(socket.asSocket, io.asServer, me, new Map());

      await socket.trigger('dm:send', { toUserId: PEER, content: 'selam' });

      expect(socket.self[0]).toMatchObject({ event: 'error:dm_rate', payload: { code: 'RATE_LIMITED' } });
      expect(dms.insertMessage).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previous;
    }
  });
});
